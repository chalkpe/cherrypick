/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MainChannel } from '@/server/api/stream/channels/main.js';
import { ChatService } from '@/core/ChatService.js';
import { createFixture, mirrorRoom, pauseNextCall, TEST_CLOCK } from '../misc/chat-voice-fixture.js';

const state = { type: 'chatRoomVoiceState', body: { roomId: 'r1', participants: [{ identity: 'i1' }], updatedAt: TEST_CLOCK } };
const fixtures: ReturnType<typeof createFixture>[] = [];

function fixture() {
	const f = createFixture();
	fixtures.push(f);
	const subscriber = new EventEmitter();
	const send = vi.fn();
	const connection: { user: { id: string }; token?: { permission: readonly string[] }; subscriber: EventEmitter; sendMessageToWs: typeof send } = { user: { id: 'm1' }, subscriber, sendMessageToWs: send };
	const chatService = Object.assign(Object.create(ChatService.prototype), { roleService: f.roleService });
	const channel = Object.assign(Object.create(MainChannel.prototype), {
		connection, chatService,
		id: 'main', noteEntityService: {}, chatVoiceService: f.service,
		chatRoomsRepository: f.chatRoomsRepository, chatRoomMembershipsRepository: f.chatRoomMembershipsRepository,
		voiceRooms: new Map(), disposed: false,
	}) as MainChannel;
	const publish = (name: string, data: unknown) => Promise.all(subscriber.listeners(name).map(listener => listener(data)));
	f.globalEventService.publishMainStream.mockImplementation((id, type, body) => { if (id === 'm1') subscriber.emit('mainStream:m1', { type, body }); });
	return { ...f, channel, connection, subscriber, send, publish };
}

afterEach(() => {
	for (const f of fixtures.splice(0)) f.service.onApplicationShutdown();
	vi.useRealTimers();
});

describe('voice state at the main channel boundary', () => {
	test.each([
		['web session', undefined, 'available', true],
		['chat app', { permission: ['read:account', 'read:chat'] }, 'available', true],
		['account-only app', { permission: ['read:account'] }, 'available', false],
		['read-only web session', undefined, 'readonly', true],
		['read-only chat app', { permission: ['read:account', 'read:chat'] }, 'readonly', true],
		['unavailable web session', undefined, 'unavailable', false],
		['unavailable chat app', { permission: ['read:account', 'read:chat'] }, 'unavailable', false],
	] as const)('%s receives voice state only when chat is readable', async (_label, token, availability, delivered) => {
		const f = fixture();
		f.connection.token = token;
		f.roleService.getUserPolicies.mockResolvedValue({ canVoiceCall: true, canScreenShare: true, chatAvailability: availability });
		await f.channel.init({});
		await f.publish('mainStream:m1', state);
		expect(f.send).toHaveBeenCalledTimes(delivered ? 1 : 0);
		if (delivered) expect(f.send).toHaveBeenCalledWith('channel', { id: 'main', type: 'chatRoomVoiceState', body: state.body });
		f.channel.dispose();
	});

	test('policy changes and errors stop voice state without blocking other main events', async () => {
		const f = fixture();
		await f.channel.init({});
		await f.publish('mainStream:m1', state);
		expect(f.send).toHaveBeenCalledTimes(1);
		f.send.mockClear();
		f.roleService.getUserPolicies.mockResolvedValue({ canVoiceCall: true, canScreenShare: true, chatAvailability: 'unavailable' });
		await f.publish('mainStream:m1', state);
		expect(f.send).not.toHaveBeenCalled();
		f.roleService.getUserPolicies.mockRejectedValue(new Error('policy unavailable'));
		await f.publish('mainStream:m1', state);
		expect(f.send).not.toHaveBeenCalled();
		f.connection.token = { permission: ['read:account'] };
		await f.publish('mainStream:m1', { type: 'unreadNotification', body: null });
		expect(f.send).toHaveBeenCalledWith('channel', { id: 'main', type: 'unreadNotification', body: null });
		f.channel.dispose();
	});

	test('membership revocation during a policy lookup drops the pending event', async () => {
		const f = fixture();
		await f.channel.init({});
		const policy = pauseNextCall(f.roleService.getUserPolicies);
		const sending = f.publish('mainStream:m1', state);
		await policy.reached;
		await f.publish('chatRoomStream:r1', { type: 'membershipEnded', body: { userId: 'm1' } });
		policy.resume();
		await sending;
		expect(f.send).not.toHaveBeenCalled();
		f.channel.dispose();
	});

	test.each([
		['web session', undefined],
		['chat app', { permission: ['read:account', 'read:chat'] }],
	] as const)('a revoked mirror cannot deliver old participants after the empty event to a %s', async (_label, token) => {
		vi.useFakeTimers({ now: TEST_CLOCK, toFake: ['Date'] });
		const f = fixture();
		f.connection.token = token;
		const room = mirrorRoom();
		f.rooms.set('r1', room);
		const frames: { type: string; body: any }[] = [];
		f.globalEventService.publishMainStream.mockImplementation((_id, type, body) => { frames.push({ type, body }); });
		await f.channel.init({});
		expect(await f.service.storeRemoteSnapshot(room, [{ identity: 'https://local.test/users/u1', screenSharing: false }], TEST_CLOCK)).toBe('stored');
		expect(frames).toHaveLength(1);
		const policy = pauseNextCall(f.roleService.getUserPolicies);
		const oldEvent = f.publish('mainStream:m1', frames[0]);
		await policy.reached;
		await f.service.clearMirrorSnapshots();
		expect(frames).toHaveLength(2);
		await f.publish('mainStream:m1', frames[1]);
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(f.send).toHaveBeenLastCalledWith('channel', { id: 'main', type: 'chatRoomVoiceState', body: { roomId: 'r1', participants: [], updatedAt: TEST_CLOCK } });
		policy.resume();
		await oldEvent;
		expect(f.send).toHaveBeenCalledTimes(2);
		for (const [, event] of f.send.mock.calls) {
			expect(event.body.participants).toEqual([]);
		}
		f.channel.dispose();
	});

	test('disposing during a policy lookup drops the pending event', async () => {
		const f = fixture();
		await f.channel.init({});
		const policy = pauseNextCall(f.roleService.getUserPolicies);
		const sending = f.publish('mainStream:m1', state);
		await policy.reached;
		f.channel.dispose();
		policy.resume();
		await sending;
		expect(f.send).not.toHaveBeenCalled();
	});

	test('requires membership even for moderators and fails closed on errors', async () => {
		const f = fixture();
		await f.channel.init({});
		await f.publish('mainStream:m1', state);
		expect(f.send).toHaveBeenCalledTimes(1);
		f.send.mockClear();
		f.chatRoomMembershipsRepository.exists.mockResolvedValue(false);
		await f.publish('mainStream:m1', state);
		expect(f.send).not.toHaveBeenCalled();
		f.chatRoomMembershipsRepository.exists.mockRejectedValue(new Error('db unavailable'));
		await f.publish('mainStream:m1', state);
		expect(f.send).not.toHaveBeenCalled();
		f.channel.dispose();
	});

	test.each(['membershipEnded', 'roomDeleted'])('an observed %s invalidates a pending positive membership check', async type => {
		const f = fixture();
		await f.channel.init({});
		const paused = pauseNextCall(f.chatRoomMembershipsRepository.exists);
		const sending = f.publish('mainStream:m1', state);
		// 旧実装にも到達できるよう、呼び出しが始まるまでマイクロタスクだけ待つ。
		for (let i = 0; i < 10; i++) await Promise.resolve();
		await f.publish('chatRoomStream:r1', { type, body: type === 'roomDeleted' ? null : { userId: 'm1' } });
		paused.resume();
		await sending;
		expect(f.send).not.toHaveBeenCalled();
		f.channel.dispose();
		expect(f.subscriber.listenerCount('chatRoomStream:r1')).toBe(0);
	});

	test('a lagging main worker applies authoritative host refusal and settings-read failure', async () => {
		const f = fixture();
		f.rooms.set('r1', mirrorRoom());
		f.redis.store.set('chatVoice:state:r1', JSON.stringify({ ...state.body }));
		await f.channel.init({});
		for (const unavailable of [false, true]) {
			if (unavailable) f.metaService.fetch.mockRejectedValue(new Error('settings unavailable'));
			else f.metaService.fetch.mockResolvedValue({ ...f.meta, blockedHosts: ['remote.test'] });
			await f.publish('mainStream:m1', state);
			expect(f.send).toHaveBeenLastCalledWith('channel', { id: 'main', type: 'chatRoomVoiceState', body: { ...state.body, participants: [] } });
		}
		f.channel.dispose();
	});

	test('an empty mirror frame still requires membership but does not read the authoritative policy', async () => {
		const f = fixture();
		f.rooms.set('r1', mirrorRoom());
		await f.channel.init({});
		const empty = { ...state, body: { ...state.body, participants: [] } };
		await f.publish('mainStream:m1', empty);
		expect(f.send).toHaveBeenCalledWith('channel', { id: 'main', type: 'chatRoomVoiceState', body: empty.body });
		expect(f.metaService.fetch).not.toHaveBeenCalled();
		f.send.mockClear();
		f.chatRoomMembershipsRepository.exists.mockResolvedValue(false);
		await f.publish('mainStream:m1', empty);
		expect(f.send).not.toHaveBeenCalled();
		f.channel.dispose();
	});

	// 認可しているあいだに新しい現況が保存されて待たされても、古い通知を空にして送らない (新しい現況はまとめて送られる)
	test.each([false, true])('a superseded mirror frame is dropped rather than blanked while its successor waits in the gate (owner refused: %s)', async refused => {
		vi.useFakeTimers({ now: TEST_CLOCK });
		const f = fixture();
		const room = mirrorRoom();
		f.rooms.set('r1', room);
		const frames: { type: string; body: any }[] = [];
		f.globalEventService.publishMainStream.mockImplementation((_id, type, body) => { frames.push({ type, body }); });
		await f.channel.init({});
		const people = [{ identity: 'https://local.test/users/u1', screenSharing: false }];
		expect(await f.service.storeRemoteSnapshot(room, people, TEST_CLOCK)).toBe('stored');
		expect(frames).toHaveLength(1);
		const authorizing = pauseNextCall(f.chatRoomMembershipsRepository.exists);
		const delivering = f.publish('mainStream:m1', frames[0]);
		await authorizing.reached;
		expect(await f.service.storeRemoteSnapshot(room, [...people, { identity: 'https://local.test/users/u2', screenSharing: false }], TEST_CLOCK + 1)).toBe('stored');
		expect(frames).toHaveLength(1);
		if (refused) f.metaService.fetch.mockResolvedValue({ ...f.meta, blockedHosts: ['remote.test'] });
		authorizing.resume();
		await delivering;
		if (refused) {
			// 断った持ち主のルームは、これまでどおり参加者のいない通知にする
			expect(f.send).toHaveBeenCalledWith('channel', { id: 'main', type: 'chatRoomVoiceState', body: { ...frames[0].body, participants: [] } });
		} else {
			expect(f.send).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(10_001);
			expect(frames).toHaveLength(2);
			await f.publish('mainStream:m1', frames[1]);
			expect(f.send).toHaveBeenCalledTimes(1);
			expect(f.send).toHaveBeenCalledWith('channel', { id: 'main', type: 'chatRoomVoiceState', body: expect.objectContaining({ updatedAt: TEST_CLOCK + 1, participants: [expect.anything(), expect.anything()] }) });
		}
		f.channel.dispose();
	});

	test('an old mirror event cannot restore participants after host-policy cache invalidation', async () => {
		vi.useFakeTimers({ now: TEST_CLOCK, toFake: ['Date'] });
		const f = fixture();
		f.rooms.set('r1', mirrorRoom());
		await f.channel.init({});
		// 許可に戻っても、取り消した現況の遅い main イベントは表示しない。
		await f.publish('mainStream:m1', state);
		expect(f.send).toHaveBeenCalledWith('channel', { id: 'main', type: 'chatRoomVoiceState', body: { ...state.body, participants: [] } });
		f.channel.dispose();
	});

	test.each(['local', 'mirror'])('late %s packing cannot disclose participants after a member leaves', async source => {
		vi.useFakeTimers({ now: TEST_CLOCK, toFake: ['Date'] });
		const f = fixture();
		await f.channel.init({});
		f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false }]);
		const packed = pauseNextCall(f.userEntityService.packMany);
		const work = source === 'local' ? f.service.refresh('r1') : f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], TEST_CLOCK);
		await packed.reached;
		f.chatRoomMembershipsRepository.exists.mockResolvedValue(false);
		await f.publish('chatRoomStream:r1', { type: 'membershipEnded', body: { userId: 'm1' } });
		packed.resume();
		await work;
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(f.send).not.toHaveBeenCalled();
		f.channel.dispose();
	});
});


describe('recording events at the main channel boundary', () => {
	const event = { type: 'chatRoomRecording', body: { roomId: 'r1', id: '070d4100-0123-4321-a123-012345678901', identity: 'https://local.test/users/u1', recording: true, updatedAt: TEST_CLOCK, user: { id: 'u1' } } };

	test.each([
		['account only', ['read:account'], true, false],
		['chat reader', ['read:account', 'read:chat'], true, true],
		['former member', ['read:account', 'read:chat'], false, false],
	] as const)('%s receives only authorized recording notices', async (_label, permission, member, delivered) => {
		const f = fixture();
		f.connection.token = { permission };
		f.chatRoomMembershipsRepository.exists.mockResolvedValue(member);
		await f.channel.init({});

		await f.publish('mainStream:m1', event);

		expect(f.send).toHaveBeenCalledTimes(delivered ? 1 : 0);
		f.channel.dispose();
	});
});
