/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomChannel } from '@/server/api/stream/channels/chat-room.js';
import { ChatUserChannel } from '@/server/api/stream/channels/chat-user.js';
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

function fixture(userId = 'member', read = vi.fn(async (..._args: unknown[]) => {})) {
	const subscriber = new EventEmitter();
	const send = vi.fn();
	const room = { id: 'r1', ownerId: 'owner', hasChannels: false, legacyChannelId: 'general' as string | null };
	const rooms = { findOneBy: vi.fn().mockResolvedValue(room) };
	const isMember = vi.fn().mockResolvedValue(true);
	const isModerator = vi.fn().mockResolvedValue(false);
	const permissions = Object.assign(Object.create(ChatService.prototype), {
		roleService: { isModerator },
	}) as ChatService;
	Object.defineProperty(permissions, 'isRoomMember', { value: isMember });
	const permission = vi.fn(permissions.hasPermissionToViewRoomTimeline.bind(permissions));
	const shouldNotify = vi.fn(async () => false);
	const getChatAvailability = vi.fn(async () => ({ read: true, write: true }));
	const resolveRoomChannel = vi.fn(async (_room, channelId) => channelId ?? room.legacyChannelId);
	const request = {
		id: 'channel-1',
		connection: { user: { id: userId }, subscriber, sendMessageToWs: send },
	} as unknown as ChannelRequest;
	const chat = {
		getChatAvailability,
		hasPermissionToViewRoomTimeline: permission,
		shouldNotifyRoomMessage: shouldNotify,
		readRoomChatMessage: read,
		resolveRoomChannel,
		findMessageById: vi.fn(async () => ({ toRoomChannelId: room.hasChannels ? 'other' : null })),
	} as unknown as ChatService;
	const channel = new ChatRoomChannel(request, rooms as unknown as ChatRoomsRepository, chat);
	const publish = (data: unknown, name = stream) => Promise.all(subscriber.listeners(name).map(listener => listener(data)));
	return { channel, request, chat, getChatAvailability, resolveRoomChannel, room, rooms, permission, isMember, isModerator, subscriber, send, publish, shouldNotify, read };
}

describe('ChatUserChannel delivery order', () => {
	const directStream = 'chatUserStream:member-other';
	const message = { type: 'message', body: { id: 'message-1', text: 'hello' } };
	const updated = { type: 'updated', body: { messageId: 'message-1', text: 'updated' } };

	test('delivers create, update and delete in publication order while the first role lookup waits', async () => {
		const f = fixture();
		const channel = new ChatUserChannel(f.request, f.chat);
		expect(await channel.init({ otherId: 'other' })).toBe(true);

		const permission = deferred<{ read: boolean; write: boolean }>();
		f.getChatAvailability.mockReturnValueOnce(permission.promise);
		const events = [
			f.publish(message, directStream),
			f.publish(updated, directStream),
			f.publish(event, directStream),
		];
		await new Promise<void>(resolve => setImmediate(resolve));
		const sentWhileWaiting = f.send.mock.calls.length;
		permission.resolve({ read: true, write: true });
		await Promise.all(events);

		expect(f.send.mock.calls.map(([, payload]) => payload.type)).toEqual(['message', 'updated', 'deleted']);
		expect(sentWhileWaiting).toBe(0);
	});

	test('drops a failed role lookup and still delivers the next event on the same subscription', async () => {
		const f = fixture();
		const channel = new ChatUserChannel(f.request, f.chat);
		expect(await channel.init({ otherId: 'other' })).toBe(true);

		f.getChatAvailability.mockRejectedValueOnce(new Error('role lookup unavailable'));
		await Promise.all([f.publish(message, directStream), f.publish(event, directStream)]);

		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', ...event });
	});

	test('drops waiting events after disposal', async () => {
		const f = fixture();
		const channel = new ChatUserChannel(f.request, f.chat);
		expect(await channel.init({ otherId: 'other' })).toBe(true);

		const permission = deferred<{ read: boolean; write: boolean }>();
		f.getChatAvailability.mockReturnValueOnce(permission.promise);
		const pending = f.publish(message, directStream);
		const waiting = f.publish(updated, directStream);
		channel.dispose();
		permission.resolve({ read: true, write: true });
		await Promise.all([pending, waiting]);

		expect(f.send).not.toHaveBeenCalled();
		expect(f.getChatAvailability).toHaveBeenCalledTimes(2);
	});
});

describe('수신자별 알림과 읽음 경계', () => {
	test.each([false, true])('메시지에 수신자의 소리 허용 %s를 전달한다', async allowed => {
		const f = fixture();
		f.shouldNotify.mockResolvedValue(allowed);
		await f.channel.init({ roomId: 'r1' });

		await f.publish({ type: 'message', body: { id: 'm1', toRoomId: 'r1', text: '본문' } });

		expect(f.send).toHaveBeenCalledWith('channel', expect.objectContaining({ type: 'message', body: expect.objectContaining({ shouldNotify: allowed }) }));
	});

	test('읽음 요청은 실제로 받은 메시지 경계를 전달한다', async () => {
		const f = fixture('reader-boundary');
		await f.channel.init({ roomId: 'r1' });

		f.channel.onMessage('read', { id: 'seen' });

		expect(f.read).toHaveBeenCalledWith('reader-boundary', 'r1', undefined, 'seen');
	});

	test('개인 설정 조회 실패는 이벤트를 중단하지 않고 소리만 억제한다', async () => {
		const f = fixture();
		f.shouldNotify.mockRejectedValue(new Error('settings unavailable'));
		await f.channel.init({ roomId: 'r1' });

		await expect(f.publish({ type: 'message', body: { id: 'm1', toRoomId: 'r1', text: '본문' } })).resolves.toBeDefined();

		expect(f.send).toHaveBeenCalledWith('channel', expect.objectContaining({ type: 'message', body: expect.objectContaining({ shouldNotify: false }) }));
	});
});

describe('ChatRoomChannel access lifetime', () => {
	test('a failed final role lookup suppresses one event and leaves the room subscribed', async () => {
		const f = fixture();
		expect(await f.channel.init({ roomId: 'r1' })).toBe(true);

		f.getChatAvailability.mockRejectedValueOnce(new Error('role lookup unavailable'));
		await f.publish(event);
		expect(f.send).not.toHaveBeenCalled();

		await f.publish({ ...event, body: 'message-2' });
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', type: 'deleted', body: 'message-2' });
	});

	test.each(['chatRoom', 'chatUser'])('an existing %s subscription checks the current chat read policy', async name => {
		const f = fixture();
		const direct = name === 'chatUser';
		const channel = direct ? new ChatUserChannel(f.request, f.chat) : f.channel;
		const streamName = direct ? 'chatUserStream:member-other' : stream;
		const message = { type: 'message', body: { id: 'm1', text: 'hello' } };
		expect(await channel.init(direct ? { otherId: 'other' } : { roomId: 'r1' })).toBe(true);

		f.getChatAvailability.mockResolvedValue({ read: true, write: false });
		await f.publish(message, streamName);
		expect(f.send).toHaveBeenCalledWith('channel', expect.objectContaining({ type: 'message' }));

		f.send.mockClear();
		f.getChatAvailability.mockResolvedValue({ read: false, write: false });
		await f.publish(message, streamName);
		expect(f.send).not.toHaveBeenCalled();
	});

	test('a removed member receives one termination notice, then no room events', async () => {
		const f = fixture();
		expect(await f.channel.init({ roomId: 'r1' })).toBe(true);
		await f.publish(event);
		expect(f.send).toHaveBeenCalledWith('channel', { id: 'channel-1', type: 'deleted', body: 'message-1' });
		f.send.mockClear();
		f.isMember.mockResolvedValue(false);
		await f.publish(left);
		await f.publish(event);
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', ...left });
		expect(f.subscriber.listenerCount(stream)).toBe(0);
		expect(f.permission).toHaveBeenCalledTimes(2);
	});

	test.each([false, true])('a deleted room notifies its subscriber once before disconnecting (moderator: %s)', async moderator => {
		const f = fixture();
		f.isMember.mockResolvedValue(!moderator);
		f.isModerator.mockResolvedValue(moderator);
		await f.channel.init({ roomId: 'r1' });
		f.rooms.findOneBy.mockResolvedValue(null);
		await f.publish(deleted);
		await f.publish(event);
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', type: 'roomDeleted', body: null });
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});

	test('a non-member moderator retains access and receives membership changes after leaving', async () => {
		const f = fixture();
		f.isMember.mockResolvedValue(false);
		f.isModerator.mockResolvedValue(true);
		await f.channel.init({ roomId: 'r1' });
		await f.publish(left);
		expect(f.permission).toHaveBeenCalledTimes(2);
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', type: 'membershipEnded', body: { userId: 'member' } });
		await f.publish(event);
		expect(f.send).toHaveBeenCalledTimes(2);
		expect(f.subscriber.listenerCount(stream)).toBe(1);
	});

	test('another member leaving does not interrupt a member who stays or cause a permission lookup', async () => {
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		await f.publish({ type: 'membershipEnded', body: { userId: 'other' } });
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', type: 'membershipEnded', body: { userId: 'other' } });
		await f.publish(event);
		expect(f.send).toHaveBeenCalledTimes(2);
		expect(f.permission).toHaveBeenCalledTimes(1);
	});

	test('membership changes are not sent after an expired permission check denies access', async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		vi.setSystemTime(1_060_000);
		f.permission.mockResolvedValue(false);
		await f.publish({ type: 'membershipEnded', body: { userId: 'other' } });
		expect(f.permission).toHaveBeenCalledTimes(2);
		expect(f.send).not.toHaveBeenCalled();
		expect(f.subscriber.listenerCount(stream)).toBe(0);
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
		const reachedPermission = deferred<void>();
		f.permission.mockImplementationOnce(() => {
			reachedPermission.resolve();
			return old.promise;
		}).mockResolvedValue(false);
		const pending = f.publish(event);
		// 권한 조회가 실제로 시작된 뒤 무효화한다.
		await reachedPermission.promise;
		await f.publish(control);
		old.resolve(true);
		await pending;
		await f.publish(event);
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', ...control });
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});

	test('room deletion during initialization neither grants access nor sends a notification', async () => {
		const f = fixture();
		const check = deferred<boolean>();
		const reachedPermission = deferred<void>();
		f.permission.mockImplementationOnce(() => {
			reachedPermission.resolve();
			return check.promise;
		});
		const pending = f.channel.init({ roomId: 'r1' });
		await reachedPermission.promise;
		f.rooms.findOneBy.mockResolvedValue(null);
		await f.publish(deleted);
		check.resolve(true);
		expect(await pending).toBe(false);
		expect(f.send).not.toHaveBeenCalled();
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});

	test('a channel lookup that completes after room deletion does not approve the subscription', async () => {
		const f = fixture();
		f.room.hasChannels = true;
		const lookup = deferred<string>();
		const reachedLookup = deferred<void>();
		f.resolveRoomChannel.mockImplementationOnce(() => {
			reachedLookup.resolve();
			return lookup.promise;
		});
		const pending = f.channel.init({ roomId: 'r1' });
		await reachedLookup.promise;
		await f.publish(deleted);
		lookup.resolve('general');

		expect(await pending).toBe(false);
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});

	test('a channel change during lookup retries with the current room', async () => {
		const f = fixture();
		f.room.hasChannels = true;
		const lookup = deferred<string>();
		const reachedLookup = deferred<void>();
		f.resolveRoomChannel.mockImplementationOnce(() => {
			reachedLookup.resolve();
			return lookup.promise;
		}).mockRejectedValue(new Error('channel no longer exists'));
		const pending = f.channel.init({ roomId: 'r1', channelId: 'general' });
		await reachedLookup.promise;
		await f.publish({ type: 'channelsUpdated', body: {} });
		lookup.resolve('general');

		expect(await pending).toBe(false);
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});

	test('room deletion while a leave recheck is pending sends no later events', async () => {
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		const check = deferred<boolean>();
		f.permission.mockReturnValue(check.promise);
		const leaving = f.publish(left);
		f.rooms.findOneBy.mockResolvedValue(null);
		await f.publish(deleted);
		check.resolve(false);
		await leaving;
		await f.publish(event);
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', ...left });
		expect(f.subscriber.listenerCount(stream)).toBe(0);
	});

	test('a leave invalidates an event awaiting its cached permission result', async () => {
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		const pending = f.publish(event);
		f.permission.mockResolvedValue(false);
		await f.publish(left);
		await pending;
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', ...left });
	});

	test('events wait for the leave recheck before forwarding, even inside the old cache window', async () => {
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		const check = deferred<boolean>();
		f.permission.mockReturnValue(check.promise);
		const control = f.publish(left);
		const pending = f.publish(event);
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', ...left });
		check.resolve(false);
		await Promise.all([control, pending]);
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', ...left });
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
		const reachedOld = deferred<void>();
		f.permission.mockImplementationOnce(() => {
			reachedOld.resolve();
			return old.promise;
		}).mockResolvedValue(false);
		const pending = f.channel.init({ roomId: 'r1' });
		await reachedOld.promise;
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
		const reachedOld = deferred<void>();
		const reachedCurrent = deferred<void>();
		f.permission.mockImplementationOnce(() => {
			reachedOld.resolve();
			return old.promise;
		}).mockImplementationOnce(() => {
			reachedCurrent.resolve();
			return current.promise;
		});
		let initialized = false;
		const pending = f.channel.init({ roomId: 'r1' }).then(allowed => {
			initialized = true;
			return allowed;
		});
		await reachedOld.promise;
		const control = f.publish(left);
		await reachedCurrent.promise;
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

	test.each(['room', 'permission', 'role'] as const)('a %s lookup error during room permission refresh closes the subscription safely', async dependency => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const f = fixture();
		await f.channel.init({ roomId: 'r1' });
		vi.setSystemTime(1_060_000);
		const lookup = {
			room: f.rooms.findOneBy,
			permission: f.permission,
			role: f.getChatAvailability,
		}[dependency];
		lookup.mockRejectedValueOnce(new Error('unavailable'));

		await expect(f.publish(event)).resolves.toBeDefined();
		expect(f.send).not.toHaveBeenCalled();
		expect(f.subscriber.listenerCount(stream)).toBe(0);

		const retry = new ChatRoomChannel(f.request, f.rooms as unknown as ChatRoomsRepository, f.chat);
		expect(await retry.init({ roomId: 'r1' })).toBe(true);
		await f.publish(event);
		expect(f.send).toHaveBeenCalledExactlyOnceWith('channel', { id: 'channel-1', ...event });
	});
});

describe('채널별 스트림', () => {
	test('채널을 지정하지 않은 연결에 다른 채널 본문을 보내지 않는다', async () => {
		const f = fixture();
		f.room.hasChannels = true;
		await f.channel.init({ roomId: 'r1' });

		await f.publish({ type: 'message', body: { id: 'secret', toRoomChannelId: 'other', text: '다른 채널 본문' } });
		await f.publish({ type: 'updated', body: { messageId: 'secret', text: '수정한 비공개 본문', editedAt: new Date().toISOString() } });

		expect(JSON.stringify(f.send.mock.calls)).not.toContain('본문');
	});

	test('선택한 채널의 새 글만 전달한다', async () => {
		const f = fixture();
		f.room.hasChannels = true;
		await f.channel.init({ roomId: 'r1', channelId: 'other' });

		await f.publish({ type: 'message', body: { id: 'wanted', toRoomChannelId: 'other', text: '선택한 채널' } });
		await f.publish({ type: 'message', body: { id: 'general-message', toRoomChannelId: 'general', text: '구버전 채널' } });

		expect(f.send).toHaveBeenCalledWith('channel', expect.objectContaining({ type: 'message', body: expect.objectContaining({ id: 'wanted' }) }));
		expect(JSON.stringify(f.send.mock.calls)).not.toContain('구버전 채널');
	});
});

test('모드 갱신 통지를 놓친 연결도 새 채널 본문을 받지 않는다', async () => {
	const f = fixture();
	await f.channel.init({ roomId: 'r1' });
	f.rooms.findOneBy.mockResolvedValue({ ...f.room, hasChannels: true, legacyChannelId: 'general' });

	await f.publish({ type: 'message', body: { id: 'new-channel-message', toRoomChannelId: 'other', text: '갱신 전 연결에 비공개' } });

	expect(JSON.stringify(f.send.mock.calls)).not.toContain('비공개');
});

describe('스트림의 읽음 요청 묶기', () => {
	const flush = () => vi.advanceTimersByTimeAsync(0);
	let seq = 0;
	const newUser = () => `reader-${++seq}`;
	const ids = (f: { read: { mock: { calls: unknown[][] } } }) => f.read.mock.calls.map(call => call[3]);

	/** 같은 사용자가 연결·채널을 여러 개 열었을 때처럼, 읽음 처리 함수 하나를 공유하는 채널들을 만든다 */
	async function open(userId: string, channelIds: (string | undefined)[], read = vi.fn(async (..._args: unknown[]) => {})) {
		const channels = [];
		for (const channelId of channelIds) {
			const f = fixture(userId, read);
			await f.channel.init({ roomId: 'r1', ...(channelId != null ? { channelId } : {}) });
			channels.push(f.channel);
		}
		return { channels, read };
	}

	test('연달아 보낸 읽음은 동시에 하나만 처리하고 마지막 id를 이어서 처리한다', async () => {
		vi.useFakeTimers();
		const user = newUser();
		const f = fixture(user);
		const first = deferred<void>();
		f.read.mockImplementationOnce(() => first.promise);
		await f.channel.init({ roomId: 'r1' });

		for (let i = 0; i < 500; i++) f.channel.onMessage('read', { id: `m${i}` });
		await flush();
		expect(f.read).toHaveBeenCalledTimes(1);
		expect(f.read).toHaveBeenLastCalledWith(user, 'r1', undefined, 'm0');

		first.resolve();
		await vi.advanceTimersByTimeAsync(999);
		expect(f.read).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(f.read).toHaveBeenCalledTimes(2);
		expect(f.read).toHaveBeenLastCalledWith(user, 'r1', undefined, 'm499');

		await vi.advanceTimersByTimeAsync(10_000);
		expect(f.read).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('처리가 끝난 뒤 기다리는 동안 온 읽음도 마지막 id 하나로 합친다', async () => {
		vi.useFakeTimers();
		const f = fixture(newUser());
		await f.channel.init({ roomId: 'r1' });

		f.channel.onMessage('read', { id: 'a' });
		await flush();
		f.channel.onMessage('read', { id: 'b' });
		f.channel.onMessage('read', { id: 'c' });
		expect(f.read).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1000);
		expect(ids(f)).toEqual(['a', 'c']);
	});

	test('한 사용자가 채널 인스턴스를 여러 개 만들어도 동시에 도는 읽음 처리는 하나다', async () => {
		vi.useFakeTimers();
		const user = newUser();
		let active = 0;
		let maxActive = 0;
		const gates: ReturnType<typeof deferred<void>>[] = [];
		const read = vi.fn(async (..._args: unknown[]) => {
			active++;
			maxActive = Math.max(maxActive, active);
			const gate = deferred<void>();
			gates.push(gate);
			await gate.promise;
			active--;
		});
		const { channels } = await open(user, ['c1', 'c2', 'c3', undefined], read);

		channels.forEach((channel, i) => channel.onMessage('read', { id: `m${i}` }));
		await flush();
		expect(read).toHaveBeenCalledTimes(1);

		// 다른 채널의 대기 읽음은 앞의 처리가 끝나고 사용자 단위 최소 간격(100ms)이 지나면 1초를 기다리지 않고 이어서 처리한다
		for (let i = 1; i < channels.length; i++) {
			gates[i - 1].resolve();
			await vi.advanceTimersByTimeAsync(100);
			expect(read).toHaveBeenCalledTimes(i + 1);
		}
		gates[channels.length - 1].resolve();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(maxActive).toBe(1);
		expect(read).toHaveBeenCalledTimes(channels.length);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('같은 채널 id로 다시 만든 인스턴스도 앞의 처리가 끝나고 1초가 지나기 전에는 새 처리를 띄우지 못한다', async () => {
		vi.useFakeTimers();
		const user = newUser();
		const first = deferred<void>();
		const read = vi.fn(async (..._args: unknown[]) => {});
		read.mockImplementationOnce(() => first.promise);
		const { channels } = await open(user, ['c1', 'c1'], read);

		channels[0].onMessage('read', { id: 'a' });
		await flush();
		channels[0].dispose();
		channels[1].onMessage('read', { id: 'b' });
		await flush();
		expect(read).toHaveBeenCalledTimes(1);

		first.resolve();
		await vi.advanceTimersByTimeAsync(999);
		expect(read).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(ids({ read })).toEqual(['a', 'b']);
	});

	test('처리가 끝난 직후 같은 채널에 다시 만든 인스턴스가 보낸 읽음은 1초 뒤에 처리한다', async () => {
		vi.useFakeTimers();
		const user = newUser();
		const { channels, read } = await open(user, ['c1', 'c1']);

		channels[0].onMessage('read', { id: 'a' });
		await flush();
		channels[0].dispose();
		channels[1].onMessage('read', { id: 'b' });
		await vi.advanceTimersByTimeAsync(999);
		expect(read).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(ids({ read })).toEqual(['a', 'b']);
	});

	test('다른 사용자의 읽음은 서로 기다리지 않는다', async () => {
		vi.useFakeTimers();
		const gate = deferred<void>();
		const read = vi.fn(async (..._args: unknown[]) => {});
		read.mockImplementationOnce(() => gate.promise);
		const [one, two] = [newUser(), newUser()];
		const a = (await open(one, [undefined], read)).channels[0];
		const b = (await open(two, [undefined], read)).channels[0];

		a.onMessage('read', { id: 'a' });
		b.onMessage('read', { id: 'b' });
		await flush();

		expect(ids({ read })).toEqual(['a', 'b']);
		gate.resolve();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('읽음이 실패해도 다음 읽음을 처리한다', async () => {
		vi.useFakeTimers();
		const f = fixture(newUser());
		f.read.mockRejectedValueOnce(new Error('failed'));
		await f.channel.init({ roomId: 'r1' });

		f.channel.onMessage('read', { id: 'a' });
		f.channel.onMessage('read', { id: 'b' });
		await vi.advanceTimersByTimeAsync(1000);

		expect(ids(f)).toEqual(['a', 'b']);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('다른 채널의 읽음이 실패해도 이어서 처리한다', async () => {
		vi.useFakeTimers();
		const read = vi.fn(async (..._args: unknown[]) => {});
		read.mockRejectedValueOnce(new Error('failed'));
		const { channels } = await open(newUser(), ['c1', 'c2'], read);

		channels[0].onMessage('read', { id: 'a' });
		channels[1].onMessage('read', { id: 'b' });
		await vi.advanceTimersByTimeAsync(100);

		expect(ids({ read })).toEqual(['a', 'b']);
	});

	test('닫은 뒤에도 이미 받은 마지막 읽음을 한 번 처리하고 상태와 타이머를 남기지 않는다', async () => {
		vi.useFakeTimers();
		const f = fixture(newUser());
		await f.channel.init({ roomId: 'r1' });

		f.channel.onMessage('read', { id: 'a' });
		await flush();
		f.channel.onMessage('read', { id: 'b' });
		f.channel.onMessage('read', { id: 'c' });
		f.channel.dispose();

		await vi.advanceTimersByTimeAsync(999);
		expect(ids(f)).toEqual(['a']);
		await vi.advanceTimersByTimeAsync(1);
		expect(ids(f)).toEqual(['a', 'c']);

		f.channel.onMessage('read', { id: 'd' });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(ids(f)).toEqual(['a', 'c']);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('처리 중에 닫아도 기다리던 읽음은 끝난 뒤 처리하고 타이머를 남기지 않는다', async () => {
		vi.useFakeTimers();
		const f = fixture(newUser());
		const first = deferred<void>();
		f.read.mockImplementationOnce(() => first.promise);
		await f.channel.init({ roomId: 'r1' });

		f.channel.onMessage('read', { id: 'a' });
		f.channel.onMessage('read', { id: 'b' });
		f.channel.dispose();
		first.resolve();
		await vi.advanceTimersByTimeAsync(1000);

		expect(ids(f)).toEqual(['a', 'b']);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('한 사용자가 쌓을 수 있는 대기 읽음은 256개까지다', async () => {
		vi.useFakeTimers();
		const gate = deferred<void>();
		const read = vi.fn(async (..._args: unknown[]) => {});
		read.mockImplementationOnce(() => gate.promise);
		const channelIds = Array.from({ length: 300 }, (_, i) => `c${i}`);
		const { channels } = await open(newUser(), channelIds, read);

		channels.forEach((channel, i) => channel.onMessage('read', { id: `m${i}` }));
		gate.resolve();
		await vi.runAllTimersAsync();

		// 처리 중이던 1개와 대기 256개
		expect(read).toHaveBeenCalledTimes(257);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('채널의 init이 끝나기 전에 온 읽음은 처리하지 않는다', async () => {
		vi.useFakeTimers();
		const f = fixture(newUser());
		const check = deferred<boolean>();
		f.permission.mockReturnValue(check.promise);
		const pending = f.channel.init({ roomId: 'r1' });

		f.channel.onMessage('read', { id: 'early' });
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.read).not.toHaveBeenCalled();

		check.resolve(true);
		expect(await pending).toBe(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.read).not.toHaveBeenCalled();

		f.channel.onMessage('read', { id: 'after' });
		await flush();
		expect(ids(f)).toEqual(['after']);
	});

	test('init이 실패한 채널의 읽음은 처리하지 않는다', async () => {
		vi.useFakeTimers();
		const f = fixture(newUser());
		f.isMember.mockResolvedValue(false);
		expect(await f.channel.init({ roomId: 'r1' })).toBe(false);

		f.channel.onMessage('read', { id: 'a' });
		await vi.advanceTimersByTimeAsync(5000);

		expect(f.read).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	test('서로 다른 채널의 읽음이 연달아 와도 처리 사이에 100ms 간격을 둔다', async () => {
		vi.useFakeTimers();
		const times: number[] = [];
		const read = vi.fn(async (..._args: unknown[]) => { times.push(Date.now()); });
		const { channels } = await open(newUser(), ['c1', 'c2', 'c3'], read);

		channels.forEach((channel, i) => channel.onMessage('read', { id: `m${i}` }));
		await flush();
		expect(read).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(99);
		expect(read).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(read).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(99);
		expect(read).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(read).toHaveBeenCalledTimes(3);

		expect(times[1] - times[0]).toBeGreaterThanOrEqual(100);
		expect(times[2] - times[1]).toBeGreaterThanOrEqual(100);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(vi.getTimerCount()).toBe(0);
	});
});
