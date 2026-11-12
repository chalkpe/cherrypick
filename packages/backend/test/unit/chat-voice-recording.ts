/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFixture, KNOWN_USERS, mirrorRoom } from '../misc/chat-voice-fixture.js';

const id = '070d4100-0123-4321-a123-012345678901';
const me = KNOWN_USERS.find(user => user.id === 'u1')!;
const member = { identity: 'https://local.test/users/m1', userId: 'm1', screenSharing: false, micTrackSid: null };
const recorder = { identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false, micTrackSid: null };
const base = { micMuted: false, deafened: false, recordingId: id };
let f: ReturnType<typeof createFixture>;

beforeEach(() => {
	vi.useFakeTimers({ now: Date.parse('2026-11-12T00:00:00Z') });
	f = createFixture();
	f.chatRoomsRepository.findOneBy.mockResolvedValue({ ...f.rooms.get('r1'), allowRecording: true });
	Object.assign(f.usersRepository, { findOneBy: vi.fn().mockResolvedValue(KNOWN_USERS.find(user => user.id === 'owner')) });
	Object.assign(f.liveKitService, { setParticipantStatus: vi.fn(async (_roomId: string, identity: string, _sid: string, status: { recording?: boolean }) => {
		for (const participant of await f.liveKitService.listParticipants()) if (participant.identity === identity) participant.recording = status.recording === true;
		return true;
	}) });
	f.liveKitService.listParticipants.mockResolvedValue([{ ...recorder }, { ...member }]);
	vi.spyOn(f.service, 'scheduleRefresh').mockImplementation(() => {});
	const find = f.chatRoomMembershipsRepository.findBy.getMockImplementation()!;
	f.chatRoomMembershipsRepository.findBy.mockImplementation(async where => where?.userId ? find(where) : [{ userId: 'm1' }, { userId: 'rm1' }]);
});

afterEach(() => { f.service.onApplicationShutdown(); vi.useRealTimers(); });

function notice(recording: boolean, at = Date.now()) {
	return { id, deliveryWindowMs: 8 * 86_400_000, identity: 'https://remote.test/users/rm1', recording, updatedAt: at };
}

function object(recording: boolean, at = Date.now()) {
	return {
		id: 'https://remote.test/chat/rooms/r1/voice', type: 'ChatRoomVoiceState', room: 'https://remote.test/chat/rooms/r1', updated: new Date(at).toISOString(),
		participants: [{ id: member.identity, screenSharing: false }, { id: 'https://remote.test/users/rm1', screenSharing: false, recording }],
		_misskey_recordingEvent: notice(recording, at),
	};
}

function mirror() {
	const room = { ...mirrorRoom(), uri: 'https://remote.test/chat/rooms/r1' };
	f.rooms.set('r1', room);
	return KNOWN_USERS.find(user => user.id === 'remoteOwner')!;
}

describe('recording event delivery independent of the voice snapshot gate', () => {
	test('queues both transitions even when recording starts and stops inside ten seconds', async () => {
		await f.service.refresh('r1');
		f.queueService.deliver.mockClear();
		f.globalEventService.publishMainStream.mockClear();

		await expect(f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true })).resolves.toBe(true);
		await expect(f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: false })).resolves.toBe(true);

		const events = f.queueService.deliver.mock.calls.map(call => (call[1] as any).object._misskey_recordingEvent);
		expect(events.map(event => event.recording)).toEqual([true, false]);
		expect(events[0].id).toBe(events[1].id);
		expect(events.every(event => event.identity === recorder.identity)).toBe(true);
		expect(f.globalEventService.publishMainStream.mock.calls.filter(call => call[1] === 'chatRoomRecording').map(call => (call[2] as any).recording)).toEqual([true, false]);
	});

	test('uses a fresh server event ID if an expired client ID is reused', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true });
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: false });
		vi.setSystemTime(Date.now() + 60 * 86_400_000);

		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true });

		const events = f.queueService.deliver.mock.calls.map(call => (call[1] as any).object._misskey_recordingEvent).filter(Boolean);
		expect(events[0].id).toBe(events[1].id);
		expect(events[2].id).not.toBe(events[0].id);
	});

	test('declares a delivery window that covers configured long automatic retries', async () => {
		(f.service as any).config.deliverJobMaxAttempts = 100;

		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true });

		const event = (f.queueService.deliver.mock.calls[0][1] as any).object._misskey_recordingEvent;
		expect(event.deliveryWindowMs).toBe(3_786_409_000);
		expect(Number.isSafeInteger(event.deliveryWindowMs)).toBe(true);
	});

	test('persists the room for sweep recovery before acknowledging a recording start', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true });

		expect(await f.redis.smembers('chatVoice:active')).toContain('r1');
	});

	test('notifies remaining call members when a recorder loses its group membership', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true });
		f.nonMembers.add('u1');
		f.liveKitService.listParticipants.mockResolvedValue([member]);

		await f.service.refresh('r1');

		const events = f.globalEventService.publishMainStream.mock.calls.filter(call => call[1] === 'chatRoomRecording');
		expect(events.map(call => (call[2] as any).recording)).toEqual([true, false]);
	});

	test('retains a stop event when the recording client leaves before its final status can arrive', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true });
		f.liveKitService.listParticipants.mockResolvedValue([member]);

		await f.service.refresh('r1');

		const events = f.queueService.deliver.mock.calls.map(call => (call[1] as any).object._misskey_recordingEvent).filter(Boolean);
		expect(events.map(event => event.recording)).toEqual([true, false]);
	});

	test('does not authorize capture when the durable delivery queue rejects the start', async () => {
		f.queueService.deliver.mockRejectedValueOnce(new Error('queue unavailable'));

		await expect(f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true })).rejects.toThrow('queue unavailable');

		expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();
	});

	test('retries an unacknowledged start with the same event and never reopens a completed recording ID', async () => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true });
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true });
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: false });

		expect(await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true })).toBe(false);
		expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
	});

	test.each(['user', 'room', 'session'] as const)('binds a recording ID to its authenticated %s', async field => {
		await f.service.reportStatus(me as any, 'r1', 'PA_1', { ...base, recording: true });
		const user = field === 'user' ? KNOWN_USERS.find(candidate => candidate.id === 'u2')! : me;
		const roomId = field === 'room' ? 'r2' : 'r1';
		const sid = field === 'session' ? 'PA_2' : 'PA_1';
		if (field === 'room') f.chatRoomsRepository.findOneBy.mockResolvedValue({ ...f.rooms.get('r1'), id: 'r2', allowRecording: true });

		expect(await f.service.reportStatus(user as any, roomId, sid, { ...base, recording: true })).toBe(false);
		expect(f.queueService.deliver).toHaveBeenCalledTimes(1);
	});

	test('delivers a late start notification after a newer stop snapshot without reviving the badge', async () => {
		const actor = mirror();
		await f.service.receiveRemoteSnapshot(actor as any, object(false) as any);
		f.globalEventService.publishMainStream.mockClear();

		await f.service.receiveRemoteSnapshot(actor as any, object(true, Date.now() - 100) as any);
		await f.service.receiveRemoteSnapshot(actor as any, object(true, Date.now() - 100) as any);

		const events = f.globalEventService.publishMainStream.mock.calls.filter(call => call[1] === 'chatRoomRecording');
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(['m1', 'chatRoomRecording', expect.objectContaining({ recording: true, id })]);
		const states = await f.service.getStates({ id: 'm1' }, ['r1']);
		expect(states[0].participants.find(participant => participant.identity === notice(true).identity)?.recording).toBe(false);
	});

	test('publishes both notices even when mirror snapshots are coalesced', async () => {
		const actor = mirror();
		await f.service.receiveRemoteSnapshot(actor as any, object(true) as any);
		vi.setSystemTime(Date.now() + 1);
		await f.service.receiveRemoteSnapshot(actor as any, object(false) as any);

		const events = f.globalEventService.publishMainStream.mock.calls.filter(call => call[1] === 'chatRoomRecording');
		expect(events.map(call => (call[2] as any).recording)).toEqual([true, false]);
	});

	test('rejects events beyond their replay lifetime and a forged room owner', async () => {
		const actor = mirror();
		await f.service.receiveRemoteSnapshot(actor as any, object(true, Date.now() - 60 * 86_400_000) as any);
		await f.service.receiveRemoteSnapshot({ ...actor, id: 'another-owner' } as any, object(true) as any);

		expect(f.globalEventService.publishMainStream.mock.calls.filter(call => call[1] === 'chatRoomRecording')).toEqual([]);
	});
});
