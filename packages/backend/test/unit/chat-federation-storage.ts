/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fork } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type * as Redis from 'ioredis';
import type { TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import type { ChatMessagesRepository, ChatRoomInvitationsRepository, ChatRoomMembershipsRepository, ChatRoomRosterStatesRepository, ChatRoomsRepository, MiChatMessage, MiChatRoom, MiUser, UsersRepository } from '@/models/_.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { ChatService, ChatTooManyReactionsError } from '@/core/ChatService.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { IdService } from '@/core/IdService.js';
import { ChatMessageUriUnique1793708299161 } from '../../migration/1793708299161-chat-message-uri-unique.js';
import type { Config } from '@/config.js';
import type { SendLockFixtureInput } from '../misc/chat-send-lock-fixture.js';

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
			logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
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
		type Mark = { readerId: string; senderId: string } | { readerId: string; roomId: string };
		type SendPath = {
			insertMarkedUnread: (message: Record<string, unknown>, marks: Mark[]) => Promise<MiChatMessage>;
			settleUnreadMarks: (message: MiChatMessage, marks: Mark[]) => Promise<void>;
		};

		/** The send path's own steps: the mark, the INSERT, then settling. Streams and federation are left out. */
		async function send(service: ChatService, id = idService.gen(), room?: MiChatRoom) {
			const path = service as unknown as SendPath;
			const mark: Mark = room ? { readerId: alice.id, roomId: room.id } : { readerId: alice.id, senderId: bob.id };
			const stored = await path.insertMarkedUnread({ id, fromUserId: bob.id, text: 'hello', uri: `https://remote.test/chat/messages/${id}`, ...(room ? { toRoomId: room.id } : { toUserId: alice.id }) }, [mark]);
			await path.settleUnreadMarks(stored, [mark]);
			return id;
		}

		/** Holds the first call of a Redis script by its name, until released. */
		function holdScript(name: string) {
			let reached!: () => void;
			let release!: () => void;
			const waiting = new Promise<void>(resolve => { reached = resolve; });
			const gate = new Promise<void>(resolve => { release = resolve; });
			const evalRedis = redisClient.eval.bind(redisClient);
			let held = false;
			vi.spyOn(redisClient, 'eval').mockImplementation(async (...args) => {
				if (!held && String(args[0]).startsWith(`-- ${name}\n`)) {
					held = true;
					reached();
					await gate;
				}
				return evalRedis(...args);
			});
			return { waiting, release };
		}

		/** Holds the lookup of marked messages once it has its answer from PostgreSQL. */
		function holdLookup(service: ChatService) {
			let observed = false;
			let release!: () => void;
			const gate = new Promise<void>(resolve => { release = resolve; });
			const path = service as unknown as { newestVisibleUnread: (...args: unknown[]) => Promise<unknown> };
			const find = path.newestVisibleUnread.bind(service);
			vi.spyOn(path, 'newestVisibleUnread').mockImplementationOnce(async (...args) => {
				const found = await find(...args);
				observed = true;
				await gate;
				return found;
			});
			return { get observed() { return observed; }, release };
		}

		// 작성자의 FK 잠금으로 실제 INSERT를 기다리게 한다. 전송의 advisory 잠금과 pending 표식은 그대로 둔다.
		async function blockInsertFromAuthor() {
			const runner = (app.get(DI.db) as DataSource).createQueryRunner();
			await runner.connect();
			await runner.startTransaction();
			try {
				await runner.query('SELECT "id" FROM "user" WHERE "id" = $1 FOR UPDATE', [bob.id]);
			} catch (error) {
				await runner.rollbackTransaction();
				await runner.release();
				throw error;
			}
			return async () => {
				await runner.rollbackTransaction();
				await runner.release();
			};
		}

		async function createRoom() {
			const roomId = idService.gen();
			await chatRoomsRepository.insert({ id: roomId, name: 'unread storage', ownerId: bob.id });
			await chatRoomMembershipsRepository.insert({ id: idService.gen(), roomId, userId: alice.id });
			return chatRoomsRepository.findOneByOrFail({ id: roomId });
		}

		const directKey = () => `newUserChatMessageExists:${alice.id}:${bob.id}`;

		async function withdrawWithUnreadCleanupFailure(service: ChatService, id: string) {
			const message = await chatMessagesRepository.findOneByOrFail({ id });
			const cleanup = vi.spyOn(redisClient, 'eval').mockRejectedValueOnce(new Error('unread cleanup unavailable'));
			try {
				await service.deleteMessage(message);
			} finally {
				cleanup.mockRestore();
			}

			expect((await chatMessagesRepository.findOneByOrFail({ id })).deletedAt).not.toBeNull();
			expect(await redisClient.smembers(`${directKey()}:messages`)).toContain(id);
		}

		test('deletion preserves a new unread message arriving during the database lookup after earlier cleanup failed', async () => {
			const service = createService();
			const earlier = await send(service);
			const messageId = await send(service);
			await withdrawWithUnreadCleanupFailure(service, earlier);
			const message = await chatMessagesRepository.findOneByOrFail({ id: messageId });
			const lookup = holdLookup(service);

			const deleting = service.deleteMessage(message);
			try {
				await vi.waitFor(() => expect(lookup.observed).toBe(true), { timeout: 5000 });
				await send(service);
			} finally {
				lookup.release();
				await deleting;
			}

			expect(await service.hasUnreadMessages(alice.id)).toBe(true);
			expect(await service.getUserReadStateMap(alice.id, [bob.id])).toEqual({ [bob.id]: false });
		});

		test('a delayed INSERT between the saved boundaries survives the withdrawal query after earlier cleanup failed', async () => {
			const service = createService();
			const firstId = idService.gen();
			const middleId = idService.gen();
			const latestId = idService.gen();
			await send(service, firstId);
			await send(service, latestId);
			await withdrawWithUnreadCleanupFailure(service, firstId);
			const lookup = holdLookup(service);

			const deleting = service.deleteMessage(await chatMessagesRepository.findOneByOrFail({ id: latestId }));
			try {
				await vi.waitFor(() => expect(lookup.observed).toBe(true), { timeout: 5000 });
				await send(service, middleId);
			} finally {
				lookup.release();
				await deleting;
			}

			expect(await service.hasUnreadMessages(alice.id)).toBe(true);
			expect(await service.getUserReadStateMap(alice.id, [bob.id])).toEqual({ [bob.id]: false });
		});

		test('an orphan from an older read-all does not make read history unread again', async () => {
			const service = createService();
			const oldMessage = await createDirectMessage();
			// 이전 버전 전체 읽음 이후 개별 키만 남은 업그레이드 fixture다.
			await redisClient.set(directKey(), oldMessage);
			const latest = await send(service);

			await service.deleteMessage(await chatMessagesRepository.findOneByOrFail({ id: latest }));

			expect(await service.hasUnreadMessages(alice.id)).toBe(false);
			expect(await service.getUserReadStateMap(alice.id, [bob.id])).toEqual({ [bob.id]: true });
		});

		test('an active legacy mark stays unknown until explicitly read, then uses the new boundary', async () => {
			const service = createService();
			await redisClient.set(directKey(), await createDirectMessage());
			await redisClient.sadd(`newChatMessagesExists:${alice.id}`, `user:${bob.id}`);
			await send(service);
			expect(await redisClient.get(`${directKey()}:first`)).toBeNull();
			expect(await service.hasUnreadMessages(alice.id)).toBe(true);

			await service.readUserChatMessage(alice.id, bob.id);
			const next = await send(service);
			expect(await redisClient.get(`${directKey()}:first`)).toBe(next);
			await service.deleteMessage(await chatMessagesRepository.findOneByOrFail({ id: next }));
			expect(await service.hasUnreadMessages(alice.id)).toBe(false);
		});

		test('a legacy mark is not kept on by the reader’s own message', async () => {
			const service = createService();
			const only = await createDirectMessage();
			await chatMessagesRepository.insert({ id: idService.gen(), fromUserId: alice.id, toUserId: bob.id, text: 'reply' });
			await redisClient.set(directKey(), only);
			await redisClient.sadd(`newChatMessagesExists:${alice.id}`, `user:${bob.id}`);
			expect(await service.hasUnreadMessages(alice.id)).toBe(true);

			await service.deleteMessage(await chatMessagesRepository.findOneByOrFail({ id: only }));

			expect(await service.hasUnreadMessages(alice.id)).toBe(false);
		});

		test('a read that fetched a stored message before the send settled leaves it read', async () => {
			const service = createService();
			const settling = holdScript('settle chat unread');

			const sending = send(service);
			await settling.waiting;
			const [stored] = await chatMessagesRepository.findBy({ fromUserId: bob.id, toUserId: alice.id });
			try {
				await service.readUserChatMessage(alice.id, bob.id, { seenIds: [stored.id], upTo: null });
			} finally {
				settling.release();
				await sending;
			}

			expect(await service.hasUnreadMessages(alice.id)).toBe(false);
			expect(await redisClient.get(directKey())).toBeNull();
		});

		test('reads that did not return a message still being stored keep it unread, read-all included', async () => {
			const service = createService();
			const before = await send(service);
			const releaseInsert = await blockInsertFromAuthor();
			const id = idService.gen();

			const sending = send(service, id);
			try {
				await vi.waitFor(async () => expect(await redisClient.smembers(`${directKey()}:pending`)).toEqual([id]), { timeout: 5000 });
				expect(await chatMessagesRepository.existsBy({ id })).toBe(false);

				// 앞선 읽기는 저장 중인 쪽지를 받지 못했다. 그 경계 안의 다른 쪽지만 읽는다.
				await service.readUserChatMessage(alice.id, bob.id, { seenIds: [before], upTo: before });
				await service.readAllChatMessages(alice.id);

				expect(await redisClient.smembers(`${directKey()}:pending`)).toEqual([id]);
			} finally {
				await releaseInsert();
				await sending;
			}

			expect(await service.getUserReadStateMap(alice.id, [bob.id])).toEqual({ [bob.id]: false });
		});

		test('a read up to a received message keeps a newer one', async () => {
			const service = createService();
			const received = await send(service);
			const newer = await send(service);

			await service.readUserChatMessage(alice.id, bob.id, { seenIds: [], upTo: received });

			expect(await redisClient.smembers(`${directKey()}:messages`)).toEqual([newer]);
			expect(await service.hasUnreadMessages(alice.id)).toBe(true);
		});

		test('a member who muted the room while a message was being stored does not get it as unread', async () => {
			const service = createService();
			const room = await createRoom();
			const earlier = await send(service, idService.gen(), room);
			const storing = holdScript('settle chat unread');

			const sending = send(service, idService.gen(), room);
			await storing.waiting;
			try {
				await service.muteRoom(alice.id, room.id, true);
			} finally {
				storing.release();
				await sending;
			}

			// 뮤트 전에 받은 쪽지만 미읽음으로 남는다.
			expect(await redisClient.smembers(`newRoomChatMessageExists:${alice.id}:${room.id}:messages`)).toEqual([earlier]);
			await chatRoomsRepository.delete(room.id);
		});

		describe('a mark left by a send that never finished', () => {
			/** The INSERT fails, and so does every cleanup after it: the state a process that stopped mid-send leaves. */
			async function abandon(service: ChatService) {
				const id = idService.gen();
				const evalRedis = redisClient.eval.bind(redisClient);
				const cleanup = vi.spyOn(redisClient, 'eval').mockImplementation(async (...args) => {
					if (String(args[0]).startsWith('-- mark chat unread\n')) return evalRedis(...args);
					throw new Error('Redis gone with the process');
				});
				// 없는 작성자를 가리켜 실제 INSERT가 외래 키로 실패한다.
				const path = service as unknown as SendPath;
				await expect(path.insertMarkedUnread({ id, fromUserId: idService.gen(), toUserId: alice.id, text: 'never stored' }, [{ readerId: alice.id, senderId: bob.id }])).rejects.toThrow();
				cleanup.mockRestore();
				expect(await redisClient.smembers(`${directKey()}:pending`)).toEqual([id]);
				return id;
			}

			test('does not count, and the next read takes it back', async () => {
				const service = createService();
				await abandon(service);
				expect(await service.hasUnreadMessages(alice.id)).toBe(false);

				await service.readUserChatMessage(alice.id, bob.id);

				expect(await redisClient.sismember(`newChatMessagesExists:${alice.id}`, `user:${bob.id}`)).toBe(0);
				expect(await redisClient.exists(`${directKey()}:pending`)).toBe(0);
			});

			test('is kept while a send still holds the lock of that message, and taken back once it is released', async () => {
				const service = createService();
				const id = await abandon(service);
				let locked!: () => void;
				let release!: () => void;
				const holding = new Promise<void>(resolve => { locked = resolve; });
				const gate = new Promise<void>(resolve => { release = resolve; });
				const sender = (app.get(DI.db) as DataSource).transaction(async manager => {
					await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chat-message-send:${id}`]);
					locked();
					await gate;
				});
				await holding;
				try {
					await service.readAllChatMessages(alice.id);
					expect(await redisClient.smembers(`${directKey()}:pending`)).toEqual([id]);
				} finally {
					release();
					await sender;
				}

				await service.readAllChatMessages(alice.id);

				expect(await redisClient.exists(`${directKey()}:pending`)).toBe(0);
				expect(await redisClient.smembers(`newChatMessagesExists:${alice.id}`)).toEqual([]);
			});

			test('a later withdrawal still tells open screens', async () => {
				const service = createService();
				await abandon(service);
				const later = await send(service);
				const publishMainStream = vi.fn();
				(service as unknown as { globalEventService: { publishMainStream: typeof publishMainStream } }).globalEventService.publishMainStream = publishMainStream;

				await service.deleteMessage(await chatMessagesRepository.findOneByOrFail({ id: later }));

				expect(publishMainStream).toHaveBeenCalledWith(alice.id, 'chatUnread', { hasUnreadChatMessages: false, version: expect.any(Number) });
				expect(await redisClient.exists(`${directKey()}:pending`)).toBe(0);
			});

			test('recovers the pending mark after the process holding its PostgreSQL lock is killed', async () => {
				const service = createService();
				const id = await abandon(service);
				const config = app.get<Config>(DI.config);
				const child = fork(new URL('../misc/chat-send-lock-fixture.ts', import.meta.url), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
				const exited = once(child, 'exit');
				const locked = once(child, 'message', { signal: AbortSignal.timeout(10_000) });
				child.send({ database: { host: config.db.host, port: config.db.port, database: config.db.db, user: config.db.user, password: config.db.pass }, messageId: id } satisfies SendLockFixtureInput);
				try {
					expect((await locked)[0]).toEqual({ type: 'locked' });

					await service.readAllChatMessages(alice.id);

					expect(await redisClient.smembers(`${directKey()}:pending`)).toEqual([id]);
				} finally {
					child.kill('SIGKILL');
					expect(await exited).toEqual([null, 'SIGKILL']);
				}

				await vi.waitFor(async () => {
					await service.readAllChatMessages(alice.id);
					expect(await redisClient.exists(`${directKey()}:pending`)).toBe(0);
				}, { timeout: 10_000 });
				expect(await redisClient.smembers(`newChatMessagesExists:${alice.id}`)).toEqual([]);
				expect(await service.hasUnreadMessages(alice.id)).toBe(false);
			});
		});

		test.each(['withdrawal', 'suspension', 'membership removal', 'room deletion'] as const)('a mark settled after a completed %s does not come back', async cleanup => {
			const service = createService();
			const room = cleanup === 'membership removal' || cleanup === 'room deletion' ? await createRoom() : undefined;
			const key = room ? `newRoomChatMessageExists:${alice.id}:${room.id}` : directKey();
			const conversation = room ? `room:${room.id}` : `user:${bob.id}`;
			const messageId = idService.gen();
			const settling = holdScript('settle chat unread');

			const sending = send(service, messageId, room);
			await settling.waiting;
			try {
				if (cleanup === 'withdrawal') await service.deleteMessage(await chatMessagesRepository.findOneByOrFail({ id: messageId }));
				if (cleanup === 'suspension') {
					await usersRepository.update(bob.id, { isSuspended: true });
					await service.handleUserSuspended(await usersRepository.findOneByOrFail({ id: bob.id }));
				}
				if (cleanup === 'membership removal') expect(await service.removeRoomMember(room!, alice)).toBe(true);
				if (cleanup === 'room deletion') await service.deleteRoom(room!, undefined, { federate: false });
			} finally {
				settling.release();
				await sending;
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
