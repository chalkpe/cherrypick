/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import { DI } from '@/di-symbols.js';
import { MiNoteDeleteReceipt, isSettledNoteDeleteReceipt, isDeliverySettledNoteDeleteReceipt } from '@/models/NoteDeleteReceipt.js';
import type { NoteDeleteEffects, RecoverableNoteDeleteReceipt } from '@/models/NoteDeleteReceipt.js';
import { MiInstance } from '@/models/Instance.js';
import { MiUser } from '@/models/User.js';
import { MiModerationLog } from '@/models/ModerationLog.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { SearchService } from '@/core/SearchService.js';
import { IdService } from '@/core/IdService.js';
import { NoteDeleteChartService, UnsupportedDeletionChartReceiptsError } from '@/core/NoteDeleteChartService.js';
import { NoteDeleteDeliveryService } from '@/core/NoteDeleteDeliveryService.js';
import { UtilityService } from '@/core/UtilityService.js';

const LOCAL_EFFECTS = ['noteStream', 'search', 'instanceStats', 'moderationLog'] as const;
type LocalEffect = typeof LOCAL_EFFECTS[number];

@Injectable()
export class NoteDeleteLocalRunnerService {
	// 공유 연결은 끊지 않는다. 종류별 미완료 요청은 이 singleton에서 최대 하나다.
	// 시간 초과 뒤에도 응답이 정산될 때까지 슬롯을 반환하지 않는다.
	private readonly pendingExternal = new Set<LocalEffect>();

	// 성공 응답은 새 claim이 표식할 때까지 보관한다. 입력 본문과 과거 권한은 보관하지 않는다.
	// 미완료 검색 요청은 기존 슬롯 하나, 인계 대기는 scan 상한과 같은 최대 10개다.
	private readonly searchResults = new Map<string, { noteId: string; userId: string; deletedAt: number; completed: boolean; pending: Promise<unknown> }>();

	private searchKey(receipt: MiNoteDeleteReceipt): string {
		return JSON.stringify([receipt.noteId, receipt.userId, +receipt.deletedAt]);
	}

	private async search(receipt: RecoverableNoteDeleteReceipt): Promise<void> {
		const key = this.searchKey(receipt);
		let result = this.searchResults.get(key);
		if (result && !result.completed) throw new Error('local_effect_busy');
		if (!result) {
			if (this.pendingExternal.has('search')) throw new Error('local_effect_busy');
			if (this.searchResults.size >= 10) {
				// 다른 실행자가 끝낸 결과도 회수한다. 미완료 의무를 밀어내어 새 요청을 반복하지 않는다.
				await this.db.transaction(async manager => {
					for (const [savedKey, saved] of [...this.searchResults]) {
						const current = await manager.getRepository(MiNoteDeleteReceipt).findOne({ where: { noteId: saved.noteId, userId: saved.userId } });
						if (!current || +current.deletedAt !== saved.deletedAt || current.effects.search || isSettledNoteDeleteReceipt(current)) this.searchResults.delete(savedKey);
					}
				});
			}
			// 위 읽기 중 다른 호출이 슬롯을 얻었을 수 있다.
			result = this.searchResults.get(key);
			if (!result) {
				if (this.pendingExternal.has('search') || this.searchResults.size >= 10) throw new Error('local_effect_busy');
				const pending = Promise.resolve().then(() => this.searchService.unindexNote(receipt.snapshot.note, true));
				result = { noteId: receipt.noteId, userId: receipt.userId, deletedAt: +receipt.deletedAt, completed: false, pending };
				this.searchResults.set(key, result);
				this.pendingExternal.add('search');
				const saved = result;
				pending.then(() => {
					saved.completed = true;
					this.pendingExternal.delete('search');
				}, () => {
					this.pendingExternal.delete('search');
					this.searchResults.delete(key);
				});
			}
		}
		await this.deadline(result.pending);
	}

	private async external(effect: LocalEffect, work: () => Promise<unknown>): Promise<void> {
		if (this.pendingExternal.has(effect)) throw new Error('local_effect_busy');
		this.pendingExternal.add(effect);
		const pending = Promise.resolve().then(work);
		pending.then(() => this.pendingExternal.delete(effect), () => this.pendingExternal.delete(effect));
		await this.deadline(pending);
	}

	private async deadline(pending: Promise<unknown>): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([pending, new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('local_effect_timeout')), 5_000);
			})]);
		} finally {
			clearTimeout(timer);
		}
	}

	constructor(
		@Inject(DI.db) private db: DataSource,
		private globalEventService: GlobalEventService,
		private searchService: SearchService,
		private idService: IdService,
		private utilityService: UtilityService,
		private noteDeleteChartService: NoteDeleteChartService,
		private noteDeleteDeliveryService: NoteDeleteDeliveryService,
	) {}

	// Redis 작업이 사라져도 DB의 의무를 다시 찾는다. 한 작업에서 최대 10개만 처리한다.
	public async scan(): Promise<number> {
		const candidates: { noteId: string; userId: string }[] = await this.db.query(`
			SELECT "noteId", "userId" FROM "note_delete_receipt"
			WHERE "completedAt" IS NULL AND NOT ("snapshot" @> '{"version":2,"state":"settled"}'::jsonb)
			AND "nextAttemptAt" <= CURRENT_TIMESTAMP AND ("claimUntil" IS NULL OR "claimUntil" <= CURRENT_TIMESTAMP)
			ORDER BY "nextAttemptAt", "noteId" LIMIT 10`);
		if (candidates.length === 0) return 0;
		let unsupported = new Set<string>();
		try {
			await this.noteDeleteChartService.applyBatch(candidates);
		} catch (error) {
			if (!(error instanceof UnsupportedDeletionChartReceiptsError)) {
				const receipt = await this.claim(candidates[0].noteId, candidates[0].userId);
				if (receipt) await this.fail(receipt, 'charts_failed');
				return receipt ? 1 : 0;
			}
			unsupported = new Set(error.items.map(item => item.noteId));
		}
		let count = 0;
		for (const candidate of candidates) {
			// 외부 대기를 시작하기 직전에만 claim하여 뒤 영수증의 lease를 소모하지 않는다.
			const receipt = await this.claim(candidate.noteId, candidate.userId);
			if (!receipt) continue;
			await this.executeBatch([receipt], unsupported);
			count++;
		}
		return count;
	}

	// 기존 주기와 계정 처리기가 같은 상한을 사용하며 후처리 오류는 기존 결과를 바꾸지 않는다.
	// 호출자 경계는 최초 삭제 승자와 stale note 재호출 양쪽에서 유지한다.
	public async runOne(noteId: string, userId: string): Promise<void> {
		const receipt = await this.claim(noteId, userId);
		if (receipt) await this.executeBatch([receipt]);
	}

	private async executeBatch(receipts: RecoverableNoteDeleteReceipt[], precomputedUnsupported?: Set<string>): Promise<boolean> {
		let unsupported = precomputedUnsupported;
		if (!unsupported) {
			try {
				await this.noteDeleteChartService.applyBatch(receipts.map(receipt => ({ noteId: receipt.noteId, userId: receipt.userId })));
				unsupported = new Set();
			} catch (error) {
				if (!(error instanceof UnsupportedDeletionChartReceiptsError)) {
					for (const receipt of receipts) await this.fail(receipt, 'charts_failed');
					return false;
				}
				unsupported = new Set(error.items.map(item => item.noteId));
			}
		}
		for (const receipt of receipts) {
			if (!await this.withClaim(receipt, async (manager, current) => { await this.settleDeliveryInTransaction(manager, current); })) continue;
			if (!await this.executeLocal(receipt)) continue;
			if (unsupported.has(receipt.noteId)) {
				await this.fail(receipt, 'unsupported_charts');
				continue;
			}
			await this.withClaim(receipt, async (manager, current) => {
				// 최신 영수증 잠금 안에서 실제 의무 확인·정산·입력 제거를 함께 확정한다.
				await this.settleDeliveryInTransaction(manager, current);
				const summary = current.snapshot.version === 3 ? current.effects.activityPub?.summary ?? null : null;
				const plan = current.snapshot.localPlan!;
				const effects = { ...current.effects };
				const pending = summary === null || summary.unfinished > 0 || !current.effects.charts || Object.entries(plan).some(([name, required]) => required && !effects[name as keyof NoteDeleteEffects]);
				await manager.getRepository(MiNoteDeleteReceipt).update({ noteId: current.noteId }, {
					effects, completedAt: pending ? null : new Date(),
					...(!pending ? { snapshot: { version: 2 as const, state: 'settled' as const } } : {}),
					lastErrorCode: effects.activityPub?.outcome === 'permanentFailed' ? 'delivery_permanent_failed' : null,
					nextAttemptAt: new Date(Date.now() + 300_000), claimToken: null, claimUntil: null,
				});
			});
		}
		return true;
	}

	public async settleDeliveryInTransaction(manager: EntityManager, receipt: RecoverableNoteDeleteReceipt): Promise<void> {
		if (receipt.snapshot.version === 3) return;
		const summary = await this.noteDeleteDeliveryService.settleInTransaction(manager, receipt);
		if (!summary || summary.unfinished !== 0) return;
		await this.noteDeleteDeliveryService.clearSettledInputs(manager, receipt);
		receipt.effects = { ...receipt.effects, activityPub: { completedAt: new Date().toISOString(), outcome: summary.permanentFailed > 0 ? 'permanentFailed' : summary.delivered > 0 ? 'delivered' : 'skipped', summary } };
		// 전달 입력의 수명은 아직 필요한 로컬 입력과 분리한다.
		receipt.snapshot = { ...receipt.snapshot, version: 3, state: 'delivery_settled', delivery: null };
		await manager.getRepository(MiNoteDeleteReceipt).update({ noteId: receipt.noteId, userId: receipt.userId }, { snapshot: receipt.snapshot, effects: receipt.effects });
	}

	private async fail(receipt: MiNoteDeleteReceipt, code: string): Promise<void> {
		// 오류 원문이나 외부 응답을 영수증에 넣지 않는다.
		await this.withClaim(receipt, async (manager, current) => {
			await this.settleDeliveryInTransaction(manager, current);
			const delay = Math.min(3_600_000, 5_000 * 2 ** Math.min(current.attempts - 1, 10));
			await manager.getRepository(MiNoteDeleteReceipt).update({ noteId: current.noteId }, {
				lastErrorCode: code, nextAttemptAt: new Date(Date.now() + delay), claimToken: null, claimUntil: null,
			});
		});
	}

	private async claim(noteId?: string, userId?: string, excluded: readonly string[] = []): Promise<RecoverableNoteDeleteReceipt | null> {
		const [rows]: [MiNoteDeleteReceipt[], number] = await this.db.query(`
			UPDATE "note_delete_receipt" AS receipt SET
				"claimToken" = $1, "claimVersion" = receipt."claimVersion" + 1,
				"claimUntil" = CURRENT_TIMESTAMP + INTERVAL '60 seconds', "attempts" = receipt."attempts" + 1
			WHERE receipt."noteId" = (
				SELECT "noteId" FROM "note_delete_receipt"
				WHERE "completedAt" IS NULL AND NOT ("snapshot" @> '{"version":2,"state":"settled"}'::jsonb) AND "nextAttemptAt" <= CURRENT_TIMESTAMP
				AND ("claimUntil" IS NULL OR "claimUntil" <= CURRENT_TIMESTAMP)
				AND NOT ("noteId" = ANY($4::varchar[]))
				AND ($2::varchar IS NULL OR ("noteId" = $2 AND "userId" = $3))
				ORDER BY "nextAttemptAt", "noteId" FOR UPDATE SKIP LOCKED LIMIT 1
			) RETURNING receipt.*`, [randomUUID(), noteId ?? null, userId ?? null, excluded]);
		const row = rows[0];
		return row && !isSettledNoteDeleteReceipt(row) ? row as RecoverableNoteDeleteReceipt : null;
	}

	// 외부 작업은 잠금을 잡지 않는다. 늦은 응답은 token/version/만료 시각으로 차단한다.
	private async withClaim(receipt: MiNoteDeleteReceipt, work: (manager: EntityManager, current: RecoverableNoteDeleteReceipt) => Promise<void>): Promise<boolean> {
		return this.db.transaction(async manager => {
			const repository = manager.getRepository(MiNoteDeleteReceipt);
			const current = await repository.createQueryBuilder('receipt')
				.where('receipt.noteId = :noteId AND receipt.userId = :userId', receipt)
				.andWhere('receipt.claimToken = :claimToken AND receipt.claimVersion = :claimVersion', receipt)
				.andWhere('receipt.claimUntil > CURRENT_TIMESTAMP')
				.setLock('pessimistic_write').getOne();
			if (!current || isSettledNoteDeleteReceipt(current)) return false;
			if (current.snapshot.version !== 1 && (current.snapshot.version !== 3 || !isDeliverySettledNoteDeleteReceipt(current))) {
				await repository.update({ noteId: current.noteId, userId: current.userId }, {
					lastErrorCode: 'unsupported_snapshot', nextAttemptAt: new Date(Date.now() + 300_000), claimToken: null, claimUntil: null,
				});
				return false;
			}
			await work(manager, current as RecoverableNoteDeleteReceipt);
			return true;
		});
	}

	private async executeLocal(receipt: RecoverableNoteDeleteReceipt): Promise<boolean> {
		const plan = receipt.snapshot.localPlan;
		if (!plan) {
			await this.fail(receipt, 'unsupported_snapshot');
			return false;
		}
		let failure: string | null = null;
		for (const name of LOCAL_EFFECTS) {
			if (!plan[name] || receipt.effects[name]) continue;
			try {
				if (name === 'instanceStats' || name === 'moderationLog') {
					const marked = await this.withClaim(receipt, async (manager, current) => {
						if (current.effects[name]) return;
						const result = await this.databaseEffect(manager, current, name);
						await this.mark(manager, current, name, result);
					});
					if (!marked) return false;
				} else {
					if (!await this.withClaim(receipt, async (_manager, current) => {
						receipt.snapshot = current.snapshot;
						receipt.effects = current.effects;
					})) return false;
					if (receipt.effects[name]) {
						if (name === 'search') this.searchResults.delete(this.searchKey(receipt));
						continue;
					}
					if (name === 'noteStream') {
						const stream = receipt.snapshot.stream;
						if (!stream) throw new Error('missing_stream_snapshot');
						await this.external(name, () => this.globalEventService.publishNoteStreamForDeletion({ ...receipt.snapshot.note, ...stream }, receipt.deletedAt));
					} else {
						await this.search(receipt);
					}
					if (!await this.withClaim(receipt, async (manager, current) => this.mark(manager, current, name))) return false;
					if (name === 'search') this.searchResults.delete(this.searchKey(receipt));
				}
			} catch {
				// 독립 효과는 계속 시도하되 첫 실패 분류와 미완료 표식을 보존한다.
				failure ??= `${name}_failed`;
			}
		}
		if (failure) await this.fail(receipt, failure);
		return failure === null;
	}

	private async mark(manager: EntityManager, receipt: RecoverableNoteDeleteReceipt, effect: LocalEffect, result?: { outcome: 'excluded'; reason: 'subject_deleted' }): Promise<void> {
		await manager.getRepository(MiNoteDeleteReceipt).update({ noteId: receipt.noteId }, {
			effects: { ...receipt.effects, [effect]: { completedAt: new Date().toISOString(), ...result } },
			...(effect === 'moderationLog' ? { snapshot: { ...receipt.snapshot, auditNote: null, deleter: null, author: null } } : {}),
			...(effect === 'noteStream' ? { snapshot: { ...receipt.snapshot, stream: null } } : {}),
		});
	}

	private async databaseEffect(manager: EntityManager, receipt: RecoverableNoteDeleteReceipt, effect: 'instanceStats' | 'moderationLog'): Promise<{ outcome: 'excluded'; reason: 'subject_deleted' } | undefined> {
		const { actor, deleter, author, auditNote } = receipt.snapshot;
		if (effect === 'instanceStats') {
			if (!actor.host) throw new Error('missing_host');
			const host = this.utilityService.toPuny(actor.host);
			const instances = manager.getRepository(MiInstance);
			// 기존 instance 등록과 같은 필드로 만들며 동시 등록은 host unique 제약에 맡긴다.
			await instances.createQueryBuilder().insert().values({ id: this.idService.gen(), host, firstRetrievedAt: new Date() }).orIgnore().execute();
			await instances.decrement({ host }, 'notesCount', 1);
		} else {
			if (!deleter || !author || !auditNote) throw new Error('missing_moderation_snapshot');
			// 기존 감사 로그도 주체 삭제 시 CASCADE로 제거된다.
			// 주체를 잠가 확인과 insert 사이 삭제를 막고, 사라졌으면 성공과 구분한다.
			const subject = await manager.getRepository(MiUser).findOne({ where: { id: deleter.id }, lock: { mode: 'pessimistic_read' } });
			if (!subject) return { outcome: 'excluded', reason: 'subject_deleted' };
			await manager.getRepository(MiModerationLog).insert({
				id: this.idService.gen(), userId: deleter.id, type: 'deleteNote',
				info: { noteId: auditNote.id, noteUserId: receipt.userId, noteUserUsername: author.username, noteUserHost: author.host, note: auditNote } as unknown as QueryDeepPartialEntity<MiModerationLog>['info'],
			});
		}
		return undefined;
	}
}
