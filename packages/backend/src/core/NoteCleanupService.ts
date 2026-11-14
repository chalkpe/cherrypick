/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import promiseLimit from 'promise-limit';
import type * as Redis from 'ioredis';
import { DataSource, In, IsNull } from 'typeorm';
import type { EntityManager, EntityTarget, ObjectLiteral, Repository, QueryRunner } from 'typeorm';
import Logger from '@/logger.js';
import { DI } from '@/di-symbols.js';
import { MiNoteCleanupRule, MiNoteCleanupState } from '@/models/NoteCleanupRule.js';
import { MiNote, MiUser, MiClip, MiClipNote, MiChannel, MiPoll, MiDriveFile, MiNoteFavorite, MiNoteReaction, MiUserNotePining } from '@/models/_.js';
import { QueueService } from '@/core/QueueService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { ReactionsBufferingService } from '@/core/ReactionsBufferingService.js';
import { DriveService } from '@/core/DriveService.js';
import { DriveFileUsageService } from '@/core/DriveFileUsageService.js';
import type { MiMeta } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { isQuote, isRenote } from '@/misc/is-renote.js';
import { CleanupConditionError, cleanupDependencies, cleanupReferences, decideCleanup, validateCleanupCondition } from './NoteCleanupCondition.js';
import type { CleanupCondition, CleanupContext, CleanupEvaluationRule } from './NoteCleanupCondition.js';
import { runCleanupBatch, initialCleanupRules, isRetryableCleanupFailure } from './NoteCleanupRunner.js';

export class CleanupInputError extends Error {
	constructor(public code: string, public path = 'condition', public referenceId?: string) { super(code); }
}
// 노트 조회 실패는 삭제 실패와 구분한다. 원인 오류를 보존해 재시도 가능 여부와 메시지를 그대로 판정한다.
export class CleanupNoteLookupError extends Error {
	constructor(cause: unknown) { super(cause instanceof Error ? cause.message : 'Cleanup note lookup failed', { cause }); }
}
type PreparedCleanupRule = { rule: MiNoteCleanupRule; lastError: MiNoteCleanupRule['lastError'] };
type LegacyUpdates = { autoDeleteNotesAfterDays?: number | null; autoDeleteKeepFavorites?: boolean };
export type CleanupRuleInput = { name?: string; action: 'keep' | 'delete'; condition: unknown; enabled?: boolean; automatic?: boolean; confirmed?: boolean };

@Injectable()
export class NoteCleanupService {
	private activeLocks = 0;
	private logger = new Logger('note-cleanup');
	private context = new AsyncLocalStorage<EntityManager>();
	constructor(
		@Inject(DI.db) private db: DataSource,
		private idService: IdService,
		private queueService: QueueService,
		private noteDeleteService: NoteDeleteService,
		private notificationService: NotificationService,
		@Inject(DI.redisForJobQueue) private redis: Redis.Redis,
		@Inject(DI.meta) private meta: MiMeta,
		private reactionsBufferingService: ReactionsBufferingService,
		private driveService: DriveService,
		private driveFileUsageService: DriveFileUsageService,
	) {}

	private repository<T extends ObjectLiteral>(target: EntityTarget<T>): Repository<T> {
		return this.context.getStore()?.getRepository(target) ?? this.db.getRepository(target);
	}

	private get rules() { return this.repository(MiNoteCleanupRule); }
	private get states() { return this.repository(MiNoteCleanupState); }

	// 세션 잠금은 수동 요청과 자동 검사의 중복 판정을 직렬화한다.
	public async locked<T>(userId: string, work: () => Promise<T>): Promise<T> {
		const pool = (this.db.driver as unknown as { master?: { options: { max?: number } } } | undefined)?.master;
		const maximum = pool?.options.max ?? 10;
		const limit = maximum < 3 ? 0 : Math.max(2, Math.floor((maximum - 1) / 2));
		if (this.activeLocks >= limit) throw new CleanupInputError('CLEANUP_BUSY', 'request');
		// 커넥션 생성이 실패하면 카운터를 올리지 않는다. 올려두면 복구 경로 없이 혼잡이 영구화된다.
		const runner = this.db.createQueryRunner('master');
		this.activeLocks++;
		let acquired = false;
		try {
			await runner.connect();
			const [result] = await runner.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`note-cleanup-${userId}`]);
			acquired = result.locked;
			if (!acquired) throw new CleanupInputError('CLEANUP_BUSY', 'request');
			return await this.context.run(runner.manager, work);
		} finally {
			try { await this.releaseLock(runner, userId, acquired); } finally { this.activeLocks--; }
		}
	}

	private async releaseLock(runner: QueryRunner, userId: string, acquired: boolean) {
		try {
			if (acquired) await runner.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`note-cleanup-${userId}`]);
		} catch (error) {
			// 잠금이 남은 연결을 풀에 돌려보내지 않는다.
			await (runner as unknown as { releasePostgresConnection(error: Error): Promise<void> }).releasePostgresConnection(new Error('Cleanup database unlock failed'));
			throw error;
		} finally { await runner.release(); }
	}

	// 기존 로컬 계정의 상태는 마이그레이션이 모두 만들었으므로, 상태가 없는 계정은 어떤 API를 먼저 불렀든 신규 계정이다.
	private async initialize(userId: string) {
		if (await this.states.existsBy({ userId })) return;
		const user = await this.repository(MiUser).findOneByOrFail({ id: userId, host: IsNull() });
		await this.db.transaction(async manager => {
			await manager.insert(MiNoteCleanupState, { userId, migrated: false, keepDriveFiles: true, cursor: null, manualRequest: null });
			for (const input of initialCleanupRules(false, user.autoDeleteNotesAfterDays, user.autoDeleteKeepFavorites)) {
				await manager.insert(MiNoteCleanupRule, { ...input, id: this.idService.gen(), userId, lastError: null, protectionNotified: false, automaticConfirmed: false });
			}
		});
	}

	// 규칙·상태·구 설정 쓰기를 잠금을 가진 같은 연결의 한 트랜잭션으로 묶는다.
	private async atomic<T>(work: () => Promise<T>): Promise<T> {
		const run = (manager: EntityManager) => this.context.run(manager, work);
		const current = this.context.getStore();
		return current ? current.transaction(run) : this.db.transaction(run);
	}

	// 구 API가 명시한 필드에 해당하는 호환 규칙만 만들거나 바꾼다. 일반 규칙과 명시하지 않은 호환 규칙은 건드리지 않는다.
	// 반환값은 이번 호출이 규칙이나 구 설정을 실제로 바꿨는지다.
	private async writeLegacy(userId: string, updates: LegacyUpdates): Promise<boolean> {
		const inputs = initialCleanupRules(true, updates.autoDeleteNotesAfterDays ?? null, updates.autoDeleteKeepFavorites ?? false);
		let changed = false;
		for (const legacy of ['age', 'favorite'] as const) {
			const value = legacy === 'age' ? updates.autoDeleteNotesAfterDays : updates.autoDeleteKeepFavorites;
			if (value === undefined) continue;
			let existing = await this.rules.findOneBy({ userId, legacy });
			// 이전에 구 형식으로 표현할 수 없게 저장된 연결은 사용자 조건을 덮어쓰지 않도록 일반 규칙으로 분리한다.
			if (existing && legacyValue(existing) === undefined) {
				// 분리는 일반 규칙 수를 늘리므로 새 생성과 같은 수량 제한을 적용한다.
				if (await this.rules.countBy({ userId, legacy: IsNull() }) >= 32) throw new CleanupInputError('RULE_LIMIT');
				await this.rules.update(existing.id, { legacy: null });
				existing = null;
				changed = true;
			}
			const input = inputs.find(rule => rule.legacy === legacy);
			if (!input) {
				if (existing) {
					await this.rules.delete({ id: existing.id, userId });
					changed = true;
				}
				continue;
			}
			// 즐겨찾기 해제를 위해 꺼진 호환 규칙을 새로 만들지 않는다.
			if (!existing && !input.enabled) continue;
			const next = { ...existing, ...input, name: existing?.name ?? input.name, defaultName: existing ? existing.defaultName ?? null : input.defaultName, id: existing?.id ?? this.idService.gen(), userId,
				automaticConfirmed: existing?.automaticConfirmed || input.automatic, lastError: existing?.lastError ?? null,
			};
			if (!existing || canonicalJson(next) !== canonicalJson(existing)) changed = true;
			await this.rules.save(next);
		}
		if (Object.keys(updates).length) {
			const user = await this.repository(MiUser).findOneByOrFail({ id: userId });
			if ((updates.autoDeleteNotesAfterDays !== undefined && (user.autoDeleteNotesAfterDays ?? null) !== (updates.autoDeleteNotesAfterDays ?? null))
				|| (updates.autoDeleteKeepFavorites !== undefined && (user.autoDeleteKeepFavorites ?? false) !== updates.autoDeleteKeepFavorites)) changed = true;
			await this.repository(MiUser).update(userId, updates);
		}
		return changed;
	}

	public async updateLegacy(userId: string, updates: LegacyUpdates) {
		const days = updates.autoDeleteNotesAfterDays;
		// 구 설정 열은 정수 일수만 저장할 수 있다.
		if (days != null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new CleanupInputError('INVALID_VALUE', 'autoDeleteNotesAfterDays');
		return this.locked(userId, async () => {
			await this.initialize(userId);
			await this.atomic(async () => {
				// 실제 변경이 있을 때만 진행 중인 정리 순번을 초기화한다.
				if (await this.writeLegacy(userId, updates)) await this.states.update(userId, { cursor: null });
			});
		});
	}

	private async validate(userId: string, condition: unknown) {
		try { validateCleanupCondition(condition); } catch (error) { throw new CleanupInputError('INVALID_CONDITION', error instanceof CleanupConditionError ? error.path : 'condition'); }
		const references = cleanupReferences(condition);
		const clipIds = [...new Set(references.filter(r => r.type === 'clip').flatMap(r => r.ids))];
		const channelIds = [...new Set(references.filter(r => r.type === 'channel').flatMap(r => r.ids))];
		if (clipIds.length + channelIds.length > 128) throw new CleanupInputError('REFERENCE_LIMIT');
		const [clips, channels] = await Promise.all([
			clipIds.length ? this.repository(MiClip).find({ where: { id: In(clipIds) }, select: { id: true, userId: true } }) : [],
			channelIds.length ? this.repository(MiChannel).find({ where: { id: In(channelIds) }, select: { id: true } }) : [],
		]);
		for (const ref of references) for (const id of ref.ids) {
			if (ref.type === 'clip') {
				const clip = clips.find(c => c.id === id);
				if (!clip) throw new CleanupInputError('MISSING_CLIP', ref.path, id);
				if (clip.userId !== userId) throw new CleanupInputError('INVALID_CLIP', ref.path);
			} else if (!channels.some(c => c.id === id)) throw new CleanupInputError('MISSING_CHANNEL', ref.path, id);
		}
	}

	public async list(userId: string) {
		return this.locked(userId, async () => {
			await this.initialize(userId);
			const rules = await this.rules.find({ where: { userId }, order: { id: 'ASC' } });
			const prepared = await this.prepare(rules.filter(r => r.enabled), userId);
			for (const item of prepared) await this.notifyProtectionFailure(userId, item.rule.id);
			const refreshed = await this.rules.find({ where: { userId }, order: { id: 'ASC' } });
			const state = await this.states.findOneByOrFail({ userId });
			return { rules: refreshed.map(publicRule), blocked: refreshed.some(r => r.enabled && r.action === 'keep' && r.lastError !== null), keepDriveFiles: state.keepDriveFiles };
		});
	}

	// 드라이브 보존 설정은 정리 진행 커서와 무관하므로 커서를 초기화하지 않는다.
	public async updateSettings(userId: string, keepDriveFiles: boolean) {
		return this.locked(userId, async () => {
			await this.initialize(userId);
			await this.states.update(userId, { keepDriveFiles });
			return { keepDriveFiles };
		});
	}

	public async save(userId: string, input: CleanupRuleInput, ruleId?: string) {
		return this.locked(userId, async () => {
			await this.initialize(userId);
			const existing = ruleId ? await this.rules.findOneBy({ id: ruleId, userId }) : null;
			if (ruleId && !existing) throw new CleanupInputError('NO_SUCH_RULE', 'ruleId');
			if (!existing && await this.rules.countBy({ userId, legacy: IsNull() }) >= 32) throw new CleanupInputError('RULE_LIMIT');
			if ((input.name !== undefined && (!input.name.trim() || input.name.length > 128)) || (!ruleId && input.name === undefined)) throw new CleanupInputError('INVALID_NAME', 'name');
			const unchangedCondition = existing && input.action === existing.action && canonicalJson(input.condition) === canonicalJson(existing.condition);
			const stopping = unchangedCondition && (input.enabled === false || (input.action === 'delete' && input.automatic === false));
			if (!stopping) await this.validate(userId, input.condition);
			else {
				try { validateCleanupCondition(input.condition); } catch { throw new CleanupInputError('INVALID_CONDITION'); }
			}
			if (existing && input.enabled !== undefined && input.enabled !== existing.enabled && !input.confirmed) throw new CleanupInputError('CONFIRMATION_REQUIRED', 'confirmed');
			const automatic = input.automatic ?? existing?.automatic ?? false;
			if (input.action === 'keep' && automatic) throw new CleanupInputError('KEEP_CANNOT_RUN', 'automatic');
			// 계속 알아서 정리하기는 저장된 규칙의 미리 보기를 본 뒤 명시 확인(confirmed)으로만 처음 켤 수 있다.
			if (automatic && (!existing || !existing.automaticConfirmed) && !input.confirmed) throw new CleanupInputError('PREVIEW_REQUIRED', 'confirmed');
			// 이름·실행설정 저장은 미해결 알림을 보존한다. 조건·행동을 바꿔도 자료 확인 전에는 오류를 해제하지 않는다.
			const candidate = { ...existing, id: existing?.id ?? this.idService.gen(), userId, name: input.name ?? existing?.name, defaultName: input.name === undefined ? (existing?.defaultName && defaultNameAction(existing.defaultName) === input.action ? existing.defaultName : null) : null, action: input.action, condition: input.condition as CleanupCondition, enabled: input.enabled ?? existing?.enabled ?? true, automatic, automaticConfirmed: existing?.automaticConfirmed || automatic, lastError: existing?.lastError ?? null, legacy: existing?.legacy ?? null } as MiNoteCleanupRule;
			// 구 형식으로 정확히 표현할 수 없게 바뀐 호환 규칙은 조건·활성·자동 실행을 그대로 둔 일반 규칙으로 전환한다.
			const legacy = legacyValue(candidate);
			if (legacy === undefined) candidate.legacy = null;
			// 호환 규칙의 일반 규칙 전환은 일반 규칙 수를 늘리므로 새 생성과 같은 수량 제한을 적용한다.
			if (existing?.legacy && candidate.legacy === null && await this.rules.countBy({ userId, legacy: IsNull() }) >= 32) throw new CleanupInputError('RULE_LIMIT');
			return this.atomic(async () => {
				const rule = await this.rules.save(candidate);
				await this.states.update(userId, { cursor: null });
				if (existing?.legacy) await this.repository(MiUser).update(userId, legacyFields(existing.legacy, legacy ?? null));
				return { rule: publicRule(rule) };
			});
		});
	}

	public async remove(userId: string, ruleId: string) {
		return this.locked(userId, async () => {
			const rule = await this.rules.findOneBy({ id: ruleId, userId });
			if (!rule) throw new CleanupInputError('NO_SUCH_RULE', 'ruleId');
			await this.atomic(async () => {
				await this.rules.delete({ id: ruleId, userId });
				await this.states.update(userId, { cursor: null });
				if (rule.legacy) await this.repository(MiUser).update(userId, legacyFields(rule.legacy, null));
			});
		});
	}

	// 참조를 다시 검사해 사용자가 고칠 수 있는 오류만 저장한다. 검사가 성공하면 과거 오류를 해제한다.
	// 조회 자체가 실패하면 확인하지 못한 것이므로 오류를 바꾸지 않고 그대로 던져 작업 재시도로 넘긴다.
	private async prepare(rules: MiNoteCleanupRule[], userId: string): Promise<PreparedCleanupRule[]> {
		const result: PreparedCleanupRule[] = [];
		for (const rule of rules) {
			let failure: MiNoteCleanupRule['lastError'] = null;
			try {
				await this.validate(userId, rule.condition);
			} catch (e) {
				if (!(e instanceof CleanupInputError)) throw e;
				failure = { ruleId: rule.id, code: e.code, path: e.path, message: e.code, ...(e.referenceId ? { referenceType: e.code === 'MISSING_CLIP' ? 'clip' : 'channel', referenceId: e.referenceId } : {}) };
			}
			await this.storeFailure(userId, rule, failure);
			result.push({ rule, lastError: failure });
		}
		return result;
	}

	// 실제 자료로 규칙을 판정한다. 자료 조회 실패는 그대로 던져 묶음 전체를 실패시키고 커서는 진행하지 않는다.
	private async settle(userId: string, prepared: PreparedCleanupRule[], afterId?: string, limit = 100) {
		const query = this.repository(MiNote).createQueryBuilder('note').where('note.userId = :userId', { userId }).orderBy('note.id', 'ASC').take(limit);
		if (afterId) query.andWhere('note.id > :afterId', { afterId });
		const notes = await query.getMany();
		const dependencies = new Set(prepared.flatMap(p => cleanupDependencies(p.rule.condition)));
		const contexts = await this.contexts(userId, notes, dependencies);
		const rules: CleanupEvaluationRule[] = prepared.map(({ rule, lastError }) => ({ id: rule.id, action: rule.action, condition: rule.condition, error: lastError?.code }));
		const evaluations = decideCleanup(rules, contexts);
		// 저장된 오류가 없는 규칙의 판정 실패: 남기기는 묶음을 실패시키고, 지우기는 해당 규칙만 제외한다.
		const runtimeErrors = evaluations[0]?.errors.filter(e => !rules.find(r => r.id === e.ruleId)?.error) ?? [];
		for (const { rule } of prepared) {
			if (!runtimeErrors.some(e => e.ruleId === rule.id)) continue;
			if (rule.action === 'keep') throw new Error(`Cleanup keep rule evaluation failed (${rule.id})`);
			this.logger.error('Cleanup delete rule evaluation failed', { userId, ruleId: rule.id });
		}
		return { notes, evaluations, complete: notes.length < limit };
	}

	// 오류가 바뀌거나 해결되면 통지 접수를 초기화해 새 오류를 한 번 통지할 수 있게 한다.
	private async storeFailure(userId: string, rule: MiNoteCleanupRule, failure: MiNoteCleanupRule['lastError']) {
		if (canonicalJson(failure) === canonicalJson(rule.lastError)) return;
		await this.rules.update({ id: rule.id, userId }, { lastError: failure, protectionNotified: false });
		rule.lastError = failure;
		rule.protectionNotified = false;
	}

	// 보호 실패 최초 감지 시 한 번만 통지한다. 접수 비트를 먼저 남겨 드문 저장 실패의 유실은 허용하되 중복 발송은 막는다.
	private async notifyProtectionFailure(userId: string, ruleId: string) {
		try {
			const current = await this.rules.findOneBy({ id: ruleId, userId });
			if (!current?.enabled || current.action !== 'keep' || !current.lastError || current.protectionNotified) return;
			await this.rules.update({ id: ruleId, userId }, { protectionNotified: true });
			this.notificationService.createNotification(userId, 'noteCleanupProtectionFailed', { ruleId, errorCode: current.lastError.code });
		} catch (error) {
			this.logger.error('Cleanup protection notification failed', { error });
		}
	}

	// 판정에 필요한 자료만 조회한다. 조회 실패는 보호 오류로 기록하지 않고 그대로 던져 묶음 전체를 재시도하게 한다.
	private async contexts(userId: string, notes: MiNote[], dependencies: Set<string>): Promise<CleanupContext[]> {
		if (!notes.length) return [];
		const ids = notes.map(n => n.id);
		const fileIds = [...new Set(notes.flatMap(n => n.fileIds))];
		const [pins, favorites, reactions, renotes, polls, files, clips, bufferedReactions] = await Promise.all([
			dependencies.has('pinned') ? this.repository(MiUserNotePining).findBy({ userId, noteId: In(ids) }) : [],
			dependencies.has('favorite') ? this.repository(MiNoteFavorite).findBy({ userId, noteId: In(ids) }) : [],
			dependencies.has('selfReaction') ? this.repository(MiNoteReaction).findBy({ userId, noteId: In(ids) }) : [],
			dependencies.has('selfRenote') ? this.repository(MiNote).createQueryBuilder('renote').select('DISTINCT renote.renoteId', 'renoteId').where('renote.userId = :userId AND renote.renoteId IN (:...ids)', { userId, ids }).andWhere('renote.text IS NULL AND renote.cw IS NULL AND renote.replyId IS NULL AND renote.hasPoll = false AND cardinality(renote.fileIds) = 0').getRawMany<{ renoteId: string }>() : [],
			dependencies.has('poll') ? this.repository(MiPoll).findBy({ noteId: In(ids) }) : [],
			dependencies.has('files') && fileIds.length ? this.repository(MiDriveFile).findBy({ id: In(fileIds) }) : [],
			dependencies.has('clip') ? this.repository(MiClipNote).createQueryBuilder('link').innerJoin(MiClip, 'clip', 'clip.id = link.clipId AND clip.userId = :userId', { userId }).where('link.noteId IN (:...ids)', { ids }).getMany() : [],
			dependencies.has('reactions') && this.meta.enableReactionsBuffering ? this.reactionsBufferingService.getMany(ids) : new Map<string, { deltas: Record<string, number>; pairs: [string, string][] }>(),
		]);
		const reactionCounts = new Map(notes.map(note => {
			const merged = this.reactionsBufferingService.mergeReactions(note.reactions, bufferedReactions.get(note.id)?.deltas ?? {});
			if (Object.values(merged).some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error(`Invalid cleanup reaction count (${note.id})`);
			return [note.id, Object.values(merged).reduce((a, b) => a + b, 0)] as const;
		}));
		const now = Date.now();
		return notes.map(note => ({ text: note.text, cw: note.cw, poll: polls.find(p => p.noteId === note.id)?.choices ?? [], fileComment: files.filter(f => note.fileIds.includes(f.id)).map(f => f.comment ?? ''), fileName: files.filter(f => note.fileIds.includes(f.id)).map(f => f.name), age: (now - this.idService.parse(note.id).date.getTime()) / 1000, reactions: reactionCounts.get(note.id)!, renotes: note.renoteCount,
			flags: { pinned: pins.some(p => p.noteId === note.id), favorite: favorites.some(f => f.noteId === note.id), selfReaction: reactions.some(r => r.noteId === note.id), selfRenote: renotes.some(r => r.renoteId === note.id), reply: note.replyId !== null, quote: isRenote(note) && isQuote(note), poll: note.hasPoll, files: note.fileIds.length > 0, cw: note.cw !== null, localOnly: note.localOnly }, visibility: note.visibility, channelId: note.channelId, clipIds: clips.filter(c => c.noteId === note.id).map(c => c.clipId), tags: note.tags,
		}));
	}

	private async page(userId: string, ruleIds: string[], afterId?: string, limit = 100) {
		const all = await this.rules.find({ where: { userId }, order: { id: 'ASC' } });
		if (!ruleIds.length || ruleIds.length > 34 || ruleIds.some(id => !all.some(r => r.id === id && r.action === 'delete' && r.enabled))) throw new CleanupInputError('INVALID_RULE_SELECTION', 'ruleIds');
		const active = all.filter(r => r.enabled && (r.action === 'keep' || ruleIds.includes(r.id)));
		const prepared = await this.prepare(active, userId);
		// 목록 밖의 경로(미리 보기·정리 회차)에서 처음 확인한 보호 오류도 한 번 알린다.
		for (const item of prepared) await this.notifyProtectionFailure(userId, item.rule.id);
		const { notes, evaluations, complete } = await this.settle(userId, prepared, afterId, limit);
		// 규칙 오류는 저장된 lastError로 응답 최상위 errors에 규칙별로 모두 실리고 항목은 blocked로 판정되므로, 항목에는 공개 스키마의 판정 필드만 담는다.
		const items = notes.map((note, i) => {
			const { keepRuleIds, deleteRuleIds, decision, reason } = evaluations[i];
			return { noteId: note.id, text: note.text, cw: note.cw, createdAt: this.idService.parse(note.id).date.toISOString(), keepRuleIds, deleteRuleIds, decision, reason };
		});
		return { all, notes, items, scanned: notes.length, deleteCount: items.filter(i => i.decision === 'delete').length, nextCursor: notes.at(-1)?.id ?? null, complete, errors: (await this.rules.findBy({ userId })).filter(r => active.some(a => a.id === r.id) && r.lastError).map(r => r.lastError!) };
	}

	// 미리 보기는 지워질 노트만 돌려준다. 판정은 실제 정리와 같은 규칙을 쓴다.
	public async preview(userId: string, ruleIds: string[], afterId?: string, limit = 100) {
		return this.locked(userId, async () => {
			await this.initialize(userId);
			const { all, notes, items, nextCursor, complete, errors } = await this.page(userId, ruleIds, afterId, limit);
			return { notes: notes.filter((_, i) => items[i].decision === 'delete'), nextCursor, complete, errors, rules: all.map(r => ({ id: r.id, name: r.name, defaultName: r.defaultName, action: r.action })) };
		});
	}

	public async request(userId: string, ruleIds: string[]) {
		return this.locked(userId, async () => {
			await this.initialize(userId);
			// 소유권과 활성 지우기 규칙 선택만 확인하고 접수한다. 판정은 큐의 정리 작업이 한다.
			const all = await this.rules.findBy({ userId });
			if (!ruleIds.length || ruleIds.length > 34 || ruleIds.some(id => !all.some(r => r.id === id && r.action === 'delete' && r.enabled))) throw new CleanupInputError('INVALID_RULE_SELECTION', 'ruleIds');
			const jobId = noteCleanupRequestJobId(userId);
			const state = await this.states.findOneByOrFail({ userId });
			// 대기 마커가 있으면 규칙 조합이 달라도 중복 접수하지 않는다.
			if (state.manualRequest) return { queued: false, jobId };
			// 마커를 먼저 남겨 큐 등록이 실패해도 자동 회차가 요청을 이어받게 한다.
			await this.states.update(userId, { manualRequest: { ruleIds, cursor: null } });
			// 깨우기 작업은 완료 뒤 자동 제거하고, 실패 이력은 보존 기한 뒤 자동 제거한다.
			await this.queueService.systemQueue.add('autoDeleteNotes', { userId, manual: true }, { jobId, removeOnComplete: true, removeOnFail: { age: 7 * 86400 }, attempts: 10, backoff: { type: 'fixed', delay: 5000 } });
			return { queued: true, jobId };
		});
	}

	// 수동 요청의 대기 마커를 한 페이지 이어 처리한다. 완료면 마커를 지우고, 일시 실패는 마커를 보존해 다음 회차가 잇는다.
	// 비재시도 오류는 마커를 지우고 종료 실패로 처리해 무한 재시도를 막는다.
	public async continueManual(userId: string) {
		return this.locked(userId, async () => {
			const state = await this.states.findOneByOrFail({ userId });
			const marker = state.manualRequest;
			if (!marker) return done();
			try {
				const result = await this.processUserLocked(userId, marker.ruleIds, marker.cursor ?? undefined);
				await this.states.update(userId, { manualRequest: result.complete ? null : { ruleIds: marker.ruleIds, cursor: result.cursor || marker.cursor } });
				return result;
			} catch (error) {
				if (!isRetryableCleanupFailure(error)) await this.states.update(userId, { manualRequest: null });
				throw error;
			}
		});
	}

	// 전역 키와 계정 키를 한 번의 Lua 실행으로 함께 확인·증가시킨다(원자적 예약).
	// 반환: 허용량(1 이상), 또는 한도가 찬 첫 키의 번호를 음수로(-1 전역, -2 계정).
	private async reserveBudget(kind: 'scan' | 'delete', userId: string, want: number): Promise<CleanupReservation> {
		const window = Math.floor(Date.now() / NOTE_CLEANUP_LIMITS.windowMs);
		// 같은 창의 키는 해시 태그를 공유해 Redis 클러스터에서도 한 슬롯에 놓이게 한다.
		const keys = [`global`, `user:${userId}`].map(scope => this.queueService.systemQueue.toKey(`note-cleanup-budget:{${window}}:${kind}:${scope}`));
		const limits = kind === 'scan' ? [NOTE_CLEANUP_LIMITS.globalScan, NOTE_CLEANUP_LIMITS.userScan] : [NOTE_CLEANUP_LIMITS.globalDelete, NOTE_CLEANUP_LIMITS.userDelete];
		const result = Number(await this.redis.eval(RESERVE_SCRIPT, keys.length, ...keys, want, NOTE_CLEANUP_LIMITS.ttlSeconds, ...limits));
		if (result > 0) return { amount: Math.min(result, want), exhausted: null };
		return { amount: 0, exhausted: result === -2 ? 'account' : 'global' };
	}

	// 회차 한 번에 계정마다 한 페이지(검사 최대 pageSize, 삭제 시도 최대 deleteChunk)만 처리한다.
	// 예약한 예산은 실제 사용량과 무관하게 전액 소비한다.
	public async processUser(userId: string, ruleIds?: string[], afterId?: string) {
		return this.locked(userId, () => this.processUserLocked(userId, ruleIds, afterId));
	}

	// 이미 계정 잠금을 가진 경로(수동 마커 이어 처리)에서 쓰는 본체. 잠금을 중첩하지 않는다.
	private async processUserLocked(userId: string, ruleIds?: string[], afterId?: string) {
		await this.initialize(userId);
		const state = await this.states.findOneByOrFail({ userId });
		const user = await this.repository(MiUser).findOneByOrFail({ id: userId, host: IsNull() });
		const selected = ruleIds ?? (await this.rules.findBy({ userId, enabled: true, action: 'delete', automatic: true })).map(r => r.id);
		if (!selected.length) return done();
		// 큐 등록 후 비활성화된 규칙은 이후 새 판정에 참여하지 않는다.
		const current = (await this.rules.findBy({ userId, enabled: true, action: 'delete' })).filter(r => selected.includes(r.id)).map(r => r.id);
		if (!current.length) return done();
		const cursor = (ruleIds ? afterId : state.cursor) || undefined;
		const scan = await this.reserveBudget('scan', userId, NOTE_CLEANUP_LIMITS.pageSize);
		// 전역 한도가 찬 경우에는 이 계정 탓이 아니므로 자동 순번을 그대로 둔다.
		if (!ruleIds && scan.exhausted !== 'global') await this.states.update(userId, { lastRunAt: new Date() });
		if (scan.exhausted) return { ...done(), complete: false, cursor: cursor ?? '', throttled: scan.exhausted };
		const page = await this.page(userId, current, cursor, scan.amount);
		if (page.items.some(i => i.reason === 'blocked') || page.errors.some(e => activeKeep(e.ruleId, page.all))) return done();
		// 지울 노트가 있을 때만 그 수만큼 삭제 예산을 예약한다. 보존만 하는 페이지는 삭제 예산을 쓰지 않는다.
		const candidates = page.items.filter(i => i.decision === 'delete').length;
		const removal = candidates ? await this.reserveBudget('delete', userId, Math.min(candidates, NOTE_CLEANUP_LIMITS.deleteChunk)) : null;
		let failed = 0;
		const removedFileIds: string[] = [];
		const result = await runCleanupBatch(page.items.map(i => ({ id: i.noteId, decision: i.decision })), removal?.amount ?? 0, async id => {
			let note: MiNote | null;
			try {
				note = await this.repository(MiNote).findOneBy({ id, userId });
			} catch (error) {
				throw new CleanupNoteLookupError(error);
			}
			if (!note) return false;
			await this.noteDeleteService.delete(user, note, false);
			removedFileIds.push(...note.fileIds);
			return true;
		}, (noteId, error) => {
			// 수동 요청은 노트 조회 실패와 재시도 가능한 삭제 실패를 묶음 실패로 올린다. 일시 실패는 마커를 보존해 잇고, 비재시도 오류는 마커를 지워 무한 재시도를 막는다.
			if (ruleIds && (error instanceof CleanupNoteLookupError || isRetryableCleanupFailure(error))) throw error;
			// 자동 회차와 지속 삭제 실패는 한 노트의 실패가 뒤 노트와 다른 계정을 멈추지 않게 한다. 커서가 지나가므로 다음 순회에서 다시 검사된다.
			failed++;
			this.logger.error('Cleanup note deletion failed', { userId, noteId, error });
		});
		// 실제로 지운 노트의 첨부만 대상으로 삼는다. 삭제에 실패한 노트의 첨부는 건드리지 않는다.
		if (state.keepDriveFiles === false && removedFileIds.length) await this.deleteUnusedAttachments(userId, user, removedFileIds);
		const complete = page.complete && result.examined === page.scanned;
		// 첫 노트부터 삭제 예산이 없어 하나도 지나지 못했으면 기존 커서를 유지한다.
		const next = result.cursor ?? cursor ?? null;
		if (!ruleIds) await this.states.update(userId, { cursor: complete ? null : next });
		const throttled = !complete && removal?.exhausted && result.examined < page.scanned ? removal.exhausted : undefined;
		return { deleted: result.deleted, failed, examined: result.examined, complete, cursor: complete ? null : next ?? '', throttled };
	}

	// 지운 노트의 첨부 중 어디에서도 쓰지 않는 파일만 지운다(drive/files/delete-bulk와 같은 판정).
	// 파일 삭제 실패는 로그만 남기고 노트 정리 결과에는 영향을 주지 않는다.
	private async deleteUnusedAttachments(userId: string, user: MiUser, fileIds: string[]) {
		try {
			const query = this.repository(MiDriveFile).createQueryBuilder('file')
				.andWhere('file.id IN (:...fileIds)', { fileIds: [...new Set(fileIds)] });
			this.driveFileUsageService.applyUnusedFilter(query, userId);
			const files = await query.getMany();
			const limit = promiseLimit<void>(4);
			await Promise.all(files.map(file => limit(async () => {
				try {
					await this.driveService.deleteFile(file, false, user);
				} catch (error) {
					this.logger.error('Cleanup drive file deletion failed', { userId, fileId: file.id, error });
				}
			})));
		} catch (error) {
			this.logger.error('Cleanup drive file lookup failed', { userId, error });
		}
	}

	// 자동 회차에서 계정 처리에 실패하면 순번을 뒤로 보내, 실패 계정이 오래된 lastRunAt으로 매번 앞자리를 차지하지 않게 한다.
	public async deferUser(userId: string) {
		await this.states.update(userId, { lastRunAt: new Date() });
	}

	// 수동 대기 마커가 있는 계정 목록. 자동 회차가 먼저 처리하고 남은 몫만 자동 검사에 쓴다.
	public async manualUsers(): Promise<string[]> {
		return (await this.states.createQueryBuilder('state').where('state.manualRequest IS NOT NULL').orderBy('state.lastRunAt', 'ASC').addOrderBy('state.userId', 'ASC').take(NOTE_CLEANUP_LIMITS.roundUsers).getMany()).map(s => s.userId);
	}

	public async automaticUsers(limit: number = NOTE_CLEANUP_LIMITS.roundUsers): Promise<string[]> {
		return (await this.states.createQueryBuilder('state').where('EXISTS (SELECT 1 FROM note_cleanup_rule rule WHERE rule."userId" = state."userId" AND rule.enabled = true AND rule.automatic = true AND rule.action = :action)', { action: 'delete' }).orderBy('state.lastRunAt', 'ASC').addOrderBy('state.userId', 'ASC').take(limit).getMany()).map(s => s.userId);
	}
}

// 수동 요청의 깨우기 작업 ID. 계정당 하나만 존재해 대기 중 중복 접수를 막는다.
export function noteCleanupRequestJobId(userId: string) {
	return `note-cleanup-${userId}`;
}

// 정리 처리량 상한. 예약 창(windowMs)마다 전역과 계정별로 따로 센다.
export const NOTE_CLEANUP_LIMITS = {
	windowMs: 300000,
	// 창 키는 창이 끝난 뒤에도 잠시 남아 키 만료가 창보다 먼저 일어나지 않게 한다.
	ttlSeconds: 600,
	globalScan: 12000,
	userScan: 1200,
	globalDelete: 300,
	userDelete: 60,
	// 한 번의 처리에서 판정하는 노트 수와 삭제 시도 수
	pageSize: 100,
	deleteChunk: 5,
	// 자동 회차 하나의 계정 수와 시간 상한(system 큐 점유 제한)
	roundUsers: 60,
	roundMs: 60000,
} as const;

type CleanupReservation = { amount: number; exhausted: 'global' | 'account' | null };
type CleanupProcessResult = { deleted: number; failed: number; examined: number; complete: boolean; cursor: string | null; throttled?: 'global' | 'account' };

function done(): CleanupProcessResult {
	return { deleted: 0, failed: 0, examined: 0, complete: true, cursor: null };
}

// KEYS: 한도를 함께 적용할 키들, ARGV: 원하는 양, TTL(초), 키별 한도
const RESERVE_SCRIPT = `
local grant = tonumber(ARGV[1])
for i = 1, #KEYS do
	local left = tonumber(ARGV[i + 2]) - tonumber(redis.call('GET', KEYS[i]) or '0')
	if left <= 0 then return -i end
	if left < grant then grant = left end
end
for i = 1, #KEYS do
	redis.call('INCRBY', KEYS[i], grant)
	redis.call('EXPIRE', KEYS[i], ARGV[2])
end
return grant
`;

// 기본 이름이 뜻하는 자연스러운 행동. 기간은 지우기, 나머지 기본 보호는 남기기다.
function defaultNameAction(name: NonNullable<MiNoteCleanupRule['defaultName']>): 'keep' | 'delete' {
	return name === 'age' ? 'delete' : 'keep';
}

// 호환 규칙이 구 설정으로 정확히 표현되면 그 값을, 표현할 수 없으면 undefined를 돌려준다.
// 기간은 정수 일수의 gt 지우기, 즐겨찾기는 favorite=true 남기기만 표현할 수 있다. 꺼지거나 자동 실행을 멈춘 상태는 비활성 값(null/false)이다.
function legacyValue(rule: Pick<MiNoteCleanupRule, 'legacy' | 'action' | 'condition' | 'enabled' | 'automatic'>): number | boolean | null | undefined {
	const c = rule.condition;
	if (rule.legacy === 'age') {
		const days = c.type === 'age' && c.operator === 'gt' ? c.seconds / 86400 : NaN;
		if (rule.action !== 'delete' || !Number.isInteger(days) || days < 1 || days > 3650) return undefined;
		return rule.enabled && rule.automatic ? days : null;
	}
	if (rule.legacy === 'favorite') {
		if (rule.action !== 'keep' || c.type !== 'flag' || c.field !== 'favorite' || c.value !== true) return undefined;
		return rule.enabled;
	}
	return undefined;
}

// 표현할 수 없게 되면 value=null로 불러 안전한 비활성 값을 쓴다.
function legacyFields(legacy: 'age' | 'favorite', value: number | boolean | null): Partial<Pick<MiUser, 'autoDeleteNotesAfterDays' | 'autoDeleteKeepFavorites'>> {
	return legacy === 'age' ? { autoDeleteNotesAfterDays: typeof value === 'number' ? value : null } : { autoDeleteKeepFavorites: value === true };
}

function activeKeep(id: string, rules: MiNoteCleanupRule[]) { return rules.some(r => r.id === id && r.action === 'keep' && r.enabled); }

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => {
		if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
		return item;
	});
}

function publicRule(rule: MiNoteCleanupRule) {
	const { protectionNotified, ...visible } = rule;
	return visible;
}
