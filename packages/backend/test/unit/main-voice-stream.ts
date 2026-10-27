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
