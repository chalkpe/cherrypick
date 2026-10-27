/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MainChannel } from '@/server/api/stream/channels/main.js';
import { createFixture, mirrorRoom, pauseNextCall, TEST_CLOCK } from '../misc/chat-voice-fixture.js';

const state = { type: 'chatRoomVoiceState', body: { roomId: 'r1', participants: [{ identity: 'i1' }], updatedAt: TEST_CLOCK } };
const fixtures: ReturnType<typeof createFixture>[] = [];

function fixture() {
	const f = createFixture();
	fixtures.push(f);
	const subscriber = new EventEmitter();
	const send = vi.fn();
	const channel = Object.assign(Object.create(MainChannel.prototype), {
		connection: { user: { id: 'm1' }, subscriber, sendMessageToWs: send },
		id: 'main', noteEntityService: {}, chatVoiceService: f.service,
		chatRoomsRepository: f.chatRoomsRepository, chatRoomMembershipsRepository: f.chatRoomMembershipsRepository,
		voiceRooms: new Map(), disposed: false,
	}) as MainChannel;
	const publish = (name: string, data: unknown) => Promise.all(subscriber.listeners(name).map(listener => listener(data)));
	f.globalEventService.publishMainStream.mockImplementation((id, type, body) => { if (id === 'm1') subscriber.emit('mainStream:m1', { type, body }); });
	return { ...f, channel, subscriber, send, publish };
}

afterEach(() => {
	for (const f of fixtures.splice(0)) f.service.onApplicationShutdown();
	vi.useRealTimers();
});

describe('voice state at the main channel boundary', () => {
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
