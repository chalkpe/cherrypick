/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In, IsNull, LessThan, LessThanOrEqual, MoreThan } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { MiUser } from '@/models/User.js';
import { MiNoteDeleteDelivery } from '@/models/NoteDeleteDelivery.js';
import { MiNoteDeleteReceipt, isDeliverySettledNoteDeleteReceipt } from '@/models/NoteDeleteReceipt.js';
import { activityPubDigest } from '@/misc/activitypub-payload.js';
import type { DeliverJobData, NoteDeleteDeliveryIdentity } from '@/queue/types.js';
import { QueueService } from '@/core/QueueService.js';
import { UserKeypairService } from '@/core/UserKeypairService.js';
import { NoteDeletePayloadService } from '@/core/NoteDeletePayloadService.js';

export type NoteDeleteDeliveryClaim = NoteDeleteDeliveryIdentity & { claimToken: string; claimVersion: number };
export type NoteDeleteDeliveryErrorCode = 'owner_removed' | 'remote_retryable' | 'remote_permanent' | 'remote_budget_exhausted' | 'key_unavailable' | 'preparation_failed' | 'blocked' | 'suspended' | 'software_suspended';
export type NoteDeleteDeliveryResult =
	| { outcome: 'delivered' }
	| { outcome: 'skipped'; code: 'blocked' | 'suspended' | 'software_suspended' }
	| { outcome: 'temporaryFailed'; code: 'remote_retryable' | 'key_unavailable' | 'preparation_failed'; nextAttemptAt: Date }
	| { outcome: 'permanentFailed'; code: 'remote_permanent' | 'remote_budget_exhausted' };

const LEASE_MS = 60_000;
const LIVE_JOBS = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);
const ERROR_CODES = new Set<NoteDeleteDeliveryErrorCode>(['remote_retryable', 'remote_permanent', 'remote_budget_exhausted', 'key_unavailable', 'preparation_failed', 'blocked', 'suspended', 'software_suspended']);

@Injectable()
export class NoteDeleteDeliveryService {
	private scanCursors: Record<'ASC' | 'DESC', Pick<MiNoteDeleteDelivery, 'receiptNoteId' | 'channel' | 'targetKey'> | null> = { ASC: null, DESC: null };
	private scanDirection: 'ASC' | 'DESC' = 'ASC';

	constructor(
		@Inject(DI.db) private db: DataSource,
		private queueService: QueueService,
		private noteDeletePayloadService: NoteDeletePayloadService,
		private userKeypairService: UserKeypairService,
	) {}

	private static assertIdentity(identity: NoteDeleteDeliveryIdentity): void {
		if (!identity || !(['receiptNoteId', 'ownerUserId', 'targetKey'] as const).every(key => typeof identity[key] === 'string' && identity[key].length > 0) ||
			!['followers', 'direct', 'relay'].includes(identity.channel) || !Number.isSafeInteger(identity.generation) || identity.generation < 0) throw new Error('invalid delete delivery identity');
	}

	public static jobId(identity: NoteDeleteDeliveryIdentity): string {
		NoteDeleteDeliveryService.assertIdentity(identity);
		const key = JSON.stringify([identity.receiptNoteId, identity.channel, identity.targetKey]);
		return `ndd-${createHash('sha256').update(key).digest('hex')}-${identity.generation}`;
	}

	private key(identity: NoteDeleteDeliveryIdentity) {
		NoteDeleteDeliveryService.assertIdentity(identity);
		return { receiptNoteId: identity.receiptNoteId, channel: identity.channel, targetKey: identity.targetKey, ownerUserId: identity.ownerUserId };
	}

	private identity(row: MiNoteDeleteDelivery): NoteDeleteDeliveryIdentity {
		return { ...this.key(row), generation: row.generation };
	}

	private unfinished(row: MiNoteDeleteDelivery) {
		return row.state === 'pending' || row.state === 'running';
	}

	private expired(row: MiNoteDeleteDelivery) {
		return row.claimUntil == null || row.claimUntil.getTime() <= Date.now();
	}

	private async locked(manager: EntityManager, identity: NoteDeleteDeliveryIdentity) {
		return manager.getRepository(MiNoteDeleteDelivery).findOne({
			where: this.key(identity), lock: { mode: 'pessimistic_write' },
		});
	}

	// 의무와 영수증의 불변 계획을 대조한다. job의 content/to/user는 읽지 않는다.
	private async data(manager: EntityManager, row: MiNoteDeleteDelivery, allowUnsigned = false): Promise<DeliverJobData | null> {
		const receipt = await manager.getRepository(MiNoteDeleteReceipt).findOneBy({ noteId: row.receiptNoteId, userId: row.ownerUserId });
		if (!receipt || isDeliverySettledNoteDeleteReceipt(receipt)) return null;
		if (receipt.snapshot.version !== 1) throw new Error('unsupported delete receipt snapshot');
		if (receipt.noteId !== row.receiptNoteId || receipt.userId !== row.ownerUserId || receipt.snapshot.actor.id !== row.ownerUserId || receipt.snapshot.note.id !== row.receiptNoteId || receipt.snapshot.note.userId !== row.ownerUserId) throw new Error('invalid delete delivery owner');
		const plan = receipt.snapshot.delivery;
		if (plan.version !== 2 || plan.reason !== 'federated') throw new Error('invalid delete delivery plan');
		const targets = row.channel === 'relay' ? plan.relays : row.channel === 'followers' ? plan.followers : row.channel === 'direct' ? plan.directTargets : [];
		const target = targets.find(item => item.targetKey === row.targetKey);
		if (row.endpoint === null || row.isSharedInbox === null || row.payloadRef === null) throw new Error('missing delete delivery input');
		const targetKey = row.channel === 'relay' ? row.relayId : createHash('sha256').update(row.endpoint).digest('hex');
		if (targetKey !== row.targetKey) throw new Error('invalid delete delivery key');
		if (!target || target.endpoint !== row.endpoint || target.isSharedInbox !== row.isSharedInbox ||
			(row.channel === 'relay' ? !('relayId' in target) || target.relayId !== row.relayId : row.relayId !== null) ||
			row.payloadRef !== (row.channel === 'relay' ? 'relaySigned' : 'activity')) throw new Error('invalid delete delivery target');
		const payload = plan[row.payloadRef] ?? (allowUnsigned && row.channel === 'relay' ? plan.relayUnsigned : null);
		if (!payload || activityPubDigest(payload.content) !== payload.digest) throw new Error('invalid delete delivery payload');
		return {
			user: { id: receipt.snapshot.actor.id }, to: target.endpoint, isSharedInbox: target.isSharedInbox,
			content: payload.content, digest: payload.digest,
		};
	}

	// 반환값은 접수 응답 수이며 전달 완료 수가 아니다. 한 의무의 외부 장애는 다음 의무를 막지 않는다.
	public async scan(): Promise<number> {
		return (await this.scanPage()).accepted;
	}

	public async scanPage(): Promise<{ accepted: number; full: boolean }> {
		const due = { state: In(['pending', 'running']), nextAttemptAt: LessThanOrEqual(new Date()) };
		const direction = this.scanDirection;
		const cursor = this.scanCursors[direction];
		const beyond = direction === 'ASC' ? MoreThan : LessThan;
		const rows = await this.db.getRepository(MiNoteDeleteDelivery).find({
			where: cursor ? [
				{ ...due, receiptNoteId: beyond(cursor.receiptNoteId) },
				{ ...due, receiptNoteId: cursor.receiptNoteId, channel: beyond(cursor.channel) },
				{ ...due, receiptNoteId: cursor.receiptNoteId, channel: cursor.channel, targetKey: beyond(cursor.targetKey) },
			] : due,
			order: { receiptNoteId: direction, channel: direction, targetKey: direction }, take: 10,
		});
		// 방향별로 이어 읽어 앞쪽 busy 행과 뒤쪽 지속 유입이 서로의 재발견을 막지 않게 한다.
		this.scanCursors[direction] = rows.length === 10 ? { receiptNoteId: rows[9].receiptNoteId, channel: rows[9].channel, targetKey: rows[9].targetKey } : null;
		this.scanDirection = direction === 'ASC' ? 'DESC' : 'ASC';
		let accepted = 0;
		for (const row of rows) {
			try {
				if (await this.enqueue(this.identity(row))) accepted++;
			} catch {
				// DB 미완료 의무는 남는다. 오류 원문이나 접수 응답을 성공 표식으로 저장하지 않는다.
			}
		}
		return { accepted, full: rows.length === 10 };
	}

	public async requestRecovery(): Promise<void> {
		await this.queueService.systemQueue.add('recoverNoteDeletes', {}, { removeOnComplete: true, removeOnFail: { age: 86_400 } });
	}

	public async enqueue(identity: NoteDeleteDeliveryIdentity): Promise<boolean> {
		const repository = this.db.getRepository(MiNoteDeleteDelivery);
		const observed = await repository.findOneBy(this.key(identity));
		if (!observed || !this.unfinished(observed) || observed.generation !== identity.generation || !this.expired(observed) || observed.nextAttemptAt.getTime() > Date.now()) return false;
		const receipt = await this.db.getRepository(MiNoteDeleteReceipt).findOneBy({ noteId: identity.receiptNoteId, userId: identity.ownerUserId });
		if (!receipt || isDeliverySettledNoteDeleteReceipt(receipt)) return false;
		if (receipt.snapshot.version !== 1 || receipt.snapshot.actor.id !== identity.ownerUserId) throw new Error('unsupported delete receipt snapshot');
		const job = await this.queueService.deliverQueue.getJob(NoteDeleteDeliveryService.jobId(identity));
		const state = job ? await job.getState() : 'unknown';
		if (LIVE_JOBS.has(state)) return false;
		// completed/failed/제거/유실은 DB ack를 대신하지 않는다. 알 수 없는 실행 상태는 건드리지 않는다.
		if (job && state !== 'completed' && state !== 'failed' && state !== 'unknown') return false;
		if (await this.settleRemovedOwner(identity)) return false;
		if (observed.payloadRef === 'relaySigned') {
			await this.noteDeletePayloadService.prepareRelaySignedPayload(identity.receiptNoteId, identity.ownerUserId);
		}
		// Redis 조회와 키 조회가 끝난 뒤 짧은 DB CAS로 접수 권한을 예약한다.
		const data = await this.db.transaction(async manager => {
			const current = await this.locked(manager, identity);
			if (!current || !this.unfinished(current) || current.generation !== identity.generation || current.claimVersion !== observed.claimVersion || !this.expired(current) || current.nextAttemptAt.getTime() > Date.now()) return null;
			const generation = current.claimVersion === 0 ? current.generation : current.generation + 1;
			const next = { ...current, generation };
			if (!await this.data(manager, next)) return null;
			const result = await manager.getRepository(MiNoteDeleteDelivery).update({
				...this.key(current), generation: current.generation, claimVersion: current.claimVersion, state: current.state,
			}, {
				generation, state: 'pending', claimVersion: current.claimVersion + 1,
				claimToken: null, claimUntil: new Date(Date.now() + LEASE_MS),
			});
			return result.affected === 1 ? { noteDeleteDelivery: this.identity(next) } : null;
		});
		if (!data?.noteDeleteDelivery) return false;
		// add 오류/응답 유실 뒤에도 예약 lease와 같은 generation을 보존한다.
		await this.queueService.enqueueNoteDeleteDeliver(data, NoteDeleteDeliveryService.jobId(data.noteDeleteDelivery));
		return true;
	}

	// 자기 claim의 HTTP 시작 전 실패 또는 만료 의무 재발견에서만 호출한다.
	public async settleRemovedOwner(identity: NoteDeleteDeliveryIdentity, claim?: NoteDeleteDeliveryClaim): Promise<boolean> {
		const observed = await this.db.getRepository(MiNoteDeleteDelivery).findOneBy(this.key(identity));
		if (!observed || !this.unfinished(observed) || observed.generation !== identity.generation) return false;
		if (claim ? !this.valid(observed, claim) : !this.expired(observed) || observed.nextAttemptAt.getTime() > Date.now()) return false;
		const owner = await this.db.getRepository(MiUser).findOne({ where: { id: identity.ownerUserId } });
		if (owner) return false;
		const key = await this.userKeypairService.getUserKeypairAvailability(identity.ownerUserId);
		if (key.available) return false;
		return this.db.transaction(async manager => {
			const row = await this.locked(manager, identity);
			if (!row || !this.unfinished(row) || row.generation !== identity.generation || row.claimVersion !== observed.claimVersion || row.claimToken !== observed.claimToken || row.state !== observed.state) return false;
			if (claim ? !this.valid(row, claim) : !this.expired(row) || row.nextAttemptAt.getTime() > Date.now()) return false;
			// 플래그나 키 오류를 부재로 바꾸지 않는다. DB 오류는 그대로 재시도한다.
			const owner = await manager.getRepository(MiUser).findOne({ where: { id: row.ownerUserId }, lock: { mode: 'pessimistic_read' } });
			if (owner) return false;
			if (!await this.data(manager, row, true)) return false;
			if (claim ? !this.valid(row, claim) : !this.expired(row) || row.nextAttemptAt.getTime() > Date.now()) return false;
			const result = await manager.getRepository(MiNoteDeleteDelivery).update({
				...this.key(row), generation: row.generation, claimVersion: row.claimVersion, claimToken: row.claimToken ?? IsNull(), state: row.state,
			}, { state: 'permanentFailed', lastErrorCode: 'owner_removed', settledAt: new Date(), claimToken: null, claimUntil: null });
			return result.affected === 1;
		});
	}

	public async claim(identity: NoteDeleteDeliveryIdentity, jobId: string): Promise<{ claim: NoteDeleteDeliveryClaim; data: DeliverJobData } | null> {
		if (jobId !== NoteDeleteDeliveryService.jobId(identity)) return null;
		return this.db.transaction(async manager => {
			const current = await this.locked(manager, identity);
			if (!current || !this.unfinished(current) || current.generation !== identity.generation || current.nextAttemptAt.getTime() > Date.now() || (current.state === 'running' && !this.expired(current))) return null;
			const data = await this.data(manager, current);
			if (!data) return null;
			const claim = { ...identity, claimToken: randomUUID(), claimVersion: current.claimVersion + 1 };
			const result = await manager.getRepository(MiNoteDeleteDelivery).update({
				...this.key(current), generation: current.generation, claimVersion: current.claimVersion, state: current.state,
			}, { state: 'running', claimToken: claim.claimToken, claimVersion: claim.claimVersion, claimUntil: new Date(Date.now() + LEASE_MS) });
			return result.affected === 1 ? { claim, data } : null;
		});
	}

	private async closed(manager: EntityManager, row: MiNoteDeleteDelivery): Promise<boolean> {
		const receipt = await manager.getRepository(MiNoteDeleteReceipt).findOneBy({ noteId: row.receiptNoteId, userId: row.ownerUserId });
		return !receipt || isDeliverySettledNoteDeleteReceipt(receipt);
	}

	private valid(row: MiNoteDeleteDelivery | null, claim: NoteDeleteDeliveryClaim): row is MiNoteDeleteDelivery {
		return row != null && row.state === 'running' && row.generation === claim.generation && row.claimVersion === claim.claimVersion && row.claimToken === claim.claimToken && !this.expired(row);
	}

	// 다음 processor는 HTTP 직전에 이 메서드의 DB 값을 사용한다.
	public async validateBeforeSend(claim: NoteDeleteDeliveryClaim): Promise<DeliverJobData | null> {
		return this.db.transaction(async manager => {
			const row = await this.locked(manager, claim);
			if (!this.valid(row, claim)) return null;
			const data = await this.data(manager, row);
			return this.valid(row, claim) ? data : null;
		});
	}

	// 키/DB 준비 실패는 원격 시도 예산을 소모하지 않는다. 실제 HTTP 호출 직전에만 호출한다.
	public async recordRemoteAttempt(claim: NoteDeleteDeliveryClaim, maxAttempts: number): Promise<{ outcome: 'reserved' | 'exhausted'; attempts: number } | null> {
		if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) throw new Error('invalid delete delivery attempt budget');
		return this.db.transaction(async manager => {
			const row = await this.locked(manager, claim);
			if (!this.valid(row, claim)) return null;
			if (!await this.data(manager, row)) return null;
			if (row.attempts >= maxAttempts) return { outcome: 'exhausted' as const, attempts: row.attempts };
			const result = await manager.getRepository(MiNoteDeleteDelivery).update({
				...this.key(claim), generation: claim.generation, claimVersion: claim.claimVersion, claimToken: claim.claimToken, state: 'running',
			}, { attempts: row.attempts + 1 });
			return result.affected === 1 ? { outcome: 'reserved' as const, attempts: row.attempts + 1 } : null;
		});
	}

	public async renew(claim: NoteDeleteDeliveryClaim): Promise<boolean> {
		return this.db.transaction(async manager => {
			const row = await this.locked(manager, claim);
			if (!this.valid(row, claim) || await this.closed(manager, row)) return false;
			const result = await manager.getRepository(MiNoteDeleteDelivery).update({
				...this.key(claim), generation: claim.generation, claimVersion: claim.claimVersion, claimToken: claim.claimToken, state: 'running',
			}, { claimUntil: new Date(Date.now() + LEASE_MS) });
			return result.affected === 1;
		});
	}

	public async acknowledge(claim: NoteDeleteDeliveryClaim, result: NoteDeleteDeliveryResult): Promise<boolean> {
		const allowed = {
			delivered: [], skipped: ['blocked', 'suspended', 'software_suspended'],
			temporaryFailed: ['remote_retryable', 'key_unavailable', 'preparation_failed'],
			permanentFailed: ['remote_permanent', 'remote_budget_exhausted'],
		};
		if (!(result.outcome in allowed) || (result.outcome !== 'delivered' && (!ERROR_CODES.has(result.code) || !allowed[result.outcome].includes(result.code)))) throw new Error('invalid delete delivery result');
		if (result.outcome === 'temporaryFailed' && (!Number.isFinite(result.nextAttemptAt.getTime()) || result.nextAttemptAt.getTime() <= Date.now())) throw new Error('invalid delete delivery retry time');
		return this.db.transaction(async manager => {
			const row = await this.locked(manager, claim);
			if (!this.valid(row, claim) || await this.closed(manager, row)) return false;
			const temporary = result.outcome === 'temporaryFailed';
			const updated = await manager.getRepository(MiNoteDeleteDelivery).update({
				...this.key(claim), generation: claim.generation, claimVersion: claim.claimVersion, claimToken: claim.claimToken, state: 'running',
			}, {
				state: result.outcome === 'temporaryFailed' ? 'pending' : result.outcome, claimToken: null, claimUntil: null,
				nextAttemptAt: result.outcome === 'temporaryFailed' ? result.nextAttemptAt : row.nextAttemptAt,
				lastErrorCode: result.outcome === 'delivered' ? null : result.code,
				settledAt: temporary ? null : new Date(),
			});
			return updated.affected === 1;
		});
	}

	// 호출자는 최신 영수증을 먼저 잠근다. 외부 요약이나 큐 상태로 완료를 추정하지 않는다.
	public async settleInTransaction(manager: EntityManager, receipt: MiNoteDeleteReceipt) {
		if (isDeliverySettledNoteDeleteReceipt(receipt) || receipt.snapshot.version !== 1) return null;
		const plan = receipt.snapshot.delivery;
		if (!plan || plan.version !== 2 || !['federated', 'quiet', 'remote', 'localOnly'].includes(plan.reason) || ![plan.followers, plan.directTargets, plan.relays].every(targets => Array.isArray(targets) && targets.every(target => target && typeof target.targetKey === 'string' && target.targetKey.length > 0))) return null;
		const expected = new Set([
			...plan.followers.map(target => `followers:${target.targetKey}`),
			...plan.directTargets.map(target => `direct:${target.targetKey}`),
			...plan.relays.map(target => `relay:${target.targetKey}`),
		]);
		const rows = await manager.getRepository(MiNoteDeleteDelivery).find({
			where: { receiptNoteId: receipt.noteId }, lock: { mode: 'pessimistic_write' },
		});
		if (rows.length !== expected.size) return null;
		const counts = { unfinished: 0, delivered: 0, skipped: 0, permanentFailed: 0 };
		for (const row of rows) {
			if (row.ownerUserId !== receipt.userId || !expected.delete(`${row.channel}:${row.targetKey}`)) return null;
			if (this.unfinished(row)) counts.unfinished++;
			else if (row.state === 'delivered' || row.state === 'skipped' || row.state === 'permanentFailed') counts[row.state]++;
			else return null;
		}
		return counts;
	}

	public async clearSettledInputs(manager: EntityManager, receipt: MiNoteDeleteReceipt): Promise<void> {
		await manager.getRepository(MiNoteDeleteDelivery).update({
			receiptNoteId: receipt.noteId, ownerUserId: receipt.userId, state: In(['delivered', 'skipped', 'permanentFailed']),
		}, { endpoint: null, isSharedInbox: null, payloadRef: null, relayId: null });
	}

	public async summarize(receiptNoteId: string, ownerUserId: string) {
		if (typeof receiptNoteId !== 'string' || !receiptNoteId || typeof ownerUserId !== 'string' || !ownerUserId) throw new Error('invalid delete delivery owner');
		const receipt = await this.db.getRepository(MiNoteDeleteReceipt).findOneBy({ noteId: receiptNoteId, userId: ownerUserId });
		if (receipt && isDeliverySettledNoteDeleteReceipt(receipt) && receipt.effects.activityPub?.summary) return receipt.effects.activityPub.summary;
		const rows = await this.db.getRepository(MiNoteDeleteDelivery).find({ where: { receiptNoteId, ownerUserId } });
		const counts = { unfinished: 0, delivered: 0, skipped: 0, permanentFailed: 0 };
		for (const row of rows) {
			if (this.unfinished(row)) counts.unfinished++;
			else counts[row.state as 'delivered' | 'skipped' | 'permanentFailed']++;
		}
		return counts;
	}
}
