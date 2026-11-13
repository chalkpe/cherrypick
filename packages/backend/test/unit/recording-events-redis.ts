/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { loadConfig } from '@/config.js';
import { ACK_RECORDING_PUBLICATION_SCRIPT, CLAIM_RECORDING_EVENT_SCRIPT, MARK_RECORDING_EVENT_SENT_SCRIPT, PREPARE_RECORDING_EVENT_SCRIPT, PartialRecordingDeliveryError, RENEW_ACTIVE_RECORDING_SCRIPT } from '@/core/recording-event.js';
import type { RecordingBinding } from '@/core/recording-event.js';
import { createFixture, KNOWN_USERS } from '../misc/chat-voice-fixture.js';

let redis: Redis;
const prefix = `test-recording-${randomUUID()}:`;
const ownedKeys = new Set<string>();
const fixtures: ReturnType<typeof createFixture>[] = [];

function key(name: string) { ownedKeys.add(name); return name; }

beforeAll(async () => {
	const config = loadConfig();
	redis = new Redis({ ...config.redis, keyPrefix: prefix, lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 });
	await redis.connect();
});

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) fixture.service.onApplicationShutdown();
	if (redis?.status === 'ready' && ownedKeys.size > 0) await redis.del(...ownedKeys);
	if (redis?.status === 'ready') {
		const keys = await redis.keys(`${prefix}*`);
		if (keys.length > 0) await redis.del(...keys.map(name => name.slice(prefix.length)));
	}
	ownedKeys.clear();
});

afterAll(() => redis?.disconnect());

async function prepare(starting: boolean, options: { id?: string; identity?: string; capacity?: number; ttl?: number; eventId?: string } = {}) {
	const id = options.id ?? 'client-id';
	const identity = options.identity ?? 'https://local.test/users/u1';
	const keys = [key(`binding:${id}`), key(`active:${identity}`), key('lock'), key('pending'), key('history'), key('sweep')];
	await redis.set(keys[2], 'owner');
	const raw = await redis.eval(PREPARE_RECORDING_EVENT_SCRIPT, keys.length, ...keys, 'owner', 'r1', identity, 'PA_1', id, starting ? '1' : '0', Date.now(), options.ttl ?? 3600, options.eventId ?? randomUUID(), 604_810_000, options.capacity ?? 4096);
	return { raw, keys, binding: typeof raw === 'string' && raw !== '' ? JSON.parse(raw) as RecordingBinding : null };
}

test('Redis keeps a stable event ID, binds the caller, and lets a stopped ID finish at capacity', async () => {
	const first = await prepare(true, { capacity: 1 });
	const duplicate = await prepare(true, { capacity: 1 });

	expect(duplicate.binding?.start.id).toBe(first.binding?.start.id);
	expect((await prepare(true, { identity: 'https://local.test/users/u2', capacity: 1 })).raw).toBe('');
	// 상한에 찬 보관 목록은 가장 오래된 항목을 축출하고 새 녹음을 받는다 (거부하지 않는다)
	const second = await prepare(true, { id: 'second', identity: 'https://local.test/users/u2', capacity: 1 });
	expect(second.binding?.clientId).toBe('second');
	expect(await redis.zscore(first.keys[4], 'client-id')).toBeNull();

	const stopped = await prepare(false, { capacity: 1 });

	expect(stopped.binding?.stop?.id).toBe(first.binding?.start.id);
	expect((await prepare(true, { capacity: 1 })).raw).toBe('');
	expect(await redis.smembers(first.keys[5])).toEqual(['r1']);
});

test('Redis does not let an expired lock owner acknowledge another worker\'s event', async () => {
	const first = await prepare(true);
	await redis.set(first.keys[2], 'replacement');

	const marked = await redis.eval(MARK_RECORDING_EVENT_SENT_SCRIPT, 2, first.keys[0], first.keys[2], 'owner', 'startSent', 3600);

	expect(marked).toBe(0);
	expect(JSON.parse((await redis.get(first.keys[0]))!).startSent).toBeUndefined();
	expect(await redis.get(first.keys[2])).toBe('replacement');
});

test('Redis deduplicates both transitions and accepts the matching stop even when its ID budget is full', async () => {
	const keys = [key('seen'), key('flags')];
	const now = Date.now();
	const claim = (id: string, transition: number) => redis.eval(CLAIM_RECORDING_EVENT_SCRIPT, 2, ...keys, id, transition, now, now + 3_600_000, 1);

	expect(await claim('one', 1)).toBe(1);
	expect(await claim('one', 1)).toBe(0);
	expect(await claim('two', 1)).toBe(-1);
	expect(await claim('one', 2)).toBe(1);
	expect(await claim('one', 2)).toBe(0);
	expect(await redis.hlen(keys[1])).toBe(1);
	expect(await redis.pttl(keys[0])).toBeGreaterThan(3_599_000);
});

test('Redis keeps the longer existing deadline when a shorter event arrives later', async () => {
	const keys = [key('seen'), key('flags')];
	const now = Date.now();
	await redis.eval(CLAIM_RECORDING_EVENT_SCRIPT, 2, ...keys, 'long', 1, now, now + 3_600_000, 4096);

	await redis.eval(CLAIM_RECORDING_EVENT_SCRIPT, 2, ...keys, 'short', 1, now, now + 10_000, 4096);

	expect(await redis.pttl(keys[0])).toBeGreaterThan(3_599_000);
	expect(await redis.pttl(keys[1])).toBeGreaterThan(3_599_000);
});

test('Redis renews active ownership without recreating a stopped recording', async () => {
	const first = await prepare(true, { ttl: 1 });
	const renewKeys = [first.keys[0], first.keys[1], first.keys[3], first.keys[4]];

	expect(await redis.eval(RENEW_ACTIVE_RECORDING_SCRIPT, 4, ...renewKeys, 'client-id', 3600, Date.now(), 4096)).toBe(1);
	expect(await redis.ttl(first.keys[0])).toBeGreaterThan(3500);
	await prepare(false);
	expect(await redis.eval(RENEW_ACTIVE_RECORDING_SCRIPT, 4, ...renewKeys, 'client-id', 3600, Date.now(), 4096)).toBe(0);
});

function recordingFixture(participants = [
	{ identity: 'https://local.test/users/u1', sessionId: 'PA_1', userId: 'u1', screenSharing: false, micTrackSid: null, recording: false },
	{ identity: 'https://local.test/users/m1', sessionId: 'PA_member', userId: 'm1', screenSharing: false, micTrackSid: null, recording: false },
]) {
	const fixture = createFixture(redis as any);
	fixtures.push(fixture);
	const room = { ...fixture.rooms.get('r1'), allowRecording: true };
	fixture.rooms.set('r1', room);
	fixture.chatRoomsRepository.findOneBy.mockResolvedValue(room);
	Object.assign(fixture.usersRepository, { findOneBy: vi.fn().mockResolvedValue(KNOWN_USERS.find(user => user.id === 'owner')) });
	fixture.liveKitService.listParticipants.mockResolvedValue(participants);
	Object.assign(fixture.liveKitService, { setParticipantStatus: vi.fn(async (_roomId: string, identity: string, sessionId: string, status: { recording?: boolean }) => {
		const participant = participants.find(candidate => candidate.identity === identity);
		if (participant == null || participant.sessionId !== sessionId) return false;
		return true;
	}) });
	vi.spyOn(fixture.service, 'scheduleRefresh').mockImplementation(() => {});
	const findMembers = fixture.chatRoomMembershipsRepository.findBy.getMockImplementation()!;
	fixture.chatRoomMembershipsRepository.findBy.mockImplementation(async where => where?.userId ? findMembers(where) : [{ userId: 'm1' }, { userId: 'rm1' }]);
	return { fixture, participants };
}

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

const recordingUser = KNOWN_USERS.find(user => user.id === 'u1')!;
const recordingStatus = { micMuted: false, deafened: false, recording: true };

test('an older sweep cannot stop a recording approved while its room lookup is delayed', async () => {
	const { fixture, participants } = recordingFixture();
	fixture.liveKitService.listParticipants.mockImplementation(async () => participants.map(participant => ({ ...participant })));
	const listed = signal();
	const resume = signal();
	fixture.chatRoomsRepository.findOneBy.mockImplementationOnce(async () => {
		listed.resolve();
		await resume.promise;
		return fixture.rooms.get('r1')!;
	});
	const refresh = fixture.service.refresh('r1');
	await listed.promise;
	const recordingId = randomUUID();

	await fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId });
	resume.resolve();
	await refresh;

	const binding = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(binding.stop).toBeUndefined();
	await fixture.service.refresh('r1');
	const snapshot = JSON.parse((await redis.get('chatVoice:state:r1'))!);
	expect(snapshot.participants.find((p: { identity: string }) => p.identity === participants[0].identity).recording).toBe(true);
});

test('a request that loses its lock cannot clear its replacement recording', async () => {
	const { fixture, participants } = recordingFixture();
	const paused = signal();
	const resume = signal();
	const evaluate = redis.eval.bind(redis);
	let lockKey = '';
	let intercepted = false;
	const spy = vi.spyOn(redis, 'eval').mockImplementation(async (...args: any[]) => {
		if (!intercepted && args[0] === PREPARE_RECORDING_EVENT_SCRIPT) {
			intercepted = true;
			lockKey = args[4];
			paused.resolve();
			await resume.promise;
		}
		return evaluate(...args as Parameters<typeof redis.eval>);
	});
	try {
		const first = fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId: randomUUID() });
		await paused.promise;
		// TTL 만료와 같은 잠금 제거를 주입하고, 새 소유자의 승인을 먼저 완료한다.
		await redis.pexpire(lockKey, -1);
		const replacementId = randomUUID();
		await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId: replacementId })).resolves.toBe(true);

		resume.resolve();
		await expect(first).resolves.toBe(false);

		await fixture.service.refresh('r1');
	const snapshot = JSON.parse((await redis.get('chatVoice:state:r1'))!);
	expect(snapshot.participants.find((p: { identity: string }) => p.identity === participants[0].identity).recording).toBe(true);
		const replacement = JSON.parse((await redis.get(`chatVoice:recording:${replacementId}`))!) as RecordingBinding;
		expect(replacement.stop).toBeUndefined();
	} finally {
		resume.resolve();
		spy.mockRestore();
	}
});

test('a new SID for the same identity does not keep the previous recording alive', async () => {
	const { fixture, participants } = recordingFixture();
	Object.assign(participants[0], { sessionId: 'PA_1' });
	const previousId = randomUUID();
	await fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId: previousId });
	Object.assign(participants[0], { sessionId: 'PA_2', recording: false });
	const currentId = randomUUID();
	await fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_2', { ...recordingStatus, recordingId: currentId });

	await fixture.service.refresh('r1');

	const previous = JSON.parse((await redis.get(`chatVoice:recording:${previousId}`))!) as RecordingBinding;
	const current = JSON.parse((await redis.get(`chatVoice:recording:${currentId}`))!) as RecordingBinding;
	expect(previous.stop?.recording).toBe(false);
	expect(previous.stopSent).toBe(true);
	expect(current.stop).toBeUndefined();
	await fixture.service.refresh('r1');
	const snapshot = JSON.parse((await redis.get('chatVoice:state:r1'))!);
	expect(snapshot.participants.find((p: { identity: string }) => p.identity === participants[0].identity).recording).toBe(true);
});

test('a rejected approval leaves no recording behind and the next approval starts clean', async () => {
	const { fixture, participants } = recordingFixture();
	const recordingId = randomUUID();
	fixture.queueService.deliver.mockRejectedValueOnce(new Error('queue unavailable'));

	await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId })).rejects.toThrow('queue unavailable');
	expect(participants[0].recording).toBe(false);
	fixture.queueService.deliver.mockClear();
	await fixture.service.refresh('r1');

	// 폐기됐으면 flush가 시작+종료를 배달할 결속도, snapshot에 남는 녹음 표시도 없다
	expect(await redis.get(`chatVoice:recording:${recordingId}`)).toBeNull();
	const snapshot = JSON.parse((await redis.get('chatVoice:state:r1'))!);
	expect(snapshot.participants.find((p: { identity: string }) => p.identity === participants[0].identity).recording).toBeFalsy();
	const events = fixture.queueService.deliver.mock.calls.map(call => (call[1] as any).object._misskey_recordingEvent).filter(Boolean);
	expect(events).toEqual([]);

	const nextId = randomUUID();
	await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId: nextId })).resolves.toBe(true);
	const nextEvents = fixture.queueService.deliver.mock.calls.map(call => (call[1] as any).object._misskey_recordingEvent).filter(Boolean);
	expect(nextEvents.map((event: any) => event.recording)).toEqual([true]);
});

test('the frontend stop shape clears only its ID-bound recording when the recording flag is omitted', async () => {
	const { fixture, participants } = recordingFixture();
	const recordingId = randomUUID();
	await fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId });

	await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', {
		micMuted: false, deafened: false, recordingId,
	})).resolves.toBe(true);

	const binding = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(participants[0].recording).toBe(false);
	expect(binding.stop?.recording).toBe(false);
	expect(binding.stopSent).toBe(true);
});

test('a leftover lock and an empty snapshot keep the room sweepable until the pending stop is delivered', async () => {
	const { fixture } = recordingFixture();
	const recordingId = randomUUID();
	const setSpy = vi.spyOn(redis, 'set');
	await fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId });
	const lockKey = setSpy.mock.calls.find(call => String(call[0]).startsWith('chatVoice:recordingLock:'))![0] as string;
	setSpy.mockRestore();
	// 프로세스 중단 흉내: finally의 잠금 해제 없이 30초 잠금만 남는다
	await redis.set(lockKey, 'leftover', 'PX', 30_000);
	fixture.liveKitService.listParticipants.mockResolvedValue([]);

	await fixture.service.refresh('r1');

	// 빈 snapshot이 미완료 녹음 방을 sweep 대상에서 지우면 안 된다
	expect(await redis.smembers('chatVoice:active')).toContain('r1');
	await redis.del(lockKey);
	await fixture.service.sweep();

	const binding = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(binding.stopSent).toBe(true);
	const events = fixture.queueService.deliver.mock.calls.map(call => (call[1] as any).object._misskey_recordingEvent).filter(Boolean);
	expect(events.map(event => event.recording)).toEqual([true, false]);
});

test('a failed approval delivery aborts the unsent binding instead of leaving a phantom start for flush', async () => {
	const { fixture } = recordingFixture();
	const recordingId = randomUUID();
	fixture.queueService.deliver.mockRejectedValueOnce(new Error('queue unavailable'));

	await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId })).rejects.toThrow('queue unavailable');

	expect(await redis.get(`chatVoice:recording:${recordingId}`)).toBeNull();
	expect(await redis.smembers(`chatVoice:recordingRoom:r1`)).toEqual([]);
	fixture.queueService.deliver.mockClear();
	await fixture.service.refresh('r1');
	const events = fixture.queueService.deliver.mock.calls.map(call => (call[1] as any).object._misskey_recordingEvent).filter(Boolean);
	expect(events).toEqual([]);
});

test('a failed stop delivery keeps the sent start bound so flush still delivers the stop', async () => {
	const { fixture } = recordingFixture();
	const recordingId = randomUUID();
	await fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId });
	fixture.queueService.deliver.mockRejectedValueOnce(new Error('queue unavailable'));

	await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { micMuted: false, deafened: false, recordingId })).rejects.toThrow('queue unavailable');

	const binding = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(binding.startSent).toBe(true);
	expect(binding.stopSent).toBeUndefined();
	await fixture.service.refresh('r1');
	const after = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(after.stopSent).toBe(true);
});

test('a new recording at the history capacity evicts the oldest entry instead of being refused', async () => {
	const first = await prepare(true, { capacity: 1 });
	expect(first.binding).not.toBeNull();

	const second = await prepare(true, { id: 'second', identity: 'https://local.test/users/u2', capacity: 1 });

	expect(second.binding?.clientId).toBe('second');
	expect(await redis.zcard(first.keys[4])).toBe(1);
	expect(await redis.zscore(first.keys[4], 'client-id')).toBeNull();
	// 축출돼도 결속은 남아 있어 그 녹음의 종료는 계속 가능하다
	const stopped = await prepare(false, { capacity: 1 });
	expect(stopped.binding?.stop?.id).toBe(first.binding?.start.id);
});

test('evicting a completed recording at capacity also removes its binding key', async () => {
	const first = await prepare(true, { id: 'old', capacity: 1 });
	await prepare(false, { id: 'old', capacity: 1 });
	expect(await redis.eval(MARK_RECORDING_EVENT_SENT_SCRIPT, 2, first.keys[0], first.keys[2], 'owner', 'stopSent', 3600)).toBe(1);

	const second = await prepare(true, { id: 'new', identity: 'https://local.test/users/u2', capacity: 1 });

	expect(second.binding?.clientId).toBe('new');
	// 종료까지 배달한 결속은 축출과 함께 지워져 방별 보관 자원이 상한 안에 머문다
	expect(await redis.get(first.keys[0])).toBeNull();
	// 활성·미전달 결속은 축출해도 지우지 않는다 (flush의 종료 배달과 소유권 검사가 아직 필요)
	const third = await prepare(true, { id: 'newer', identity: 'https://local.test/users/u3', capacity: 1 });
	expect(third.binding?.clientId).toBe('newer');
	expect(await redis.get(second.keys[0])).not.toBeNull();
});

test('a duplicate stop of an evicted ID keeps the history within capacity', async () => {
	const first = await prepare(true, { id: 'a', capacity: 2 });
	await prepare(true, { id: 'b', identity: 'https://local.test/users/u2', capacity: 2 });
	const third = await prepare(true, { id: 'c', identity: 'https://local.test/users/u3', capacity: 2 });
	expect(await redis.zcard(third.keys[4])).toBe(2);
	expect(await redis.zscore(third.keys[4], 'a')).toBeNull();

	const stopped = await prepare(false, { id: 'a', capacity: 2 });

	expect(stopped.binding?.stop?.id).toBe(first.binding?.start.id);
	// 재삽입도 상한을 지켜야 한다 (축출 없이 목록이 늘어나면 안 된다)
	expect(await redis.zcard(third.keys[4])).toBe(2);
});

test('renewing an evicted active recording keeps the history within capacity', async () => {
	const first = await prepare(true, { id: 'a', capacity: 2 });
	await prepare(true, { id: 'b', identity: 'https://local.test/users/u2', capacity: 2 });
	await prepare(true, { id: 'c', identity: 'https://local.test/users/u3', capacity: 2 });
	expect(await redis.zscore(first.keys[4], 'a')).toBeNull();
	const renewKeys = [first.keys[0], first.keys[1], first.keys[3], first.keys[4]];

	expect(await redis.eval(RENEW_ACTIVE_RECORDING_SCRIPT, 4, ...renewKeys, 'a', 3600, Date.now(), 2)).toBe(1);

	expect(await redis.zcard(first.keys[4])).toBe(2);
	expect(await redis.zscore(first.keys[4], 'a')).not.toBeNull();
});

test('a partially delivered approval keeps the binding so flush finishes the stop without re-announcing the start', async () => {
	const { fixture, participants } = recordingFixture();
	// 서로 다른 inbox 둘 (remote.test 공유 inbox, far.test 개별 inbox)
	const findMembers = fixture.chatRoomMembershipsRepository.findBy.getMockImplementation()!;
	fixture.chatRoomMembershipsRepository.findBy.mockImplementation(async where => where?.userId ? findMembers(where) : [{ userId: 'm1' }, { userId: 'rm1' }, { userId: 'rm3' }]);
	const recordingId = randomUUID();
	fixture.queueService.deliver.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('queue unavailable'));

	await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId })).rejects.toThrow(PartialRecordingDeliveryError);

	// 일부 inbox에는 이미 시작이 접수됐으므로 결속을 폐기하면 안 된다
	const binding = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(binding.startPartial).toBe(true);
	expect(binding.startSent).toBeUndefined();
	expect(binding.stop).toBeUndefined();

	fixture.queueService.deliver.mockClear();
	await fixture.service.refresh('r1');

	const after = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(after.stopSent).toBe(true);
	const events = fixture.queueService.deliver.mock.calls.map(call => (call[1] as any).object._misskey_recordingEvent).filter(Boolean);
	// 승인받지 못한 시작을 새 대상에게 다시 보내지 않고 종료만 마저 배달한다
	expect(events.length).toBeGreaterThan(0);
	expect(events.every((event: any) => event.recording === false)).toBe(true);
	const snapshot = JSON.parse((await redis.get('chatVoice:state:r1'))!);
	expect(snapshot.participants.find((p: { identity: string }) => p.identity === participants[0].identity).recording).toBeFalsy();
});

test('an approval whose local announcement fails after remote delivery keeps the binding for the stop', async () => {
	const { fixture } = recordingFixture();
	const recordingId = randomUUID();
	fixture.globalEventService.publishRecordingMainStream.mockRejectedValueOnce(new Error('pubsub unavailable'));

	await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId })).rejects.toThrow(PartialRecordingDeliveryError);

	const binding = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(binding.startPartial).toBe(true);
	expect(binding.startSent).toBeUndefined();

	await fixture.service.refresh('r1');

	const after = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(after.stopSent).toBe(true);
	const events = fixture.queueService.deliver.mock.calls.map(call => (call[1] as any).object._misskey_recordingEvent).filter(Boolean);
	expect(events.map((event: any) => event.recording)).toEqual([true, false]);
});

test('a local-only approval whose acknowledgement fails after the announcement keeps the binding', async () => {
	const { fixture } = recordingFixture();
	const findMembers = fixture.chatRoomMembershipsRepository.findBy.getMockImplementation()!;
	fixture.chatRoomMembershipsRepository.findBy.mockImplementation(async where => where?.userId ? findMembers(where) : [{ userId: 'm1' }]);
	const recordingId = randomUUID();
	const evaluate = redis.eval.bind(redis);
	const spy = vi.spyOn(redis, 'eval').mockImplementation(async (...args: any[]) => {
		if (args[0] === ACK_RECORDING_PUBLICATION_SCRIPT) throw new Error('ack unavailable');
		return evaluate(...args as Parameters<typeof redis.eval>);
	});
	try {
		await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId })).rejects.toThrow(PartialRecordingDeliveryError);
	} finally {
		spy.mockRestore();
	}

	// 로컬 시작 고지는 이미 발행됐으므로 결속을 남겨 종료를 마저 보내게 한다
	expect(fixture.globalEventService.publishMainStream.mock.calls.some(call => call[1] === 'chatRoomRecording' && call[2].recording === true)).toBe(true);
	const binding = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(binding.startPartial).toBe(true);
	expect(binding.startSent).toBeUndefined();

	await fixture.service.refresh('r1');

	const after = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(after.stopSent).toBe(true);
});
