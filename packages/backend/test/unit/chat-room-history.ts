/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type * as Redis from 'ioredis';
import type { TestingModule } from '@nestjs/testing';
import { In } from 'typeorm';
import type { DataSource } from 'typeorm';
import type { ChatMessagesRepository, ChatRoomChannelsRepository, ChatRoomHistoryStatesRepository, ChatRoomMembershipsRepository, ChatRoomsRepository, MiChatRoom, MiUser, UsersRepository } from '@/models/_.js';
import { DeleteAccountProcessorService } from '@/queue/processors/DeleteAccountProcessorService.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { QueueService } from '@/core/QueueService.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomHistoryService } from '@/core/ChatRoomHistoryService.js';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import type { ChatHistoryImport } from '@/core/ChatRoomHistoryService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import { buildChatNote } from '@/core/activitypub/misc/chat-payloads.js';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { IdService } from '@/core/IdService.js';

const LOCAL = 'https://local.test';

// 저장과 조회가 PostgreSQL에서 실제로 어떻게 되는지 보는 시험이라 실제 DB와 Redis를 쓴다.
describe('그룹 과거 기록의 저장과 조회', () => {
	let app: TestingModule;
	let db: DataSource;
	let idService: IdService;
	let redisClient: Redis.Redis;
	let usersRepository: UsersRepository;
	let chatMessagesRepository: ChatMessagesRepository;
	let chatRoomsRepository: ChatRoomsRepository;
	let chatRoomMembershipsRepository: ChatRoomMembershipsRepository;
	let chatRoomChannelsRepository: ChatRoomChannelsRepository;
	let historyStatesRepository: ChatRoomHistoryStatesRepository;
	let owner: MiUser;
	let member: MiUser;
	let reactor: MiUser;
	const created: string[] = [];

	const publishChatRoomStream = vi.fn();
	const createChatRoomHistorySyncJob = vi.fn();

	function historyService() {
		return Object.assign(Object.create(ChatRoomHistoryService.prototype), {
			config: { url: LOCAL, host: new URL(LOCAL).host },
			redisClient,
			usersRepository,
			chatMessagesRepository,
			chatRoomMembershipsRepository,
			chatRoomHistoryStatesRepository: historyStatesRepository,
			emojisRepository: app.get(DI.emojisRepository),
			idService,
			queueService: { createChatRoomHistorySyncJob },
			globalEventService: { publishChatRoomStream },
			customEmojiService: { localEmojisCache: { fetch: async () => new Map() } },
			chatRoomChannelService: app.get(ChatRoomChannelService),
			apRendererService: {
				genLocalChatRoomUri: (id: string) => `${LOCAL}/chat/rooms/${id}`,
				renderChatHistoryNote: async (message: { id: string; text: string | null; uri: string | null }, authorUri: string, _emojis: unknown, toUsers: MiUser[], roomUri: string) =>
					buildChatNote(message, { id: '', host: null }, toUsers, undefined, { baseUrl: LOCAL, roomUri, authorUri, published: idService.parse(message.id).date.toISOString() }),
				renderEmoji: () => undefined,
				renderRemoteEmoji: () => undefined,
			},
		}) as ChatRoomHistoryService;
	}

	async function createUser(data: Partial<MiUser>) {
		const id = idService.gen();
		await usersRepository.insert({ id, username: `u${id}`, usernameLower: `u${id}`, ...data });
		created.push(id);
		return usersRepository.findOneByOrFail({ id });
	}

	async function createRoom(roomOwner: MiUser, uri: string | null = null) {
		const id = idService.gen();
		await chatRoomsRepository.insert({ id, name: 'room', ownerId: roomOwner.id, description: '', uri });
		return chatRoomsRepository.findOneByOrFail({ id });
	}

	async function insertMessage(room: MiChatRoom, from: MiUser | null, data: Record<string, unknown> = {}, time?: number) {
		const id = idService.gen(time);
		await chatMessagesRepository.insert({ id, fromUserId: from?.id ?? null, toRoomId: room.id, text: `text ${id}`, uri: `${LOCAL}/chat/messages/${id}`, ...data });
		return id;
	}

	function importInput(room: MiChatRoom, overrides: Partial<ChatHistoryImport> = {}): ChatHistoryImport {
		const n = idService.gen();
		const uri = `https://member.test/chat/messages/${n}`;
		return {
			uri,
			sourceUri: uri,
			authorUri: member.uri!,
			authorId: member.id,
			archivedAuthor: null,
			published: new Date('2025-01-01T00:00:00.000Z'),
			editedAt: null,
			text: 'imported',
			dice: null,
			fileIds: [],
			unavailableFileCount: 0,
			emojis: [],
			toRoomChannelId: null,
			channelRefs: [],
			reactions: [],
			...overrides,
		};
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule], providers: [IdService, ChatRoomChannelService, { provide: QueueService, useValue: {} }, { provide: FetchInstanceMetadataService, useValue: { chatRoomChannelsCapability: vi.fn(async () => false) } }] }).compile();
		await app.init();
		db = app.get(DI.db);
		idService = app.get(IdService);
		redisClient = app.get(DI.redis);
		usersRepository = app.get(DI.usersRepository);
		chatMessagesRepository = app.get(DI.chatMessagesRepository);
		chatRoomsRepository = app.get(DI.chatRoomsRepository);
		chatRoomMembershipsRepository = app.get(DI.chatRoomMembershipsRepository);
		chatRoomChannelsRepository = app.get(DI.chatRoomChannelsRepository);
		historyStatesRepository = app.get(DI.chatRoomHistoryStatesRepository);
	});

	beforeEach(async () => {
		vi.clearAllMocks();
		owner = await createUser({});
		member = await createUser({ host: 'member.test', uri: `https://member.test/users/${idService.gen()}`, inbox: 'https://member.test/inbox', name: '멤버' });
		reactor = await createUser({ host: 'third.test', uri: `https://third.test/users/${idService.gen()}`, inbox: 'https://third.test/inbox' });
	});

	afterEach(async () => {
		await chatRoomsRepository.delete({ ownerId: owner.id });
		await usersRepository.delete(created.splice(0));
	});

	afterAll(async () => {
		await app.close();
	});

	describe('소유 서버', () => {
		test('보관한 전체 기록을 최근 글부터 페이지로 나누고 다른 서버 작성 글은 원래 주소로 싣는다', async () => {
			const room = await createRoom(owner);
			await chatRoomMembershipsRepository.insert({ id: idService.gen(), roomId: room.id, userId: member.id });
			const ids: string[] = [];
			for (let i = 0; i < 21; i++) ids.push(await insertMessage(room, i % 2 === 0 ? owner : member, i % 2 === 0 ? {} : { uri: `https://member.test/chat/messages/m${i}` }, Date.parse('2026-01-01T00:00:00.000Z') + i * 1000));
			const service = historyService();

			const firstPage = await service.renderPage(room, member, null) as unknown as { orderedItems: { id: string; attributedTo: string; _misskey_chatAuthor?: unknown }[]; next?: string };
			const secondPage = await service.renderPage(room, member, firstPage.next!.split('until=')[1]) as unknown as typeof firstPage;

			expect(firstPage.orderedItems).toHaveLength(20);
			expect(firstPage.orderedItems[0]).toMatchObject({ id: `${LOCAL}/chat/messages/${ids[20]}`, attributedTo: `${LOCAL}/users/${owner.id}` });
			expect(firstPage.orderedItems[1]).toMatchObject({ id: 'https://member.test/chat/messages/m19', attributedTo: member.uri, _misskey_chatAuthor: { name: '멤버', username: member.username, host: 'member.test' } });
			expect(firstPage.orderedItems[1]).not.toHaveProperty('_misskey_chatAuthorArchived');
			expect(secondPage.orderedItems.map(item => item.id)).toEqual([`${LOCAL}/chat/messages/${ids[0]}`]);
			expect(secondPage.next).toBeUndefined();
		});

		test('삭제된 글과 정지된 작성자의 글은 내주지 않고 계정이 없어진 글은 보관한 작성자로 내준다', async () => {
			const room = await createRoom(owner);
			const suspended = await createUser({ host: 'member.test', uri: `https://member.test/users/${idService.gen()}`, isSuspended: true });
			await insertMessage(room, member, { deletedAt: new Date(), text: null });
			await insertMessage(room, suspended);
			await insertMessage(room, null, { archivedAuthor: { uri: `${LOCAL}/users/gone`, username: 'gone', name: '떠난 사람', host: null } });

			const page = await historyService().renderPage(room, member, null) as unknown as { orderedItems: Record<string, unknown>[] };

			expect(page.orderedItems).toHaveLength(1);
			expect(page.orderedItems[0]).toMatchObject({ attributedTo: `${LOCAL}/users/gone`, _misskey_chatAuthor: { username: 'gone', name: '떠난 사람', host: new URL(LOCAL).host }, _misskey_chatAuthorArchived: true });
		});

		test('채널을 지원하지 않는 서버에는 구버전용 기본 채널의 글만, 그 채널이 없으면 아무것도 주지 않는다', async () => {
			const room = await createRoom(owner);
			const legacy = idService.gen();
			const other = idService.gen();
			await chatRoomChannelsRepository.insert([{ id: legacy, roomId: room.id, name: 'general', position: 0 }, { id: other, roomId: room.id, name: 'other', position: 1 }]);
			await chatRoomsRepository.update(room.id, { hasChannels: true, legacyChannelId: legacy });
			// member.test는 채널을 지원하지 않는 서버다
			const inLegacy = await insertMessage(room, owner, { toRoomChannelId: legacy });
			await insertMessage(room, owner, { toRoomChannelId: other });
			const service = historyService();

			const legacyOnly = await service.renderPage(await chatRoomsRepository.findOneByOrFail({ id: room.id }), member, null) as unknown as { orderedItems: { id: string }[] };
			await chatRoomsRepository.update(room.id, { legacyChannelId: null });
			const none = await service.renderPage(await chatRoomsRepository.findOneByOrFail({ id: room.id }), member, null) as unknown as { orderedItems: unknown[] };

			expect(legacyOnly.orderedItems.map(item => item.id)).toEqual([`${LOCAL}/chat/messages/${inLegacy}`]);
			expect(none.orderedItems).toEqual([]);
		});

		test('리액션은 누른 계정의 주소로 싣고 정지된 계정의 리액션은 뺀다', async () => {
			const room = await createRoom(owner);
			const suspended = await createUser({ host: 'third.test', uri: `https://third.test/users/${idService.gen()}`, isSuspended: true });
			await insertMessage(room, member, { reactions: [`${reactor.id}/👍`, `${suspended.id}/🎉`, `${owner.id}/❤`] });

			const page = await historyService().renderPage(room, member, null) as unknown as { orderedItems: { _misskey_chatReactions: unknown }[] };

			expect(page.orderedItems[0]._misskey_chatReactions).toEqual([
				{ actor: reactor.uri, reaction: '👍' },
				{ actor: `${LOCAL}/users/${owner.id}`, reaction: '❤' },
			]);
		});
	});

	describe('받는 서버', () => {
		async function mirrorRoom() {
			const remoteOwner = await createUser({ host: 'owner.test', uri: `https://owner.test/users/${idService.gen()}` });
			const id = idService.gen();
			await chatRoomsRepository.insert({ id, name: 'mirror', ownerId: remoteOwner.id, description: '', uri: `https://owner.test/chat/rooms/${id}` });
			await chatRoomMembershipsRepository.insert({ id: idService.gen(), roomId: id, userId: owner.id });
			return { room: await chatRoomsRepository.findOneByOrFail({ id }), remoteOwner };
		}

		afterEach(async () => {
			await chatRoomsRepository.createQueryBuilder().delete().where('uri LIKE :uri', { uri: 'https://owner.test/%' }).execute();
		});

		test('작성 시각으로 ID를 만들어 기존 글보다 앞에 놓고, 미읽음 표시와 실시간 이벤트를 만들지 않는다', async () => {
			const { room } = await mirrorRoom();
			const live = await insertMessage(room, member);
			const service = historyService();

			const stored = await service.importMessage(room, importInput(room));

			expect(stored).not.toBeNull();
			expect(stored!.id < live).toBe(true);
			expect(idService.parse(stored!.id).date.toISOString()).toBe('2025-01-01T00:00:00.000Z');
			expect(stored!.importedAt).toBeInstanceOf(Date);
			expect(publishChatRoomStream).not.toHaveBeenCalled();
			expect(await redisClient.get(`newRoomChatMessageExists:${owner.id}:${room.id}`)).toBeNull();
			expect(await redisClient.sismember(`newChatMessagesExists:${owner.id}`, `room:${room.id}`)).toBe(0);
		});

		test('이미 있는 글과 삭제 표시는 소유 서버가 다른 내용을 내줘도 바꾸거나 되살리지 않는다', async () => {
			const { room } = await mirrorRoom();
			const uri = 'https://member.test/chat/messages/kept';
			const deletedUri = 'https://member.test/chat/messages/deleted';
			await insertMessage(room, member, { uri, text: 'original', reactions: [`${reactor.id}/👍`] });
			await insertMessage(room, member, { uri: deletedUri, text: null, deletedAt: new Date() });
			const service = historyService();

			expect(await service.importMessage(room, importInput(room, { uri, text: 'forged', reactions: [] }))).toBeNull();
			expect(await service.importMessage(room, importInput(room, { uri: deletedUri, text: 'back again' }))).toBeNull();

			expect(await chatMessagesRepository.findOneByOrFail({ uri })).toMatchObject({ text: 'original', reactions: [`${reactor.id}/👍`] });
			expect(await chatMessagesRepository.findOneByOrFail({ uri: deletedUri })).toMatchObject({ text: null, deletedAt: expect.any(Date) });
		});

		test('삭제가 먼저 도착한 글은 저장하지 않는다', async () => {
			const { room } = await mirrorRoom();
			const input = importInput(room);
			await redisClient.setex(`chat_delete_upon_arrival:${input.uri}:${encodeURIComponent(input.authorUri)}`, 60, input.authorUri);
			const relayed = importInput(room);
			await redisClient.setex(`chat_delete_upon_arrival:${relayed.uri}:${encodeURIComponent(relayed.authorUri)}:room:${room.id}`, 60, relayed.authorUri);

			expect(await historyService().importMessage(room, input)).toBeNull();
			expect(await historyService().importMessage(room, relayed)).toBeNull();
			expect(await chatMessagesRepository.existsBy({ uri: In([input.uri, relayed.uri]) })).toBe(false);
		});

		describe('보관 사본', () => {
			const sourceUri = 'https://member.test/chat/messages/source';
			const copyUriOf = (roomId: string) => `${LOCAL}/chat/history/${createHash('sha256').update(`${roomId}\n${sourceUri}`).digest('hex').slice(0, 32)}`;

			test('원래 URI로 삭제가 먼저 도착했으면 사본은 저장하지 않는다', async () => {
				const { room } = await mirrorRoom();
				await redisClient.setex(`chat_delete_upon_arrival:${sourceUri}:${encodeURIComponent(member.uri!)}`, 60, member.uri!);

				expect(await historyService().importMessage(room, importInput(room, { uri: copyUriOf(room.id), sourceUri }))).toBeNull();
				expect(await chatMessagesRepository.existsBy({ uri: copyUriOf(room.id) })).toBe(false);
			});

			test('원래 URI로 이미 저장된 글이 있으면 사본은 저장하지 않는다', async () => {
				const { room } = await mirrorRoom();
				await insertMessage(room, member, { uri: sourceUri, text: 'original' });

				expect(await historyService().importMessage(room, importInput(room, { uri: copyUriOf(room.id), sourceUri }))).toBeNull();
				expect(await chatMessagesRepository.findOneByOrFail({ uri: sourceUri })).toMatchObject({ text: 'original' });
			});

			test('사본은 사본 URI로 저장하고 원래 URI의 실시간 수신을 막지 않는다', async () => {
				const { room } = await mirrorRoom();
				const service = historyService();

				const stored = await service.importMessage(room, importInput(room, { uri: copyUriOf(room.id), sourceUri, authorId: null, archivedAuthor: { uri: member.uri!, username: member.username, name: member.name, host: 'member.test' } }));

				expect(stored).toMatchObject({ uri: copyUriOf(room.id), fromUserId: null });
				const live = await service.importMessage(room, importInput(room, { uri: sourceUri, sourceUri }));
				expect(live).toMatchObject({ uri: sourceUri, fromUserId: member.id });
			});
		});

		test('리액션은 중복 없이 메시지당 한도까지만 저장한다', async () => {
			const { room } = await mirrorRoom();
			const reactions = [`${reactor.id}/👍`, `${reactor.id}/👍`, ...Array.from({ length: 150 }, (_, i) => `user${i}/👍`)];

			const stored = await historyService().importMessage(room, importInput(room, { reactions }));

			expect(stored!.reactions).toHaveLength(100);
			expect(stored!.reactions.filter(pair => pair === `${reactor.id}/👍`)).toHaveLength(1);
		});

		test('계정을 확인할 수 없는 작성자의 글은 보관한 작성자 정보로 저장한다', async () => {
			const { room } = await mirrorRoom();

			const stored = await historyService().importMessage(room, importInput(room, { authorId: null, archivedAuthor: { uri: 'https://member.test/users/gone', username: 'gone', name: null, host: 'member.test' }, unavailableFileCount: 1 }));

			expect(await chatMessagesRepository.findOneByOrFail({ id: stored!.id })).toMatchObject({ fromUserId: null, archivedAuthor: { username: 'gone', host: 'member.test' }, unavailableFileCount: 1 });
		});

		test('참여하면 처음부터 다시 받고, 열람은 멈춘 곳부터 이어 받으며 앞선 차례의 진행은 반영되지 않는다', async () => {
			const { room } = await mirrorRoom();
			const service = historyService();

			await service.requestImport(room, { restart: true });
			const firstPass = (await service.getState(room.id))!;
			await service.advance(room.id, firstPass.pass, `${room.uri}/history?until=a`);
			await service.markUnavailable(room.id, firstPass.pass);
			await redisClient.del(`chat_room_history_request:${room.id}`);
			await service.requestImport(room, { restart: false });
			const resumed = (await service.getState(room.id))!;
			await service.requestImport(room, { restart: true });
			const restarted = (await service.getState(room.id))!;

			expect(resumed).toMatchObject({ status: 'running', nextUri: `${room.uri}/history?until=a`, pass: firstPass.pass });
			expect(restarted).toMatchObject({ status: 'running', nextUri: null, pass: firstPass.pass + 1 });
			expect(await service.advance(room.id, firstPass.pass, `${room.uri}/history?until=b`)).toBe(false);
			expect(await service.advance(room.id, restarted.pass, null)).toBe(true);
			expect(await service.getState(room.id)).toMatchObject({ status: 'completed', completedAt: expect.any(Date) });
			expect(publishChatRoomStream).toHaveBeenCalledWith(room.id, 'historyImported', { status: 'completed' });
			expect(createChatRoomHistorySyncJob).toHaveBeenCalledTimes(3);
		});

		test('이 서버가 소유한 그룹에는 가져오기를 요청하지 않는다', async () => {
			const room = await createRoom(owner);

			await historyService().requestImport(room, { restart: true });

			expect(await historyStatesRepository.existsBy({ roomId: room.id })).toBe(false);
			expect(createChatRoomHistorySyncJob).not.toHaveBeenCalled();
		});
	});

	test('파일 삭제 후 남은 그룹 아이콘을 찾아 복구 작업을 접수한다', async () => {
		const room = await createRoom(owner);
		await chatRoomsRepository.update(room.id, { iconFileId: 'deleted-file' });
		const enqueue = vi.fn();
		const chat = Object.assign(Object.create(ChatService.prototype), {
			chatRoomsRepository,
			queueService: { createChatRoomIconDeletedJob: enqueue },
		}) as ChatService;

		await chat.enqueueMissingRoomIcons('deleted-file');

		expect(enqueue).toHaveBeenCalledWith(room.id, 'deleted-file');
	});

	describe('작성자 계정 삭제', () => {
		// 실제 계정 삭제 작업(DeleteAccountProcessorService)을 실행한다. 파일·노트·페이지가 없는 계정이라 그 정리 서비스는 불리지 않는다
		function deleteAccountProcessor() {
			return Object.assign(Object.create(DeleteAccountProcessorService.prototype), {
				logger: { info: vi.fn(), succ: vi.fn() },
				db,
				usersRepository,
				userProfilesRepository: app.get(DI.userProfilesRepository),
				notesRepository: app.get(DI.notesRepository),
				driveFilesRepository: app.get(DI.driveFilesRepository),
				pagesRepository: app.get(DI.pagesRepository),
				userEntityService: { isRemoteUser: (user: MiUser) => user.host != null },
				searchService: { unindexNote: vi.fn() },
				emailService: { sendEmail: vi.fn() },
				globalEventService: { publishInternalEvent: vi.fn() },
				chatRoomHistoryService: historyService(),
			}) as DeleteAccountProcessorService;
		}

		async function createUserWithProfile(data: Partial<MiUser>) {
			const user = await createUser(data);
			await app.get(DI.userProfilesRepository).insert({ userId: user.id });
			return user;
		}

		test('사용자 행 삭제 시 기록한 그룹 글은 남고 일대일 메시지는 지워진다', async () => {
			const room = await createRoom(owner);
			const author = await createUserWithProfile({ name: '떠나는 사람' });
			const inRoom = await insertMessage(room, author, { archivedAuthor: { uri: `${LOCAL}/users/${author.id}`, username: author.username, name: author.name, host: null } });
			const direct = idService.gen();
			await chatMessagesRepository.insert({ id: direct, fromUserId: author.id, directFromUserId: author.id, toUserId: owner.id, text: 'direct' });

			await usersRepository.delete(author.id);

			expect(await chatMessagesRepository.findOneBy({ id: inRoom })).toMatchObject({ fromUserId: null, archivedAuthor: { uri: `${LOCAL}/users/${author.id}` } });
			expect(await chatMessagesRepository.existsBy({ id: direct })).toBe(false);
		});

		test('계정을 지우면 그룹 메시지는 보관한 작성자로 남고 일대일 메시지는 기존대로 함께 지워진다', async () => {
			const room = await createRoom(owner);
			const leaving = await createUserWithProfile({ name: '떠나는 사람' });
			const inRoom = await insertMessage(room, leaving, { archivedAuthor: { uri: `${LOCAL}/users/${leaving.id}`, username: leaving.username, name: leaving.name, host: leaving.host } });
			const direct = idService.gen();
			const received = idService.gen();
			await chatMessagesRepository.insert([
				{ id: direct, fromUserId: leaving.id, directFromUserId: leaving.id, toUserId: owner.id, text: 'direct' },
				{ id: received, fromUserId: owner.id, toUserId: leaving.id, text: 'received' },
			]);

			await deleteAccountProcessor().process({ data: { user: { id: leaving.id, host: null }, soft: false } } as never);

			expect(await usersRepository.existsBy({ id: leaving.id })).toBe(false);
			expect(await chatMessagesRepository.findOneByOrFail({ id: inRoom })).toMatchObject({
				fromUserId: null,
				archivedAuthor: { uri: `${LOCAL}/users/${leaving.id}`, username: leaving.username, name: '떠나는 사람', host: null },
			});
			expect(await chatMessagesRepository.existsBy({ id: In([direct, received]) })).toBe(false);
		});

		test('원격 계정의 삭제는 기존대로 계정 행을 남기므로 메시지도 그대로 남는다', async () => {
			const room = await createRoom(owner);
			const remote = await createUserWithProfile({ host: 'member.test', uri: `https://member.test/users/${idService.gen()}` });
			const inRoom = await insertMessage(room, remote);
			const direct = idService.gen();
			await chatMessagesRepository.insert({ id: direct, fromUserId: remote.id, toUserId: owner.id, text: 'direct' });

			await deleteAccountProcessor().process({ data: { user: { id: remote.id, host: remote.host }, soft: true } } as never);

			expect(await chatMessagesRepository.findOneByOrFail({ id: inRoom })).toMatchObject({ fromUserId: remote.id, archivedAuthor: null });
			expect(await chatMessagesRepository.existsBy({ id: direct })).toBe(true);
		});

		test('응답에는 계정 대신 보관한 작성자 정보를 싣고, 지워진 원격 계정도 프로필로 내주지 않는다', async () => {
			const room = await createRoom(owner);
			const orphan = await insertMessage(room, null, { archivedAuthor: { uri: 'https://member.test/users/gone', username: 'gone', name: '떠난 사람', host: 'member.test' } });
			const deletedAccount = await createUser({ host: 'member.test', uri: `https://member.test/users/${idService.gen()}`, name: '지운 계정', isDeleted: true });
			const fromDeleted = await insertMessage(room, deletedAccount);
			const live = await insertMessage(room, member);
			const entity = Object.assign(Object.create(ChatEntityService.prototype), {
				chatMessagesRepository,
				usersRepository,
				chatRoomChannelsRepository,
				idService,
				userEntityService: { pack: async (user: MiUser | string) => ({ id: typeof user === 'string' ? user : user.id }), packMany: async (users: (MiUser | string)[]) => users.map(user => ({ id: typeof user === 'string' ? user : user.id })) },
				driveFileEntityService: { packManyByIdsMap: async () => new Map() },
				customEmojiService: { populateEmojis: async () => ({}) },
			}) as ChatEntityService;

			const packed = await entity.packMessagesLiteForRoom(await chatMessagesRepository.findBy({ id: In([orphan, fromDeleted, live]) }));
			const byId = new Map(packed.map(message => [message.id, message]));

			expect(byId.get(orphan)).toMatchObject({ fromUserId: null, fromUser: null, archivedAuthor: { name: '떠난 사람', username: 'gone', host: 'member.test' } });
			expect(byId.get(fromDeleted)).toMatchObject({ fromUser: null, archivedAuthor: { name: '지운 계정', host: 'member.test' } });
			expect(byId.get(live)).toMatchObject({ fromUser: { id: member.id }, archivedAuthor: null });
		});
	});
});
