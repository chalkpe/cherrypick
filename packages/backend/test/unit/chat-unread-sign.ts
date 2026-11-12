/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { FindOperator } from 'typeorm';
import { ChatService } from '@/core/ChatService.js';
import { DeleteAccountService } from '@/core/DeleteAccountService.js';
import { UserMutingService } from '@/core/UserMutingService.js';
import type { MiChatMessage, MiChatRoom, MiMuting, MiUser } from '@/models/_.js';
import { memoryRedis } from '../misc/chat-unread-redis.js';

/** Whether a stored row meets a repository condition made of plain values, In and IsNull. */
function meets(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, expected]) => {
		const actual = row[key] ?? null;
		if (!(expected instanceof FindOperator)) {
			if (expected != null && typeof expected === 'object') return actual != null && meets(actual as Record<string, unknown>, expected as Record<string, unknown>);
			return actual === expected;
		}
		if (expected.type === 'in') return (expected.value as unknown as unknown[]).includes(actual);
		if (expected.type === 'isNull') return actual == null;
		if (expected.type === 'not') return actual !== expected.value;
		if (expected.type === 'moreThanOrEqual') return typeof actual === 'string' && actual >= expected.value;
		throw new Error(`condition not supported in this test: ${expected.type}`);
	});
}

function fixture() {
	const reader = { id: 'reader', host: null, isSuspended: false, chatScope: 'everyone' };
	const violet = { id: 'violet', host: null, isSuspended: false, chatScope: 'everyone' };
	const amber = { id: 'amber', host: null, isSuspended: false, chatScope: 'everyone' };
	const users = [reader, violet, amber];
	const room = { id: 'room1', ownerId: violet.id, isArchived: false };
	const messages: Partial<MiChatMessage>[] = [];
	const mutings: Pick<MiMuting, 'id' | 'muterId' | 'muteeId'>[] = [];
	const main = vi.fn();
	const push = vi.fn();
	let noticeGate: Promise<void> = Promise.resolve();
	let nextId = 0;

	const mutingsRepository = {
		insert: async (muting: Pick<MiMuting, 'id' | 'muterId' | 'muteeId'>) => { mutings.push(muting); },
		delete: async (where: Record<string, unknown>) => {
			for (const muting of mutings.filter(row => meets(row, where))) mutings.splice(mutings.indexOf(muting), 1);
		},
		findBy: async (where: Record<string, unknown>) => mutings.filter(row => meets(row, where)),
		existsBy: async (where: Record<string, unknown>) => mutings.some(row => meets(row, where)),
	};

	const chatService = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		redisClient: memoryRedis(),
		mutingsRepository,
		usersRepository: {
			findOneBy: async ({ id }: { id: string }) => users.find(user => user.id === id) ?? null,
			findOneByOrFail: async ({ id }: { id: string }) => users.find(user => user.id === id)!,
			findBy: async (where: Record<string, unknown>) => users.filter(row => meets(row, where)),
			existsBy: async () => false,
			update: async () => undefined,
		},
		userEntityService: {
			isLocalUser: () => true,
			isRemoteUser: () => false,
			// The account as sent to its owner, cut down to the one field these tests read.
			pack: async (userId: string) => ({ id: userId, hasUnreadChatMessages: await chatService.hasUnreadMessages(userId) }),
		},
		idService: { gen: () => `message${++nextId}` },
		chatMessagesRepository: {
			insertOne: async (message: Partial<MiChatMessage>) => {
				messages.push(message);
				return message;
			},
			findOneBy: async ({ id }: { id: string }) => messages.find(message => message.id === id) ?? null,
			existsBy: async (where: Record<string, unknown> | Record<string, unknown>[]) => messages.some(row => [where].flat().some(condition => meets({ ...row, fromUser: users.find(user => user.id === row.fromUserId) }, condition))),
			findOne: async ({ where }: { where: Record<string, unknown> }) => messages.filter(row => meets({ ...row, fromUser: users.find(user => user.id === row.fromUserId) }, where)).sort((a, b) => b.id!.localeCompare(a.id!))[0] ?? null,
			update: async (id: string, values: Partial<MiChatMessage>) => { Object.assign(messages.find(message => message.id === id)!, values); },
			createQueryBuilder: () => {
				let alias = '';
				let authorId = '';
				return {
					select(_expression: string, selected: string) { alias = selected; return this; },
					where(_expression: string, parameters: { authorId?: string }) { authorId = parameters.authorId ?? ''; return this; },
					andWhere() { return this; },
					getRawMany: async () => alias === 'roomId'
						? [...new Set(messages.filter(message => message.fromUserId === authorId && message.toRoomId != null).map(message => message.toRoomId))].map(roomId => ({ roomId }))
						: [{ toUserId: reader.id }],
				};
			},
		},
		chatApprovalsRepository: {
			createQueryBuilder: () => ({ where() { return this; }, orWhere() { return this; }, take() { return this; }, getMany: async () => [] }),
			insertOne: async () => undefined,
		},
		chatRoomsRepository: { findOneBy: async () => room },
		apRendererService: { renderChatDelete: () => ({ type: 'Delete' }), renderChatRoomActivityRelay: () => ({}), addContext: (activity: unknown) => activity },
		chatRoomMembershipsRepository: {
			findBy: async () => [{ userId: reader.id, isMuted: false }, { userId: amber.id, isMuted: false }],
			findOneBy: async ({ userId }: { userId: string }) => ({ userId, isMuted: false }),
		},
		roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
		userBlockingService: { checkBlocked: async () => false },
		chatEntityService: {
			packMessageLiteFor1on1: async (message: unknown) => message,
			packMessageLiteForRoom: async (message: unknown) => message,
			packMessageDetailed: async (message: unknown) => {
				await noticeGate;
				return message;
			},
		},
		globalEventService: { publishChatUserStream: vi.fn(), publishChatRoomStream: vi.fn(), publishMainStream: main },
		pushNotificationService: { pushNotification: push },
	}) as ChatService;

	const deleteAccountService = Object.assign(Object.create(DeleteAccountService.prototype), {
		meta: { rootUserId: 'root' },
		usersRepository: { findOneByOrFail: async ({ id }: { id: string }) => ({ ...users.find(user => user.id === id)!, username: id }), update: async () => undefined },
		userEntityService: { isLocalUser: () => false },
		queueService: { createDeleteAccountJob: vi.fn() },
		globalEventService: { publishInternalEvent: vi.fn() },
		chatService,
	}) as DeleteAccountService;

	const userMutingService = Object.assign(Object.create(UserMutingService.prototype), {
		mutingsRepository,
		idService: { gen: () => `muting${++nextId}` },
		cacheService: { userMutingsCache: { refresh: async () => undefined } },
		chatService,
	}) as UserMutingService;

	return {
		reader: reader as unknown as MiUser,
		violet: violet as unknown as MiUser,
		amber: amber as unknown as MiUser,
		room: room as unknown as MiChatRoom,
		chatService,
		userMutingService,
		deleteAccountService,
		redis: (chatService as unknown as { redisClient: { sadd: (key: string, member: string) => Promise<number> } }).redisClient,
		/** The message as stored, for the calls that take one. */
		stored: (text: string) => messages.find(message => message.text === text) as MiChatMessage,
		mutings: mutings as MiMuting[],
		push,
		/** What the reader's open screens were told, in order. */
		told: () => main.mock.calls.filter(([userId]) => userId === reader.id).map(([, type]) => type as string),
		accountSent: () => main.mock.calls.filter(([userId, type]) => userId === reader.id && type === 'meUpdated').map(([, , account]) => account as { hasUnreadChatMessages: boolean }),
		/** Holds the delayed notice at the point where it has decided to notify and is preparing what to send. */
		holdNotice: () => {
			let release!: () => void;
			noticeGate = new Promise<void>(resolve => { release = resolve; });
			return release;
		},
	};
}

describe('chat unread sign', () => {
	afterEach(() => vi.useRealTimers());

	describe('reading', () => {
		test('tells the reader once the only unread direct conversation is read', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('keeps quiet while another conversation is still unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });

			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);

			expect(f.told()).toEqual([]);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);

			await f.chatService.readUserChatMessage(f.reader.id, f.amber.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('tells the reader once the only unread room is read', async () => {
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });

			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('keeps quiet when a room is read while a direct conversation is still unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });

			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);

			expect(f.told()).toEqual([]);
		});

		test('does not announce a read that cleared nothing', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);

			// An open conversation sends a read for every message it receives.
			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('marking everything read clears every conversation and tells the reader', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });

			await f.chatService.readAllChatMessages(f.reader.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
			expect(await f.chatService.getUserReadStateMap(f.reader.id, [f.violet.id])).toEqual({ violet: true });
			expect(await f.chatService.getRoomReadStateMap(f.reader.id, [f.room.id])).toEqual({ room1: true });
		});

		test('marking everything read always tells the reader, as they asked for it', async () => {
			const f = fixture();

			await f.chatService.readAllChatMessages(f.reader.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});
	});

	describe('unread marks that go away without a read', () => {
		test('tells the reader when the only unread room is one they were removed from', async () => {
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });

			await f.chatService.finishRoomMemberRemoval(f.room, f.reader);

			expect(f.told()).toContain('readAllChatMessages');
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('tells the reader when the only unread conversation is with an account that got suspended', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

			await f.chatService.handleUserSuspended(f.violet);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});
	});

	describe('conversations the chat list no longer shows', () => {
		test('a direct conversation whose only message was taken back does not count as unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);

			await f.chatService.deleteMessage(f.stored('hello'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('taking back one of several messages keeps the conversation unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'first' });
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'second' });

			await f.chatService.deleteMessage(f.stored('second'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			expect(f.told()).not.toContain('readAllChatMessages');
			expect(f.told()).toContain('chatUnreadChanged');
		});

		test('taking back the only message of one conversation leaves the sign on while another is unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });

			await f.chatService.deleteMessage(f.stored('hello'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			expect(f.told()).toEqual([]);
		});

		test('a room whose only message was taken back does not count as unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });

			await f.chatService.deleteMessage(f.stored('hello'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('a message taken back on another server is treated the same', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

			await f.chatService.deleteRemoteMessage(f.violet, f.stored('hello'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(f.told()).toEqual(['readAllChatMessages']);
		});

		test('deleting the account behind the only unread conversation turns the sign off', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

			await f.deleteAccountService.deleteAccount(f.violet);

			expect(f.told()).toEqual(['readAllChatMessages']);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('a mark left behind by a conversation that has no messages any more does not count', async () => {
			const f = fixture();
			await f.redis.sadd(`newChatMessagesExists:${f.reader.id}`, 'user:gone');
			await f.redis.sadd(`newChatMessagesExists:${f.reader.id}`, 'room:gone');

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});
	});

	describe('delayed notice of a new message', () => {
		test('still notifies about a message left unread', async () => {
			vi.useFakeTimers();
			const f = fixture();

			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await vi.advanceTimersByTimeAsync(3000);

			expect(f.told()).toEqual(['newChatMessage']);
			expect(f.push).toHaveBeenCalledWith(f.reader.id, 'newChatMessage', expect.objectContaining({ text: 'hello' }));
		});

		test('does not follow a read with a notice that was already being prepared', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			const release = f.holdNotice();
			await vi.advanceTimersByTimeAsync(3000);

			await f.chatService.readUserChatMessage(f.reader.id, f.violet.id);
			release();
			await vi.advanceTimersByTimeAsync(0);

			// A notice arriving after the word that everything was read would leave the sign on.
			expect(f.told()).toEqual(['readAllChatMessages']);
			expect(f.push).not.toHaveBeenCalled();
		});

		test('does not follow a room read with a notice that was already being prepared', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });
			const release = f.holdNotice();
			await vi.advanceTimersByTimeAsync(3000);

			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);
			release();
			await vi.advanceTimersByTimeAsync(0);

			expect(f.told()).toEqual(['readAllChatMessages']);
			expect(f.push).not.toHaveBeenCalledWith(f.reader.id, 'newChatMessage', expect.anything());
		});

		test('does not notify about a message that was marked read along with everything else', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

			await f.chatService.readAllChatMessages(f.reader.id);
			await vi.advanceTimersByTimeAsync(3000);

			expect(f.told()).toEqual(['readAllChatMessages']);
		});
	});

	describe('muted accounts', () => {
		test('a direct message from a muted account neither counts as unread nor notifies', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.userMutingService.mute(f.reader, f.violet);

			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(f.told()).toEqual([]);
			expect(f.push).not.toHaveBeenCalled();
		});

		test('reading the last conversation the list shows tells the reader, whatever a muted account sent', async () => {
			const f = fixture();
			await f.userMutingService.mute(f.reader, f.violet);
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);

			await f.chatService.readUserChatMessage(f.reader.id, f.amber.id);

			expect(f.told()).toEqual(['readAllChatMessages']);
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('muting the account behind the only unread conversation turns the sign off', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });

			await f.userMutingService.mute(f.reader, f.violet);

			expect(f.accountSent()).toEqual([{ id: f.reader.id, hasUnreadChatMessages: false }]);
		});

		test('muting one account leaves the sign on while another conversation is unread', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'hello' });
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });

			await f.userMutingService.mute(f.reader, f.violet);

			expect(f.accountSent()).toEqual([{ id: f.reader.id, hasUnreadChatMessages: true }]);
		});

		test('unmuting brings back what was unread before and during the mute', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'before' });
			await f.userMutingService.mute(f.reader, f.violet);
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'during' });

			await f.userMutingService.unmute([...f.mutings]);

			expect(f.accountSent().at(-1)).toEqual({ id: f.reader.id, hasUnreadChatMessages: true });
			expect(await f.chatService.getUserReadStateMap(f.reader.id, [f.violet.id])).toEqual({ violet: false });
		});

		test('muting or unmuting an account with nothing unread says nothing', async () => {
			const f = fixture();
			await f.chatService.createMessageToUser(f.amber, f.reader, { text: 'hi' });

			await f.userMutingService.mute(f.reader, f.violet);
			await f.userMutingService.unmute([...f.mutings]);

			expect(f.told()).toEqual([]);
		});

		test('a room message from a muted account still counts and notifies', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.userMutingService.mute(f.reader, f.violet);

			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'hello' });
			await vi.advanceTimersByTimeAsync(3000);

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			expect(f.told()).toEqual(['newChatMessage']);
		});
	});
});
