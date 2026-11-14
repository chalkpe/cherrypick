/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
import { MiUser } from '@/models/User.js';
import type { ChatRoomNotificationService } from '@/core/ChatRoomNotificationService.js';
import { notificationServiceOver } from '../misc/chat-room-notification-fixture.js';
import type { EntityManager } from 'typeorm';

const author = { id: 'author', username: 'author', host: null, uri: null, inbox: null, sharedInbox: null, isSuspended: false };
const reader = { id: 'reader', username: 'reader', host: null, uri: null, inbox: null, sharedInbox: null, isSuspended: false };
const room = { id: 'room1', ownerId: author.id, hasChannels: false, isArchived: false, uri: null } as unknown as MiChatRoom;

function serviceFixture() {
	const chat = {
		chatRoomsRepository: { findOneBy: async ({ id }: { id: string }) => id === room.id ? room : null },
		chatRoomMembershipsRepository: { findBy: async () => [{ userId: reader.id, isMuted: false }] },
		usersRepository: { findOneBy: async ({ id }: { id: string }) => [author, reader].find(user => user.id === id) ?? null },
	};
	const service = notificationServiceOver(chat as unknown as ChatService);
	return service;
}

let messageSeq = 0;

function message(text: string): MiChatMessage {
	return {
		id: `m${++messageSeq}`,
		text,
		fromUserId: author.id,
		toRoomId: room.id,
		toRoomChannelId: null,
		roomMessageSequence: null,
		mentionedUserIds: [],
		deletedAt: null,
	} as unknown as MiChatMessage;
}

async function recordAndMark(service: ChatRoomNotificationService, text: string) {
	const created = message(text);
	const recorded = await service.record({} as EntityManager, room, created);
	await service.mark(room, created, recorded);
	return created;
}

describe('미읽음 표식의 순번 보장', () => {
	test('늦게 도착한 이전 글의 생성 표식이 더 새 글의 표식을 덮어쓰지 않는다', async () => {
		const service = serviceFixture();
		const first = message('첫 글');
		const firstRecorded = await service.record({} as EntityManager, room, first);
		const second = message('둘째 글');
		const secondRecorded = await service.record({} as EntityManager, room, second);

		await service.mark(room, second, secondRecorded);
		await service.mark(room, first, firstRecorded);

		expect((await service.state(reader.id, room)).hasUnread).toBe(true);
		expect(await service.notificationRecipients(second, room)).toEqual([reader.id]);
	});

	test('멘션 표식도 더 새 글의 멘션을 유지한다', async () => {
		const service = serviceFixture();
		const first = message('@reader 첫 멘션');
		const firstRecorded = await service.record({} as EntityManager, room, first);
		const second = message('@reader 둘째 멘션');
		const secondRecorded = await service.record({} as EntityManager, room, second);

		await service.mark(room, second, secondRecorded);
		await service.mark(room, first, firstRecorded);
		await service.setLevel(reader.id, room.id, 'mentions');

		expect(await service.notificationRecipients(second, room)).toEqual([reader.id]);
	});

	test('수정은 더 새 글의 표식을 덮어쓰지 않는다', async () => {
		const service = serviceFixture();
		const first = await recordAndMark(service, '첫 글');
		const second = await recordAndMark(service, '둘째 글');

		const edited = await service.record({} as EntityManager, room, first, []);
		await service.mark(room, first, edited, true);

		expect(await service.notificationRecipients(second, room)).toEqual([reader.id]);
	});

	test('수정은 오래된 표식을 그 글의 순번으로 전진시킨다', async () => {
		const service = serviceFixture();
		const first = message('첫 글');
		const firstRecorded = await service.record({} as EntityManager, room, first);
		const second = message('@reader 둘째 글');
		await service.record({} as EntityManager, room, second);

		await service.mark(room, first, firstRecorded);
		const edited = await service.record({} as EntityManager, room, second, []);
		await service.mark(room, second, edited, true);

		expect(await service.notificationRecipients(second, room)).toEqual([reader.id]);
	});
});

describe('멘션 전용 지연 알림의 수신자 판단', () => {
	test('일반 글이 표식을 옮겨도 멘션 글의 알림은 멘션 표식으로 판단한다', async () => {
		const service = serviceFixture();
		const mention = await recordAndMark(service, '@reader 멘션 글');
		await recordAndMark(service, '뒤따른 일반 글');
		await service.setLevel(reader.id, room.id, 'mentions');

		expect(await service.notificationRecipients(mention, room)).toEqual([reader.id]);
	});
});

describe('일반 그룹의 경계 읽음', () => {
	test('읽음 경계 뒤의 새 글은 미읽음으로 남고 전체 읽음은 지운다', async () => {
		const service = serviceFixture();
		const first = await recordAndMark(service, '이미 본 글');
		const second = await recordAndMark(service, '아직 보지 않은 글');

		await service.read(reader.id, room.id, undefined, first.id);
		expect((await service.state(reader.id, room)).hasUnread).toBe(true);
		expect(await service.notificationRecipients(second, room)).toEqual([reader.id]);

		await service.read(reader.id, room.id, undefined, second.id);
		expect((await service.state(reader.id, room)).hasUnread).toBe(false);

		await recordAndMark(service, '다시 온 새 글');
		await service.read(reader.id, room.id, undefined, undefined, true);
		expect((await service.state(reader.id, room)).hasUnread).toBe(false);
	});
});

describe('수정 지연 알림의 예약 대상', () => {
	afterEach(() => vi.useRealTimers());

	function editFixture() {
		const users = [author, reader];
		const messages = new Map<string, Partial<MiChatMessage>>();
		let sequence = 0;
		let idSeq = 0;
		const notifications = vi.fn();
		const stream = vi.fn();
		const usersRepository = {
			existsBy: async ({ id, isSuspended }: { id: string; isSuspended: boolean }) => users.some(user => user.id === id && user.isSuspended === isSuspended),
			findOneBy: async ({ id }: { id: string }) => users.find(user => user.id === id) ?? null,
			findOneByOrFail: async ({ id }: { id: string }) => users.find(user => user.id === id)!,
			findBy: async ({ id }: { id: { value: string[] } }) => users.filter(user => id.value.includes(user.id)),
		};
		const manager = {
			findOne: async (entity: unknown, options: { where: { id: string } }) => entity === MiChatRoom ? room : messages.get(options.where.id) ?? null,
			findOneBy: async (entity: unknown, where: { id: string }) => {
				if (entity === MiChatRoom) return room;
				if (entity === MiChatMessage) return messages.get(where.id) ?? null;
				return null;
			},
			existsBy: async (entity: unknown, where: { userId: string }) => entity === MiChatRoomMembership ? where.userId === reader.id || where.userId === author.id : true,
			findBy: async (entity: unknown, where: { id?: { value: string[] } }) => {
				if (entity === MiChatRoomMembership) return [{ userId: reader.id, isMuted: false }];
				if (entity === MiUser) return users.filter(user => where.id!.value.includes(user.id));
				return [];
			},
			update: async (_entity: unknown, idOrWhere: unknown, patch: object) => {
				if (typeof idOrWhere !== 'string') return { affected: 1 };
				Object.assign(messages.get(idOrWhere)!, patch);
				return { affected: 1 };
			},
			withRepository: (repository: unknown) => repository,
			createQueryBuilder: () => {
				const builder = { update: () => builder, set: () => builder, where: () => builder, returning: () => builder, execute: async () => ({ raw: [{ messageSequence: String(++sequence) }] }) };
				return builder;
			},
		};
		const chatService = Object.assign(Object.create(ChatService.prototype), {
			config: { url: 'https://local.test' },
			usersRepository,
			userEntityService: { isLocalUser: () => true, isRemoteUser: () => false, genLocalUserUri: (id: string) => `https://local.test/users/${id}` },
			chatRoomChannelService: Object.assign(Object.create(ChatRoomChannelService.prototype), { db: { manager: {} } }),
			db: { manager, transaction: async <T>(run: (manager: unknown) => Promise<T>) => run(manager) },
			idService: { gen: () => `message${++idSeq}` },
			chatRoomMembershipsRepository: {
				findBy: async () => [{ userId: reader.id, isMuted: false }],
				findOneBy: async ({ userId }: { userId: string }) => userId === reader.id ? { userId, isMuted: false } : null,
			},
			chatRoomsRepository: { findOneBy: async () => room, findOneByOrFail: async () => room },
			chatMessagesRepository: {
				insertOne: async (value: Partial<MiChatMessage>) => { messages.set(value.id!, value); return value; },
				findOneBy: async ({ id }: { id: string }) => messages.get(id) ?? null,
			},
			roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
			userBlockingService: { checkBlocked: async () => false },
			chatEntityService: { packMessageLiteForRoom: async (value: unknown) => value, packMessageDetailed: async (value: unknown) => value },
			globalEventService: { publishChatRoomStream: vi.fn(), publishMainStream: stream },
			pushNotificationService: { pushNotification: notifications },
			customEmojiService: { populateEmojis: async () => ({}) },
			apRendererService: { renderChatUpdate: async () => ({}), addContext: (activity: unknown) => activity },
			queueService: { deliver: vi.fn() },
			redisClient: {
				sadd: vi.fn(async () => 1),
				expire: vi.fn(async () => 1),
				pipeline: () => ({ del: () => {}, srem: () => {}, exec: async () => [] }),
			},
		}) as ChatService;
		const roomNotifications = notificationServiceOver(chatService);
		Object.assign(chatService, { chatRoomNotificationService: roomNotifications });
		return { chatService, notifications, stream, roomNotifications };
	}

	test('수정으로 새로 멘션된 수신자에게는 지연 알림이 간다', async () => {
		vi.useFakeTimers();
		const f = editFixture();
		await f.roomNotifications.setLevel(reader.id, room.id, 'mentions');

		const created = await f.chatService.createMessageToRoom(author, room, { text: '멘션 없는 글' });
		await vi.advanceTimersByTimeAsync(3000);
		expect(f.notifications).not.toHaveBeenCalled();

		await f.chatService.updateMessage(author.id, created.id, '@reader 새 멘션');
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.notifications).toHaveBeenCalledTimes(1);
		expect(f.notifications).toHaveBeenCalledWith(reader.id, 'newChatMessage', expect.objectContaining({ id: created.id }));
	});

	test('끄기 동안의 수정은 표식이 없어 다시 켜도 알리지 않는다', async () => {
		vi.useFakeTimers();
		const f = editFixture();
		await f.roomNotifications.setLevel(reader.id, room.id, 'none');

		const created = await f.chatService.createMessageToRoom(author, room, { text: '끄기 중 온 글' });
		await vi.advanceTimersByTimeAsync(3000);
		expect(f.notifications).not.toHaveBeenCalled();

		await f.chatService.updateMessage(author.id, created.id, '@reader 새 멘션');
		await f.roomNotifications.setLevel(reader.id, room.id, 'mentions');
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.notifications).not.toHaveBeenCalled();
		expect(f.stream).not.toHaveBeenCalled();
	});

	test('수정 알림은 지연 사이에 읽으면 발송하지 않는다', async () => {
		vi.useFakeTimers();
		const f = editFixture();
		await f.roomNotifications.setLevel(reader.id, room.id, 'mentions');

		const created = await f.chatService.createMessageToRoom(author, room, { text: '멘션 없는 글' });
		await vi.advanceTimersByTimeAsync(3000);
		expect(f.notifications).not.toHaveBeenCalled();

		await f.chatService.updateMessage(author.id, created.id, '@reader 새 멘션');
		await f.chatService.readRoomChatMessage(reader.id, room.id);
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.notifications).not.toHaveBeenCalled();
		expect(f.stream).not.toHaveBeenCalled();
	});
});
