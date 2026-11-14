/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { notificationServiceOver } from '../misc/chat-room-notification-fixture.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import type { MiChatMessage } from '@/models/_.js';

const alice = { id: 'alice', host: null, uri: null, inbox: null, sharedInbox: null, isSuspended: false };

describe('delayed room notification packs once', () => {
	afterEach(() => vi.useRealTimers());

	function fixture(changing = true) {
		const author = { ...alice, id: 'author' };
		const reader = { ...alice, id: 'reader', chatScope: 'everyone' };
		const room = { id: 'room1', ownerId: author.id, isArchived: false };
		const users = [author, reader];
		const notifications = vi.fn();
		const stream = vi.fn();
		let message: Partial<MiChatMessage> | null = null;
		let reads = 0;
		// 수정이 계속되는 상황: 읽을 때마다 내용이 바뀐다
		const readMessage = () => {
			if (message == null) return null;
			reads++;
			if (!changing) return message;
			return { ...message, revision: `r${reads}` };
		};
		const usersRepository = {
			existsBy: async ({ id, isSuspended }: { id: string; isSuspended: boolean }) => users.some(user => user.id === id && user.isSuspended === isSuspended),
			findOneBy: async ({ id }: { id: string }) => users.find(user => user.id === id) ?? null,
		};
		const userEntityService = { isLocalUser: () => true, isRemoteUser: () => false, genLocalUserUri: (id: string) => `https://local.test/users/${id}` };
		const chatService = Object.assign(Object.create(ChatService.prototype), {
			config: { url: 'https://local.test' }, usersRepository, userEntityService,
			chatRoomChannelService: Object.assign(Object.create(ChatRoomChannelService.prototype), { db: { manager: {} } }),
			db: {
				manager: { existsBy: async () => true },
				transaction: async <T>(run: (manager: unknown) => Promise<T>) => run({
					findOne: async () => room,
					findOneBy: async (entity: { name: string }) => entity.name === 'MiChatMessage' ? readMessage() : room,
					existsBy: async (entity: { name: string }, where: { id: string; isSuspended: boolean }) => entity.name === 'MiUser' ? usersRepository.existsBy(where) : true,
					findBy: async () => [{ userId: reader.id, isMuted: false }],
					withRepository: (repository: unknown) => repository,
				}),
			},
			idService: { gen: () => 'message1' },
			chatRoomMembershipsRepository: {
				findBy: async () => [{ userId: reader.id, isMuted: false }],
				findOneBy: async ({ userId }: { userId: string }) => userId === reader.id ? { userId, isMuted: false } : null,
			},
			chatMessagesRepository: {
				insertOne: async (value: Partial<MiChatMessage>) => (message = value),
				findOneBy: async () => readMessage(),
			},
			roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
			userBlockingService: { checkBlocked: async () => false },
			chatEntityService: { packMessageLiteForRoom: async (value: unknown) => value, packMessageDetailed: async (value: unknown) => value },
			globalEventService: { publishChatRoomStream: vi.fn(), publishMainStream: stream },
			pushNotificationService: { pushNotification: notifications },
			redisClient: {
				pipeline: () => ({ set: () => {}, sadd: () => {}, del: () => {}, srem: () => {}, exec: async () => [] }),
				sadd: vi.fn(async () => 1),
				expire: vi.fn(async () => 1),
			},
		}) as ChatService;
		Object.assign(chatService, { chatRoomsRepository: { findOneBy: async () => room }, chatRoomNotificationService: notificationServiceOver(chatService) });
		return { author, room, chatService, notifications, stream, reads: () => reads, resetReads: () => { reads = 0; } };
	}

	test('수정이 계속되어도 지연 후 한 번만 읽어 포장하고 전달한다', async () => {
		vi.useFakeTimers();
		const f = fixture();

		await f.chatService.createMessageToRoom(f.author, f.room as never, { text: 'hello' });
		f.resetReads();
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.reads()).toBeLessThanOrEqual(2);
		expect(f.notifications).toHaveBeenCalledTimes(1);
		expect(f.notifications).toHaveBeenCalledWith('reader', 'newChatMessage', expect.objectContaining({ text: 'hello' }));
		expect(f.stream).toHaveBeenCalledWith('reader', 'newChatMessage', expect.objectContaining({ text: 'hello' }));
	});

	test('수정이 없으면 지연 후 한 번만 확인하고 전달한다', async () => {
		vi.useFakeTimers();
		const f = fixture(false);

		await f.chatService.createMessageToRoom(f.author, f.room as never, { text: 'hello' });
		f.resetReads();
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.reads()).toBeLessThanOrEqual(2);
		expect(f.notifications).toHaveBeenCalledTimes(1);
		expect(f.notifications).toHaveBeenCalledWith('reader', 'newChatMessage', expect.objectContaining({ text: 'hello' }));
	});

	test('지연 알림 전에 읽은 글은 알리지 않는다', async () => {
		vi.useFakeTimers();
		const f = fixture(false);

		await f.chatService.createMessageToRoom(f.author, f.room as never, { text: 'hello' });
		await f.chatService.readRoomChatMessage('reader', 'room1');
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.notifications).not.toHaveBeenCalled();
		expect(f.stream).not.toHaveBeenCalled();
	});
});
