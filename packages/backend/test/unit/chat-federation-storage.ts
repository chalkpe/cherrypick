/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type * as Redis from 'ioredis';
import type { TestingModule } from '@nestjs/testing';
import type { ChatMessagesRepository, ChatRoomInvitationsRepository, ChatRoomMembershipsRepository, ChatRoomRosterStatesRepository, ChatRoomsRepository, MiChatRoom, MiUser, UsersRepository } from '@/models/_.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { ChatService, ChatTooManyReactionsError } from '@/core/ChatService.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { IdService } from '@/core/IdService.js';
import { ChatMessageUriUnique1793708299161 } from '../../migration/1793708299161-chat-message-uri-unique.js';

// These cases depend on what PostgreSQL and Redis do with the query, so they use the real ones.
describe('chat federation storage', () => {
	let app: TestingModule;
	let idService: IdService;
	let usersRepository: UsersRepository;
	let chatMessagesRepository: ChatMessagesRepository;
	let chatRoomsRepository: ChatRoomsRepository;
	let chatRoomMembershipsRepository: ChatRoomMembershipsRepository;
	let chatRoomInvitationsRepository: ChatRoomInvitationsRepository;
	let chatRoomRosterStatesRepository: ChatRoomRosterStatesRepository;
	let redisClient: Redis.Redis;
	let alice: MiUser;
	let bob: MiUser;

	const deliver = vi.fn();
	const publishChatUserStream = vi.fn();
	const publishChatRoomStream = vi.fn();
	const renderChatReaction = vi.fn(() => ({ type: 'Like' }));
	const renderChatReactionUndo = vi.fn(() => ({ type: 'Undo' }));

	function createService() {
		return Object.assign(Object.create(ChatService.prototype), {
			db: app.get(DI.db),
			userBlockingService: { checkBlocked: vi.fn().mockResolvedValue(false) },
			config: { url: 'https://local.test' },
			usersRepository,
			chatMessagesRepository,
			chatRoomsRepository,
			chatRoomMembershipsRepository,
			mutingsRepository: app.get(DI.mutingsRepository),
			chatRoomInvitationsRepository: { findBy: async () => [] },
			redisClient,
			chatRosterService: Object.assign(Object.create(ChatRosterService.prototype), { redisClient }),
			queueService: { deliver },
			globalEventService: { publishChatUserStream, publishChatRoomStream, publishMainStream: vi.fn() },
			liveKitService: { deleteRoom: vi.fn(async () => {}) },
			customEmojiService: { localEmojisCache: { fetch: async () => new Map() } },
			userEntityService: {
				isLocalUser: (user: MiUser) => user.host == null,
				isRemoteUser: (user: MiUser) => user.host != null,
				genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
				pack: async (id: string) => ({ id }),
			},
			apRendererService: {
				renderChatReaction,
				renderChatReactionUndo,
				renderChatDelete: () => ({ type: 'Delete' }),
				addContext: (activity: unknown) => activity,
			},
		}) as ChatService;
	}

	async function createUser(data: Partial<MiUser>) {
		const id = idService.gen();
		await usersRepository.insert({ id, username: id, usernameLower: id, ...data });
		return usersRepository.findOneByOrFail({ id });
	}

	async function createDirectMessage(id = idService.gen()) {
		await chatMessagesRepository.insert({ id, fromUserId: bob.id, toUserId: alice.id, text: 'hello', uri: `https://remote.test/chat/messages/${id}` });
		return id;
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule], providers: [IdService] }).compile();
		await app.init();
		idService = app.get(IdService);
		usersRepository = app.get(DI.usersRepository);
		chatMessagesRepository = app.get(DI.chatMessagesRepository);
		chatRoomsRepository = app.get(DI.chatRoomsRepository);
		chatRoomMembershipsRepository = app.get(DI.chatRoomMembershipsRepository);
		chatRoomInvitationsRepository = app.get(DI.chatRoomInvitationsRepository);
		chatRoomRosterStatesRepository = app.get(DI.chatRoomRosterStatesRepository);
		redisClient = app.get(DI.redis);
	});

	beforeEach(async () => {
		vi.clearAllMocks();
		alice = await createUser({});
		bob = await createUser({ host: 'remote.test', uri: `https://remote.test/users/${idService.gen()}`, inbox: 'https://remote.test/inbox' });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await createService().readAllChatMessages(alice.id);
		await createService().readAllChatMessages(bob.id);
		await usersRepository.delete([alice.id, bob.id]);
	});

	afterAll(async () => {
		await app.close();
	});

	describe('unread storage', () => {
		function markUnread(service: ChatService, messageId: string) {
			// 전송 경로가 사용하는 실제 Redis 저장 연산만 호출한다. DB 행은 위 fixture가 준비한다.
			return (service as unknown as { markUnread: (mark: { readerId: string; senderId: string }, id: string) => Promise<void> })
				.markUnread({ readerId: alice.id, senderId: bob.id }, messageId);
		}

		test('deletion preserves a new unread message arriving during the database lookup', async () => {
			const service = createService();
			const messageId = await createDirectMessage();
			const message = await chatMessagesRepository.findOneByOrFail({ id: messageId });
			await markUnread(service, messageId);
			let queried!: () => void;
			let release!: () => void;
			const queryReached = new Promise<void>(resolve => { queried = resolve; });
			const gate = new Promise<void>(resolve => { release = resolve; });
			const findOne = chatMessagesRepository.findOne.bind(chatMessagesRepository);
			vi.spyOn(chatMessagesRepository, 'findOne').mockImplementationOnce(async options => {
				const remaining = await findOne(options);
				queried();
				await gate;
				return remaining;
			});

			const deleting = service.deleteMessage(message);
			await queryReached;
			try {
				await markUnread(service, await createDirectMessage());
			} finally {
				release();
				await deleting;
			}

			expect(await service.hasUnreadMessages(alice.id)).toBe(true);
			expect(await service.getUserReadStateMap(alice.id, [bob.id])).toEqual({ [bob.id]: false });
		});

		test('a delayed INSERT between the saved boundaries survives the withdrawal query', async () => {
			const service = createService();
			const firstId = idService.gen();
			const middleId = idService.gen();
			const latestId = idService.gen();
			await createDirectMessage(firstId);
			await createDirectMessage(latestId);
			await markUnread(service, firstId);
			await markUnread(service, latestId);
			await service.deleteMessage(await chatMessagesRepository.findOneByOrFail({ id: firstId }));
			let queried!: () => void;
			let release!: () => void;
			const reached = new Promise<void>(resolve => { queried = resolve; });
			const gate = new Promise<void>(resolve => { release = resolve; });
			const findOne = chatMessagesRepository.findOne.bind(chatMessagesRepository);
			vi.spyOn(chatMessagesRepository, 'findOne').mockImplementationOnce(async options => {
				const remaining = await findOne(options);
				queried();
				await gate;
				return remaining;
			});

			const deleting = service.deleteMessage(await chatMessagesRepository.findOneByOrFail({ id: latestId }));
			await reached;
			try {
				await createDirectMessage(middleId);
				await markUnread(service, middleId);
			} finally {
				release();
				await deleting;
			}

			expect(await service.hasUnreadMessages(alice.id)).toBe(true);
			expect(await service.getUserReadStateMap(alice.id, [bob.id])).toEqual({ [bob.id]: false });
		});

		test('an orphan from an older read-all does not make read history unread again', async () => {
			const service = createService();
			const oldMessage = await createDirectMessage();
			// 이전 버전 전체 읽음 이후 개별 키만 남은 업그레이드 fixture다.
			await redisClient.set(`newUserChatMessageExists:${alice.id}:${bob.id}`, oldMessage);
			const latest = await createDirectMessage();
			await markUnread(service, latest);

			await service.deleteMessage(await chatMessagesRepository.findOneByOrFail({ id: latest }));

			expect(await service.hasUnreadMessages(alice.id)).toBe(false);
			expect(await service.getUserReadStateMap(alice.id, [bob.id])).toEqual({ [bob.id]: true });
		});

		test('an active legacy mark stays unknown until explicitly read, then uses the new boundary', async () => {
			const service = createService();
			const key = `newUserChatMessageExists:${alice.id}:${bob.id}`;
			await redisClient.set(key, await createDirectMessage());
			await redisClient.sadd(`newChatMessagesExists:${alice.id}`, `user:${bob.id}`);
			await markUnread(service, await createDirectMessage());
			expect(await redisClient.get(`${key}:first`)).toBeNull();
			expect(await service.hasUnreadMessages(alice.id)).toBe(true);

			await service.readUserChatMessage(alice.id, bob.id);
			const next = await createDirectMessage();
			await markUnread(service, next);
			expect(await redisClient.get(`${key}:first`)).toBe(next);
			await service.deleteMessage(await chatMessagesRepository.findOneByOrFail({ id: next }));
			expect(await service.hasUnreadMessages(alice.id)).toBe(false);
		});

		test.each(['withdrawal', 'suspension', 'membership removal', 'room deletion'] as const)('a delayed Redis mark cannot undo completed %s', async cleanup => {
			const service = createService();
			let room: MiChatRoom | undefined;
			if (cleanup === 'membership removal' || cleanup === 'room deletion') {
				const roomId = idService.gen();
				await chatRoomsRepository.insert({ id: roomId, name: 'delayed mark', ownerId: bob.id });
				room = await chatRoomsRepository.findOneByOrFail({ id: roomId });
				await chatRoomMembershipsRepository.insert({ id: idService.gen(), roomId, userId: alice.id });
			}
			const messageId = idService.gen();
			await chatMessagesRepository.insert({ id: messageId, fromUserId: bob.id, text: 'delayed', ...(room ? { toRoomId: room.id } : { toUserId: alice.id }) });
			const message = await chatMessagesRepository.findOneByOrFail({ id: messageId });
			const mark = room ? { readerId: alice.id, roomId: room.id } : { readerId: alice.id, senderId: bob.id };
			const key = room ? `newRoomChatMessageExists:${alice.id}:${room.id}` : `newUserChatMessageExists:${alice.id}:${bob.id}`;
			const conversation = room ? `room:${room.id}` : `user:${bob.id}`;
			let reached!: () => void;
			let release!: () => void;
			const waiting = new Promise<void>(resolve => { reached = resolve; });
			const gate = new Promise<void>(resolve => { release = resolve; });
			const evalRedis = redisClient.eval.bind(redisClient);
			vi.spyOn(redisClient, 'eval').mockImplementation(async (...args) => {
				if (String(args[0]).includes("local active = redis.call('SISMEMBER', KEYS[3]")) {
					reached();
					await gate;
				}
				return evalRedis(...args);
			});

			const marking = (service as unknown as { markUnread: (target: typeof mark, id: string) => Promise<void> }).markUnread(mark, messageId);
			await waiting;
			try {
				if (cleanup === 'withdrawal') await service.deleteMessage(message);
				if (cleanup === 'suspension') {
					await usersRepository.update(bob.id, { isSuspended: true });
					await service.handleUserSuspended(await usersRepository.findOneByOrFail({ id: bob.id }));
				}
				if (cleanup === 'membership removal') expect(await service.removeRoomMember(room!, alice)).toBe(true);
				if (cleanup === 'room deletion') await service.deleteRoom(room!, undefined, { federate: false });
			} finally {
				release();
				await marking;
			}

			expect(await redisClient.get(key)).toBeNull();
			expect(await redisClient.sismember(`newChatMessagesExists:${alice.id}`, conversation)).toBe(0);
			expect(await service.hasUnreadMessages(alice.id)).toBe(false);
		});
	});

	describe('local reactions', () => {
		test('unreacting without a reaction neither publishes nor federates', async () => {
			const messageId = await createDirectMessage();

			await createService().unreact(messageId, alice.id, '👍');

			expect(publishChatUserStream).not.toHaveBeenCalled();
			expect(deliver).not.toHaveBeenCalled();
		});

		test('unreacting an existing reaction publishes and federates it once', async () => {
			const messageId = await createDirectMessage();
			const service = createService();
			await service.react(messageId, alice.id, '👍');
			vi.clearAllMocks();

			await service.unreact(messageId, alice.id, '👍');

			expect(await chatMessagesRepository.findOneByOrFail({ id: messageId })).toMatchObject({ reactions: [] });
			expect(publishChatUserStream).toHaveBeenCalledTimes(2);
			expect(renderChatReactionUndo).toHaveBeenCalledTimes(1);
			expect(deliver).toHaveBeenCalledTimes(1);
		});

		test('repeating a reaction keeps the first one and sends no second Like', async () => {
			const messageId = await createDirectMessage();
			const service = createService();

			await service.react(messageId, alice.id, '👍');
			await service.react(messageId, alice.id, '👍');

			expect(await chatMessagesRepository.findOneByOrFail({ id: messageId })).toMatchObject({ reactions: [`${alice.id}/👍`] });
			expect(renderChatReaction).toHaveBeenCalledTimes(1);
			expect(deliver).toHaveBeenCalledTimes(1);
		});

		test('the Undo after a repeated reaction names the original Like', async () => {
			const messageId = await createDirectMessage();
			const service = createService();

			await service.react(messageId, alice.id, '👍');
			const likeId = renderChatReaction.mock.calls[0].at(-1 as never);
			await service.react(messageId, alice.id, '👍');
			await service.unreact(messageId, alice.id, '👍');

			expect(renderChatReactionUndo.mock.calls[0].at(-1 as never)).toBe(likeId);
		});
	});

	describe('message URIs', () => {
		const uriIndex = 'IDX_f10847101444176c7fc3748b5f';

		function insertMessage(uri: string | null, manager = chatMessagesRepository.manager) {
			const id = idService.gen();
			return manager.insert('chat_message', { id, fromUserId: bob.id, toUserId: alice.id, text: id, uri }).then(() => id);
		}

		test('two rows cannot claim the same URI', async () => {
			const uri = `https://remote.test/chat/messages/${idService.gen()}`;
			await insertMessage(uri);

			const error = await insertMessage(uri).then(() => null, err => err);

			expect(isDuplicateKeyValueError(error)).toBe(true);
		});

		test('rows without a URI are not treated as duplicates', async () => {
			await insertMessage(null);
			await expect(insertMessage(null)).resolves.toEqual(expect.any(String));
		});

		test('the migration keeps the oldest row, clears the URI of later copies and makes the index unique', async () => {
			const queryRunner = chatMessagesRepository.manager.connection.createQueryRunner();
			await queryRunner.startTransaction();
			try {
				const migration = new ChatMessageUriUnique1793708299161();
				await migration.down(queryRunner);
				const uri = `https://remote.test/chat/messages/${idService.gen()}`;
				const first = await insertMessage(uri, queryRunner.manager);
				const second = await insertMessage(uri, queryRunner.manager);
				const unrelated = await insertMessage(`${uri}-other`, queryRunner.manager);

				await migration.up(queryRunner);

				const rows = await queryRunner.query('SELECT "id", "uri" FROM "chat_message" WHERE "id" = ANY($1)', [[first, second, unrelated]]) as { id: string; uri: string | null }[];
				expect(new Map(rows.map(row => [row.id, row.uri]))).toEqual(new Map([[first, uri], [second, null], [unrelated, `${uri}-other`]]));
				const [index] = await queryRunner.query('SELECT "indexdef" FROM "pg_indexes" WHERE "indexname" = $1', [uriIndex]) as { indexdef: string }[];
				expect(index.indexdef).toMatch(/^CREATE UNIQUE INDEX/);
			} finally {
				await queryRunner.rollbackTransaction();
				await queryRunner.release();
			}
		});
	});

	describe('reaction limit', () => {
		test('a local reaction past the limit is refused and not stored', async () => {
			const id = idService.gen();
			const full = Array.from({ length: 100 }, (_, i) => `user${i}/👍`);
			await chatMessagesRepository.insert({ id, fromUserId: bob.id, toUserId: alice.id, text: 'full', reactions: full });

			await expect(createService().react(id, alice.id, '👍')).rejects.toBeInstanceOf(ChatTooManyReactionsError);
			expect((await chatMessagesRepository.findOneByOrFail({ id })).reactions).toEqual(full);
		});
	});

	describe('remote room updates', () => {
		async function createMirrorRoom() {
			const id = idService.gen();
			await chatRoomsRepository.insert({ id, name: 'initial', ownerId: bob.id, description: '', uri: `https://remote.test/chat/rooms/${id}` });
			return chatRoomsRepository.findOneByOrFail({ id });
		}

		const newer = new Date('2026-11-03T00:00:10.000Z');
		const older = new Date('2026-11-03T00:00:05.000Z');

		test('a delayed older update does not overwrite a newer one', async () => {
			const room = await createMirrorRoom();
			const service = createService();

			await service.updateRoom(room, { name: 'newer', isArchived: false }, { federate: false, remoteUpdatedAt: newer });
			publishChatRoomStream.mockClear();
			await service.updateRoom(room, { name: 'older', isArchived: true }, { federate: false, remoteUpdatedAt: older });

			expect(await chatRoomsRepository.findOneByOrFail({ id: room.id })).toMatchObject({ name: 'newer', isArchived: false, lastRemoteUpdatedAt: newer });
			expect(publishChatRoomStream).not.toHaveBeenCalled();
		});

		test('an update with a later timestamp applies and moves the marker forward', async () => {
			const room = await createMirrorRoom();
			const service = createService();

			await service.updateRoom(room, { name: 'older' }, { federate: false, remoteUpdatedAt: older });
			await service.updateRoom(room, { name: 'newer' }, { federate: false, remoteUpdatedAt: newer });

			expect(await chatRoomsRepository.findOneByOrFail({ id: room.id })).toMatchObject({ name: 'newer', lastRemoteUpdatedAt: newer });
		});

		test('an update without a timestamp applies in arrival order', async () => {
			const room = await createMirrorRoom();
			const service = createService();

			await service.updateRoom(room, { name: 'versioned' }, { federate: false, remoteUpdatedAt: newer });
			await service.updateRoom(room, { name: 'unversioned' }, { federate: false });

			expect(await chatRoomsRepository.findOneByOrFail({ id: room.id })).toMatchObject({ name: 'unversioned', lastRemoteUpdatedAt: newer });
		});
	});

	describe('invitations to a room this server has not seen', () => {
		let carol: MiUser;
		const createNotification = vi.fn();

		function createInbox() {
			const usersByUri = new Map<string, MiUser>([
				[`https://local.test/users/${alice.id}`, alice],
				[`https://local.test/users/${carol.id}`, carol],
			]);
			const inbox = Object.assign(Object.create(ApInboxService.prototype), {
				db: app.get(DI.db),
				utilityService: { punyHost: (url: string) => new URL(url).host },
				chatRosterService: Object.assign(Object.create(ChatRosterService.prototype), { redisClient, chatRoomRosterStatesRepository }),
				apDbResolverService: { getUserFromApId: async (uri: string) => usersByUri.get(uri) ?? null },
				userEntityService: { isLocalUser: (user: MiUser) => user.host == null },
				userBlockingService: { checkBlocked: vi.fn().mockResolvedValue(false) },
				chatRoomsRepository,
				chatRoomInvitationsRepository,
				idService,
				redisClient,
				chatService: createService(),
				notificationService: { createNotification },
				logger: { info: vi.fn(), warn: vi.fn() },
			});
			return inbox as never as {
				chatRoomByUri: (uri: string) => Promise<MiChatRoom | null>;
				invite: (actor: MiUser, activity: unknown) => Promise<string>;
			};
		}

		// Inbox workers run side by side, so all of them can have read that there is no such room before any of them creates it.
		function readingTogether(inbox: ReturnType<typeof createInbox>, count: number) {
			const read = inbox.chatRoomByUri.bind(inbox);
			let reads = 0;
			let release!: () => void;
			const together = new Promise<void>(resolve => { release = resolve; });
			inbox.chatRoomByUri = async uri => {
				const room = await read(uri);
				if (++reads === count) release();
				await together;
				return room;
			};
		}

		function invite(actor: MiUser, roomUri: string, invitee: MiUser) {
			return {
				type: 'Invite',
				actor: actor.uri,
				object: { id: roomUri, type: 'Group', name: 'a new room', attributedTo: actor.uri },
				target: `https://local.test/users/${invitee.id}`,
			};
		}

		function newRoomUri() {
			return `https://remote.test/chat/rooms/${idService.gen()}`;
		}

		beforeEach(async () => {
			carol = await createUser({});
		});

		afterEach(async () => {
			await usersRepository.delete(carol.id);
		});

		test('two arriving together both get through, and the room is created once', async () => {
			const roomUri = newRoomUri();
			const inbox = createInbox();
			readingTogether(inbox, 2);

			const results = await Promise.allSettled([
				inbox.invite(bob, invite(bob, roomUri, alice)),
				inbox.invite(bob, invite(bob, roomUri, carol)),
			]);

			expect(results.map(result => result.status === 'fulfilled' ? result.value : String(result.reason))).toEqual(['ok', 'ok']);
			const rooms = await chatRoomsRepository.findBy({ uri: roomUri });
			expect(rooms).toHaveLength(1);
			expect(rooms[0]).toMatchObject({ ownerId: bob.id, name: 'a new room' });
			const invitations = await chatRoomInvitationsRepository.findBy({ roomId: rooms[0].id });
			expect(invitations.map(invitation => invitation.userId).toSorted()).toEqual([alice.id, carol.id].toSorted());
			expect(createNotification).toHaveBeenCalledTimes(2);
		});

		test('someone else on that server cannot invite by racing the owner', async () => {
			const roomUri = newRoomUri();
			const dave = await createUser({ host: 'remote.test', uri: `https://remote.test/users/${idService.gen()}`, inbox: 'https://remote.test/inbox' });
			const inbox = createInbox();
			readingTogether(inbox, 2);

			const results = await Promise.all([
				inbox.invite(bob, invite(bob, roomUri, alice)),
				inbox.invite(dave, invite(dave, roomUri, carol)),
			]);

			expect(results.toSorted()).toEqual(['ok', 'skip: inviter is not the room owner']);
			const [room] = await chatRoomsRepository.findBy({ uri: roomUri });
			expect(await chatRoomInvitationsRepository.countBy({ roomId: room.id })).toBe(1);
			await usersRepository.delete(dave.id);
		});

		test('any other failure to create the room is left for the queue to retry', async () => {
			const roomUri = newRoomUri();
			const nobody = { ...bob, id: idService.gen() };

			await expect(createInbox().invite(nobody, invite(nobody, roomUri, alice))).rejects.toThrow('foreign key');
		});
	});

	describe('remote reaction counter', () => {
		test('repeated reactions do not extend the fixed window', async () => {
			const messageId = await createDirectMessage();
			const message = await chatMessagesRepository.findOneByOrFail({ id: messageId });
			const countKey = `chat_remote_reaction_activity_count:${alice.id}`;
			const service = createService();
			const record = (service as never as { recordRemoteReactionActivity: (...args: unknown[]) => Promise<boolean> }).recordRemoteReactionActivity.bind(service);
			await redisClient.del(countKey);

			await record(alice, message, '👍', 'https://remote.test/likes/1', false);
			await redisClient.expire(countKey, 100);
			await record(alice, message, '👍', 'https://remote.test/likes/2', false);

			const ttl = await redisClient.ttl(countKey);
			await redisClient.del(countKey, `chat_remote_reaction_activities:${message.id}:${alice.id}:👍`);
			expect(ttl).toBeGreaterThan(0);
			expect(ttl).toBeLessThanOrEqual(100);
		});

		test('deferred reactions do not extend the fixed window', async () => {
			const countKey = `chat_pending_reaction_count:${alice.id}`;
			const messageUri = `https://remote.test/chat/messages/${idService.gen()}`;
			const service = createService();
			await redisClient.del(countKey);

			await service.storePendingChatReaction(alice.id, messageUri, '👍', false);
			await redisClient.expire(countKey, 100);
			await service.storePendingChatReaction(alice.id, messageUri, '👍', true);

			const ttl = await redisClient.ttl(countKey);
			await redisClient.del(countKey, `chat_pending_reaction_events:${messageUri}`);
			expect(ttl).toBeGreaterThan(0);
			expect(ttl).toBeLessThanOrEqual(100);
		});
	});
});
