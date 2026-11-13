/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../src/core/UtilityService.js', () => ({ UtilityService: class {} }));
vi.mock('../../src/core/HttpRequestService.js', () => ({ HttpRequestService: class {} }));
vi.mock('../../src/core/FederatedInstanceService.js', () => ({ FederatedInstanceService: class {} }));
vi.mock('../../src/core/FetchInstanceMetadataService.js', () => ({ FetchInstanceMetadataService: class {} }));
vi.mock('../../src/core/NoteDeleteDeliveryService.js', () => ({ NoteDeleteDeliveryService: class {} }));
vi.mock('../../src/core/chart/charts/instance.js', () => ({ default: class {} }));
vi.mock('../../src/core/chart/charts/ap-request.js', () => ({ default: class {} }));
vi.mock('../../src/core/chart/charts/federation.js', () => ({ default: class {} }));
import { DeliverProcessorService } from '../../src/queue/processors/DeliverProcessorService.js';
import { ApRequestService } from '../../src/core/activitypub/ApRequestService.js';
import { QueueService } from '../../src/core/QueueService.js';
import { UserKeypairService } from '../../src/core/UserKeypairService.js';
import { EntityNotFoundError } from 'typeorm';
import { MiUserKeypair } from '../../src/models/UserKeypair.js';
import { StatusError } from '../../src/misc/status-error.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
afterEach(() => vi.useRealTimers());

function fixture(durable = true) {
	const identity = { receiptNoteId: 'note', ownerUserId: 'owner', channel: 'direct', targetKey: 'target', generation: 0 };
	const data = { user: { id: 'owner' }, to: 'https://remote.test/inbox', content: '{"type":"Delete"}', isSharedInbox: true, ...(durable ? { noteDeleteDelivery: identity } : {}) };
	const claim = { ...identity, claimToken: 'token', claimVersion: 1 };
	const bridge = { settleRemovedOwner: vi.fn(async () => false), claim: vi.fn(async () => ({ claim, data })), validateBeforeSend: vi.fn(async () => data), recordRemoteAttempt: vi.fn(async () => ({ outcome: 'reserved', attempts: 1 })), renew: vi.fn(async () => true), acknowledge: vi.fn(async () => true) };
	const key = vi.fn(async () => ({ privateKey }));
	const http = vi.fn(async () => ({}));
	const ap = new ApRequestService({ url: 'https://local.test' } as any, { getUserKeypair: key } as any, { send: http } as any, { getLogger: () => ({}) } as any, {} as any);
	const utility = { isFederationAllowedUri: vi.fn(() => true), toPuny: (host: string) => host, isDeliverSuspendedSoftware: vi.fn(() => false) };
	const instances = { find: vi.fn(async () => [] as any[]) };
	const federation = { fetch: vi.fn(async () => null as any), fetchOrRegister: vi.fn(async () => ({ id: 'i', isNotResponding: true })), update: vi.fn() };
	const charts = { deliverSucc: vi.fn(), deliverFail: vi.fn() };
	const config = { deliverJobMaxAttempts: undefined as number | undefined };
	const processor = new DeliverProcessorService({} as any, instances as any, utility as any, federation as any, {} as any, ap, {} as any, charts as any, { deliverd: vi.fn() } as any, { logger: { createSubLogger: () => ({}) } } as any, bridge as any, config as any);
	const job = { id: 'job', data: durable ? { ...data, to: 'https://untrusted.test', content: 'untrusted' } : data } as any;
	return { config, processor, job, data, bridge, key, http, utility, instances, federation, charts, ap };
}

test('DB payload로 기존 서명과 HTTP 경로를 실행하고 ack한다', async () => {
	const f = fixture();
	await f.processor.process(f.job);

	expect(f.http).toHaveBeenCalledWith(f.data.to, expect.objectContaining({ body: f.data.content, headers: expect.objectContaining({ signature: expect.any(String) }) }));
	expect(f.bridge.recordRemoteAttempt).toHaveBeenCalledWith(expect.anything(), 12);
	expect(f.bridge.acknowledge).toHaveBeenCalledWith(expect.anything(), { outcome: 'delivered' });
});

test.each(['blocked', 'suspended', 'software_suspended'])('정책 제외 %s는 HTTP 없이 ack한다', async code => {
	const f = fixture();
	if (code === 'blocked') f.utility.isFederationAllowedUri.mockReturnValue(false);
	if (code === 'suspended') f.instances.find.mockResolvedValue([{ host: 'remote.test' }]);
	if (code === 'software_suspended') { f.federation.fetch.mockResolvedValue({}); f.utility.isDeliverSuspendedSoftware.mockReturnValue(true); }
	await f.processor.process(f.job);

	expect(f.http).not.toHaveBeenCalled();
	expect(f.bridge.recordRemoteAttempt).not.toHaveBeenCalled();
	expect(f.bridge.acknowledge).toHaveBeenCalledWith(expect.anything(), { outcome: 'skipped', code });
});

test.each([429, 500, 400, 410])('HTTP %s 결과를 구분한다', async status => {
	const f = fixture();
	f.http.mockRejectedValue(new StatusError('remote', status));
	await f.processor.process(f.job);

	expect(f.bridge.acknowledge).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(status === 429 || status === 500 ? { outcome: 'temporaryFailed', code: 'remote_retryable', nextAttemptAt: expect.any(Date) } : { outcome: 'permanentFailed', code: 'remote_permanent' }));
	expect(f.bridge.recordRemoteAttempt).toHaveBeenCalledTimes(1);
});

test('키 실패는 원격 시도로 세지 않는다', async () => {
	const f = fixture();
	f.key.mockRejectedValue(new Error('key'));
	await f.processor.process(f.job);

	expect(f.http).not.toHaveBeenCalled();
	expect(f.bridge.recordRemoteAttempt).not.toHaveBeenCalled();
	expect(f.bridge.acknowledge).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'temporaryFailed', code: 'preparation_failed' }));
});

test('ack DB 오류를 성공으로 덮지 않는다', async () => {
	const f = fixture();
	f.bridge.acknowledge.mockRejectedValue(new Error('database'));
	await expect(f.processor.process(f.job)).rejects.toThrow('delete delivery processing failed');

	expect(f.bridge.acknowledge).toHaveBeenCalledTimes(1);
});

test.each(['null', 'exhausted'])('예약 %s는 전송 성공이 아니다', async outcome => {
	const f = fixture();
	f.bridge.recordRemoteAttempt.mockResolvedValue(outcome === 'null' ? null as any : { outcome, attempts: 12 });
	expect(await f.processor.process(f.job)).not.toBe('Success');

	expect(f.http).not.toHaveBeenCalled();
	if (outcome === 'null') expect(f.bridge.acknowledge).not.toHaveBeenCalled();
	else expect(f.bridge.acknowledge).toHaveBeenCalledWith(expect.anything(), { outcome: 'permanentFailed', code: 'remote_budget_exhausted' });
});

test('일반 job은 기존 성공과 재시도 예외를 유지한다', async () => {
	const f = fixture(false);
	expect(await f.processor.process(f.job)).toBe('Success');
	f.http.mockRejectedValue(new StatusError('remote', 500));
	await expect(f.processor.process(f.job)).rejects.toThrow('500');

	expect(f.bridge.claim).not.toHaveBeenCalled();
});

function gate() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => { release = resolve; });
	return { promise, release };
}

test('긴 키 조회 동안 lease를 갱신하고 HTTP 직전에 재검증한다', async () => {
	vi.useFakeTimers();
	const f = fixture();
	const waiting = gate();
	const entered = gate();
	f.key.mockImplementationOnce(async () => { entered.release(); await waiting.promise; return { privateKey }; });
	const task = f.processor.process(f.job);
	await entered.promise;
	await vi.advanceTimersByTimeAsync(40_000);

	expect(f.bridge.renew).toHaveBeenCalledTimes(2);
	expect(f.bridge.recordRemoteAttempt).not.toHaveBeenCalled();
	waiting.release();
	await task;

	expect(f.bridge.validateBeforeSend).toHaveBeenCalledTimes(1);
	expect(f.http).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
});

test.each(['expired', 'database'])('키 조회 중 lease 갱신 %s는 전송과 표식을 남기지 않는다', async failure => {
	vi.useFakeTimers();
	const f = fixture();
	const waiting = gate();
	const entered = gate();
	f.key.mockImplementationOnce(async () => { entered.release(); await waiting.promise; return { privateKey }; });
	if (failure === 'expired') f.bridge.renew.mockResolvedValue(false);
	else f.bridge.renew.mockRejectedValue(new Error('renew database'));
	const task = f.processor.process(f.job);
	const observed = task.then(value => value, error => error);
	await entered.promise;
	await vi.advanceTimersByTimeAsync(20_000);
	waiting.release();
	const result = await observed;

	if (failure === 'database') expect(result).toBeInstanceOf(Error);
	expect(f.http).not.toHaveBeenCalled();
	expect(f.bridge.acknowledge).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

test('늦은 HTTP 성공 뒤 만료된 lease는 성공 ack를 남기지 않는다', async () => {
	vi.useFakeTimers();
	const f = fixture();
	const waiting = gate();
	const entered = gate();
	f.http.mockImplementationOnce(async () => { entered.release(); await waiting.promise; return {}; });
	f.bridge.renew.mockResolvedValue(false);
	const task = f.processor.process(f.job);
	await entered.promise;
	await vi.advanceTimersByTimeAsync(60_001);
	waiting.release();
	expect(await task).toContain('lease lost');

	expect(f.http).toHaveBeenCalledTimes(1);
	expect(f.bridge.acknowledge).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

test.each(['claim', 'validate', 'ack'])('stale %s는 일반 전달 실패나 성공이 아니다', async boundary => {
	const f = fixture();
	if (boundary === 'claim') f.bridge.claim.mockResolvedValue(null as any);
	if (boundary === 'validate') f.bridge.validateBeforeSend.mockResolvedValue(null as any);
	if (boundary === 'ack') f.bridge.acknowledge.mockResolvedValue(false);
	expect(await f.processor.process(f.job)).toContain('stale');

	expect(f.http).toHaveBeenCalledTimes(boundary === 'ack' ? 1 : 0);
	expect(f.charts.deliverFail).not.toHaveBeenCalled();
});

test.each(['validateBeforeSend', 'recordRemoteAttempt'] as const)('%s DB 장애는 원격 시도나 결과를 만들지 않는다', async method => {
	const f = fixture();
	f.bridge[method].mockRejectedValue(new Error('database'));
	await expect(f.processor.process(f.job)).rejects.toThrow('delete delivery processing failed');

	expect(f.http).not.toHaveBeenCalled();
	expect(f.bridge.acknowledge).not.toHaveBeenCalled();
});

test('마지막 원격 일시 실패는 generation 간 예산 소진으로 정산한다', async () => {
	const f = fixture();
	f.bridge.recordRemoteAttempt.mockResolvedValue({ outcome: 'reserved', attempts: 12 });
	f.http.mockRejectedValue(new StatusError('remote', 500));
	await f.processor.process(f.job);

	expect(f.http).toHaveBeenCalledTimes(1);
	expect(f.bridge.acknowledge).toHaveBeenCalledWith(expect.anything(), { outcome: 'permanentFailed', code: 'remote_budget_exhausted' });
});

test('ack를 기다리는 동안 처리기는 완료되지 않는다', async () => {
	const f = fixture();
	const waiting = gate();
	const entered = gate();
	let finished = false;
	f.bridge.acknowledge.mockImplementationOnce(async () => { entered.release(); await waiting.promise; return true; });
	const task = f.processor.process(f.job).then(() => { finished = true; });
	await entered.promise;

	expect(finished).toBe(false);
	waiting.release();
	await task;

	expect(finished).toBe(true);
});

test.each([400, 410])('일반 job HTTP %s는 기존 영구 실패 예외를 유지한다', async status => {
	const f = fixture(false);
	f.http.mockRejectedValue(new StatusError('remote', status));
	await expect(f.processor.process(f.job)).rejects.toMatchObject({ name: 'UnrecoverableError' });

	expect(f.bridge.acknowledge).not.toHaveBeenCalled();
});

test('설정된 원격 예산을 기존 일반 큐와 같은 config에서 읽는다', async () => {
	const f = fixture();
	f.config.deliverJobMaxAttempts = 3;
	await f.processor.process(f.job);

	expect(f.bridge.recordRemoteAttempt).toHaveBeenCalledWith(expect.anything(), 3);
});

test('식별자 job은 DB 자료로 전송하고 Redis 결과와 오류에 비공개 입력을 넣지 않는다', async () => {
	const f = fixture();
	f.job.data = { noteDeleteDelivery: f.job.data.noteDeleteDelivery };
	expect(await f.processor.process(f.job)).toBe('delete delivery delivered');
	expect(f.http).toHaveBeenCalledWith(f.data.to, expect.objectContaining({ body: f.data.content }));
	f.bridge.claim.mockRejectedValue(new Error(`private ${f.data.to} ${f.data.content}`));
	await expect(f.processor.process(f.job)).rejects.toThrow('delete delivery processing failed');
});

test.each(['claim', 'beforeSend', 'missingRow', 'deliveryClaim', 'deliveryBeforeSend'] as const)('실제 전달 서비스의 %s 종료 차단은 서명 HTTP 호출을 0회로 유지한다', async phase => {
	const { NoteDeleteDeliveryService } = await vi.importActual<typeof import('../../src/core/NoteDeleteDeliveryService.js')>('../../src/core/NoteDeleteDeliveryService.js');
	const { MiNoteDeleteReceipt } = await import('../../src/models/NoteDeleteReceipt.js');
	const { MiNoteDeleteDelivery } = await import('../../src/models/NoteDeleteDelivery.js');
	const { createHash } = await import('node:crypto');
	const { serializeActivityPub } = await import('../../src/misc/activitypub-payload.js');
	const f = fixture();
	const target = { endpoint: f.data.to, isSharedInbox: true, targetKey: createHash('sha256').update(f.data.to).digest('hex') };
	const row: any = { receiptNoteId: 'note', ownerUserId: 'owner', channel: 'direct', ...target, generation: 0, state: 'pending', claimVersion: 0, claimUntil: null, nextAttemptAt: new Date(0), relayId: null, payloadRef: 'activity', attempts: 0 };
	const receipt: any = { noteId: 'note', userId: 'owner', completedAt: null, effects: {}, snapshot: {
		version: 1, actor: { id: 'owner' }, note: { id: 'note', userId: 'owner' }, delivery: { version: 2, reason: 'federated', directTargets: [target], activity: serializeActivityPub({ type: 'Delete' }) },
	} };
	const close = () => { receipt.snapshot = phase.startsWith('delivery') ? { ...receipt.snapshot, version: 3, state: 'delivery_settled', delivery: null } : { version: 2, state: 'settled' }; receipt.completedAt = phase.startsWith('delivery') ? null : new Date(); };
	const manager: any = { getRepository: (model: unknown) => {
		if (model === MiNoteDeleteReceipt) return { findOneBy: async () => receipt };
		if (model === MiNoteDeleteDelivery) return { findOne: async () => phase === 'missingRow' ? null : row, update: async (_where: unknown, values: object) => { Object.assign(row, values); return { affected: 1 }; } };
		throw new Error('unexpected repository');
	} };
	const service = new NoteDeleteDeliveryService({ transaction: async (work: any) => work(manager) } as any, {} as any, {} as any, {} as any);
	Object.assign(f.processor, { noteDeleteDeliveryService: service });
	const identity = { receiptNoteId: row.receiptNoteId, ownerUserId: row.ownerUserId, channel: row.channel, targetKey: row.targetKey, generation: 0 };
	f.job.id = NoteDeleteDeliveryService.jobId(identity);
	f.job.data = { noteDeleteDelivery: identity };
	if (phase === 'claim' || phase === 'deliveryClaim') close();
	if (phase === 'beforeSend' || phase === 'deliveryBeforeSend') f.key.mockImplementationOnce(async () => { close(); return { privateKey }; });

	await f.processor.process(f.job);

	expect(f.http).not.toHaveBeenCalled();
	expect(row.attempts).toBe(0);
	if (phase !== 'beforeSend' && phase !== 'deliveryBeforeSend') expect(f.key).not.toHaveBeenCalled();
});

test.each(['removed', 'temporaryKey', 'databaseError', 'isDeleted', 'otherClaim', 'httpRunning', 'cachedMemory', 'cachedRedis', 'signError', 'absentOwnerTemporaryKey'] as const)('실제 전달·서명 경계의 %s는 HTTP와 owner 정산을 구별한다', async phase => {
	const { NoteDeleteDeliveryService } = await vi.importActual<typeof import('../../src/core/NoteDeleteDeliveryService.js')>('../../src/core/NoteDeleteDeliveryService.js');
	const { MiNoteDeleteReceipt } = await import('../../src/models/NoteDeleteReceipt.js');
	const { MiNoteDeleteDelivery } = await import('../../src/models/NoteDeleteDelivery.js');
	const { MiUser } = await import('../../src/models/User.js');
	const { createHash } = await import('node:crypto');
	const { serializeActivityPub } = await import('../../src/misc/activitypub-payload.js');
	const f = fixture();
	const target = { endpoint: f.data.to, isSharedInbox: true, targetKey: createHash('sha256').update(f.data.to).digest('hex') };
	const row: import('../../src/models/NoteDeleteDelivery.js').MiNoteDeleteDelivery = {
		receiptNoteId: 'note', ownerUserId: 'owner', channel: 'direct', ...target, relayId: null,
		payloadRef: 'activity', state: 'pending', generation: 0, attempts: 0, claimVersion: 0,
		claimToken: null, claimUntil: null, nextAttemptAt: new Date(0), lastErrorCode: null, settledAt: null,
	};
	const receipt: import('../../src/models/NoteDeleteReceipt.js').MiNoteDeleteReceipt = {
		noteId: 'note', userId: 'owner', deletedAt: new Date(), quiet: false, completedAt: null, effects: {},
		attempts: 0, nextAttemptAt: new Date(0), claimToken: null, claimUntil: null, claimVersion: 0, lastErrorCode: null,
		snapshot: {
			version: 1, actor: { id: 'owner', host: null }, deleter: null, author: null, auditNote: null, stream: null,
			note: { id: 'note', userId: 'owner', visibility: 'public', userHost: null, hasReply: false, hasRenote: false, hasFile: false },
			charts: { version: 1, notes: false, perUser: null, instance: null },
			delivery: { version: 2, reason: 'federated', directTargets: [target], followers: [], relays: [], relaySigned: null, relayUnsigned: null, activity: serializeActivityPub({ type: 'Delete' }) },
		},
	};
	let ownerPresent = true;
	let inTransaction = false;
	const redisValues = new Map<string, string>();
	const redis = { get: async (key: string) => { expect(inTransaction).toBe(false); return redisValues.get(key) ?? null; }, set: async (key: string, value: string) => { expect(inTransaction).toBe(false); redisValues.set(key, value); } };
	const keyRepository = { findOneByOrFail: async () => {
		expect(inTransaction).toBe(false);
		if (!ownerPresent) {
			if (phase === 'absentOwnerTemporaryKey') throw new Error('key database unavailable');
			throw new EntityNotFoundError(MiUserKeypair, { userId: 'owner' });
		}
		return { userId: 'owner', privateKey: phase === 'signError' ? 'invalid synthetic key' : privateKey };
	} };
	const keys = new UserKeypairService(redis as any, keyRepository as any);
	const secondKeys = new UserKeypairService(redis as any, keyRepository as any);
	const cached = phase === 'cachedMemory' || phase === 'cachedRedis' || phase === 'signError';
	if (cached) await keys.getUserKeypair('owner');
	const activeKeys = phase === 'cachedRedis' ? secondKeys : keys;
	Object.assign(f.ap, { userKeypairService: activeKeys });
	const manager = { getRepository: (model: unknown) => {
		if (model === MiNoteDeleteReceipt) return { findOneBy: async () => structuredClone(receipt) };
		if (model === MiNoteDeleteDelivery) return { findOneBy: async () => structuredClone(row), findOne: async () => structuredClone(row), update: async (_where: unknown, values: Partial<typeof row>) => { Object.assign(row, values); return { affected: 1 }; } };
		if (model === MiUser) return { findOne: async () => {
			if (phase === 'databaseError') throw new Error('database unavailable');
			return ownerPresent ? { id: 'owner', isDeleted: phase === 'isDeleted' } : null;
		} };
		throw new Error('unexpected repository');
	} };
	const db = { getRepository: manager.getRepository, transaction: async (work: (value: typeof manager) => Promise<unknown>) => { inTransaction = true; try { return await work(manager); } finally { inTransaction = false; } } };
	const queued: import('../../src/queue/types.js').NoteDeleteDeliverJobData[] = [];
	const queue = Object.assign(Object.create(QueueService.prototype), { config: {}, deliverQueue: {
		getJob: async () => null,
		add: async (_name: string, data: import('../../src/queue/types.js').NoteDeleteDeliverJobData) => { queued.push(data); },
	} }) as QueueService;
	const service = new NoteDeleteDeliveryService(db as unknown as import('typeorm').DataSource, queue, {} as import('../../src/core/NoteDeletePayloadService.js').NoteDeletePayloadService, activeKeys);
	Object.assign(f.processor, { noteDeleteDeliveryService: service });
	const identity = { receiptNoteId: row.receiptNoteId, ownerUserId: row.ownerUserId, channel: row.channel, targetKey: row.targetKey, generation: 0 };
	f.job.id = NoteDeleteDeliveryService.jobId(identity);
	f.job.data = { noteDeleteDelivery: identity };
	if (phase === 'temporaryKey' || phase === 'isDeleted' || phase === 'otherClaim') {
		keyRepository.findOneByOrFail = async () => {
			if (phase === 'otherClaim') { row.claimToken = 'other'; row.claimVersion++; }
			throw new Error('key temporarily unavailable');
		};
	} else if (phase === 'httpRunning') f.http.mockImplementationOnce(async () => { ownerPresent = false; return {}; });
	else ownerPresent = false;

	try {
		if (phase === 'cachedMemory' || phase === 'cachedRedis') {
			const accepted = await service.enqueue(identity);
			expect(row.lastErrorCode).toBeNull();
			expect(accepted).toBe(true);
			expect(queued).toEqual([{ noteDeleteDelivery: identity }]);
			f.job.data = queued[0];
		}
		if (phase === 'databaseError' || phase === 'absentOwnerTemporaryKey') await expect(f.processor.process(f.job)).rejects.toThrow('processing failed');
		else await f.processor.process(f.job);

		const sent = phase === 'httpRunning' || phase === 'cachedMemory' || phase === 'cachedRedis';
		expect(f.http).toHaveBeenCalledTimes(sent ? 1 : 0);
		expect(row.attempts).toBe(sent ? 1 : 0);
		expect(row.state).toBe(phase === 'removed' ? 'permanentFailed' : sent ? 'delivered' : phase === 'databaseError' || phase === 'otherClaim' || phase === 'absentOwnerTemporaryKey' ? 'running' : 'pending');
		expect(row.lastErrorCode).toBe(phase === 'removed' ? 'owner_removed' : phase === 'temporaryKey' || phase === 'isDeleted' || phase === 'signError' ? 'preparation_failed' : null);
	} finally {
		keys.dispose();
		secondKeys.dispose();
	}
});
