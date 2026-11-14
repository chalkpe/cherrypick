/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFixture, KNOWN_USERS, mirrorRoom } from '../misc/chat-voice-fixture.js';

const me = KNOWN_USERS.find(user => user.id === 'u1')!;
const member = { identity: 'https://local.test/users/m1', sessionId: 'PA_member', userId: 'm1', screenSharing: false, micTrackSid: null };
const recorder = { identity: 'https://local.test/users/u1', sessionId: 'PA_1', userId: 'u1', screenSharing: false, micTrackSid: null };
const settings = { micMuted: false, deafened: false };
let f: ReturnType<typeof createFixture>;
let setStatus: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.useFakeTimers({ now: Date.parse('2026-11-12T00:00:00Z') });
	f = createFixture();
	f.chatRoomsRepository.findOneBy.mockResolvedValue({ ...f.rooms.get('r1'), allowRecording: true });
	Object.assign(f.usersRepository, { findOneBy: vi.fn().mockResolvedValue(KNOWN_USERS.find(user => user.id === 'owner')) });
	setStatus = vi.fn().mockResolvedValue(true);
	Object.assign(f.liveKitService, { setParticipantStatus: setStatus });
	f.liveKitService.listParticipants.mockResolvedValue([{ ...recorder }, { ...member }]);
	vi.spyOn(f.service, 'scheduleRefresh').mockImplementation(() => {});
	const find = f.chatRoomMembershipsRepository.findBy.getMockImplementation()!;
	// user (host IsNull) 필터가 있는 조회는 로컬 멤버만 돌려준다 (publishMirrorSnapshot 의 알림 대상)
	f.chatRoomMembershipsRepository.findBy.mockImplementation(async where => where?.userId ? find(where) : where?.user ? [{ userId: 'm1' }] : [{ userId: 'm1' }, { userId: 'rm1' }]);
});

afterEach(() => { f.service.onApplicationShutdown(); vi.useRealTimers(); });

function snapshot() {
	return JSON.parse(f.redis.store.get('chatVoice:state:r1')!).participants as { identity: string; recording?: boolean }[];
}

function recordingOf(identity: string) {
	return snapshot().find(p => p.identity === identity)?.recording;
}

function mirror() {
	const room = { ...mirrorRoom(), uri: 'https://remote.test/chat/rooms/r1' };
	f.rooms.set('r1', room);
	return KNOWN_USERS.find(user => user.id === 'remoteOwner')!;
}

function object(recording: boolean, at = Date.now(), micMuted = false) {
	return {
		id: 'https://remote.test/chat/rooms/r1/voice', type: 'ChatRoomVoiceState', room: 'https://remote.test/chat/rooms/r1', updated: new Date(at).toISOString(),
		participants: [{ id: member.identity, screenSharing: false }, { id: 'https://remote.test/users/rm1', screenSharing: false, recording, micMuted }],
	};
}

describe('one recording state per participant', () => {
	test('overlays the approved recording state on the participant list for the reporting session', async () => {
		await expect(f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: true })).resolves.toBe(true);
		await f.service.refresh('r1');

		expect(recordingOf(recorder.identity)).toBe(true);
		expect(recordingOf(member.identity)).toBe(false);
		expect(setStatus).toHaveBeenCalledWith('r1', recorder.identity, 'PA_1', settings);
	});

	test('a new session does not inherit the previous recording state', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: true });
		f.liveKitService.listParticipants.mockResolvedValue([{ ...recorder, sessionId: 'PA_2' }, { ...member }]);

		await f.service.refresh('r1');

		expect(recordingOf(recorder.identity)).toBe(false);
	});

	test('a stop report clears the display', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: true });
		await expect(f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: false })).resolves.toBe(true);

		await f.service.refresh('r1');

		expect(recordingOf(recorder.identity)).toBe(false);
	});

	test('a settings-only report keeps the recording state', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: true });

		await expect(f.service.reportStatus(me as any, 'r1', 'PA_1', { micMuted: true, deafened: false })).resolves.toBe(true);
		await f.service.refresh('r1');

		expect(recordingOf(recorder.identity)).toBe(true);
		expect(setStatus).toHaveBeenLastCalledWith('r1', recorder.identity, 'PA_1', { micMuted: true, deafened: false });
	});

	test('a settings-only report from a clean participant creates no recording state', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', settings);
		await f.service.refresh('r1');

		expect(recordingOf(recorder.identity)).toBe(false);
		expect([...f.redis.store.keys()].some(key => key.startsWith('chatVoice:recordingState:'))).toBe(false);
	});

	test('rejects a recording start when the room does not allow recording', async () => {
		f.chatRoomsRepository.findOneBy.mockResolvedValue({ ...f.rooms.get('r1'), allowRecording: false });

		await expect(f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: true })).resolves.toBe(false);

		expect(setStatus).not.toHaveBeenCalled();
		expect([...f.redis.store.keys()].some(key => key.startsWith('chatVoice:recordingState:'))).toBe(false);
	});

	test('rejects a report from a session that is no longer connected without writing state', async () => {
		setStatus.mockResolvedValue(false);

		await expect(f.service.reportStatus(me as any, 'r1', 'PA_old', { ...settings, recording: true })).resolves.toBe(false);

		expect([...f.redis.store.keys()].some(key => key.startsWith('chatVoice:recordingState:'))).toBe(false);
	});

	test('clears the recording state of a participant who left the call', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: true });
		const stateKey = [...f.redis.store.keys()].find(key => key.startsWith('chatVoice:recordingState:'))!;
		expect(stateKey).toBeDefined();
		f.liveKitService.listParticipants.mockResolvedValue([{ ...member }]);

		await f.service.refresh('r1');

		expect(f.redis.store.has(stateKey)).toBe(false);
		expect(await f.redis.smembers('chatVoice:recordingIdentities:r1')).toEqual([]);
		expect(recordingOf(member.identity)).toBe(false);
	});

	test('overlapping reports of the same participant all apply without an internal error', async () => {
		const reports = Array.from({ length: 8 }, (_, i) => f.service.reportStatus(me as any, 'r1', 'PA_1', { micMuted: i % 2 === 0, deafened: false, recording: i % 2 === 0 }));

		await expect(Promise.all(reports)).resolves.toEqual(Array(8).fill(true));

		await f.service.refresh('r1');
		expect([true, false]).toContain(recordingOf(recorder.identity));
	});

	test('a failed remote queue does not fail the recording approval or the local display', async () => {
		await expect(f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: true })).resolves.toBe(true);
		f.queueService.deliver.mockRejectedValue(new Error('queue unavailable'));

		await f.service.refresh('r1').catch(() => {});

		expect(recordingOf(recorder.identity)).toBe(true);
	});
});

describe('recording changes federate without waiting for the interval', () => {
	test('sends a recording start to other servers inside the ten second interval', async () => {
		await f.service.refresh('r1');
		f.queueService.deliver.mockClear();

		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: true });
		await f.service.refresh('r1');

		const objects = f.queueService.deliver.mock.calls.map(call => (call[1] as any).object);
		expect(objects).toHaveLength(1);
		expect(objects[0].participants.find((p: { id: string }) => p.id === recorder.identity).recording).toBe(true);
		expect(objects[0]._misskey_recordingEvent).toBeUndefined();
	});

	test('sends a recording stop inside the interval too', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: true });
		await f.service.refresh('r1');
		f.queueService.deliver.mockClear();

		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: false });
		await f.service.refresh('r1');

		const objects = f.queueService.deliver.mock.calls.map(call => (call[1] as any).object);
		expect(objects).toHaveLength(1);
		expect(objects[0].participants.find((p: { id: string }) => p.id === recorder.identity).recording).toBe(false);
	});

	test('a recording send does not reset the throttle clock for non-recording changes', async () => {
		await f.service.refresh('r1');
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: true });
		await f.service.refresh('r1');
		f.queueService.deliver.mockClear();

		// 録画ではない変化 (画面共有) は、直前の録画送信に関係なく間隔の鍵が残っているあいだ送らない
		f.liveKitService.listParticipants.mockResolvedValue([{ ...recorder, screenSharing: true }, { ...member }]);
		await f.service.refresh('r1');
		expect(f.queueService.deliver).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(10_001);
		const objects = f.queueService.deliver.mock.calls.map(call => (call[1] as any).object);
		expect(objects.length).toBeGreaterThan(0);
		expect(objects.at(-1).participants.find((p: { id: string }) => p.id === recorder.identity).screenSharing).toBe(true);
	});

	test('settings-only changes keep the thirty second rule even while recording', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...settings, recording: true });
		await f.service.refresh('r1');
		f.queueService.deliver.mockClear();

		await f.service.reportStatus(me as any, 'r1', 'PA_1', { micMuted: true, deafened: false, recording: true });
		await f.service.refresh('r1');

		expect(f.queueService.deliver).not.toHaveBeenCalled();
	});
});

describe('mirror recording display', () => {
	test('shows recording from the owner snapshot participants', async () => {
		const actor = mirror();

		await f.service.receiveRemoteSnapshot(actor as any, object(true) as any);

		const states = await f.service.getStates({ id: 'm1' }, ['r1']);
		expect(states[0].participants.find(participant => participant.identity === 'https://remote.test/users/rm1')?.recording).toBe(true);
		expect(f.globalEventService.publishMainStream.mock.calls.some(call => call[1] === 'chatRoomRecording')).toBe(false);
	});

	test('publishes a recording change immediately even inside the mirror interval', async () => {
		const actor = mirror();
		await f.service.receiveRemoteSnapshot(actor as any, object(false) as any);
		f.globalEventService.publishMainStream.mockClear();
		vi.setSystemTime(Date.now() + 1);

		await f.service.receiveRemoteSnapshot(actor as any, object(true) as any);

		const events = f.globalEventService.publishMainStream.mock.calls.filter(call => call[1] === 'chatRoomVoiceState');
		expect(events).toHaveLength(1);
		expect(events[0][2].participants.find((p: { identity: string }) => p.identity === 'https://remote.test/users/rm1').recording).toBe(true);
	});

	test('a mirror recording publish does not reset the interval for non-recording changes', async () => {
		const actor = mirror();
		await f.service.receiveRemoteSnapshot(actor as any, object(false) as any);
		vi.setSystemTime(Date.now() + 1);
		await f.service.receiveRemoteSnapshot(actor as any, object(true) as any);
		f.globalEventService.publishMainStream.mockClear();
		vi.setSystemTime(Date.now() + 1);

		await f.service.receiveRemoteSnapshot(actor as any, object(true, Date.now(), true) as any);

		expect(f.globalEventService.publishMainStream.mock.calls.filter(call => call[1] === 'chatRoomVoiceState')).toEqual([]);
	});

	test('still coalesces non-recording mirror changes', async () => {
		const actor = mirror();
		await f.service.receiveRemoteSnapshot(actor as any, object(false) as any);
		f.globalEventService.publishMainStream.mockClear();
		vi.setSystemTime(Date.now() + 1);

		await f.service.receiveRemoteSnapshot(actor as any, object(false, Date.now(), true) as any);

		expect(f.globalEventService.publishMainStream.mock.calls.filter(call => call[1] === 'chatRoomVoiceState')).toEqual([]);
	});

	test('rejects a forged room owner', async () => {
		const actor = mirror();

		const result = await f.service.receiveRemoteSnapshot({ ...actor, id: 'another-owner' } as any, object(true) as any);

		expect(result).toMatch(/^skip/);
		expect(await f.service.getStates({ id: 'm1' }, ['r1'])).toEqual([]);
	});
});
