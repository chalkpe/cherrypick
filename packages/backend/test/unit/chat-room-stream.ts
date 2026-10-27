/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomChannel } from '@/server/api/stream/channels/chat-room.js';
import type { ChatRoomsRepository } from '@/models/_.js';
import type { ChannelRequest } from '@/server/api/stream/channel.js';

const stream = 'chatRoomStream:r1';
const event = { type: 'deleted', body: 'message-1' } as const;
const left = { type: 'membershipEnded', body: { userId: 'member' } } as const;
const deleted = { type: 'roomDeleted', body: null } as const;

afterEach(() => vi.useRealTimers());

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

function fixture() {
	const subscriber = new EventEmitter();
	const send = vi.fn();
	const room = { id: 'r1', ownerId: 'owner' };
	const rooms = { findOneBy: vi.fn().mockResolvedValue(room) };
	const isMember = vi.fn().mockResolvedValue(true);
	const isModerator = vi.fn().mockResolvedValue(false);
	const permissions = Object.assign(Object.create(ChatService.prototype), {
		roleService: { isModerator },
	}) as ChatService;
	Object.defineProperty(permissions, 'isRoomMember', { value: isMember });
	const permission = vi.fn(permissions.hasPermissionToViewRoomTimeline.bind(permissions));
	const channel = new ChatRoomChannel({
		id: 'channel-1',
		connection: { user: { id: 'member' }, subscriber, sendMessageToWs: send },
	} as unknown as ChannelRequest, rooms as unknown as ChatRoomsRepository, {
		hasPermissionToViewRoomTimeline: permission,
	} as unknown as ChatService);
	const publish = (data: unknown) => Promise.all(subscriber.listeners(stream).map(listener => listener(data)));
	return { channel, rooms, permission, isMember, isModerator, subscriber, send, publish };
}

describe('ChatRoomChannel access lifetime', () => {
	test('a member who leaves immediately stops receiving room events and unsubscribes', async () => {
		const f = fixture();
		expect(await f.channel.init({ roomId: 'r1' })).toBe(true);
		await f.publish(event);
		expect(f.send).toHaveBeenCalledWith('channel', { id: 'channel-1', type: 'deleted', body: 'message-1' });
		f.send.mockClear();
		f.isMember.mockResolvedValue(false);
		await f.publish(left);
		await f.publish(event);
		expect(f.send).not.toHaveBeenCalled();
		expect(f.subscriber.listenerCount(stream)).toBe(0);
		expect(f.permission).toHaveBeenCalledTimes(2);
	});

	test.each([false, true])('a deleted room stops the subscriber (moderator: %s)', async moderator => {
		const f = fixture();
		f.isMember.mockResolvedValue(!moderator);
		f.isModerator.mockResolvedValue(moderator);
		await f.channel.init({ roomId: 'r1' });
		f.rooms.findOneBy.mockResolvedValue(null);
		await f.publish(deleted);
		await f.publish(event);
		expect(f.send).not.toHaveBeenCalled();
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});

	test('a non-member moderator retains access after leaving and control events stay internal', async () => {
		const f = fixture();
		f.isMember.mockResolvedValue(false);
		f.isModerator.mockResolvedValue(true);
		await f.channel.init({ roomId: 'r1' });
		await f.publish(left);
		expect(f.permission).toHaveBeenCalledTimes(2);
		expect(f.send).not.toHaveBeenCalled();
		await f.publish(event);
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(f.subscriber.listenerCount(stream)).toBe(1);
	});

	test('another member leaving does not interrupt a member who stays or cause a permission lookup', async () => {
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		await f.publish({ type: 'membershipEnded', body: { userId: 'other' } });
		expect(f.send).not.toHaveBeenCalled();
		await f.publish(event);
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(f.permission).toHaveBeenCalledTimes(1);
	});

	test('unsignalled loss of access is checked at 60 seconds with no lookup per event inside the window', async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		f.permission.mockResolvedValue(false);
		for (const age of [0, 30_000, 59_999]) {
			vi.setSystemTime(1_000_000 + age);
			await f.publish(event);
		}
		expect(f.send).toHaveBeenCalledTimes(3);
		expect(f.rooms.findOneBy).toHaveBeenCalledTimes(1);
		vi.setSystemTime(1_060_000);
		await f.publish(event);
		expect(f.send).toHaveBeenCalledTimes(3);
		expect(f.permission).toHaveBeenCalledTimes(2);
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});

	test('an allowed backstop check is shared by concurrent events and cached for another 60 seconds', async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		vi.setSystemTime(1_060_000);
		const check = deferred<boolean>();
		f.permission.mockReturnValue(check.promise);
		const events = [f.publish(event), f.publish(event)];
		check.resolve(true);
		await Promise.all(events);
		await f.publish(event);
		expect(f.permission).toHaveBeenCalledTimes(2);
		expect(f.send).toHaveBeenCalledTimes(3);
	});

	test.each([left, deleted])('a control event invalidates an in-flight allowed backstop check ($type)', async control => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		vi.setSystemTime(1_060_000);
		const old = deferred<boolean>();
		f.permission.mockReturnValueOnce(old.promise).mockResolvedValue(false);
		const pending = f.publish(event);
		// 無効化前に、古い問い合わせが権限サービスへ到達するまで待つ。
		await Promise.resolve();
		await f.publish(control);
		old.resolve(true);
		await pending;
		await f.publish(event);
		expect(f.send).not.toHaveBeenCalled();
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});

	test('a leave invalidates an event awaiting its cached permission result', async () => {
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		const pending = f.publish(event);
		f.permission.mockResolvedValue(false);
		await f.publish(left);
		await pending;
		expect(f.send).not.toHaveBeenCalled();
	});

	test('events wait for the leave recheck before forwarding, even inside the old cache window', async () => {
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		const check = deferred<boolean>();
		f.permission.mockReturnValue(check.promise);
		const control = f.publish(left);
		const pending = f.publish(event);
		expect(f.send).not.toHaveBeenCalled();
		check.resolve(false);
		await Promise.all([control, pending]);
		expect(f.send).not.toHaveBeenCalled();
	});

	test('disposal prevents forwarding after a pending check resolves', async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		vi.setSystemTime(1_060_000);
		const check = deferred<boolean>();
		f.permission.mockReturnValue(check.promise);
		const pending = f.publish(event);
		f.channel.dispose();
		check.resolve(true);
		await pending;
		expect(f.send).not.toHaveBeenCalled();
	});

	test('a leave during initialization invalidates the initial permission lookup', async () => {
		const f = fixture();
		const old = deferred<boolean>();
		f.permission.mockReturnValueOnce(old.promise).mockResolvedValue(false);
		const pending = f.channel.init({ roomId: 'r1' });
		await Promise.resolve();
		await f.publish(left);
		old.resolve(true);
		expect(await pending).toBe(false);
		await f.publish(event);
		expect(f.send).not.toHaveBeenCalled();
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});

	test.each(['current-first', 'old-first'] as const)('initialization follows the current allowed moderator check (%s)', async order => {
		const f = fixture();
		f.isMember.mockResolvedValue(false);
		f.isModerator.mockResolvedValue(true);
		const old = deferred<boolean>();
		const current = deferred<boolean>();
		f.permission.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
		let initialized = false;
		const pending = f.channel.init({ roomId: 'r1' }).then(allowed => {
			initialized = true;
			return allowed;
		});
		await Promise.resolve();
		const control = f.publish(left);
		await Promise.resolve();
		expect(f.permission).toHaveBeenCalledTimes(2);

		if (order === 'current-first') {
			current.resolve(true);
			await control;
			old.resolve(true);
		} else {
			old.resolve(true);
			// 古い判定が終わっても、最新の判定までは初期化を確定しない。
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(initialized).toBe(false);
			expect(f.send).not.toHaveBeenCalled();
			expect(f.subscriber.listenerCount(stream)).toBe(1);
			current.resolve(true);
		}

		expect(await pending).toBe(true);
		await control;
		expect(f.send).not.toHaveBeenCalled();
		expect(f.subscriber.listenerCount(stream)).toBe(1);
		await f.publish(event);
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', type: 'deleted', body: 'message-1' });
	});

	test('disposal during initialization cannot attach a listener later', async () => {
		const f = fixture();
		const check = deferred<boolean>();
		f.permission.mockReturnValue(check.promise);
		const pending = f.channel.init({ roomId: 'r1' });
		f.channel.dispose();
		check.resolve(true);
		expect(await pending).toBe(false);
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});

	test.each(['room', 'permission'] as const)('a %s lookup error fails closed without a rejected event handler', async dependency => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		vi.setSystemTime(1_060_000);
		(dependency === 'room' ? f.rooms.findOneBy : f.permission).mockRejectedValue(new Error('unavailable'));
		await expect(f.publish(event)).resolves.toBeDefined();
		expect(f.send).not.toHaveBeenCalled();
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});
});
