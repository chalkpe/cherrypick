/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { loadConfig } from '@/config.js';
import { CLAIM_RECORDING_EVENT_SCRIPT, MARK_RECORDING_EVENT_SENT_SCRIPT, PREPARE_RECORDING_EVENT_SCRIPT, RENEW_ACTIVE_RECORDING_SCRIPT } from '@/core/recording-event.js';
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

test('Redis keeps a stable event ID, binds the caller, and reserves room for the stop at capacity', async () => {
	const first = await prepare(true, { capacity: 1 });
	const duplicate = await prepare(true, { capacity: 1 });

	expect(duplicate.binding?.start.id).toBe(first.binding?.start.id);
	expect((await prepare(true, { identity: 'https://local.test/users/u2', capacity: 1 })).raw).toBe('');
	expect((await prepare(true, { id: 'second', capacity: 1 })).raw).toBe('');

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

	expect(await redis.eval(RENEW_ACTIVE_RECORDING_SCRIPT, 4, ...renewKeys, 'client-id', 3600, Date.now())).toBe(1);
	expect(await redis.ttl(first.keys[0])).toBeGreaterThan(3500);
	await prepare(false);
	expect(await redis.eval(RENEW_ACTIVE_RECORDING_SCRIPT, 4, ...renewKeys, 'client-id', 3600, Date.now())).toBe(0);
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
		if (status.recording != null) participant.recording = status.recording;
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
	expect(participants[0].recording).toBe(true);
});

test('a request that loses its lock cannot clear its replacement recording in LiveKit', async () => {
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

		expect(participants[0].recording).toBe(true);
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
	expect(participants[0].recording).toBe(true);
});

test('a rejected approval followed by a lost rollback cannot leave recording active', async () => {
	const { fixture, participants } = recordingFixture();
	const recordingId = randomUUID();
	fixture.queueService.deliver.mockRejectedValueOnce(new Error('queue unavailable'));

	await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { ...recordingStatus, recordingId })).rejects.toThrow('queue unavailable');
	expect(participants[0].recording).toBe(false);
	await fixture.service.refresh('r1');

	const binding = JSON.parse((await redis.get(`chatVoice:recording:${recordingId}`))!) as RecordingBinding;
	expect(binding.stop?.recording).toBe(false);
	expect(binding.stopSent).toBe(true);
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
