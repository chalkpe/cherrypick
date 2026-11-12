/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import { DeleteAccountProcessorService } from '@/queue/processors/DeleteAccountProcessorService.js';
import { DeleteAccountService } from '@/core/DeleteAccountService.js';
import { UserMutingService } from '@/core/UserMutingService.js';
import type { MiChatMessage, MiChatRoom, MiMuting, MiUser } from '@/models/_.js';
import { meets } from '../misc/chat-repository-match.js';
import { memoryRedis } from '../misc/chat-unread-redis.js';

function fixture() {
	const reader = { id: 'reader', host: null, isSuspended: false, chatScope: 'everyone' };
	const violet = { id: 'violet', host: null, isSuspended: false, chatScope: 'everyone' };
	const amber = { id: 'amber', host: null, isSuspended: false, chatScope: 'everyone' };
	const users = [reader, violet, amber];
	let roomPresent = true;
	const room = { id: 'room1', ownerId: violet.id, isArchived: false };
	const messages: Partial<MiChatMessage>[] = [];
	const memberships = [{ userId: reader.id, isMuted: false }, { userId: amber.id, isMuted: false }];
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
			existsBy: async (where: Record<string, unknown>) => users.some(row => meets(row, where)),
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
				if (messages.some(stored => stored.id === message.id)) throw new Error('duplicate message id in fixture');
				messages.push(message);
				return message;
			},
			delete: async (id: string | Record<string, unknown>) => {
				for (const message of messages.filter(row => typeof id === 'string' ? row.id === id : meets(row, id))) messages.splice(messages.indexOf(message), 1);
			},
			findOneBy: async ({ id }: { id: string }) => messages.find(message => message.id === id) ?? null,
			existsBy: async (where: Record<string, unknown> | Record<string, unknown>[]) => messages.some(row => [where].flat().some(condition => meets({ ...row, fromUser: users.find(user => user.id === row.fromUserId) }, condition))),
			findOne: async ({ where }: { where: Record<string, unknown> | Record<string, unknown>[] }) => messages.filter(row => [where].flat().some(condition => meets({ ...row, fromUser: users.find(user => user.id === row.fromUserId) }, condition))).sort((a, b) => b.id!.localeCompare(a.id!))[0] ?? null,
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
		chatRoomsRepository: {
			findOneBy: async () => roomPresent ? room : null,
			delete: async () => { roomPresent = false; },
			findBy: async ({ ownerId }: { ownerId: string }) => room.ownerId === ownerId ? [room] : [],
		},
		apRendererService: { renderChatRoomDelete: () => ({ type: 'Delete' }), renderChatDelete: () => ({ type: 'Delete' }), renderChatRoomActivityRelay: () => ({}), addContext: (activity: unknown) => activity },
		chatRoomMembershipsRepository: {
			findBy: async () => memberships.map(member => ({ ...member })),
			findOneBy: async ({ userId }: { userId: string }) => memberships.find(member => member.userId === userId) ?? null,
		},
		chatRoomInvitationsRepository: { findBy: async () => [] },
		chatRosterService: { markRoomDeletedFor: vi.fn() },
		liveKitService: { deleteRoom: async () => undefined },
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
		redis: (chatService as unknown as { redisClient: ReturnType<typeof memoryRedis> }).redisClient,
		/** The message as stored, for the calls that take one. */
		stored: (text: string) => messages.find(message => message.text === text) as MiChatMessage,
		mutings: mutings as MiMuting[],
		push,
		memberships,
		messages,
		users,
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
		test('a delayed earlier ID does not expand an older unread range into read history', async () => {
			vi.useFakeTimers();
			const f = fixture();
			const service = f.chatService as unknown as { idService: { gen: () => string } };
			vi.spyOn(service.idService, 'gen').mockReturnValueOnce('message2').mockReturnValueOnce('message4').mockReturnValue('message1');
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'read history' });
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'older unread format' });
			const key = `newRoomChatMessageExists:${f.reader.id}:${f.room.id}`;
			await f.redis.del(`${key}:revision`);
			await f.redis.del(`${key}:messages`);

			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'delayed earlier insert' });
			await f.chatService.deleteMessage(f.stored('older unread format'));
			await f.chatService.deleteMessage(f.stored('delayed earlier insert'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('a lost Redis reply and unavailable cleanup never mark read room history unread', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'read history' });
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);
			const evaluate = f.redis.eval;
			let applied = false;
			const fault = vi.spyOn(f.redis, 'eval').mockImplementation(async (...args) => {
				if (!applied) {
					applied = true;
					await evaluate(...args);
				}
				throw new Error('lost Redis reply');
			});

			await expect(f.chatService.createMessageToRoom(f.violet, f.room, { text: 'failed send' })).rejects.toThrow('lost Redis reply');
			fault.mockRestore();

			expect(f.stored('failed send')).toBeUndefined();
			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(await f.chatService.getRoomReadStateMap(f.reader.id, [f.room.id])).toEqual({ room1: true });
		});

		test('physical deletion of an ordinary member reconciles unread above read history', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'read history' });
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);
			await f.chatService.createMessageToRoom(f.amber, f.room, { text: 'unread' });
			const emptyRepository = { find: async () => [] };
			const processor = Object.assign(Object.create(DeleteAccountProcessorService.prototype), {
				logger: { info: vi.fn(), succ: vi.fn() },
				usersRepository: {
					findOneBy: async () => f.amber,
					delete: async () => {
						// 사용자 FK CASCADE가 작성자의 메시지를 제거하는 저장소 경계이다.
						for (const message of f.messages.filter(row => row.fromUserId === f.amber.id)) f.messages.splice(f.messages.indexOf(message), 1);
					},
				},
				notesRepository: emptyRepository,
				driveFilesRepository: emptyRepository,
				pagesRepository: emptyRepository,
				userProfilesRepository: { findOneByOrFail: async () => ({}) },
				userEntityService: { isRemoteUser: () => false },
				globalEventService: { publishInternalEvent: vi.fn() },
				chatService: f.chatService,
			}) as DeleteAccountProcessorService;

			await processor.process({ data: { user: { id: f.amber.id }, soft: false } } as never);

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test.each(['direct', 'room'] as const)('a Redis failure never leaves a stored %s message behind a failed send', async kind => {
			vi.useFakeTimers();
			const f = fixture();
			vi.spyOn(f.redis, 'eval').mockRejectedValueOnce(new Error('injected Redis failure'));

			const sending = kind === 'direct'
				? f.chatService.createMessageToUser(f.violet, f.reader, { text: 'retry safely' })
				: f.chatService.createMessageToRoom(f.violet, f.room, { text: 'retry safely' });
			await expect(sending).rejects.toThrow('injected Redis failure');

			expect(f.messages.filter(message => message.text === 'retry safely')).toEqual([]);
		});

		test.each(['withdrawn', 'suspended', 'removed', 'room deleted'] as const)('a delayed mark cannot restore unread for a message that was %s', async change => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'read history' });
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);
			const service = f.chatService as unknown as { chatEntityService: { packMessageLiteForRoom: (message: MiChatMessage) => Promise<MiChatMessage> } };
			let entered!: () => void;
			let release!: () => void;
			const packed = new Promise<void>(resolve => { entered = resolve; });
			const gate = new Promise<void>(resolve => { release = resolve; });
			vi.spyOn(service.chatEntityService, 'packMessageLiteForRoom').mockImplementationOnce(async message => {
				entered();
				await gate;
				return message;
			});

			const sending = f.chatService.createMessageToRoom(f.amber, f.room, { text: 'pending' });
			await packed;
			if (change === 'withdrawn') await f.chatService.deleteMessage(f.stored('pending'));
			if (change === 'suspended') {
				f.amber.isSuspended = true;
				await f.chatService.handleUserSuspended(f.amber);
			}
			if (change === 'room deleted') await f.chatService.deleteRoom(f.room);
			if (change === 'removed') {
				f.memberships.splice(0, 1);
				await f.chatService.finishRoomMemberRemoval(f.room, f.reader);
			}
			release();
			await sending;

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
			expect(await f.chatService.getRoomReadStateMap(f.reader.id, [f.room.id])).toEqual({ room1: true });
		});

		test('withdrawing the last eligible room message does not promote muted arrivals', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'eligible' });
			f.memberships[0].isMuted = true;
			await f.chatService.createMessageToRoom(f.amber, f.room, { text: 'muted' });
			f.memberships[0].isMuted = false;

			await f.chatService.deleteMessage(f.stored('eligible'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('unmuting before the notice delay does not notify about muted arrivals', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'eligible' });
			await vi.advanceTimersByTimeAsync(3000);
			f.memberships[0].isMuted = true;
			await f.chatService.createMessageToRoom(f.amber, f.room, { text: 'muted' });
			f.memberships[0].isMuted = false;

			await vi.advanceTimersByTimeAsync(3000);

			expect(f.push).not.toHaveBeenCalledWith(f.reader.id, 'newChatMessage', expect.objectContaining({ text: 'muted' }));
		});

		test('suspending the only unread author clears a room with read history', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToRoom(f.violet, f.room, { text: 'read history' });
			await f.chatService.readRoomChatMessage(f.reader.id, f.room.id);
			await f.chatService.createMessageToRoom(f.amber, f.room, { text: 'unread' });
			f.amber.isSuspended = true;

			await f.chatService.handleUserSuspended(f.amber);

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(false);
		});

		test('a delayed insert between first and latest survives a withdrawal snapshot', async () => {
			vi.useFakeTimers();
			const f = fixture();
			const service = f.chatService as unknown as {
				idService: { gen: () => string };
				chatMessagesRepository: { findOne: (...args: unknown[]) => Promise<MiChatMessage | null> };
			};
			vi.spyOn(service.idService, 'gen')
				.mockReturnValueOnce('message1').mockReturnValueOnce('approval1')
				.mockReturnValueOnce('message3').mockReturnValueOnce('approval2')
				.mockReturnValueOnce('message2').mockReturnValue('approval3');
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'first' });
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'latest' });
			expect(f.stored('first').id).toBe('message1');
			expect(f.stored('latest').id).toBe('message3');
			await f.chatService.deleteMessage(f.stored('first'));
			let release!: () => void;
			let queried!: () => void;
			const queryFinished = new Promise<void>(resolve => { queried = resolve; });
			const gate = new Promise<void>(resolve => { release = resolve; });
			const find = service.chatMessagesRepository.findOne;
			vi.spyOn(service.chatMessagesRepository, 'findOne').mockImplementationOnce(async (...args) => {
				const result = await find(...args);
				queried();
				await gate;
				return result;
			});

			const withdrawing = f.chatService.deleteMessage(f.stored('latest'));
			await queryFinished;
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'delayed' });
			expect(f.stored('delayed').id).toBe('message2');
			release();
			await withdrawing;

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
		});

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
		test('receiving after an older first-boundary format does not discard its unread messages', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'old unread' });
			const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
			await f.redis.del(`${key}:revision`);
			await f.redis.del(`${key}:messages`);

			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'new unread' });
			await f.chatService.deleteMessage(f.stored('new unread'));

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
		});

		test('withdrawing a muted legacy conversation preserves its unknown read boundary', async () => {
			vi.useFakeTimers();
			const f = fixture();
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'remaining' });
			await f.chatService.createMessageToUser(f.violet, f.reader, { text: 'withdrawn' });
			const key = `newUserChatMessageExists:${f.reader.id}:${f.violet.id}`;
			await f.redis.del(`${key}:first`);
			await f.userMutingService.mute(f.reader, f.violet);

			await f.chatService.deleteMessage(f.stored('withdrawn'));
			await f.userMutingService.unmute([...f.mutings]);

			expect(await f.chatService.hasUnreadMessages(f.reader.id)).toBe(true);
			expect(await f.redis.get(key)).not.toBeNull();
		});

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
