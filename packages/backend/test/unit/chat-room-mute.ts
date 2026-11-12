/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatRoomAccessError, ChatService } from '@/core/ChatService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import type { MiChatMessage, MiChatRoom, MiChatRoomMembership, MiUser } from '@/models/_.js';
import { memoryRedis } from '../misc/chat-unread-redis.js';

type Membership = Pick<MiChatRoomMembership, 'id' | 'roomId' | 'userId' | 'isMuted'>;

// Muting a room is each participant's own choice. It keeps new messages there from marking the room unread,
// and from the notice and the push that follow three seconds later. The owner has no membership to keep the choice on.
function fixture() {
	const owner = { id: 'owner', host: null, isSuspended: false };
	const member = { id: 'member', host: null, isSuspended: false };
	const other = { id: 'other', host: null, isSuspended: false };
	const outsider = { id: 'outsider', host: null, isSuspended: false };
	const users = [owner, member, other, outsider];
	const room = { id: 'room1', name: 'room', description: '', ownerId: owner.id, isArchived: false, isMutedByOwner: false };
	const memberships: Membership[] = [
		{ id: 'membership1', roomId: room.id, userId: member.id, isMuted: false },
		{ id: 'membership2', roomId: room.id, userId: other.id, isMuted: false },
	];
	const messages: Partial<MiChatMessage>[] = [];
	const main = vi.fn();
	const push = vi.fn();
	let nextId = 0;

	const chatRoomsRepository = {
		findOneBy: async ({ id }: { id: string }) => id === room.id ? { ...room } : null,
		update: async (where: { id: string; ownerId: string }, values: Partial<MiChatRoom>) => {
			if (where.id !== room.id || where.ownerId !== room.ownerId) return { affected: 0 };
			Object.assign(room, values);
			return { affected: 1 };
		},
	};

	const chatRoomMembershipsRepository = {
		findBy: async ({ roomId }: { roomId: string }) => memberships.filter(membership => membership.roomId === roomId).map(membership => ({ ...membership })),
		findOneBy: async ({ roomId, userId }: { roomId: string; userId: string }) => {
			const found = memberships.find(membership => membership.roomId === roomId && membership.userId === userId);
			return found != null ? { ...found } : null;
		},
		update: async (id: string, values: Partial<Membership>) => {
			Object.assign(memberships.find(membership => membership.id === id)!, values);
		},
	};

	const chatService = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		redisClient: memoryRedis(),
		usersRepository: {
			findOneBy: async ({ id }: { id: string }) => users.find(user => user.id === id) ?? null,
			findOneByOrFail: async ({ id }: { id: string }) => users.find(user => user.id === id)!,
			existsBy: async () => false,
		},
		userEntityService: { isLocalUser: () => true, isRemoteUser: () => false },
		idService: { gen: () => `message${++nextId}` },
		chatMessagesRepository: {
			insertOne: async (message: Partial<MiChatMessage>) => {
				messages.push(message);
				return message;
			},
			findOneBy: async ({ id }: { id: string }) => messages.find(message => message.id === id) ?? null,
			existsBy: async () => messages.length > 0,
		},
		chatRoomsRepository,
		chatRoomMembershipsRepository,
		mutingsRepository: { findBy: async () => [], existsBy: async () => false },
		chatEntityService: {
			packMessageLiteForRoom: async (message: unknown) => message,
			packMessageDetailed: async (message: unknown) => message,
		},
		globalEventService: { publishChatRoomStream: vi.fn(), publishMainStream: main },
		pushNotificationService: { pushNotification: push },
	}) as ChatService;

	const chatEntityService = Object.assign(Object.create(ChatEntityService.prototype), {
		chatRoomMembershipsRepository,
		chatRoomInvitationsRepository: { findOneBy: async () => null },
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
		push,
		/** Sends to the room as the endpoint does: with the room as it is stored at that moment. */
		say: (from: MiUser, text: string) => chatService.createMessageToRoom(from, { ...room } as unknown as MiChatRoom, { text }),
		/** What the room says about itself to this participant. */
		shownTo: (user: MiUser) => chatEntityService.packRoom({ ...room } as unknown as MiChatRoom, user),
		/** What this participant's open screens were told, in order. */
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

			await f.say(f.owner, 'hello');
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.chatService.hasUnreadMessages(f.member.id)).toBe(false);
			expect(f.toldTo(f.member)).toEqual([]);
			expect(f.pushedTo(f.member)).toEqual([]);
		});

		test('mutes for themselves alone', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.muteRoom(f.member.id, f.room.id, true);

			await f.say(f.other, 'hello');
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.chatService.hasUnreadMessages(f.owner.id)).toBe(true);
			expect(f.toldTo(f.owner)).toEqual(['newChatMessage']);
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

			await f.say(f.member, 'hello');
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.chatService.hasUnreadMessages(f.owner.id)).toBe(false);
			expect(await f.chatService.getRoomReadStateMap(f.owner.id, [f.room.id])).toEqual({ room1: true });
			expect(f.toldTo(f.owner)).toEqual([]);
			expect(f.pushedTo(f.owner)).toEqual([]);
		});

		test('mutes for themselves alone', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.muteRoom(f.owner.id, f.room.id, true);

			await f.say(f.member, 'hello');
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.chatService.hasUnreadMessages(f.other.id)).toBe(true);
			expect(f.toldTo(f.other)).toEqual(['newChatMessage']);
			expect(f.pushedTo(f.other)).toEqual(['newChatMessage']);
			expect((await f.shownTo(f.member)).isMuted).toBe(false);
			expect((await f.shownTo(f.other)).isMuted).toBe(false);
			expect((await f.shownTo(f.owner)).isMuted).toBe(true);
		});

		test('stays the owner without becoming a member', async () => {
			const f = fixture();

			await f.chatService.muteRoom(f.owner.id, f.room.id, true);

			expect(f.memberships.map(membership => [membership.userId, membership.isMuted])).toEqual([['member', false], ['other', false]]);
			expect(f.room.ownerId).toBe(f.owner.id);
		});

		test('gets the mark, the notice and the push again for messages sent after unmuting', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.muteRoom(f.owner.id, f.room.id, true);
			await f.say(f.member, 'during the mute');
			await vi.advanceTimersByTimeAsync(3000);

			await f.chatService.muteRoom(f.owner.id, f.room.id, false);
			await f.say(f.member, 'after the mute');
			await vi.advanceTimersByTimeAsync(3000);

			expect((await f.shownTo(f.owner)).isMuted).toBe(false);
			expect(await f.chatService.hasUnreadMessages(f.owner.id)).toBe(true);
			expect(f.toldTo(f.owner)).toEqual(['newChatMessage']);
			expect(f.push).toHaveBeenCalledWith(f.owner.id, 'newChatMessage', expect.objectContaining({ text: 'after the mute' }));
			expect(f.push).not.toHaveBeenCalledWith(f.owner.id, 'newChatMessage', expect.objectContaining({ text: 'during the mute' }));
		});

		test('gets no notice for a message that came just before muting, and its mark stays until the room is read', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.say(f.member, 'hello');

			await f.chatService.muteRoom(f.owner.id, f.room.id, true);
			await vi.advanceTimersByTimeAsync(3000);

			expect(f.toldTo(f.owner)).toEqual([]);
			expect(f.pushedTo(f.owner)).toEqual([]);
			// The chat list still shows the room as unread, so the sign has something to point at.
			expect(await f.chatService.hasUnreadMessages(f.owner.id)).toBe(true);
			expect(await f.chatService.getRoomReadStateMap(f.owner.id, [f.room.id])).toEqual({ room1: false });

			await f.chatService.readRoomChatMessage(f.owner.id, f.room.id);

			expect(f.toldTo(f.owner)).toEqual(['readAllChatMessages']);
			expect(await f.chatService.hasUnreadMessages(f.owner.id)).toBe(false);
		});
	});

	test('is refused to someone who is neither a member nor the owner', async () => {
		const f = fixture();

		await expect(f.chatService.muteRoom(f.outsider.id, f.room.id, true)).rejects.toBeInstanceOf(ChatRoomAccessError);

		expect(f.room.isMutedByOwner).toBe(false);
		expect(f.memberships.every(membership => !membership.isMuted)).toBe(true);
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
