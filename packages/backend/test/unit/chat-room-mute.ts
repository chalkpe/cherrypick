/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatRoomAccessError, ChatService } from '@/core/ChatService.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
import { MiUser } from '@/models/User.js';
import type { EntityManager } from 'typeorm';
import { fakeUnreadRedis, liveNotificationServiceOver } from '../misc/chat-room-notification-fixture.js';

type Membership = Pick<MiChatRoomMembership, 'id' | 'roomId' | 'userId' | 'isMuted'>;

// 방 음소거는 참여자 각자의 알림 설정이다. 끄면 그 방의 새 글이 미읽음 표식·지연 알림·푸시를 만들지 않는다.
// 방장은 멤버십이 없어 방에 둔 음소거 컬럼으로 잇는다. 알림 끄기는 그 전에 생긴 표식도 감추고, 다시 켜면 보인다.
function fixture() {
	const owner = { id: 'owner', username: 'owner', host: null, isSuspended: false };
	const member = { id: 'member', username: 'member', host: null, isSuspended: false };
	const other = { id: 'other', username: 'other', host: null, isSuspended: false };
	const outsider = { id: 'outsider', username: 'outsider', host: null, isSuspended: false };
	const users = [owner, member, other, outsider];
	const room = { id: 'room1', name: 'room', description: '', ownerId: owner.id, isArchived: false, isMutedByOwner: false, hasChannels: false, messageSequence: '0', uri: null } as unknown as MiChatRoom;
	const memberships: Membership[] = [
		{ id: 'membership1', roomId: room.id, userId: member.id, isMuted: false },
		{ id: 'membership2', roomId: room.id, userId: other.id, isMuted: false },
	];
	const messages = new Map<string, Partial<MiChatMessage>>();
	const main = vi.fn();
	const push = vi.fn();
	const redis = fakeUnreadRedis();
	let nextId = 0;
	let sequence = 0;

	const chatRoomsRepository = {
		findOneBy: async ({ id }: { id: string }) => id === room.id ? room : null,
		findBy: async ({ ownerId }: { ownerId: string }) => ownerId === room.ownerId ? [room] : [],
		update: async (where: { id: string; ownerId?: string }, values: Partial<MiChatRoom>) => {
			if (where.id !== room.id || (where.ownerId != null && where.ownerId !== room.ownerId)) return { affected: 0 };
			Object.assign(room, values);
			return { affected: 1 };
		},
	};
	const chatRoomMembershipsRepository = {
		findBy: async (where: { roomId?: string; userId?: string }) => memberships.filter(m => (where.roomId == null || m.roomId === where.roomId) && (where.userId == null || m.userId === where.userId)).map(m => ({ ...m })),
		findOneBy: async ({ roomId, userId }: { roomId: string; userId: string }) => {
			const found = memberships.find(m => m.roomId === roomId && m.userId === userId);
			return found != null ? { ...found } : null;
		},
		update: async (id: string, values: Partial<Membership>) => {
			const found = memberships.find(m => m.id === id);
			if (found != null) Object.assign(found, values);
			return { affected: found != null ? 1 : 0 };
		},
	};
	const usersRepository = {
		findOneBy: async ({ id }: { id: string }) => users.find(u => u.id === id) ?? null,
		findOneByOrFail: async ({ id }: { id: string }) => users.find(u => u.id === id)!,
		existsBy: async ({ id, isSuspended }: { id: string; isSuspended?: boolean }) => users.some(u => u.id === id && (isSuspended == null || u.isSuspended === isSuspended)),
		findBy: async ({ id }: { id: { value: string[] } }) => users.filter(u => id.value.includes(u.id)),
	};
	const manager = {
		findOne: async (entity: unknown, options: { where: { id: string } }) => entity === MiChatRoom ? (options.where.id === room.id ? room : null) : messages.get(options.where.id) ?? null,
		findOneBy: async (entity: unknown, where: { id: string }) => {
			if (entity === MiChatRoom) return where.id === room.id ? room : null;
			if (entity === MiChatMessage) return messages.get(where.id) ?? null;
			return null;
		},
		existsBy: async (entity: unknown, where: { roomId: string; userId: string }) => entity === MiChatRoomMembership ? memberships.some(m => m.roomId === where.roomId && m.userId === where.userId) : false,
		findBy: async (entity: unknown, where: { roomId?: string; id?: { value: string[] } }) => {
			if (entity === MiChatRoomMembership) return chatRoomMembershipsRepository.findBy({ roomId: where.roomId });
			if (entity === MiUser) return usersRepository.findBy({ id: where.id! });
			return [];
		},
		update: async (_entity: unknown, idOrWhere: unknown, patch: object) => {
			if (typeof idOrWhere !== 'string') return { affected: 1 };
			const message = messages.get(idOrWhere);
			if (message != null) Object.assign(message, patch);
			return { affected: 1 };
		},
		withRepository: (repository: unknown) => repository,
		createQueryBuilder: () => {
			const builder = { update: () => builder, set: () => builder, where: () => builder, returning: () => builder, execute: async () => {
				const value = String(++sequence);
				room.messageSequence = value;
				return { raw: [{ messageSequence: value }] };
			} };
			return builder;
		},
	};

	const chatService = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		redisClient: redis,
		usersRepository,
		userEntityService: { isLocalUser: () => true, isRemoteUser: () => false, genLocalUserUri: (id: string) => `https://local.test/users/${id}` },
		chatRoomChannelService: Object.assign(Object.create(ChatRoomChannelService.prototype), { db: { manager: {} } }),
		db: { manager, transaction: async <T>(run: (m: unknown) => Promise<T>) => run(manager) },
		idService: { gen: () => `message${++nextId}` },
		chatMessagesRepository: {
			insertOne: async (message: Partial<MiChatMessage>) => { messages.set(message.id!, message); return message; },
			findOneBy: async ({ id }: { id: string }) => messages.get(id) ?? null,
		},
		chatRoomsRepository,
		chatRoomMembershipsRepository,
		roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
		userBlockingService: { checkBlocked: async () => false },
		chatEntityService: { packMessageLiteForRoom: async (value: unknown) => value, packMessageDetailed: async (value: unknown) => value },
		customEmojiService: { populateEmojis: async () => ({}) },
		apRendererService: { renderChatMessage: async () => ({}), addContext: (activity: unknown) => activity },
		queueService: { deliver: vi.fn() },
		globalEventService: { publishChatRoomStream: vi.fn(), publishMainStream: main },
		pushNotificationService: { pushNotification: push },
	}) as ChatService;
	const notifications = liveNotificationServiceOver(chatService, redis, main);
	Object.assign(chatService, { chatRoomNotificationService: notifications });

	const chatEntityService = Object.assign(Object.create(ChatEntityService.prototype), {
		chatRoomNotificationService: notifications,
		chatRoomMembershipsRepository,
		chatRoomsRepository,
		chatRoomInvitationsRepository: { findOneBy: async () => null },
		chatRoomIconEntityService: { pack: async () => ({}) },
		idService: { parse: () => ({ date: new Date('2026-11-12T00:00:00.000Z') }) },
		userEntityService: { pack: async (user: { id: string } | string) => ({ id: typeof user === 'string' ? user : user.id }) },
	}) as ChatEntityService;

	return {
		owner: owner as unknown as MiUser,
		member: member as unknown as MiUser,
		other: other as unknown as MiUser,
		outsider: outsider as unknown as MiUser,
		room,
		memberships,
		chatService,
		main,
		push,
		say: (from: MiUser, text: string) => chatService.createMessageToRoom(from, room, { text }),
		shownTo: (user: MiUser) => chatEntityService.packRoom(room, user),
		unread: async (user: MiUser) => (await chatService.chatUnreadTotals(user.id)).hasUnreadChatMessages,
		toldTo: (user: MiUser) => main.mock.calls.filter(([userId]) => userId === user.id).map(([, type]) => type as string),
		pushedTo: (user: MiUser) => push.mock.calls.filter(([userId]) => userId === user.id).map(([, type]) => type as string),
	};
}

describe('muting a chat room', () => {
	afterEach(() => vi.useRealTimers());

	describe('a member', () => {
		test('gets no unread mark, notice or push for messages sent after muting', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.muteRoom(f.member.id, f.room.id, true);
			f.main.mockClear();

			await f.say(f.owner, 'hello');
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.unread(f.member)).toBe(false);
			// 알림을 끈 멤버에게도 미읽음 상태(없음)는 동기화되지만, 새 쪽지 알림과 푸시는 가지 않는다
			expect(f.toldTo(f.member)).toEqual(['chatUnread']);
			expect(f.main).toHaveBeenCalledWith(f.member.id, 'chatUnread', expect.objectContaining({ hasUnreadChatMessages: false }));
			expect(f.pushedTo(f.member)).toEqual([]);
		});

		test('mutes for themselves alone', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.muteRoom(f.member.id, f.room.id, true);
			f.main.mockClear();
			f.push.mockClear();

			await f.say(f.other, 'hello');
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.unread(f.owner)).toBe(true);
			expect(f.toldTo(f.owner)).toEqual(['chatUnread', 'newChatMessage']);
			expect(f.pushedTo(f.owner)).toEqual(['newChatMessage']);
			expect((await f.shownTo(f.owner)).isMuted).toBe(false);
			expect((await f.shownTo(f.other)).isMuted).toBe(false);
			expect((await f.shownTo(f.member)).isMuted).toBe(true);
		});
	});

	describe('the owner', () => {
		test('gets no unread mark, notice or push for messages sent after muting', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.muteRoom(f.owner.id, f.room.id, true);
			f.main.mockClear();

			await f.say(f.member, 'hello');
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.unread(f.owner)).toBe(false);
			expect(await f.chatService.getRoomReadStateMap(f.owner.id, [f.room.id])).toEqual({ room1: true });
			expect(f.toldTo(f.owner)).toEqual(['chatUnread']);
			expect(f.main).toHaveBeenCalledWith(f.owner.id, 'chatUnread', expect.objectContaining({ hasUnreadChatMessages: false }));
			expect(f.pushedTo(f.owner)).toEqual([]);
		});

		test('mutes for themselves alone', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.muteRoom(f.owner.id, f.room.id, true);
			f.main.mockClear();
			f.push.mockClear();

			await f.say(f.member, 'hello');
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.unread(f.other)).toBe(true);
			expect(f.toldTo(f.other)).toEqual(['chatUnread', 'newChatMessage']);
			expect(f.pushedTo(f.other)).toEqual(['newChatMessage']);
			expect((await f.shownTo(f.member)).isMuted).toBe(false);
			expect((await f.shownTo(f.other)).isMuted).toBe(false);
			expect((await f.shownTo(f.owner)).isMuted).toBe(true);
		});

		test('stays the owner without becoming a member', async () => {
			const f = fixture();

			await f.chatService.muteRoom(f.owner.id, f.room.id, true);

			expect(f.memberships.map(m => [m.userId, m.isMuted])).toEqual([['member', false], ['other', false]]);
			expect(f.room.ownerId).toBe(f.owner.id);
		});

		test('gets the mark, the notice and the push again for messages sent after unmuting', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.muteRoom(f.owner.id, f.room.id, true);
			await f.say(f.member, 'during the mute');
			await vi.advanceTimersByTimeAsync(3000);

			await f.chatService.muteRoom(f.owner.id, f.room.id, false);
			f.main.mockClear();
			f.push.mockClear();
			await f.say(f.member, 'after the mute');
			await vi.advanceTimersByTimeAsync(3000);

			expect((await f.shownTo(f.owner)).isMuted).toBe(false);
			expect(await f.unread(f.owner)).toBe(true);
			expect(f.toldTo(f.owner)).toEqual(['chatUnread', 'newChatMessage']);
			expect(f.push).toHaveBeenCalledWith(f.owner.id, 'newChatMessage', expect.objectContaining({ text: 'after the mute' }));
			expect(f.push).not.toHaveBeenCalledWith(f.owner.id, 'newChatMessage', expect.objectContaining({ text: 'during the mute' }));
		});

		test('hides a mark from before the mute while muted and shows it again when unmuted', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.say(f.member, 'hello');
			await vi.advanceTimersByTimeAsync(3000);
			expect(await f.unread(f.owner)).toBe(true);

			await f.chatService.muteRoom(f.owner.id, f.room.id, true);
			f.main.mockClear();
			f.push.mockClear();
			await vi.advanceTimersByTimeAsync(3000);

			// 알림을 끄면 그 전에 생긴 표식도 보이지 않고, 지연 알림도 가지 않는다
			expect(await f.unread(f.owner)).toBe(false);
			expect(await f.chatService.getRoomReadStateMap(f.owner.id, [f.room.id])).toEqual({ room1: true });
			expect(f.pushedTo(f.owner)).toEqual([]);

			await f.chatService.muteRoom(f.owner.id, f.room.id, false);

			// 다시 켜면 끄기 전의 표식이 그대로 보인다
			expect(await f.unread(f.owner)).toBe(true);
			expect(await f.chatService.getRoomReadStateMap(f.owner.id, [f.room.id])).toEqual({ room1: false });

			f.main.mockClear();
			await f.chatService.readRoomChatMessage(f.owner.id, f.room.id);

			expect(f.toldTo(f.owner)).toEqual(['chatUnread']);
			expect(await f.unread(f.owner)).toBe(false);
		});
	});

	test('is refused to someone who is neither a member nor the owner', async () => {
		const f = fixture();

		await expect(f.chatService.muteRoom(f.outsider.id, f.room.id, true)).rejects.toBeInstanceOf(ChatRoomAccessError);

		expect(f.room.isMutedByOwner).toBe(false);
		expect(f.memberships.every(m => !m.isMuted)).toBe(true);
	});

	test('is refused for a room that does not exist', async () => {
		const f = fixture();

		await expect(f.chatService.muteRoom(f.owner.id, 'gone', true)).rejects.toBeInstanceOf(ChatRoomAccessError);
	});

	test('is not shown to someone looking at the room from outside', async () => {
		const f = fixture();
		await f.chatService.muteRoom(f.owner.id, f.room.id, true);
		await f.chatService.muteRoom(f.member.id, f.room.id, true);

		expect((await f.shownTo(f.outsider)).isMuted).toBe(false);
	});
});

describe('the delayed notice', () => {
	afterEach(() => vi.useRealTimers());

	test('does not notify a muted owner but still notifies the other members', async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.chatService.muteRoom(f.owner.id, f.room.id, true);
		f.main.mockClear();
		f.push.mockClear();

		await f.say(f.member, 'hello');
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.pushedTo(f.owner)).toEqual([]);
		expect(f.toldTo(f.other)).toEqual(['chatUnread', 'newChatMessage']);
		expect(f.pushedTo(f.other)).toEqual(['newChatMessage']);
	});

	test('notifies the owner again once unmuted', async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.chatService.muteRoom(f.owner.id, f.room.id, true);
		await f.chatService.muteRoom(f.owner.id, f.room.id, false);
		f.main.mockClear();
		f.push.mockClear();

		await f.say(f.member, 'hello');
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.toldTo(f.owner)).toEqual(['chatUnread', 'newChatMessage']);
		expect(f.pushedTo(f.owner)).toEqual(['newChatMessage']);
		expect(f.toldTo(f.other)).toEqual(['chatUnread', 'newChatMessage']);
	});
});