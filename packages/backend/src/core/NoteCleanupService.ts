/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type * as Redis from 'ioredis';
import { DataSource, In, IsNull } from 'typeorm';
import type { EntityManager, EntityTarget, ObjectLiteral, Repository, QueryRunner, SelectQueryBuilder } from 'typeorm';
import Logger from '@/logger.js';
import { DI } from '@/di-symbols.js';
import { MiNoteCleanupRule, MiNoteCleanupState } from '@/models/NoteCleanupRule.js';
import { MiNote, MiUser, MiClip, MiClipNote, MiChannel, MiPoll, MiDriveFile, MiNoteFavorite, MiNoteReaction, MiUserNotePining } from '@/models/_.js';
import { QueueService } from '@/core/QueueService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { ReactionsBufferingService } from '@/core/ReactionsBufferingService.js';
import type { MiMeta } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { isQuote, isRenote } from '@/misc/is-renote.js';
import { CleanupConditionError, cleanupReferences, decideCleanup, validateCleanupCondition } from './NoteCleanupCondition.js';
import type { CleanupCondition, CleanupContext, CleanupEvaluationRule } from './NoteCleanupCondition.js';
import { runCleanupBatch, initialCleanupRules } from './NoteCleanupRunner.js';

export class CleanupInputError extends Error {
	constructor(public code: string, public path = 'condition', public referenceId?: string) { super(code); }
}
// recheck: 이번 참조 검사는 성공했지만 저장된 과거 오류가 있어 자료 확인 뒤에만 해제할 수 있는 규칙
type PreparedCleanupRule = { rule: MiNoteCleanupRule; lastError: MiNoteCleanupRule['lastError']; recheck: boolean };
type CleanupScanConsumption = { used: number; pending: boolean };
type LegacyUpdates = { autoDeleteNotesAfterDays?: number | null; autoDeleteKeepFavorites?: boolean };
export type CleanupRuleInput = { name?: string; action: 'keep' | 'delete'; condition: unknown; enabled?: boolean; automatic?: boolean; confirmed?: boolean; previewToken?: string };

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
		this.activeLocks++;
		const runner = this.db.createQueryRunner('master');
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
			await manager.insert(MiNoteCleanupState, { userId, migrated: false, cursor: null, previewAt: null, previewToken: null });
			for (const input of initialCleanupRules(false, user.autoDeleteNotesAfterDays, user.autoDeleteKeepFavorites)) {
				await manager.insert(MiNoteCleanupRule, { ...input, id: this.idService.gen(), userId, lastError: null, automaticConfirmed: false });
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
	private async writeLegacy(userId: string, updates: LegacyUpdates) {
		const inputs = initialCleanupRules(true, updates.autoDeleteNotesAfterDays ?? null, updates.autoDeleteKeepFavorites ?? false);
		for (const legacy of ['age', 'favorite'] as const) {
			const value = legacy === 'age' ? updates.autoDeleteNotesAfterDays : updates.autoDeleteKeepFavorites;
			if (value === undefined) continue;
			let existing = await this.rules.findOneBy({ userId, legacy });
			// 이전에 구 형식으로 표현할 수 없게 저장된 연결은 사용자 조건을 덮어쓰지 않도록 일반 규칙으로 분리한다.
			if (existing && legacyValue(existing) === undefined) {
				await this.rules.update(existing.id, { legacy: null });
				existing = null;
			}
			const input = inputs.find(rule => rule.legacy === legacy);
			if (!input) {
				if (existing) await this.rules.delete({ id: existing.id, userId });
				continue;
			}
			// 즐겨찾기 해제를 위해 꺼진 호환 규칙을 새로 만들지 않는다.
			if (!existing && !input.enabled) continue;
			await this.rules.save({ ...existing, ...input, name: existing?.name ?? input.name, defaultName: existing ? existing.defaultName ?? null : input.defaultName, id: existing?.id ?? this.idService.gen(), userId,
				automaticConfirmed: existing?.automaticConfirmed || input.automatic, lastError: existing?.lastError ?? null,
			});
		}
		if (Object.keys(updates).length) await this.repository(MiUser).update(userId, updates);
	}

	public async updateLegacy(userId: string, updates: LegacyUpdates) {
		const days = updates.autoDeleteNotesAfterDays;
		// 구 설정 열은 정수 일수만 저장할 수 있다.
		if (days != null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new CleanupInputError('INVALID_VALUE', 'autoDeleteNotesAfterDays');
		return this.locked(userId, async () => {
			await this.initialize(userId);
			await this.atomic(async () => {
				await this.writeLegacy(userId, updates);
				await this.states.update(userId, { cursor: null, previewToken: null });
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

	private fingerprint(rules: MiNoteCleanupRule[], ruleIds: string[]) {
		return createHash('sha256').update(canonicalJson({ rules: rules.map(r => [r.id, r.name, r.action, r.enabled, r.condition]), ruleIds: [...ruleIds].sort() })).digest('hex');
	}

	public async list(userId: string) {
		return this.locked(userId, async () => {
			await this.initialize(userId);
			const rules = await this.rules.find({ where: { userId }, order: { id: 'ASC' } });
			const prepared = await this.prepare(rules.filter(r => r.enabled), userId);
			// 다시 불러오기에서도 자료를 확인한 경우에만 과거 오류를 해제한다. 확인에 실패하면 저장된 오류로 계속 막는다.
			if (prepared.some(p => p.recheck)) {
				try { await this.recover(userId, prepared); } catch (error) { this.logger.error('Cleanup data recheck failed', { error }); }
			}
			for (const item of prepared) await this.notifyProtectionFailure(userId, item.rule.id);
			const refreshed = await this.rules.find({ where: { userId }, order: { id: 'ASC' } });
			return { rules: refreshed.map(publicRule), blocked: refreshed.some(r => r.enabled && r.action === 'keep' && r.lastError !== null), migrated: (await this.states.findOneByOrFail({ userId })).migrated };
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
			if (automatic && !existing) throw new CleanupInputError('PREVIEW_REQUIRED', 'previewToken');
			if (automatic && !existing?.automaticConfirmed) {
				const state = await this.states.findOneByOrFail({ userId });
				const rules = await this.rules.find({ where: { userId }, order: { id: 'ASC' } });
				if (!existing || !state.previewAt || Date.now() - state.previewAt.getTime() > 600000 || !input.previewToken || state.previewToken !== input.previewToken || input.previewToken !== this.fingerprint(rules, [existing.id]) || canonicalJson(input.condition) !== canonicalJson(existing.condition) || input.action !== existing.action) throw new CleanupInputError('PREVIEW_REQUIRED', 'previewToken');
			}
			// 이름·실행설정 저장은 미해결 알림을 보존한다. 조건·행동을 바꿔도 자료 확인(settle) 전에는 오류를 해제하지 않는다.
			const candidate = { ...existing, id: existing?.id ?? this.idService.gen(), userId, name: input.name ?? existing?.name, defaultName: input.name === undefined ? existing?.defaultName ?? null : null, action: input.action, condition: input.condition as CleanupCondition, enabled: input.enabled ?? existing?.enabled ?? true, automatic, automaticConfirmed: existing?.automaticConfirmed || automatic, lastError: existing?.lastError ?? null, legacy: existing?.legacy ?? null } as MiNoteCleanupRule;
			// 구 형식으로 정확히 표현할 수 없게 바뀐 호환 규칙은 조건·활성·자동 실행을 그대로 둔 일반 규칙으로 전환한다.
			const legacy = legacyValue(candidate);
			if (legacy === undefined) candidate.legacy = null;
			return this.atomic(async () => {
				const rule = await this.rules.save(candidate);
				await this.states.update(userId, { cursor: null, previewToken: null });
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
				await this.states.update(userId, { cursor: null, previewToken: null });
				if (rule.legacy) await this.repository(MiUser).update(userId, legacyFields(rule.legacy, null));
			});
			try { await this.notificationService.deleteNoteCleanupProtectionMarker(userId, ruleId); } catch (error) { this.logger.error('Cleanup protection notification marker deletion failed', { error }); }
		});
	}

	// 참조를 다시 검사하고 규칙별 현재 오류를 저장한다.
	// 자료 오류의 과거 범위는 참조 검사가 성공해도 보존하고 recover()에서 같은 범위를 확인한 뒤 해제한다.
	private async prepare(rules: MiNoteCleanupRule[], userId: string): Promise<PreparedCleanupRule[]> {
		const result: PreparedCleanupRule[] = [];
		for (const rule of rules) {
			let failure = rule.lastError;
			let recheck = false;
			try {
				await this.validate(userId, rule.condition);
				recheck = rule.lastError !== null;
			} catch (e) {
				// 이번 참조 조회가 일시 실패하면 확인하지 못한 것이므로 저장된 오류를 그대로 유지한다.
				if (e instanceof CleanupInputError || rule.lastError === null) {
					const code = e instanceof CleanupInputError ? e.code : 'TEMPORARY_FAILURE';
					const referenceId = e instanceof CleanupInputError ? e.referenceId : undefined;
					failure = { recovery: { ...rule.lastError?.recovery, source: 'reference' }, ruleId: rule.id, code, path: e instanceof CleanupInputError ? e.path : 'condition', message: code, userActionable: code !== 'TEMPORARY_FAILURE', ...(referenceId ? { referenceType: code === 'MISSING_CLIP' ? 'clip' : 'channel', referenceId } : {}) };
				}
			}
			await this.storeFailure(userId, rule, failure);
			result.push({ rule, lastError: failure, recheck });
		}
		return result;
	}

	// 오류가 난 자료 범위만 다시 확인한다.
	// 페이지 일부 또는 전부가 삭제됐어도 원래 범위를 조회한 결과로 판정하며, 무관한 첫 페이지는 회복 근거로 쓰지 않는다.
	private async recover(userId: string, prepared: PreparedCleanupRule[], consumption?: CleanupScanConsumption) {
		for (const item of prepared.filter(p => p.recheck && p.lastError)) {
			const { rule, lastError } = item;
			const recovery = lastError!.recovery;
			// 실패 범위가 없는 오류는 참조 오류뿐이며, prepare의 같은 참조 검사가 성공한 것으로 원인이 해결됐다.
			if (!recovery.noteIds) {
				await this.storeFailure(userId, rule, null);
				item.lastError = null;
				item.recheck = false;
				continue;
			}
			const query = this.repository(MiNote).createQueryBuilder('note').where('note.userId = :userId', { userId }).andWhere('note.id IN (:...ids)', { ids: recovery.noteIds }).orderBy('note.id', 'ASC').take(100);
			const notes = await this.scanNotes(query, consumption);
			const contexts = await this.contexts(userId, notes);
			const evaluation = decideCleanup([{ id: rule.id, action: rule.action, condition: rule.condition }], contexts);
			if (evaluation[0]?.errors.length) {
				// 참조가 복원돼도 함께 남아 있던 자료 오류는 같은 범위에서 계속 확인한다.
				const failure = { ...lastError!, code: 'TEMPORARY_FAILURE', path: 'condition', message: 'TEMPORARY_FAILURE', userActionable: false, referenceType: undefined, referenceId: undefined, recovery: { source: 'data' as const, noteIds: notes.map(n => n.id) } };
				await this.storeFailure(userId, rule, failure);
				item.lastError = failure;
			} else {
				await this.storeFailure(userId, rule, null);
				item.lastError = null;
			}
			item.recheck = false;
		}
	}

	// 조회 실패는 실제 소비량을 확정할 수 없으므로 예약 상한을 유지한다.
	// 조회 성공 뒤 판정이 실패해도 이미 불러온 자료의 검사 비용은 보존한다.
	private async scanNotes(query: SelectQueryBuilder<MiNote>, consumption?: CleanupScanConsumption) {
		if (consumption) consumption.pending = true;
		const notes = await query.getMany();
		if (consumption) {
			consumption.used += notes.length;
			consumption.pending = false;
		}
		return notes;
	}

	// 실제 자료로 규칙을 판정하고, 이번 판정 결과에 따라서만 저장된 오류를 갱신한다.
	private async settle(userId: string, prepared: PreparedCleanupRule[], afterId?: string, limit = 100, consumption?: CleanupScanConsumption) {
		try {
			await this.recover(userId, prepared, consumption);
		} finally {
			for (const item of prepared) await this.notifyProtectionFailure(userId, item.rule.id);
		}
		const query = this.repository(MiNote).createQueryBuilder('note').where('note.userId = :userId', { userId }).orderBy('note.id', 'ASC').take(limit);
		if (afterId) query.andWhere('note.id > :afterId', { afterId });
		const notes = await this.scanNotes(query, consumption);
		let contexts: CleanupContext[];
		try { contexts = await this.contexts(userId, notes); } catch (error) {
			for (const { rule } of prepared.filter(p => p.rule.action === 'keep' && p.lastError === null)) await this.recordTemporaryFailure(userId, rule, notes);
			throw error;
		}
		const rules: CleanupEvaluationRule[] = prepared.map(({ rule, lastError }) => ({ id: rule.id, action: rule.action, condition: rule.condition, error: lastError?.code }));
		const evaluations = decideCleanup(rules, contexts);
		const runtimeErrors = evaluations[0]?.errors.filter(e => !rules.find(r => r.id === e.ruleId)?.error) ?? [];
		for (const { rule, lastError } of prepared) {
			if (lastError === null && runtimeErrors.some(e => e.ruleId === rule.id)) await this.recordTemporaryFailure(userId, rule, notes);
		}
		return { notes, evaluations };
	}

	private async recordTemporaryFailure(userId: string, rule: MiNoteCleanupRule, notes: MiNote[]) {
		await this.storeFailure(userId, rule, { ruleId: rule.id, code: 'TEMPORARY_FAILURE', path: 'condition', message: 'TEMPORARY_FAILURE', userActionable: false, recovery: { source: 'data', noteIds: notes.map(n => n.id) } });
		await this.notifyProtectionFailure(userId, rule.id);
	}

	// 구 형식의 오류만 있는 행도 다음 기존 검사에서 한 번 접수를 확인한다.
	// 해결 시 세대 번호는 남겨 같은 오류의 재발을 과거 접수 결과와 구분한다.
	private async storeFailure(userId: string, rule: MiNoteCleanupRule, failure: MiNoteCleanupRule['lastError']) {
		const previous = rule.protectionNotification ?? null;
		const identity = rule.action === 'keep' && failure ? canonicalJson(publicError(failure)) : null;
		const protectionNotification: MiNoteCleanupRule['protectionNotification'] = identity === null
			? previous ? { generation: previous.generation, identity: null, status: 'resolved' } : null
			: previous?.identity === identity ? previous : { generation: (previous?.generation ?? 0) + 1, identity, status: 'pending' };
		if (canonicalJson(failure) !== canonicalJson(rule.lastError) || canonicalJson(previous) !== canonicalJson(protectionNotification)) {
			await this.rules.update({ id: rule.id, userId }, { lastError: failure, protectionNotification });
		}
		rule.lastError = failure;
		rule.protectionNotification = protectionNotification;
	}

	private async notifyProtectionFailure(userId: string, ruleId: string) {
		try {
			const current = await this.rules.findOneBy({ id: ruleId, userId });
			const pending = current?.protectionNotification;
			if (!current?.enabled || current.action !== 'keep' || !current.lastError || pending?.status !== 'pending' || pending.identity !== canonicalJson(publicError(current.lastError))) return;
			const status = await this.notificationService.createNoteCleanupProtectionNotification(userId, { ruleId, errorCode: current.lastError.code }, pending.generation);
			// 늦은 결과는 같은 소유자의 같은 세대 접수 상태만 바꿀 수 있다.
			await this.rules.update({ id: ruleId, userId, protectionNotification: pending }, { protectionNotification: { ...pending, status } });
		} catch (error) {
			this.logger.error('Cleanup protection notification acceptance failed', { error });
		}
	}

	private async contexts(userId: string, notes: MiNote[]): Promise<CleanupContext[]> {
		if (!notes.length) return [];
		const ids = notes.map(n => n.id);
		const fileIds = [...new Set(notes.flatMap(n => n.fileIds))];
		const errors: Record<string, string> = {};
		const guarded = async <T>(source: string, value: Promise<T> | T, fallback: T): Promise<T> => {
			try { return await value; } catch (error) {
				this.logger.error(`Cleanup data lookup failed (${source})`, { error });
				errors[source] = 'TEMPORARY_FAILURE';
				return fallback;
			}
		};
		const [pins, favorites, reactions, renotes, polls, files, clips, bufferedReactions] = await Promise.all([
			guarded('pinned', this.repository(MiUserNotePining).findBy({ userId, noteId: In(ids) }), []),
			guarded('favorite', this.repository(MiNoteFavorite).findBy({ userId, noteId: In(ids) }), []),
			guarded('selfReaction', this.repository(MiNoteReaction).findBy({ userId, noteId: In(ids) }), []),
			guarded('selfRenote', this.repository(MiNote).createQueryBuilder('renote').select('DISTINCT renote.renoteId', 'renoteId').where('renote.userId = :userId AND renote.renoteId IN (:...ids)', { userId, ids }).andWhere('renote.text IS NULL AND renote.cw IS NULL AND renote.replyId IS NULL AND renote.hasPoll = false AND cardinality(renote.fileIds) = 0').getRawMany<{ renoteId: string }>(), []),
			guarded('poll', this.repository(MiPoll).findBy({ noteId: In(ids) }), []),
			guarded('files', fileIds.length ? this.repository(MiDriveFile).findBy({ id: In(fileIds) }) : [], []),
			guarded('clip', this.repository(MiClipNote).createQueryBuilder('link').innerJoin(MiClip, 'clip', 'clip.id = link.clipId AND clip.userId = :userId', { userId }).where('link.noteId IN (:...ids)', { ids }).getMany(), []),
			guarded('reactions', this.meta.enableReactionsBuffering ? this.reactionsBufferingService.getMany(ids) : new Map(), new Map<string, { deltas: Record<string, number>; pairs: [string, string][] }>()),
		]);
		const reactionCounts = new Map(notes.map(note => {
			const merged = this.reactionsBufferingService.mergeReactions(note.reactions, bufferedReactions.get(note.id)?.deltas ?? {});
			if (Object.values(merged).some(count => !Number.isSafeInteger(count) || count < 0)) {
				errors.reactions = 'TEMPORARY_FAILURE';
				this.logger.error('Invalid cleanup reaction count', { noteId: note.id });
			}
			return [note.id, Object.values(merged).reduce((a, b) => a + b, 0)] as const;
		}));
		const now = Date.now();
		return notes.map(note => ({ errors: { ...errors }, text: note.text, cw: note.cw, poll: polls.find(p => p.noteId === note.id)?.choices ?? [], fileComment: files.filter(f => note.fileIds.includes(f.id)).map(f => f.comment ?? ''), fileName: files.filter(f => note.fileIds.includes(f.id)).map(f => f.name), age: (now - this.idService.parse(note.id).date.getTime()) / 1000, reactions: reactionCounts.get(note.id)!, renotes: note.renoteCount,
			flags: { pinned: pins.some(p => p.noteId === note.id), favorite: favorites.some(f => f.noteId === note.id), selfReaction: reactions.some(r => r.noteId === note.id), selfRenote: renotes.some(r => r.renoteId === note.id), reply: note.replyId !== null, quote: isRenote(note) && isQuote(note), poll: note.hasPoll, files: note.fileIds.length > 0, cw: note.cw !== null, localOnly: note.localOnly }, visibility: note.visibility, channelId: note.channelId, clipIds: clips.filter(c => c.noteId === note.id).map(c => c.clipId), tags: note.tags,
		}));
	}

	private async page(userId: string, ruleIds: string[], afterId?: string, limit = 100, consumption?: CleanupScanConsumption) {
		const all = await this.rules.find({ where: { userId }, order: { id: 'ASC' } });
		if (!ruleIds.length || ruleIds.length > 34 || ruleIds.some(id => !all.some(r => r.id === id && r.action === 'delete' && r.enabled))) throw new CleanupInputError('INVALID_RULE_SELECTION', 'ruleIds');
		const active = all.filter(r => r.enabled && (r.action === 'keep' || ruleIds.includes(r.id)));
		const { notes, evaluations } = await this.settle(userId, await this.prepare(active, userId), afterId, limit, consumption);
		// 규칙 오류는 저장된 lastError로 응답 최상위 errors에 규칙별로 모두 실리고 항목은 blocked로 판정되므로, 항목에는 공개 스키마의 판정 필드만 담는다.
		const items = notes.map((note, i) => {
			const { keepRuleIds, deleteRuleIds, decision, reason } = evaluations[i];
			return { noteId: note.id, text: note.text, cw: note.cw, createdAt: this.idService.parse(note.id).date.toISOString(), keepRuleIds, deleteRuleIds, decision, reason };
		});
		return { all, notes, items, scanned: notes.length, deleteCount: items.filter(i => i.decision === 'delete').length, protectedCount: items.filter(i => i.reason === 'protected').length, nextCursor: notes.at(-1)?.id ?? null, complete: notes.length < limit, errors: (await this.rules.findBy({ userId })).filter(r => active.some(a => a.id === r.id) && r.lastError).map(r => publicError(r.lastError)!) };
	}

	public async preview(userId: string, ruleIds: string[], afterId?: string, limit = 100) {
		return this.locked(userId, async () => {
			await this.initialize(userId);
			const { all, notes, ...page } = await this.page(userId, ruleIds, afterId, limit);
			const previewToken = this.fingerprint(all, ruleIds);
			await this.states.update(userId, { previewToken, previewAt: new Date() });
			return { ...page, rules: all.map(r => ({ id: r.id, name: r.name, defaultName: r.defaultName, action: r.action })), previewToken };
		});
	}

	public async request(userId: string, ruleIds: string[]) {
		return this.locked(userId, async () => {
			await this.initialize(userId);
			await this.page(userId, ruleIds, undefined, 1);
			const jobId = `note-cleanup-${userId}-${createHash('sha256').update([...ruleIds].sort().join(',')).digest('hex')}`;
			const existing = await this.queueService.systemQueue.getJob(jobId);
			if (existing) return { queued: false, jobId };
			await this.queueService.systemQueue.add('autoDeleteNotes', { userId, ruleIds, requestId: randomUUID() }, { jobId, removeOnComplete: true, removeOnFail: true, attempts: 1 });
			return { queued: true, jobId };
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
		if (result > 0) return { keys, amount: Math.min(result, want), exhausted: null };
		return { keys, amount: 0, exhausted: result === -2 ? 'account' : 'global' };
	}

	// 쓰지 않은 예약량을 예약했던 같은 창의 키에 돌려준다. 반납 실패는 그 창의 처리량만 줄이므로 기록만 한다.
	private async releaseBudget(reservation: CleanupReservation, used: number) {
		const unused = reservation.amount - used;
		if (unused <= 0) return;
		try { await this.redis.eval(RELEASE_SCRIPT, reservation.keys.length, ...reservation.keys, unused); } catch (error) { this.logger.error('Cleanup budget release failed', { error }); }
	}

	// 회차 한 번에 계정마다 한 페이지(검사 최대 pageSize, 삭제 시도 최대 deleteChunk)만 처리한다.
	// 검사 예산은 실제로 불러온 노트 수, 삭제 예산은 삭제 시도 수(실패 포함)만큼 쓰고 나머지는 반납한다.
	public async processUser(userId: string, ruleIds?: string[], afterId?: string) {
		return this.locked(userId, async () => {
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
			const consumption: CleanupScanConsumption = { used: 0, pending: false };
			let page: Awaited<ReturnType<NoteCleanupService['page']>>;
			try {
				// 전역 한도가 찬 경우에는 이 계정 탓이 아니므로 자동 순번을 그대로 둔다.
				if (!ruleIds && scan.exhausted !== 'global') await this.states.update(userId, { lastRunAt: new Date() });
				if (scan.exhausted) return { ...done(), complete: false, cursor: cursor ?? '', throttled: scan.exhausted };
				page = await this.page(userId, current, cursor, scan.amount, consumption);
			} finally {
				// 회복 조회도 소비에 포함하며, 불명확한 조회 실패는 전액을 보수적으로 남긴다.
				await this.releaseBudget(scan, consumption.pending ? scan.amount : Math.min(scan.amount, consumption.used));
			}
			if (page.items.some(i => i.reason === 'blocked') || page.errors.some(e => activeKeep(e.ruleId, page.all))) return done();
			// 지울 노트가 있을 때만 그 수만큼 삭제 예산을 예약한다. 보존만 하는 페이지는 삭제 예산을 쓰지 않는다.
			const candidates = page.items.filter(i => i.decision === 'delete').length;
			const removal = candidates ? await this.reserveBudget('delete', userId, Math.min(candidates, NOTE_CLEANUP_LIMITS.deleteChunk)) : null;
			let failed = 0;
			const result = await runCleanupBatch(page.items.map(i => ({ id: i.noteId, decision: i.decision })), removal?.amount ?? 0, async id => {
				const note = await this.repository(MiNote).findOneBy({ id, userId });
				if (!note) return false;
				return await this.noteDeleteService.delete(user, note, false);
			}, (noteId, error) => {
				// 한 노트의 실패가 뒤 노트와 다른 계정을 멈추지 않게 한다. 커서가 지나가므로 다음 순회에서 다시 검사된다.
				failed++;
				this.logger.error('Cleanup note deletion failed', { userId, noteId, error });
			});
			if (removal) await this.releaseBudget(removal, result.deleted + failed);
			const complete = page.complete && result.examined === page.scanned;
			// 첫 노트부터 삭제 예산이 없어 하나도 지나지 못했으면 기존 커서를 유지한다.
			const next = result.cursor ?? cursor ?? null;
			if (!ruleIds) await this.states.update(userId, { cursor: complete ? null : next });
			const throttled = !complete && removal?.exhausted && result.examined < page.scanned ? removal.exhausted : undefined;
			return { deleted: result.deleted, failed, examined: result.examined, complete, cursor: complete ? null : next ?? '', throttled };
		});
	}

	// 자동 회차에서 계정 처리에 실패하면 순번을 뒤로 보내, 실패 계정이 오래된 lastRunAt으로 매번 앞자리를 차지하지 않게 한다.
	public async deferUser(userId: string) {
		await this.states.update(userId, { lastRunAt: new Date() });
	}

	public async automaticUsers(): Promise<string[]> {
		return (await this.states.createQueryBuilder('state').where('EXISTS (SELECT 1 FROM note_cleanup_rule rule WHERE rule."userId" = state."userId" AND rule.enabled = true AND rule.automatic = true AND rule.action = :action)', { action: 'delete' }).orderBy('state.lastRunAt', 'ASC').addOrderBy('state.userId', 'ASC').take(NOTE_CLEANUP_LIMITS.roundUsers).getMany()).map(s => s.userId);
	}
}

// 정리 처리량 상한. 예약 창(windowMs)마다 전역과 계정별로 따로 센다.
export const NOTE_CLEANUP_LIMITS = {
	windowMs: 300000,
	// 창 키는 다음 창까지 반납을 받을 수 있게 창보다 길게 둔다.
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

type CleanupReservation = { keys: string[]; amount: number; exhausted: 'global' | 'account' | null };
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

// KEYS: 예약했던 키들, ARGV: 반납할 양. 0 아래로 내려가지 않는다.
const RELEASE_SCRIPT = `
local amount = tonumber(ARGV[1])
for i = 1, #KEYS do
	local used = tonumber(redis.call('GET', KEYS[i]) or '0')
	if used > 0 then redis.call('DECRBY', KEYS[i], math.min(amount, used)) end
end
return amount
`;

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

// 회복 범위는 저장 전용 정보이며 API의 규칙·오류 응답에는 싣지 않는다.
function publicError(error: MiNoteCleanupRule['lastError']) {
	if (!error) return null;
	const { recovery, ...visible } = error;
	return visible;
}

function publicRule(rule: MiNoteCleanupRule) {
	const { protectionNotification, ...visible } = rule;
	return { ...visible, lastError: publicError(rule.lastError) };
}
