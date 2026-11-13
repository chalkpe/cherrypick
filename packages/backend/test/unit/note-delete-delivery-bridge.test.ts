/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { EntityNotFoundError } from 'typeorm';
import { MiUserKeypair } from '../../src/models/UserKeypair.js';
vi.mock('../../src/core/activitypub/ApRequestService.js', () => ({ ApRequestCreator: { createDigest: (body: string) => activityPubDigest(body) } }));
vi.mock('../../src/core/activitypub/ApRendererService.js', () => ({ ApRendererService: class {} }));
import { UserKeypairService } from '../../src/core/UserKeypairService.js';
import { QueueService } from '../../src/core/QueueService.js';
import { MiUser } from '../../src/models/User.js';
import { MiNoteDeleteDelivery } from '../../src/models/NoteDeleteDelivery.js';
import { MiNoteDeleteReceipt } from '../../src/models/NoteDeleteReceipt.js';
import type { NoteDeleteDeliveryPlan } from '../../src/models/NoteDeleteReceipt.js';
import { activityPubDigest, serializeActivityPub } from '../../src/misc/activitypub-payload.js';
import type { DeliveryQueueJobData, NoteDeleteDeliveryIdentity } from '../../src/queue/types.js';
import type { NoteDeleteDeliveryResult } from '../../src/core/NoteDeleteDeliveryService.js';
import { NoteDeleteDeliveryService } from '../../src/core/NoteDeleteDeliveryService.js';

test('전달 job ID는 복합 키와 generation을 보존하고 콜론을 포함하지 않는다', () => {
	const id = { receiptNoteId: 'note', ownerUserId: 'owner', channel: 'direct' as const, targetKey: 'target', generation: 0 };
	const first = NoteDeleteDeliveryService.jobId(id);

	expect(first).toMatch(/^ndd-[a-f0-9]{64}-0$/);
	expect(NoteDeleteDeliveryService.jobId({ ...id })).toBe(first);
	expect(NoteDeleteDeliveryService.jobId({ ...id, generation: 1 })).not.toBe(first);
	expect(NoteDeleteDeliveryService.jobId({ ...id, channel: 'followers' })).not.toBe(first);
});

// DB 조건 갱신과 Redis 상태만 흉내 낸다. 실제 잠금·경쟁·재시작·HTTP 증거가 아니다.
function fixture(count = 1) {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-01-01'));
	const payload = serializeActivityPub({ type: 'Delete', id: 'urn:delete', object: 'urn:note' });
	const target = { targetKey: createHash('sha256').update('https://remote.test/inbox').digest('hex'), endpoint: 'https://remote.test/inbox', isSharedInbox: true };
	const rows: MiNoteDeleteDelivery[] = Array.from({ length: count }, (_, i) => ({
		receiptNoteId: `note-${String(i).padStart(2, '0')}`, ownerUserId: 'owner', channel: 'direct',
		...target, relayId: null, payloadRef: 'activity', state: 'pending', generation: 0, attempts: 0,
		claimVersion: 0, claimToken: null, claimUntil: null, nextAttemptAt: new Date(), lastErrorCode: null, settledAt: null,
	}));
	const receipts = rows.map(row => ({
		noteId: row.receiptNoteId, userId: row.ownerUserId, effects: {}, completedAt: null,
		snapshot: { version: 1, actor: { id: 'owner' }, note: { id: row.receiptNoteId, userId: row.ownerUserId }, delivery: { version: 2 as const, reason: 'federated' as const, directTargets: [target], followers: [] as NoteDeleteDeliveryPlan['followers'], relays: [] as NoteDeleteDeliveryPlan['relays'], activity: payload, relayUnsigned: null, relaySigned: null } },
	}));
	const state = { ownerPresent: true, ownerDbError: false, ownerIsDeleted: false, inTransaction: false, failUpdate: false, loseAddResponse: false, failAdd: false };

	function matches(row: any, where: any): boolean {
		if (Array.isArray(where)) return where.some(part => matches(row, part));
		return Object.entries(where).every(([key, value]: [string, any]) => {
			if (value?.type === 'isNull') return row[key] == null;
			if (value?.type === 'in') return value.value.includes(row[key]);
			if (value?.type === 'lessThanOrEqual') return row[key] <= value.value;
			if (value?.type === 'moreThan') return row[key] > value.value;
			if (value?.type === 'lessThan') return row[key] < value.value;
			if (value && typeof value === 'object') throw new Error(`지원하지 않는 조회 조건: ${value.type}`);
			return row[key] === value;
		});
	}

	const repository = {
		find: vi.fn(async (options: any) => rows.filter(row => matches(row, options.where)).sort((a, b) => {
			for (const [key, direction] of Object.entries(options.order ?? {})) {
				const left = String(a[key as keyof MiNoteDeleteDelivery]);
				const right = String(b[key as keyof MiNoteDeleteDelivery]);
				if (left !== right) return (left < right ? -1 : 1) * (direction === 'ASC' ? 1 : -1);
			}
			return 0;
		}).slice(0, options.take)),
		findOneBy: vi.fn(async (where: any) => structuredClone(rows.find(row => matches(row, where)) ?? null)),
		findOne: vi.fn(async (options: any) => {
			expect(state.inTransaction).toBe(true);
			expect(options.lock).toEqual({ mode: 'pessimistic_write' });
			return repository.findOneBy(options.where);
		}),
		update: vi.fn(async (where: any, values: any) => {
			expect(state.inTransaction).toBe(true);
			if (state.failUpdate) throw new Error('secret DB detail');
			const row = rows.find(row => matches(row, where));
			if (!row) return { affected: 0 };
			Object.assign(row, structuredClone(values));
			return { affected: 1 };
		}),
	};
	const getRepository = (targetClass: unknown): any => {
		if (targetClass === MiUser) return { findOne: async () => { if (state.ownerDbError) throw new Error('owner database unavailable'); return state.ownerPresent ? { id: 'owner', isDeleted: state.ownerIsDeleted } : null; } };
		if (targetClass === MiNoteDeleteDelivery) return repository;
		if (targetClass === MiNoteDeleteReceipt) return { findOneBy: async (where: any) => structuredClone(receipts.find(row => matches(row, where)) ?? null) };
		throw new Error('원본 저장소 접근 금지');
	};
	let tail = Promise.resolve();
	const db = { getRepository, transaction: (work: (manager: any) => Promise<any>) => {
		const running = tail.then(async () => {
			state.inTransaction = true;
			const before = structuredClone(rows);
			try { return await work({ getRepository }); } catch (error) {
				rows.splice(0, rows.length, ...before);
				throw error;
			} finally { state.inTransaction = false; }
		});
		tail = running.then(() => {}, () => {});
		return running;
	} };
	const jobs = new Map<string, { state: string; data: DeliveryQueueJobData }>();
	const deliverQueue = {
		getJob: vi.fn(async (id: string) => {
			expect(state.inTransaction).toBe(false);
			const job = jobs.get(id);
			return job ? { getState: async () => job.state } : null;
		}),
		add: vi.fn(async (_label: string, data: DeliveryQueueJobData, options: any) => {
			expect(state.inTransaction).toBe(false);
			if (state.failAdd) throw new Error('secret Redis detail');
			if (!jobs.has(options.jobId)) jobs.set(options.jobId, { state: 'waiting', data: structuredClone(data) });
			if (state.loseAddResponse) throw new Error('response lost');
			return jobs.get(options.jobId);
		}),
	};
	// 큐 생성자의 scheduler 등록은 실행하지 않고 실제 접수 메서드만 연결한다.
	const queue = Object.assign(Object.create(QueueService.prototype), { config: { deliverJobMaxAttempts: 7 }, deliverQueue }) as QueueService;
	const signer = { prepareRelaySignedPayload: vi.fn(async () => {
		expect(state.inTransaction).toBe(false);
		return null;
	}) };
	const createService = () => new NoteDeleteDeliveryService(db as any, queue, signer as any, { getUserKeypairAvailability: async () => ({ available: false }) } as any);
	const identity = (index = 0): NoteDeleteDeliveryIdentity => {
		const row = rows[index];
		return { receiptNoteId: row.receiptNoteId, ownerUserId: row.ownerUserId, channel: row.channel, targetKey: row.targetKey, generation: row.generation };
	};
	return { rows, receipts, jobs, state, repository, deliverQueue, queue, signer, identity, createService };
}

afterEach(() => vi.useRealTimers());

test('원본 없는 DB scan이 실제 QueueService로 식별자만 기존 옵션으로 접수한다', async () => {
	const f = fixture();
	const service = f.createService();

	expect(await service.scan()).toBe(1);
	const id = NoteDeleteDeliveryService.jobId(f.identity());
	const job = f.jobs.get(id)!;
	expect(JSON.parse(JSON.stringify(job.data))).toEqual({ noteDeleteDelivery: f.identity() });
	expect(f.deliverQueue.add.mock.calls[0][0]).toBe('note-delete-delivery');
	expect(JSON.stringify(f.deliverQueue.add.mock.calls[0])).not.toContain(f.rows[0].endpoint);
	expect(f.deliverQueue.add.mock.calls[0][2]).toEqual({ jobId: id, attempts: 7, backoff: { type: 'custom' }, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } });
	expect(f.rows[0].state).toBe('pending');
	expect(f.receipts[0].effects).toEqual({});
	expect(f.receipts[0].completedAt).toBeNull();
	expect(await f.createService().scan()).toBe(0);
	expect(f.deliverQueue.add).toHaveBeenCalledTimes(1);
});

test('일반 deliver 호출자는 전달 의무 필드 없이 같은 옵션을 사용한다', async () => {
	const f = fixture();

	await f.queue.deliver({ id: 'ordinary' }, { type: 'Delete' } as any, 'https://remote.test/inbox', false);

	const data = f.deliverQueue.add.mock.calls[0][1];
	const options = f.deliverQueue.add.mock.calls[0][2];
	expect(data).not.toHaveProperty('noteDeleteDelivery');
	expect(options.jobId).toBeUndefined();
	expect(options.attempts).toBe(7);
	expect(options.backoff).toEqual({ type: 'custom' });
});

test('enqueue 응답 유실은 유효 job을 다시 접수하거나 generation을 올리지 않는다', async () => {
	const f = fixture();
	f.state.loseAddResponse = true;

	expect(await f.createService().scan()).toBe(0);
	expect(f.jobs.size).toBe(1);
	vi.advanceTimersByTime(60_001);
	expect(await f.createService().scan()).toBe(0);
	expect(f.rows[0].generation).toBe(0);
	expect(f.deliverQueue.add).toHaveBeenCalledTimes(1);
});

test.each(['missing', 'completed', 'failed'] as const)('DB ack 없는 %s job은 lease 만료 뒤 새 안정 ID로 재접수한다', async status => {
	const f = fixture();
	await f.createService().scan();
	const oldId = NoteDeleteDeliveryService.jobId(f.identity());
	if (status === 'missing') f.jobs.delete(oldId);
	else f.jobs.get(oldId)!.state = status;

	expect(await f.createService().scan()).toBe(0);
	vi.advanceTimersByTime(60_001);
	expect(await f.createService().scan()).toBe(1);
	expect(f.rows[0].generation).toBe(1);
	expect(f.jobs.has(NoteDeleteDeliveryService.jobId(f.identity()))).toBe(true);
	expect(f.rows[0].state).toBe('pending');
});

test('add 실패만으로 generation을 올리지 않으며 만료 뒤 DB에서 재발견한다', async () => {
	const f = fixture();
	f.state.failAdd = true;
	const service = f.createService();

	expect(await service.scan()).toBe(0);
	expect(f.rows[0].generation).toBe(0);
	expect(await service.scan()).toBe(0);
	f.state.failAdd = false;
	vi.advanceTimersByTime(60_001);
	expect(await service.scan()).toBe(1);
	expect(f.rows[0].generation).toBe(1);
});

test.each(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'])('유효 %s job은 lease 만료에도 generation과 접수 횟수를 유지한다', async state => {
	const f = fixture();
	await f.createService().scan();
	f.jobs.get(NoteDeleteDeliveryService.jobId(f.identity()))!.state = state;
	vi.advanceTimersByTime(120_000);

	expect(await f.createService().scan()).toBe(0);
	expect(f.rows[0].generation).toBe(0);
	expect(f.deliverQueue.add).toHaveBeenCalledTimes(1);
});

test('한 scan은 열 개만 읽고 앞쪽 활성 job 때문에 뒤쪽 의무가 굶지 않는다', async () => {
	const f = fixture(12);
	const service = f.createService();

	expect(await service.scan()).toBe(10);
	expect(await service.scan()).toBe(2);
	vi.advanceTimersByTime(60_001);
	expect(await service.scan()).toBe(0);
	expect(await service.scan()).toBe(0);
	expect(f.jobs.size).toBe(12);
	expect(f.repository.find.mock.calls.every(([options]) => options.take === 10)).toBe(true);
});

test('동시 접수 CAS는 한 generation과 한 add만 예약한다', async () => {
	const f = fixture();
	const service = f.createService();

	expect(await Promise.all([service.enqueue(f.identity()), service.enqueue(f.identity())])).toEqual([true, false]);
	expect(f.deliverQueue.add).toHaveBeenCalledTimes(1);
});

test('소유자·대상·payload 불일치는 접수와 전송 전 검증에서 거부한다', async () => {
	const f = fixture();
	const service = f.createService();

	expect(await service.enqueue({ ...f.identity(), ownerUserId: 'other' })).toBe(false);
	f.rows[0].endpoint = 'https://wrong.test/inbox';
	await expect(service.enqueue(f.identity())).rejects.toThrow('delete delivery');
	f.rows[0].endpoint = 'https://remote.test/inbox';
	await service.enqueue(f.identity());
	const held = await service.claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity()));
	f.receipts[0].snapshot.delivery.activity.content = 'tampered';
	await expect(service.validateBeforeSend(held!.claim)).rejects.toThrow('payload');
	expect(f.rows[0].attempts).toBe(0);
	expect(f.rows[0].settledAt).toBeNull();
});

test('전송 전 검증은 job payload 대신 DB 계획을 반환하고 잘못된 job ID는 claim하지 않는다', async () => {
	const f = fixture();
	const service = f.createService();
	await service.scan();
	const identity = f.identity();

	expect(await service.claim(identity, 'external-job')).toBeNull();
	const held = await service.claim(identity, NoteDeleteDeliveryService.jobId(identity));
	const job = f.jobs.get(NoteDeleteDeliveryService.jobId(identity))!;
	Object.assign(job.data, { content: 'external secret', to: 'https://wrong.test' });
	const data = await service.validateBeforeSend(held!.claim);

	expect(data!.content).toBe(f.receipts[0].snapshot.delivery.activity.content);
	expect(data!.to).toBe(f.rows[0].endpoint);
	expect(await service.claim(identity, NoteDeleteDeliveryService.jobId(identity))).toBeNull();
	expect(await service.validateBeforeSend({ ...held!.claim, ownerUserId: 'other' })).toBeNull();
});

test('lease 만료·새 generation 뒤 늦은 ack와 이전 job은 상태를 덮지 못한다', async () => {
	const f = fixture();
	const service = f.createService();
	await service.scan();
	const oldIdentity = f.identity();
	const oldId = NoteDeleteDeliveryService.jobId(oldIdentity);
	const old = await service.claim(oldIdentity, oldId);
	vi.advanceTimersByTime(60_001);

	expect(await service.acknowledge(old!.claim, { outcome: 'delivered' })).toBe(false);
	f.jobs.delete(oldId);
	expect(await service.scan()).toBe(1);
	const held = await service.claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity()));
	const saved = structuredClone(f.rows[0]);
	expect(await service.acknowledge(old!.claim, { outcome: 'permanentFailed', code: 'remote_permanent' })).toBe(false);
	expect(await service.claim(oldIdentity, oldId)).toBeNull();
	expect(f.rows[0]).toEqual(saved);
	expect(await service.acknowledge(held!.claim, { outcome: 'delivered' })).toBe(true);
});

test('같은 generation의 재claim도 token/version으로 늦은 ack를 차단하며 lease를 갱신한다', async () => {
	const f = fixture();
	const service = f.createService();
	await service.scan();
	const identity = f.identity();
	const id = NoteDeleteDeliveryService.jobId(identity);
	const old = await service.claim(identity, id);
	vi.advanceTimersByTime(60_001);
	const held = await service.claim(identity, id);

	expect(held!.claim.claimVersion).toBeGreaterThan(old!.claim.claimVersion);
	expect(await service.acknowledge(old!.claim, { outcome: 'delivered' })).toBe(false);
	vi.advanceTimersByTime(50_000);
	expect(await service.renew(held!.claim)).toBe(true);
	vi.advanceTimersByTime(20_000);
	expect(await service.validateBeforeSend(held!.claim)).not.toBeNull();
});

const terminalResults: NoteDeleteDeliveryResult[] = [
	{ outcome: 'delivered' }, { outcome: 'skipped', code: 'blocked' }, { outcome: 'permanentFailed', code: 'remote_permanent' },
];

test.each(terminalResults)('$outcome는 별도 terminal 상태로 정산하며 job 제거 뒤 재접수하지 않는다', async result => {
	const f = fixture();
	const service = f.createService();
	await service.scan();
	const held = await service.claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity()));

	expect(await service.acknowledge(held!.claim, result)).toBe(true);
	f.jobs.clear();
	vi.advanceTimersByTime(120_000);
	expect(await service.scan()).toBe(0);
	expect(f.rows[0].state).toBe(result.outcome);
	expect(f.rows[0].settledAt).toBeInstanceOf(Date);
	const counts = await service.summarize(f.rows[0].receiptNoteId, 'owner');
	expect(counts).toEqual({ unfinished: 0, delivered: result.outcome === 'delivered' ? 1 : 0, skipped: result.outcome === 'skipped' ? 1 : 0, permanentFailed: result.outcome === 'permanentFailed' ? 1 : 0 });
	expect(await service.summarize(f.rows[0].receiptNoteId, 'other')).toEqual({ unfinished: 0, delivered: 0, skipped: 0, permanentFailed: 0 });
	expect(f.receipts[0].completedAt).toBeNull();
});

test('키 오류와 일시 원격 실패는 pending으로 남기고 원격 시도만 예산에 기록한다', async () => {
	const f = fixture();
	const service = f.createService();
	await service.scan();
	const identity = f.identity();
	const id = NoteDeleteDeliveryService.jobId(identity);
	const first = await service.claim(identity, id);

	expect(await service.acknowledge(first!.claim, { outcome: 'temporaryFailed', code: 'key_unavailable', nextAttemptAt: new Date(Date.now() + 5000) })).toBe(true);
	expect(f.rows[0].attempts).toBe(0);
	expect(await service.claim(identity, id)).toBeNull();
	vi.advanceTimersByTime(5000);
	const second = await service.claim(identity, id);
	expect(await service.recordRemoteAttempt(second!.claim, 7)).toEqual({ outcome: 'reserved', attempts: 1 });
	expect(await service.acknowledge(second!.claim, { outcome: 'temporaryFailed', code: 'remote_retryable', nextAttemptAt: new Date(Date.now() + 5000) })).toBe(true);
	expect(f.rows[0].state).toBe('pending');
	expect(f.rows[0].settledAt).toBeNull();
	expect((await service.summarize(f.rows[0].receiptNoteId, 'owner')).unfinished).toBe(1);
});

test('HTTP 성공 뒤 DB ack 실패를 성공으로 만들지 않고 재전송 가능 상태를 유지한다', async () => {
	const f = fixture();
	const service = f.createService();
	await service.scan();
	const held = await service.claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity()));
	f.state.failUpdate = true;

	await expect(service.acknowledge(held!.claim, { outcome: 'delivered' })).rejects.toThrow('DB');
	expect(f.rows[0].state).toBe('running');
	expect(JSON.stringify(f.rows)).not.toContain('secret');
	f.state.failUpdate = false;
	f.jobs.clear();
	vi.advanceTimersByTime(60_001);
	expect(await service.scan()).toBe(1);
	expect(f.rows[0].generation).toBe(1);
});

test('허용되지 않은 결과·민감 오류 원문은 DB에 저장하지 않는다', async () => {
	const f = fixture();
	const service = f.createService();
	await service.scan();
	const held = await service.claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity()));

	await expect(service.acknowledge(held!.claim, { outcome: 'skipped', code: 'token=secret' } as any)).rejects.toThrow('result');
	await expect(service.acknowledge(held!.claim, { outcome: 'temporaryFailed', code: 'remote_permanent', nextAttemptAt: new Date(Date.now() + 5000) } as any)).rejects.toThrow('result');
	expect(JSON.stringify(f.rows)).not.toContain('secret');
	expect(f.rows[0].state).toBe('running');
});

test('누락된 소유자·복합 키·generation은 TypeORM의 undefined 조건 생략 전에 거부한다', async () => {
	const f = fixture();
	const service = f.createService();

	for (const identity of [
		{ ...f.identity(), ownerUserId: undefined }, { ...f.identity(), targetKey: undefined },
		{ ...f.identity(), channel: 'unknown' }, { ...f.identity(), generation: -1 },
	]) {
		await expect(service.enqueue(identity as any)).rejects.toThrow('identity');
	}
	expect(f.repository.findOneBy).not.toHaveBeenCalled();
	expect(f.deliverQueue.add).not.toHaveBeenCalled();
});

test('relay 접수는 transaction 밖에서 준비한 뒤 반환값 대신 DB 최초 서명 문자열만 읽는다', async () => {
	const f = fixture();
	Object.assign(f.rows[0], { channel: 'relay', targetKey: 'relay', relayId: 'relay', payloadRef: 'relaySigned' });
	const plan = f.receipts[0].snapshot.delivery as any;
	plan.relays = [{ endpoint: f.rows[0].endpoint, isSharedInbox: true, targetKey: 'relay', relayId: 'relay' }];
	const first = serializeActivityPub({ signature: 'first-saved' });
	f.signer.prepareRelaySignedPayload.mockImplementationOnce(async () => {
		expect(f.state.inTransaction).toBe(false);
		plan.relaySigned = first;
		return serializeActivityPub({ signature: 'losing-result' }) as any;
	});

	expect(await f.createService().scan()).toBe(1);
	expect(f.rows[0].state).toBe('pending');
	expect((await f.createService().claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity())))!.data.content).toBe(first.content);
});

test('키·Redis 상태 조회 장애는 영구 실패나 성공으로 정산하지 않는다', async () => {
	const f = fixture();
	Object.assign(f.rows[0], { channel: 'relay', targetKey: 'relay', relayId: 'relay', payloadRef: 'relaySigned' });
	f.signer.prepareRelaySignedPayload.mockRejectedValueOnce(new Error('secret key detail'));

	expect(await f.createService().scan()).toBe(0);
	expect(f.rows[0].claimVersion).toBe(0);
	expect(f.rows[0].attempts).toBe(0);
	f.deliverQueue.getJob.mockRejectedValueOnce(new Error('secret Redis detail'));
	expect(await f.createService().scan()).toBe(0);
	expect(f.rows[0].generation).toBe(0);
	expect(f.rows[0].state).toBe('pending');
	expect(JSON.stringify(f.rows)).not.toContain('secret');
});

test('기존 원격 시도 한도는 generation을 넘어 유지하며 키·접수 오류로 소모하지 않는다', async () => {
	const f = fixture();
	f.rows[0].attempts = 7;
	const service = f.createService();
	await service.scan();
	const held = await service.claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity()));

	expect(await service.recordRemoteAttempt(held!.claim, 7)).toEqual({ outcome: 'exhausted', attempts: 7 });
	expect(f.rows[0].attempts).toBe(7);
	expect(f.rows[0].state).toBe('running');
	expect(await service.acknowledge(held!.claim, { outcome: 'permanentFailed', code: 'remote_budget_exhausted' })).toBe(true);
	expect(f.rows[0].state).toBe('permanentFailed');
});

test('영수증의 actor와 원래 노트 소유자 불일치는 고정 전달 계획이 있어도 거부한다', async () => {
	const f = fixture();
	f.receipts[0].snapshot.note.userId = 'other';

	expect(await f.createService().scan()).toBe(0);
	expect(f.rows[0].claimVersion).toBe(0);
	expect(f.jobs.size).toBe(0);
});

test.each(['all', 'delivery'] as const)('%s 종료 snapshot은 의무가 running으로 남아 있어도 payload 전에 claim·전송·ack를 차단한다', async state => {
	const f = fixture();
	const service = f.createService();
	const claimed = await service.claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity()));
	const row = f.rows[0];
	Object.assign(f.receipts[0], { snapshot: state === 'all' ? { version: 2, state: 'settled' } : { ...f.receipts[0].snapshot, version: 3, state: 'delivery_settled', delivery: null }, completedAt: state === 'all' ? new Date() : null, effects: { activityPub: { outcome: 'permanentFailed', summary: { unfinished: 0, delivered: 0, skipped: 0, permanentFailed: 1 } } } });
	const before = structuredClone(f.receipts);

	expect(await service.validateBeforeSend(claimed!.claim)).toBeNull();
	expect(await service.recordRemoteAttempt(claimed!.claim, 12)).toBeNull();
	expect(await service.acknowledge(claimed!.claim, { outcome: 'delivered' })).toBe(false);
	expect(await service.renew(claimed!.claim)).toBe(false);
	row.claimUntil = new Date(0);
	expect(await service.enqueue(f.identity())).toBe(false);
	expect(await service.claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity()))).toBeNull();

	expect(f.deliverQueue.add).not.toHaveBeenCalled();
	expect(f.signer.prepareRelaySignedPayload).not.toHaveBeenCalled();
	expect(row.attempts).toBe(0);
	expect(f.receipts).toEqual(before);
});

test('미지원 미완료 snapshot은 종료로 정산하지 않고 검증 오류로 남긴다', async () => {
	const f = fixture();
	(f.receipts[0].snapshot as any).version = 999;

	await expect(f.createService().claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity()))).rejects.toThrow('unsupported');

	expect(f.rows[0].state).toBe('pending');
	expect(f.receipts[0].completedAt).toBeNull();
});

test('rollback으로 정산 전달 행이 없어져도 늦은 식별자 job을 다시 만들지 않는다', async () => {
	const f = fixture();
	const identity = f.identity();
	f.rows.splice(0);

	expect(await f.createService().claim(identity, NoteDeleteDeliveryService.jobId(identity))).toBeNull();
	expect(await f.createService().enqueue(identity)).toBe(false);
	expect(f.deliverQueue.add).not.toHaveBeenCalled();
});

test('만료 의무는 원래 발신자의 물리 삭제만 owner_removed로 정산하고 시도 수를 보존한다', async () => {
	const f = fixture();
	f.state.ownerPresent = false;
	f.rows[0].attempts = 2;

	expect(await f.createService().enqueue(f.identity())).toBe(false);

	expect(f.rows[0]).toMatchObject({ state: 'permanentFailed', lastErrorCode: 'owner_removed', attempts: 2 });
	expect(f.deliverQueue.add).not.toHaveBeenCalled();
});

test.each(['present', 'isDeleted', 'dbError', 'activeClaim', 'future', 'staleClaim'] as const)('%s는 owner_removed 판정이나 다른 claim 탈취를 만들지 않는다', async phase => {
	const f = fixture();
	f.state.ownerPresent = phase === 'present' || phase === 'isDeleted';
	f.state.ownerIsDeleted = phase === 'isDeleted';
	f.state.ownerDbError = phase === 'dbError';
	if (phase === 'activeClaim' || phase === 'staleClaim') Object.assign(f.rows[0], { state: 'running', claimToken: 'other', claimVersion: 2, claimUntil: new Date(Date.now() + 60_000) });
	if (phase === 'future') f.rows[0].nextAttemptAt = new Date(Date.now() + 60_000);
	const before = structuredClone(f.rows[0]);
	const service = f.createService();
	const work = service.settleRemovedOwner(f.identity(), phase === 'staleClaim' ? { ...f.identity(), claimToken: 'old', claimVersion: 1 } : undefined);

	if (phase === 'dbError') await expect(work).rejects.toThrow('database unavailable');
	else expect(await work).toBe(false);

	expect(f.rows[0]).toEqual(before);
});

test('자기 유효 claim의 준비 실패는 owner 소실만 정산하고 늦은 ack와 예약을 막는다', async () => {
	const f = fixture();
	const service = f.createService();
	const claim = (await service.claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity())))!.claim;
	f.state.ownerPresent = false;

	expect(await service.settleRemovedOwner(claim, claim)).toBe(true);
	expect(await service.recordRemoteAttempt(claim, 12)).toBeNull();
	expect(await service.acknowledge(claim, { outcome: 'delivered' })).toBe(false);
	expect(f.rows[0]).toMatchObject({ state: 'permanentFailed', lastErrorCode: 'owner_removed', attempts: 0 });
});

test('relay 발신자가 소실되면 미서명 고정 입력으로 의무를 확인하고 키 조회 전에 정산한다', async () => {
	const f = fixture();
	f.state.ownerPresent = false;
	Object.assign(f.rows[0], { channel: 'relay', targetKey: 'relay', relayId: 'relay', payloadRef: 'relaySigned' });
	Object.assign(f.receipts[0].snapshot.delivery, {
		relays: [{ endpoint: f.rows[0].endpoint, isSharedInbox: true, targetKey: 'relay', relayId: 'relay' }],
		relayUnsigned: serializeActivityPub({ type: 'Delete' }),
	});

	expect(await f.createService().enqueue(f.identity())).toBe(false);

	expect(f.rows[0]).toMatchObject({ state: 'permanentFailed', lastErrorCode: 'owner_removed', attempts: 0 });
	expect(f.signer.prepareRelaySignedPayload).not.toHaveBeenCalled();
});

test('전달 입력과 행이 제거된 뒤에도 보존한 전달 요약을 0건으로 바꾸지 않는다', async () => {
	const f = fixture();
	const summary = { unfinished: 0, delivered: 0, skipped: 0, permanentFailed: 1 };
	Object.assign(f.receipts[0], { snapshot: { ...f.receipts[0].snapshot, version: 3, state: 'delivery_settled', delivery: null }, effects: { activityPub: { completedAt: new Date().toISOString(), outcome: 'permanentFailed', summary } } });
	const identity = f.identity();
	f.rows.splice(0);

	expect(await f.createService().summarize(identity.receiptNoteId, identity.ownerUserId)).toEqual(summary);
});

test.each(['memory', 'redis'] as const)('실제 %s 키 캐시가 남은 발신자는 DB 행 소실 뒤에도 접수한다', async layer => {
	const f = fixture();
	const values = new Map<string, string>();
	const redis = {
		get: async (key: string) => values.get(key) ?? null,
		set: async (key: string, value: string) => { values.set(key, value); },
	};
	const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const keypair = { userId: 'owner', privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
	let keyPresent = true;
	const repository = { findOneByOrFail: vi.fn(async () => {
		expect(f.state.inTransaction).toBe(false);
		if (!keyPresent) throw new Error('keypair row absent');
		return keypair;
	}) };
	const first = new UserKeypairService(redis as any, repository as any);
	const second = new UserKeypairService(redis as any, repository as any);
	try {
		await first.getUserKeypair('owner');
		keyPresent = false;
		f.state.ownerPresent = false;
		const keys = layer === 'memory' ? first : second;
		const cached = await keys.getUserKeypair('owner');
		expect(cached.privateKey === keypair.privateKey).toBe(true);
		expect(repository.findOneByOrFail).toHaveBeenCalledTimes(1);
		const service = f.createService();
		Object.assign(service, { userKeypairService: keys });

		const accepted = await service.enqueue(f.identity());
		expect(f.rows[0].lastErrorCode).toBeNull();
		expect(accepted).toBe(true);
		expect(f.jobs.size).toBe(1);
	} finally {
		first.dispose();
		second.dispose();
	}
});

test.each(['peer', 'expiredPeer', 'generation', 'terminal', 'ownerRestored', 'claimExpires', 'deliverySettled'] as const)('키 조회 중 %s 변경을 최신 정산에서 재검증한다', async phase => {
	const f = fixture();
	f.state.ownerPresent = false;
	const service = f.createService();
	const held = phase === 'claimExpires' ? await service.claim(f.identity(), NoteDeleteDeliveryService.jobId(f.identity())) : null;
	const before = structuredClone(f.rows[0]);
	Object.assign(service, { userKeypairService: { getUserKeypairAvailability: async () => {
		expect(f.state.inTransaction).toBe(false);
		if (phase === 'peer' || phase === 'expiredPeer') Object.assign(f.rows[0], { state: 'running', claimToken: 'peer', claimVersion: before.claimVersion + 1, claimUntil: new Date(Date.now() + (phase === 'peer' ? 60_000 : -1)) });
		if (phase === 'generation') f.rows[0].generation++;
		if (phase === 'terminal') f.rows[0].state = 'delivered';
		if (phase === 'ownerRestored') f.state.ownerPresent = true;
		if (phase === 'claimExpires') vi.advanceTimersByTime(60_001);
		if (phase === 'deliverySettled') Object.assign(f.receipts[0], { snapshot: { version: 3, state: 'delivery_settled', delivery: null } });
		return { available: false };
	} } });

	expect(await service.settleRemovedOwner(f.identity(), held?.claim)).toBe(false);
	expect(f.rows[0].lastErrorCode).toBeNull();
	expect(f.rows[0].attempts).toBe(0);
	if (phase === 'deliverySettled') expect(f.receipts[0].snapshot.delivery).toBeNull();
});

test.each(['missing', 'ownerPresent', 'peerClaim', 'temporary'] as const)('실제 키 조회의 %s 경계에서 정산 자격을 유지한다', async phase => {
	const f = fixture();
	f.state.ownerPresent = phase === 'ownerPresent';
	if (phase === 'peerClaim') Object.assign(f.rows[0], { state: 'running', claimToken: 'peer', claimVersion: 1, claimUntil: new Date(Date.now() + 60_000) });
	const before = structuredClone(f.rows[0]);
	const failure = phase === 'temporary' ? new Error('key repository unavailable') : new EntityNotFoundError(MiUserKeypair, { userId: 'owner' });
	const repository = { findOneByOrFail: vi.fn(async () => {
		expect(f.state.inTransaction).toBe(false);
		throw failure;
	}) };
	const keys = new UserKeypairService({ get: async () => null } as any, repository as any);
	const service = f.createService();
	Object.assign(service, { userKeypairService: keys });

	try {
		const work = service.settleRemovedOwner(f.identity());
		if (phase === 'temporary') await expect(work).rejects.toBe(failure);
		else expect(await work).toBe(phase === 'missing');

		if (phase === 'missing') {
			expect(repository.findOneByOrFail).toHaveBeenCalledTimes(1);
			expect(f.rows[0]).toMatchObject({ state: 'permanentFailed', lastErrorCode: 'owner_removed', attempts: before.attempts });
		} else {
			expect(f.rows[0]).toEqual(before);
		}
	} finally {
		keys.dispose();
	}
});

// 뒤쪽 유입이 커서를 끝없이 밀어도 앞쪽 재시도를 재발견해야 한다.
test('매 scan 뒤쪽 새 due 열 개가 생겨도 앞쪽 재시도를 유한 순회 안에 발견한다', async () => {
	const f = fixture(10);
	const service = f.createService();
	const first = f.identity();
	await service.scan();
	const held = await service.claim(first, NoteDeleteDeliveryService.jobId(first));
	expect(held).not.toBeNull();
	await service.acknowledge(held!.claim, { outcome: 'temporaryFailed', code: 'remote_retryable', nextAttemptAt: new Date(Date.now() + 1000) });
	f.jobs.get(NoteDeleteDeliveryService.jobId(first))!.state = 'completed';

	for (let pass = 0; pass < 8; pass++) {
		for (let offset = 0; offset < 10; offset++) {
			const noteId = `tail-${String(pass * 10 + offset).padStart(3, '0')}`;
			f.rows.push({ ...structuredClone(f.rows[0]), receiptNoteId: noteId, generation: 0, claimVersion: 0, nextAttemptAt: new Date(), lastErrorCode: null });
			f.receipts.push({ ...structuredClone(f.receipts[0]), noteId, snapshot: { ...structuredClone(f.receipts[0].snapshot), note: { id: noteId, userId: 'owner' } } });
		}
		if (pass === 1) vi.advanceTimersByTime(1000);
		const before = f.deliverQueue.add.mock.calls.length;

		await service.scan();

		expect(f.deliverQueue.add.mock.calls.length - before).toBeLessThanOrEqual(10);
		if (pass === 0) expect(f.rows[0].generation).toBe(0);
		if (pass === 4) expect(f.rows[0].generation).toBe(1);
	}

	expect(f.rows[0].generation).toBe(1);
	expect(f.jobs.has(NoteDeleteDeliveryService.jobId(f.identity()))).toBe(true);
	expect(f.rows[0].state).toBe('pending');
	expect(f.receipts[0].effects).toEqual({});
	expect(f.receipts[0].completedAt).toBeNull();
});

test('앞 열 개의 live job과 반복 실패가 있어도 중간과 뒤쪽 의무를 이어 발견한다', async () => {
	const f = fixture(45);
	const service = f.createService();
	await service.scan();
	const firstJobs = structuredClone([...f.jobs]);
	const firstRows = structuredClone(f.rows.slice(0, 10));
	f.rows[10].endpoint = 'https://invalid.test/inbox';
	const enqueue = vi.spyOn(service, 'enqueue');

	for (let pass = 0; pass < 12; pass++) {
		enqueue.mockClear();
		await service.scan();

		expect(enqueue.mock.calls.length).toBeLessThanOrEqual(10);
		const keys = enqueue.mock.calls.map(([id]) => JSON.stringify([id.receiptNoteId, id.channel, id.targetKey]));
		expect(new Set(keys).size).toBe(keys.length);
	}

	expect(f.jobs.size).toBe(44);
	expect([...f.jobs].slice(0, 10)).toEqual(firstJobs);
	expect(f.rows.slice(0, 10)).toEqual(firstRows);
	expect(f.rows[10].claimVersion).toBe(0);
	expect(f.rows[10].settledAt).toBeNull();
});

test('양방향 빈 결과와 끝 도달 뒤 새 due 및 재시작은 canonical 상태를 보존한다', async () => {
	const f = fixture(23);
	const service = f.createService();
	for (const row of f.rows) row.nextAttemptAt = new Date(Date.now() + 1000);
	const before = structuredClone(f.rows);

	expect(await service.scan()).toBe(0);
	expect(await service.scan()).toBe(0);
	expect(f.rows).toEqual(before);
	vi.advanceTimersByTime(1000);
	for (let pass = 0; pass < 8; pass++) await service.scan();

	expect(f.jobs.size).toBe(23);
	const queued = structuredClone(f.rows);
	for (let pass = 0; pass < 8; pass++) expect(await service.scan()).toBe(0);
	expect(await f.createService().scan()).toBe(0);
	expect(f.rows).toEqual(queued);
	expect(f.receipts.every(receipt => receipt.completedAt === null && Object.keys(receipt.effects).length === 0)).toBe(true);
});

test('접수 실패한 앞쪽 의무는 lease 만료 뒤 양방향 순회에서 다시 접수한다', async () => {
	const f = fixture(35);
	const service = f.createService();
	f.state.failAdd = true;

	expect(await service.scan()).toBe(0);
	expect(f.rows[0].claimVersion).toBe(1);
	expect(f.jobs.size).toBe(0);
	f.state.failAdd = false;
	vi.advanceTimersByTime(60_001);
	for (let pass = 0; pass < 10; pass++) await service.scan();

	expect(f.jobs.size).toBe(35);
	expect(f.rows[0].generation).toBe(1);
	expect(f.rows.every(row => row.state === 'pending' && row.settledAt === null)).toBe(true);
});

test('같은 영수증의 channel과 targetKey 경계도 양방향으로 빠짐없이 순회한다', async () => {
	const f = fixture(36);
	const service = f.createService();
	const receipt = f.receipts[0];
	const plan = receipt.snapshot.delivery as NoteDeleteDeliveryPlan;
	plan.directTargets = [];
	for (let i = 0; i < f.rows.length; i++) {
		const row = f.rows[i];
		row.receiptNoteId = receipt.noteId;
		row.channel = i < 18 ? 'direct' : 'followers';
		row.endpoint = `https://remote.test/inbox-${i}`;
		row.targetKey = createHash('sha256').update(row.endpoint).digest('hex');
		const target = { targetKey: row.targetKey, endpoint: row.endpoint!, isSharedInbox: row.isSharedInbox! };
		if (row.channel === 'direct') plan.directTargets.push(target);
		else plan.followers.push(target);
	}

	for (let pass = 0; pass < 10; pass++) await service.scan();

	expect(f.jobs.size).toBe(36);
	expect(f.rows.every(row => row.claimVersion === 1 && row.state === 'pending')).toBe(true);
	expect(receipt.effects).toEqual({});
});
