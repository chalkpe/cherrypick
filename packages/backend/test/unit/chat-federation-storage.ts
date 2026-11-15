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
import { ApChatRoomStateService } from '@/core/activitypub/ApChatRoomStateService.js';
import { ChatRoomNotificationService } from '@/core/ChatRoomNotificationService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { QueueService } from '@/core/QueueService.js';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { ChatService, ChatTooManyReactionsError } from '@/core/ChatService.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { IdService } from '@/core/IdService.js';
import { noChatInviteJoins } from '../misc/chat-roster-stub.js';
import { ChatMessageUriUnique1793708299161 } from '../../migration/1793708299161-chat-message-uri-unique.js';
import { MiChatRoomChannelSection } from '@/models/ChatRoomChannelSection.js';

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
			userBlockingService: { checkBlocked: vi.fn().mockResolvedValue(false) },
			config: { url: 'https://local.test' },
			db: app.get(DI.db),
			chatRoomChannelService: app.get(ChatRoomChannelService),
			chatRoomNotificationService: app.get(ChatRoomNotificationService),
			usersRepository,
			chatMessagesRepository,
			chatRoomsRepository,
			chatRoomMembershipsRepository,
			chatRoomInvitationsRepository: { findBy: async () => [] },
			redisClient,
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
				addContext: (activity: unknown) => activity,
			},
		}) as ChatService;
	}

	async function createUser(data: Partial<MiUser>) {
		const id = idService.gen();
		await usersRepository.insert({ id, username: id, usernameLower: id, ...data });
		return usersRepository.findOneByOrFail({ id });
	}

	async function createDirectMessage() {
		const id = idService.gen();
		await chatMessagesRepository.insert({ id, fromUserId: bob.id, toUserId: alice.id, text: 'hello', uri: `https://remote.test/chat/messages/${id}` });
		return id;
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule], providers: [IdService, ChatRoomChannelService, { provide: QueueService, useValue: {} }, ChatRoomNotificationService, GlobalEventService, { provide: FetchInstanceMetadataService, useValue: { chatRoomChannelsCapability: vi.fn(async () => false) } }] }).compile();
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
		await usersRepository.delete([alice.id, bob.id]);
	});

	afterAll(async () => {
		await app.close();
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

		test('채널 전환 목록을 동일 트랜잭션에서 적용하고 기존 메시지를 legacy 채널로 옮긴다', async () => {
			const room = await createMirrorRoom();
			const messageId = idService.gen();
			await chatMessagesRepository.insert({ id: messageId, fromUserId: bob.id, toRoomId: room.id, text: 'before conversion' });
			const generalUri = `${room.uri}/channels/same-number`;
			const service = createService();

			const applied = await service.updateRoom(room, {}, { federate: false, remoteUpdatedAt: newer, remoteGroup: { type: 'Group',
				_misskey_chatChannels: [{ id: generalUri, name: 'renamed general' }], _misskey_chatLegacyChannel: generalUri,
			} });

			expect(applied.hasChannels).toBe(true);
			const channels = await app.get(ChatRoomChannelService).list(room.id);
			expect(channels).toHaveLength(1);
			expect(channels[0].id).not.toBe('same-number');
			expect((await chatMessagesRepository.findOneByOrFail({ id: messageId })).toRoomChannelId).toBe(channels[0].id);
		});

		test('지연된 목록이나 잘못된 목록이 최신 채널을 삭제하지 않는다', async () => {
			const room = await createMirrorRoom();
			const uri = `${room.uri}/channels/general`;
			const service = createService();
			await service.updateRoom(room, {}, { federate: false, remoteUpdatedAt: newer, remoteGroup: { type: 'Group', _misskey_chatChannels: [{ id: uri, name: 'newest' }], _misskey_chatLegacyChannel: uri } });

			await service.updateRoom(room, {}, { federate: false, remoteUpdatedAt: older, remoteGroup: { type: 'Group', _misskey_chatChannels: [{ id: uri, name: 'old' }], _misskey_chatLegacyChannel: uri } });
			await service.updateRoom(room, {}, { federate: false, remoteUpdatedAt: new Date(newer.getTime() + 1000), remoteGroup: { type: 'Group', _misskey_chatChannels: [], _misskey_chatLegacyChannel: null } });
			await service.updateRoom(room, { name: 'unversioned' }, { federate: false });

			expect((await app.get(ChatRoomChannelService).list(room.id)).map(channel => channel.name)).toEqual(['newest']);
			expect((await chatRoomsRepository.findOneByOrFail({ id: room.id })).hasChannels).toBe(true);
		});

		test('원격 목록에서 삭제된 채널의 메시지는 삭제하고 다른 메시지의 참조 JSON은 보존한다', async () => {
			const room = await createMirrorRoom();
			const legacyUri = `${room.uri}/channels/general`;
			const otherUri = `${room.uri}/channels/other`;
			const service = createService();
			await service.updateRoom(room, {}, { federate: false, remoteUpdatedAt: older, remoteGroup: { type: 'Group', _misskey_chatChannels: [{ id: legacyUri, name: 'general' }, { id: otherUri, name: 'other' }], _misskey_chatLegacyChannel: legacyUri } });
			const channels = await app.get(ChatRoomChannelService).list(room.id);
			const general = channels.find(channel => channel.uri === legacyUri)!;
			const other = channels.find(channel => channel.uri === otherUri)!;
			const removedId = idService.gen();
			const preservedId = idService.gen();
			const refs = [{ channelId: other.id, uri: otherUri, start: 0, length: 2 }];
			await chatMessagesRepository.insert([
				{ id: removedId, fromUserId: bob.id, toRoomId: room.id, toRoomChannelId: other.id, text: 'removed' },
				{ id: preservedId, fromUserId: bob.id, toRoomId: room.id, toRoomChannelId: general.id, text: '#가', channelRefs: refs },
			]);

			await service.updateRoom(room, {}, { federate: false, remoteUpdatedAt: newer, remoteGroup: { type: 'Group', _misskey_chatChannels: [{ id: legacyUri, name: 'renamed' }], _misskey_chatLegacyChannel: legacyUri } });

			expect(await chatMessagesRepository.findOneBy({ id: removedId })).toBeNull();
			expect((await chatMessagesRepository.findOneByOrFail({ id: preservedId })).channelRefs).toEqual(refs);
		});

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

	describe('remote channel sections', () => {
		async function createMirrorRoom() {
			const id = idService.gen();
			await chatRoomsRepository.insert({ id, name: 'initial', ownerId: bob.id, description: '', uri: `https://remote.test/chat/rooms/${id}` });
			return chatRoomsRepository.findOneByOrFail({ id });
		}

		const newer = new Date('2026-11-03T00:00:10.000Z');
		const older = new Date('2026-11-03T00:00:05.000Z');

		function group(room: MiChatRoom, channels: { id: string; name: string }[], sections?: unknown) {
			return {
				type: 'Group',
				_misskey_chatChannels: channels,
				_misskey_chatLegacyChannel: channels[0]?.id ?? null,
				...(sections !== undefined ? { _misskey_chatChannelSections: sections } : {}),
			};
		}

		async function apply(room: MiChatRoom, object: unknown, at: Date) {
			return createService().updateRoom(room, {}, { federate: false, remoteUpdatedAt: at, remoteGroup: object as never });
		}

		async function storedSections(roomId: string): Promise<MiChatRoomChannelSection[]> {
			return app.get(DI.db).manager.find(MiChatRoomChannelSection, { where: { roomId }, order: { position: 'ASC' } });
		}

		test('유효한 섹션 목록은 지역 id로 저장하고 채널 순서를 표시 순서로 매긴다', async () => {
			const room = await createMirrorRoom();
			const c1 = `${room.uri}/channels/c1`;
			const c2 = `${room.uri}/channels/c2`;
			const c3 = `${room.uri}/channels/c3`;
			const s1 = `${room.uri}/sections/s1`;

			await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '공지' }, { id: c3, name: '자료' }], [
				{ id: s1, name: '운영', channels: [c2, c3] },
			]), newer);

			const sections = await storedSections(room.id);
			expect(sections).toHaveLength(1);
			expect(sections[0]).toMatchObject({ uri: s1, name: '운영', position: 0 });
			expect(sections[0].id).not.toBe('s1');
			const channels = await app.get(ChatRoomChannelService).list(room.id);
			expect(channels.map(channel => channel.uri)).toEqual([c1, c2, c3]);
			expect(channels.map(channel => channel.sectionId)).toEqual([null, sections[0].id, sections[0].id]);
			expect(channels.map(channel => channel.position)).toEqual([0, 1, 2]);
		});

		test('섹션 이름·순서는 URI로 같은 섹션을 찾아 바꾸고 목록에 없는 섹션은 지운다', async () => {
			const room = await createMirrorRoom();
			const c1 = `${room.uri}/channels/c1`;
			const c2 = `${room.uri}/channels/c2`;
			const c3 = `${room.uri}/channels/c3`;
			const s1 = `${room.uri}/sections/s1`;
			const s2 = `${room.uri}/sections/s2`;
			await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '가' }, { id: c3, name: '나' }], [
				{ id: s1, name: '첫째', channels: [c2] },
				{ id: s2, name: '둘째', channels: [c3] },
			]), older);
			const before = await storedSections(room.id);
			const firstId = before.find(section => section.uri === s1)!.id;

			await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '가' }, { id: c3, name: '나' }], [
				{ id: s2, name: '둘째 새 이름', channels: [c3] },
				{ id: s1, name: '첫째', channels: [] },
			]), newer);

			const sections = await storedSections(room.id);
			expect(sections.map(section => section.uri)).toEqual([s2, s1]);
			expect(sections.find(section => section.uri === s1)!.id).toBe(firstId);
			expect(sections.find(section => section.uri === s2)!.name).toBe('둘째 새 이름');
			const channels = await app.get(ChatRoomChannelService).list(room.id);
			expect(channels.map(channel => channel.uri)).toEqual([c1, c2, c3]);
			expect(channels.map(channel => channel.sectionId)).toEqual([null, null, sections[0].id]);
		});

		test('섹션이 사라지면 그 채널은 섹션 없는 채널로 남는다', async () => {
			const room = await createMirrorRoom();
			const c1 = `${room.uri}/channels/c1`;
			const c2 = `${room.uri}/channels/c2`;
			const s1 = `${room.uri}/sections/s1`;
			await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '가' }], [
				{ id: s1, name: '운영', channels: [c2] },
			]), older);

			await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '가' }], []), newer);

			expect(await storedSections(room.id)).toEqual([]);
			const channels = await app.get(ChatRoomChannelService).list(room.id);
			expect(channels.map(channel => channel.sectionId)).toEqual([null, null]);
			expect(channels.map(channel => channel.position)).toEqual([0, 1]);
		});

		test('섹션 키가 없으면 섹션을 건드리지 않고 채널 목록만 적용한다', async () => {
			const room = await createMirrorRoom();
			const c1 = `${room.uri}/channels/c1`;
			const c2 = `${room.uri}/channels/c2`;
			const s1 = `${room.uri}/sections/s1`;
			await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '가' }], [
				{ id: s1, name: '운영', channels: [c2] },
			]), older);
			const before = await storedSections(room.id);

			await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '나' }]), newer);

			const sections = await storedSections(room.id);
			expect(sections.map(section => section.id)).toEqual(before.map(section => section.id));
			const channels = await app.get(ChatRoomChannelService).list(room.id);
			expect(channels.map(channel => channel.name)).toEqual(['general', '나']);
			expect(channels.map(channel => channel.sectionId)).toEqual([null, sections[0].id]);
		});

		test('잘못된 섹션 필드는 지금 섹션을 유지한 채 채널 목록만 적용한다', async () => {
			const room = await createMirrorRoom();
			const c1 = `${room.uri}/channels/c1`;
			const c2 = `${room.uri}/channels/c2`;
			const s1 = `${room.uri}/sections/s1`;
			await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '가' }], [
				{ id: s1, name: '운영', channels: [c2] },
			]), older);
			const before = await storedSections(room.id);

			await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '나' }], [
				{ id: s1, name: '운영', channels: [c1, c2] },
				{ id: `${room.uri}/sections/s2`, name: '둘째', channels: [c2] },
			]), newer);

			const sections = await storedSections(room.id);
			expect(sections.map(section => section.id)).toEqual(before.map(section => section.id));
			const channels = await app.get(ChatRoomChannelService).list(room.id);
			expect(channels.map(channel => channel.name)).toEqual(['general', '나']);
			expect(channels.map(channel => channel.sectionId)).toEqual([null, sections[0].id]);
		});

		test('NUL 문자가 든 섹션 이름은 무시하고 함께 온 채널 목록만 적용한다', async () => {
		const room = await createMirrorRoom();
		const c1 = `${room.uri}/channels/c1`;
		const c2 = `${room.uri}/channels/c2`;
		const s1 = `${room.uri}/sections/s1`;
		await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '가' }], [
			{ id: s1, name: '운영', channels: [c2] },
		]), older);
		const before = await storedSections(room.id);

		await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '나' }], [
			{ id: s1, name: '운영\u0000', channels: [c2] },
		]), newer);

		const sections = await storedSections(room.id);
		expect(sections.map(section => section.id)).toEqual(before.map(section => section.id));
		expect(sections.map(section => section.name)).toEqual(['운영']);
		const channels = await app.get(ChatRoomChannelService).list(room.id);
		expect(channels.map(channel => channel.name)).toEqual(['general', '나']);
		expect(channels.map(channel => channel.sectionId)).toEqual([null, sections[0].id]);
	});

	test('NUL 문자가 든 섹션 URI는 무시하고 함께 온 채널 목록만 적용한다', async () => {
		const room = await createMirrorRoom();
		const c1 = `${room.uri}/channels/c1`;
		const c2 = `${room.uri}/channels/c2`;
		const s1 = `${room.uri}/sections/s1`;
		await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '가' }], [
			{ id: s1, name: '운영', channels: [c2] },
		]), older);
		const before = await storedSections(room.id);

		await apply(room, group(room, [{ id: c1, name: 'general' }, { id: c2, name: '다' }], [
			{ id: `${room.uri}/sections/s\u00002`, name: '둘째', channels: [c2] },
		]), newer);

		const sections = await storedSections(room.id);
		expect(sections.map(section => section.id)).toEqual(before.map(section => section.id));
		expect(sections.map(section => section.uri)).toEqual([s1]);
		const channels = await app.get(ChatRoomChannelService).list(room.id);
		expect(channels.map(channel => channel.name)).toEqual(['general', '다']);
		expect(channels.map(channel => channel.sectionId)).toEqual([null, sections[0].id]);
	});

	test('늦게 온 옛 판번호의 섹션 목록은 통째로 버린다', async () => {
			const room = await createMirrorRoom();
			const c1 = `${room.uri}/channels/c1`;
			const s1 = `${room.uri}/sections/s1`;
			await apply(room, group(room, [{ id: c1, name: 'general' }], [
				{ id: s1, name: '최신', channels: [] },
			]), newer);

			await apply(room, group(room, [{ id: c1, name: 'old' }], [
				{ id: `${room.uri}/sections/old`, name: '옛 섹션', channels: [c1] },
			]), older);

			const sections = await storedSections(room.id);
			expect(sections.map(section => section.name)).toEqual(['최신']);
			expect((await app.get(ChatRoomChannelService).list(room.id)).map(channel => channel.name)).toEqual(['general']);
		});

		test('같은 활동을 두 번 받아도 결과가 같다', async () => {
			const room = await createMirrorRoom();
			const c1 = `${room.uri}/channels/c1`;
			const c2 = `${room.uri}/channels/c2`;
			const s1 = `${room.uri}/sections/s1`;
			const object = group(room, [{ id: c1, name: 'general' }, { id: c2, name: '가' }], [
				{ id: s1, name: '운영', channels: [c2] },
			]);
			await apply(room, object, newer);
			const first = await storedSections(room.id);
			const firstChannels = await app.get(ChatRoomChannelService).list(room.id);

			await apply(room, object, newer);

			const second = await storedSections(room.id);
			const secondChannels = await app.get(ChatRoomChannelService).list(room.id);
			expect(second.map(section => section.id)).toEqual(first.map(section => section.id));
			expect(secondChannels.map(channel => [channel.id, channel.sectionId, channel.position])).toEqual(firstChannels.map(channel => [channel.id, channel.sectionId, channel.position]));
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
			const chatService = createService();
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
				chatService,
				apChatRoomStateService: Object.assign(Object.create(ApChatRoomStateService.prototype), { chatService }),
				chatInviteLinkService: noChatInviteJoins(),
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
