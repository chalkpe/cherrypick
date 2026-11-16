/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiUser } from '@/models/User.js';
import { fakeUnreadRedis, liveNotificationServiceOver } from '../misc/chat-room-notification-fixture.js';

// 읽음이 표식을 하나도 지우지 않았으면 쪽지 미읽음 상태는 그대로다. 상태를 다시 계산해 알리는 비용도 내지 않는다.
// 표식을 지웠거나 직접 요청한 모두 읽음이면 알림 서비스가 현재 상태를 버전과 함께 알린다.
function fixture({ withRoom = false }: { withRoom?: boolean } = {}) {
	const redis = fakeUnreadRedis();
	const main = vi.fn();
	const reader = { id: 'reader', host: null };
	const room = { id: 'room1', ownerId: 'owner', hasChannels: false, isMutedByOwner: false } as unknown as MiChatRoom;
	const chatService = Object.assign(Object.create(ChatService.prototype), {
		redisClient: redis,
		globalEventService: { publishMainStream: main },
		usersRepository: { findOneBy: async ({ id }: { id: string }) => id === reader.id ? reader : null },
		chatRoomsRepository: {
			findOneBy: async ({ id }: { id: string }) => withRoom && id === room.id ? room : null,
			findBy: async () => [],
		},
		chatRoomMembershipsRepository: {
			findBy: async (where: { roomId?: string; userId?: string }) => withRoom && (where.roomId === room.id || where.userId === reader.id) ? [{ userId: reader.id, roomId: room.id, isMuted: false }] : [],
		},
	}) as ChatService;
	const notifications = liveNotificationServiceOver(chatService, redis, main);
	Object.assign(chatService, { chatRoomNotificationService: notifications });
	return {
		redis,
		main,
		chatService,
		incr: vi.spyOn(redis, 'incr'),
		markUser: async (r: string, sender: string) => {
			await redis.set(`newUserChatMessageExists:${r}:${sender}`, 'message1');
			await redis.sadd(`newChatMessagesExists:${r}`, `user:${sender}`);
		},
		markRoom: async (r: string, roomId: string) => {
			await redis.set(`newRoomChatMessageExists:${r}:${roomId}`, 'message1');
			await redis.sadd(`newChatMessagesExists:${r}`, `room:${roomId}`);
		},
	};
}

describe('a read that removes no mark', () => {
	test('stays silent for a 1on1 conversation', async () => {
		const f = fixture();

		await f.chatService.readUserChatMessage('reader', 'sender');

		expect(f.main).not.toHaveBeenCalled();
		expect(f.incr).not.toHaveBeenCalled();
	});

	test('stays silent when the same conversation is read again', async () => {
		const f = fixture();
		await f.markUser('reader', 'sender');
		await f.chatService.readUserChatMessage('reader', 'sender');
		expect(f.main).toHaveBeenCalledTimes(1);
		f.main.mockClear();
		f.incr.mockClear();

		await f.chatService.readUserChatMessage('reader', 'sender');

		expect(f.main).not.toHaveBeenCalled();
		expect(f.incr).not.toHaveBeenCalled();
	});
});

describe('a read that removes a mark', () => {
	test('announces once when the last 1on1 mark is cleared', async () => {
		const f = fixture();
		await f.markUser('reader', 'sender');

		await f.chatService.readUserChatMessage('reader', 'sender');

		expect(f.main).toHaveBeenCalledTimes(1);
		expect(f.main).toHaveBeenCalledWith('reader', 'chatUnread', { hasUnreadChatMessages: false, hasUnreadChatNotifications: false, version: 1 });
		expect((await f.chatService.chatUnreadTotals('reader')).hasUnreadChatMessages).toBe(false);
	});

	test('announces the remaining unread while another conversation is still unread', async () => {
		const f = fixture();
		await f.markUser('reader', 'sender');
		await f.markUser('reader', 'other');

		await f.chatService.readUserChatMessage('reader', 'sender');

		expect(f.main).toHaveBeenCalledTimes(1);
		expect(f.main).toHaveBeenCalledWith('reader', 'chatUnread', { hasUnreadChatMessages: true, hasUnreadChatNotifications: true, version: 1 });
		expect((await f.chatService.chatUnreadTotals('reader')).hasUnreadChatMessages).toBe(true);
	});

	test('a room read tells the current state even when there was no mark', async () => {
		const f = fixture({ withRoom: true });

		await f.chatService.readRoomChatMessage('reader', 'room1');

		expect(f.main).toHaveBeenCalledWith('reader', 'chatUnread', { hasUnreadChatMessages: false, hasUnreadChatNotifications: false, version: 1 });
	});

	test('announces once when the last room mark is cleared', async () => {
		const f = fixture({ withRoom: true });
		await f.markRoom('reader', 'room1');

		await f.chatService.readRoomChatMessage('reader', 'room1');

		expect(f.main).toHaveBeenCalledWith('reader', 'chatUnread', { hasUnreadChatMessages: false, hasUnreadChatNotifications: false, version: 1 });
		expect((await f.chatService.chatUnreadTotals('reader')).hasUnreadChatMessages).toBe(false);
	});
});

describe('read-all', () => {
	test('tells the current state even when there was nothing to clear', async () => {
		const f = fixture();

		await f.chatService.readAllChatMessages('reader');

		expect(f.main).toHaveBeenCalledTimes(1);
		expect(f.main).toHaveBeenCalledWith('reader', 'chatUnread', { hasUnreadChatMessages: false, hasUnreadChatNotifications: false, version: 1 });
	});

	test('clears every conversation and tells the state', async () => {
		const f = fixture();
		await f.markUser('reader', 'sender');
		await f.markUser('reader', 'other');

		await f.chatService.readAllChatMessages('reader');

		expect((await f.chatService.chatUnreadTotals('reader')).hasUnreadChatMessages).toBe(false);
		expect(await f.redis.get('newUserChatMessageExists:reader:sender')).toBeNull();
		expect(await f.redis.get('newUserChatMessageExists:reader:other')).toBeNull();
		expect(f.main).toHaveBeenLastCalledWith('reader', 'chatUnread', { hasUnreadChatMessages: false, hasUnreadChatNotifications: false, version: 1 });
	});
});