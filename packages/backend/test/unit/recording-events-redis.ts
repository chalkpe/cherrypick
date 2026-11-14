/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { loadConfig } from '@/config.js';
import { CLEAR_RECORDING_STATE_IF_CURRENT_SCRIPT } from '@/core/recording-state.js';
import { createFixture, KNOWN_USERS, mirrorRoom } from '../misc/chat-voice-fixture.js';

let redis: Redis;
const prefix = `test-recording-${randomUUID()}:`;
const ownedKeys = new Set<string>();
const fixtures: ReturnType<typeof createFixture>[] = [];

function key(name: string) { ownedKeys.add(name); return name; }

function hashOf(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const recordingUser = KNOWN_USERS.find(user => user.id === 'u1')!;
const recordingIdentity = 'https://local.test/users/u1';
const recordingStatus = { micMuted: false, deafened: false, recording: true };
const stateKeyOf = (roomId: string, identity: string) => `chatVoice:recordingState:${hashOf([roomId, identity])}`;

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

function recordingFixture(participants = [
	{ identity: recordingIdentity, sessionId: 'PA_1', userId: 'u1', screenSharing: false, micTrackSid: null },
	{ identity: 'https://local.test/users/m1', sessionId: 'PA_member', userId: 'm1', screenSharing: false, micTrackSid: null },
]) {
	const fixture = createFixture(redis as any);
	fixtures.push(fixture);
	const room = { ...fixture.rooms.get('r1'), allowRecording: true };
	fixture.rooms.set('r1', room);
	fixture.chatRoomsRepository.findOneBy.mockResolvedValue(room);
	Object.assign(fixture.usersRepository, { findOneBy: vi.fn().mockResolvedValue(KNOWN_USERS.find(user => user.id === 'owner')) });
	fixture.liveKitService.listParticipants.mockResolvedValue(participants);
	Object.assign(fixture.liveKitService, { setParticipantStatus: vi.fn(async (_roomId: string, identity: string, sessionId: string) => {
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

test('the cleanup script deletes only the state it read', async () => {
	const stateKey = key('chatVoice:recordingState:cas');
	await redis.set(stateKey, JSON.stringify({ sessionId: 'PA_1', recording: true }));

	expect(await redis.eval(CLEAR_RECORDING_STATE_IF_CURRENT_SCRIPT, 1, stateKey, 'another-value')).toBe(0);
	expect(await redis.get(stateKey)).not.toBeNull();

	const raw = (await redis.get(stateKey))!;
	expect(await redis.eval(CLEAR_RECORDING_STATE_IF_CURRENT_SCRIPT, 1, stateKey, raw)).toBe(1);
	expect(await redis.get(stateKey)).toBeNull();
	// 鍵がもう無くても、読んだ値 (空文字) と一致すれば一覧の項目を消せる
	expect(await redis.eval(CLEAR_RECORDING_STATE_IF_CURRENT_SCRIPT, 1, stateKey, '')).toBe(1);
});

test('a recording report stores one state per participant with the snapshot lifetime', async () => {
	const { fixture } = recordingFixture();

	await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', recordingStatus)).resolves.toBe(true);

	const stateKey = stateKeyOf('r1', recordingIdentity);
	expect(JSON.parse((await redis.get(stateKey))!)).toEqual({ sessionId: 'PA_1', recording: true });
	const ttl = await redis.ttl(stateKey);
	expect(ttl).toBeGreaterThan(0);
	expect(ttl).toBeLessThanOrEqual(120);
	expect(await redis.smembers('chatVoice:recordingIdentities:r1')).toEqual([recordingIdentity]);
});

test('a new SID for the same identity does not keep the previous recording alive', async () => {
	const { fixture, participants } = recordingFixture();
	await fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', recordingStatus);
	Object.assign(participants[0], { sessionId: 'PA_2' });

	await fixture.service.refresh('r1');
	let snapshot = JSON.parse((await redis.get('chatVoice:state:r1'))!);
	expect(snapshot.participants.find((p: { identity: string }) => p.identity === recordingIdentity).recording).toBe(false);

	await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_2', recordingStatus)).resolves.toBe(true);
	await fixture.service.refresh('r1');
	snapshot = JSON.parse((await redis.get('chatVoice:state:r1'))!);
	expect(snapshot.participants.find((p: { identity: string }) => p.identity === recordingIdentity).recording).toBe(true);
	expect(JSON.parse((await redis.get(stateKeyOf('r1', recordingIdentity)))!).sessionId).toBe('PA_2');
});

test('overlapping reports of the same participant all apply without an internal error', async () => {
	const { fixture } = recordingFixture();

	const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
		fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', { micMuted: i % 2 === 0, deafened: false, recording: i % 2 === 0 })));

	expect(results).toEqual(Array(8).fill(true));
	const state = JSON.parse((await redis.get(stateKeyOf('r1', recordingIdentity)))!);
	expect(state.sessionId).toBe('PA_1');
	expect([true, false]).toContain(state.recording);
});

test('refresh clears the state of a participant who left the call', async () => {
	const { fixture, participants } = recordingFixture();
	await fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', recordingStatus);
	fixture.liveKitService.listParticipants.mockResolvedValue([participants[1]]);

	await fixture.service.refresh('r1');

	expect(await redis.get(stateKeyOf('r1', recordingIdentity))).toBeNull();
	expect(await redis.smembers('chatVoice:recordingIdentities:r1')).toEqual([]);
});

test('cleanup does not delete a state re-reported after it was read', async () => {
	const { fixture, participants } = recordingFixture();
	await fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', recordingStatus);
	fixture.liveKitService.listParticipants.mockResolvedValue([participants[1]]);
	const stateKey = stateKeyOf('r1', recordingIdentity);
	const paused = signal();
	const resume = signal();
	const get = redis.get.bind(redis);
	let intercepted = false;
	const spy = vi.spyOn(redis, 'get').mockImplementation(async k => {
		const value = await get(k);
		if (!intercepted && k === stateKey) {
			intercepted = true;
			paused.resolve();
			await resume.promise;
		}
		return value;
	});
	try {
		const refresh = fixture.service.refresh('r1');
		await paused.promise;
		// 読み直しのクリーンアップが状態を読んだあとに、同じ identity が新しいセッションで報告し直す
		Object.assign(participants[0], { sessionId: 'PA_2' });
		fixture.liveKitService.listParticipants.mockResolvedValue(participants);
		await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_2', recordingStatus)).resolves.toBe(true);
		resume.resolve();
		await refresh;

		expect(JSON.parse((await redis.get(stateKey))!)).toEqual({ sessionId: 'PA_2', recording: true });
		await fixture.service.refresh('r1');
		const snapshot = JSON.parse((await redis.get('chatVoice:state:r1'))!);
		expect(snapshot.participants.find((p: { identity: string }) => p.identity === recordingIdentity).recording).toBe(true);
	} finally {
		resume.resolve();
		spy.mockRestore();
	}
});

test('a failed remote delivery does not fail the recording approval or the local display', async () => {
	const { fixture } = recordingFixture();
	// 서로 다른 inbox 둘 (remote.test 공유 inbox, far.test 개별 inbox)
	const findMembers = fixture.chatRoomMembershipsRepository.findBy.getMockImplementation()!;
	fixture.chatRoomMembershipsRepository.findBy.mockImplementation(async where => where?.userId ? findMembers(where) : [{ userId: 'm1' }, { userId: 'rm1' }, { userId: 'rm3' }]);

	await expect(fixture.service.reportStatus(recordingUser as any, 'r1', 'PA_1', recordingStatus)).resolves.toBe(true);
	fixture.queueService.deliver.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('queue unavailable'));
	await fixture.service.refresh('r1').catch(() => {});

	expect(JSON.parse((await redis.get(stateKeyOf('r1', recordingIdentity)))!).recording).toBe(true);
	const snapshot = JSON.parse((await redis.get('chatVoice:state:r1'))!);
	expect(snapshot.participants.find((p: { identity: string }) => p.identity === recordingIdentity).recording).toBe(true);
});

function mirrorFixture() {
	const fixture = createFixture(redis as any);
	fixtures.push(fixture);
	const room = { ...mirrorRoom(), uri: 'https://remote.test/chat/rooms/r1' };
	fixture.rooms.set('r1', room);
	const actor = KNOWN_USERS.find(user => user.id === 'remoteOwner')!;
	return { fixture, actor };
}

function mirrorObject(recording: boolean, at: number, micMuted = false) {
	return {
		id: 'https://remote.test/chat/rooms/r1/voice', type: 'ChatRoomVoiceState', room: 'https://remote.test/chat/rooms/r1', updated: new Date(at).toISOString(),
		participants: [{ id: 'https://local.test/users/m1', screenSharing: false }, { id: 'https://remote.test/users/rm1', screenSharing: false, recording, micMuted }],
	};
}

test('the mirror gate publishes recording changes inside the interval in real Lua', async () => {
	const { fixture, actor } = mirrorFixture();
	const t0 = Date.now();
	await fixture.service.receiveRemoteSnapshot(actor as any, mirrorObject(false, t0) as any);
	fixture.globalEventService.publishMainStream.mockClear();

	await fixture.service.receiveRemoteSnapshot(actor as any, mirrorObject(true, t0 + 1) as any);

	const events = fixture.globalEventService.publishMainStream.mock.calls.filter(call => call[1] === 'chatRoomVoiceState');
	expect(events).toHaveLength(1);
	expect(events[0][2].participants.find((p: { identity: string }) => p.identity === 'https://remote.test/users/rm1').recording).toBe(true);
});

test('a mirror recording publish keeps the non-recording interval clock in real Lua', async () => {
	const { fixture, actor } = mirrorFixture();
	const t0 = Date.now();
	await fixture.service.receiveRemoteSnapshot(actor as any, mirrorObject(false, t0) as any);
	await fixture.service.receiveRemoteSnapshot(actor as any, mirrorObject(true, t0 + 1) as any);
	fixture.globalEventService.publishMainStream.mockClear();

	// 録画ではない変化 (設定) は、直前の録画通知に関係なく間隔に抑えられる
	await fixture.service.receiveRemoteSnapshot(actor as any, mirrorObject(true, t0 + 2, true) as any);

	expect(fixture.globalEventService.publishMainStream.mock.calls.filter(call => call[1] === 'chatRoomVoiceState')).toEqual([]);
});

test('the mirror gate still coalesces non-recording changes in real Lua', async () => {
	const { fixture, actor } = mirrorFixture();
	const t0 = Date.now();
	await fixture.service.receiveRemoteSnapshot(actor as any, mirrorObject(false, t0) as any);
	fixture.globalEventService.publishMainStream.mockClear();

	await fixture.service.receiveRemoteSnapshot(actor as any, mirrorObject(false, t0 + 1, true) as any);

	expect(fixture.globalEventService.publishMainStream.mock.calls.filter(call => call[1] === 'chatRoomVoiceState')).toEqual([]);
});
