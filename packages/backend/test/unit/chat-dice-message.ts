/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { notificationServiceOver } from '../misc/chat-room-notification-fixture.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import jsonld from 'jsonld';
import { ChatService, ChatMessageAccessError } from '@/core/ChatService.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import CreateToUser, { meta as userMeta } from '@/server/api/endpoints/chat/messages/create-to-user.js';
import CreateToRoom, { meta as roomMeta } from '@/server/api/endpoints/chat/messages/create-to-room.js';
import { ChatDiceError } from '@/core/chat-dice.js';
import type { ChatDiceResult } from '@/core/chat-dice.js';
import type { MiChatMessage, MiUser } from '@/models/_.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { buildChatNote } from '@/core/activitypub/misc/chat-payloads.js';
import { CONTEXT, PRELOADED_CONTEXTS } from '@/core/activitypub/misc/contexts.js';

const dice: ChatDiceResult = { version: 1, engine: '@dice-roller/rpg-dice-roller', engineVersion: '5.5.1', notation: '1d6', total: 4, output: '1d6: [4] = 4' };
const sender = { id: 'sender', host: null };
const recipient = { id: 'recipient', host: null };
const room = { id: 'room', ownerId: sender.id, isArchived: false };

afterEach(() => vi.useRealTimers());

function fixture() {
	vi.useFakeTimers();
	const rows: MiChatMessage[] = [];
	const repository = {
		insertOne: vi.fn(async (value: object) => {
			const message = { deletedAt: null, reactions: [], fileIds: [], toUserId: null, toRoomId: null, dice: null, ...value } as unknown as MiChatMessage;
			rows.push(message);
			return message;
		}),
		findOneBy: vi.fn(async () => rows[0] ?? null),
		update: vi.fn(async (_query: unknown, patch: object) => { Object.assign(rows[0], patch); return { affected: 1 }; }),
	};
	const entity = Object.assign(Object.create(ChatEntityService.prototype), {
		chatMessagesRepository: repository,
		usersRepository: { findOneBy: vi.fn(async () => sender) },
		idService: { parse: () => ({ date: new Date('2026-11-11T00:00:00Z') }) },
		userEntityService: { pack: vi.fn(async (id: string) => ({ id })) },
		driveFileEntityService: { packManyByIdsMap: vi.fn(async () => new Map()) },
	}) as ChatEntityService;
	const stream = { publishChatUserStream: vi.fn(), publishChatRoomStream: vi.fn() };
	const roll = vi.fn(async (_id: string, notation: string) => ({ ...dice, notation }));
	const pipeline = { set: vi.fn(), sadd: vi.fn(), exec: vi.fn() };
	const dependencies = {
		config: { url: 'https://local.test' },
		chatRoomChannelService: Object.assign(Object.create(ChatRoomChannelService.prototype), { db: { manager: {} } }),
		db: { transaction: async (run: (manager: unknown) => Promise<unknown>) => run({ findOne: async () => room, findBy: async () => [], withRepository: (repository: unknown) => repository }) },
		chatMessagesRepository: repository,
		chatEntityService: entity,
		chatDiceService: { roll },
		chatRoomMembershipsRepository: { findBy: vi.fn(async () => []), findOneBy: vi.fn() },
		chatRoomsRepository: { findOneBy: vi.fn() },
		usersRepository: { findOneBy: vi.fn(async () => sender), findOneByOrFail: vi.fn(async () => sender), findBy: vi.fn(async () => [sender, recipient]) },
		idService: { gen: () => 'message' },
		redisClient: { pipeline: () => pipeline },
		globalEventService: stream,
		userEntityService: { isLocalUser: (u: { host: string | null }) => u.host == null, isRemoteUser: (u: { host: string | null }) => u.host != null },
		assertCanSendToUser: vi.fn(async () => ({ iApprovedOther: true })),
		assertRemoteWriteAllowed: vi.fn(),
		checkChatAvailability: vi.fn(),
		findOwnFilesForMessage: vi.fn(async () => []),
		findRoomById: vi.fn(async () => room),
		isRoomMember: vi.fn(async () => true),
		userBlockingService: { checkBlocked: vi.fn(async () => false) },
		queueService: { deliver: vi.fn() },
		apRendererService: { renderChatDelete: vi.fn(), renderChatUpdate: vi.fn(), addContext: (value: unknown) => value },
		customEmojiService: { populateEmojis: vi.fn(async () => ({})) },
	};
	const service = Object.create(ChatService.prototype) as ChatService;
	for (const [key, value] of Object.entries(dependencies)) Object.defineProperty(service, key, { value, writable: true, configurable: true });
	Object.assign(service, { chatRoomNotificationService: notificationServiceOver(service) });
	const send = (text: string, group = false, extra: object = {}) => group
		? new CreateToRoom({} as never, service).exec({ toRoomId: room.id, text, ...extra }, sender as never, null, null)
		: new CreateToUser({ getUser: async () => recipient } as never, service).exec({ toUserId: recipient.id, text, ...extra }, sender as never, null, null);
	return { service, entity, repository, rows, roll, stream, send };
}

describe('local dice API to storage and stream (repository doubles)', () => {
	test('assigns distinct error identifiers to each creation endpoint', () => {
		const errors = [userMeta, roomMeta].flatMap(meta => Object.values(meta.errors).filter(error => error.code.startsWith('DICE_')));

		expect(errors).toHaveLength(6);
		expect(new Set(errors.map(error => error.id)).size).toBe(6);
	});
	test.each([false, true])('creates one default roll and packs the saved result, group=%s', async group => {
		const f = fixture();

		const created = await f.send('/dice', group, { dice: { ...dice, total: 999 }, _misskey_dice: dice });

		expect(created).toMatchObject({ text: '/dice', dice });
		expect(f.roll).toHaveBeenCalledExactlyOnceWith(sender.id, '1d6');
		expect(f.rows[0].dice).toEqual(dice);
		const again = await f.entity.packMessageLiteFor1on1(f.rows[0]);
		expect(again.dice).toEqual(dice);
		expect(f.roll).toHaveBeenCalledTimes(1);
		const events = group ? f.stream.publishChatRoomStream : f.stream.publishChatUserStream;
		expect(events.mock.calls[0].at(-1)).toMatchObject({ dice });
	});
	test('passes a native complex expression unchanged', async () => {
		const f = fixture();
		await f.send('/dice 2d20kh1+1d4');

		expect(f.roll).toHaveBeenCalledExactlyOnceWith(sender.id, '2d20kh1+1d4');
	});
	test.each(['hello', '/dicefoo', '$(x2 /dice)', '<b>1d6: [6] = 6</b>'])('does not trust injected result on normal text %s', async text => {
		const f = fixture();
		const created = await f.send(text, false, { dice, _misskey_dice: dice });

		expect(created.dice).toBeNull();
		expect(f.roll).not.toHaveBeenCalled();
	});
	test('does not roll for blocked recipient', async () => {
		const f = fixture();
		vi.spyOn(f.service, 'assertCanSendToUser').mockRejectedValue(new ChatMessageAccessError('blocked'));

		await expect(f.send('/dice')).rejects.toMatchObject({ code: 'CANNOT_CHAT_WITH_USER' });
		expect(f.roll).not.toHaveBeenCalled();
	});
	test('does not roll for a missing attachment', async () => {
		const f = fixture();
		vi.spyOn(f.service, 'findOwnFilesForMessage').mockResolvedValue(null);

		await expect(f.send('/dice', false, { fileIds: ['file'] })).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
		expect(f.roll).not.toHaveBeenCalled();
	});
	test('does not roll for a nonmember or archived room', async () => {
		const f = fixture();
		vi.spyOn(f.service, 'isRoomMember').mockResolvedValue(false);
		await expect(f.send('/dice', true)).rejects.toMatchObject({ code: 'NO_SUCH_ROOM' });
		expect(f.roll).not.toHaveBeenCalled();

		await expect(f.service.createMessageToRoom(sender, { ...room, isArchived: true } as never, { text: '/dice' })).rejects.toThrow('archived');
		expect(f.roll).not.toHaveBeenCalled();
	});
	test.each(['invalid', 'limit', 'busy'] as const)('fails without storing a partial result on %s', async reason => {
		const f = fixture();
		f.roll.mockRejectedValue(new ChatDiceError(reason));

		await expect(f.send('/dice')).rejects.toMatchObject({ code: `DICE_${reason.toUpperCase()}` });
		expect(f.repository.insertOne).not.toHaveBeenCalled();
	});
	test('rejects local and remote edits of a dice message', async () => {
		const f = fixture();
		await f.send('/dice');

		await expect(f.service.updateMessage(sender.id, 'message', '/dice 1d20')).rejects.toThrow();
		await expect(f.service.updateRemoteMessage(sender as MiUser, f.rows[0], 'replacement', new Date())).rejects.toThrow();
		expect(f.rows[0]).toMatchObject({ text: '/dice', dice });
		expect(f.repository.update).not.toHaveBeenCalled();
	});
	test('editing an ordinary message to a command never rolls', async () => {
		const f = fixture();
		await f.send('ordinary');

		await f.service.updateMessage(sender.id, 'message', '/dice');

		expect(f.rows[0]).toMatchObject({ text: '/dice', dice: null });
		expect(f.roll).not.toHaveBeenCalled();
	});
	test('an authored delete clears the stored result with the text', async () => {
		const f = fixture();
		await f.send('/dice');

		await f.service.deleteMessage(f.rows[0]);

		expect(f.rows[0]).toMatchObject({ text: null, dice: null });
		expect(f.rows[0].deletedAt).toBeInstanceOf(Date);
	});
	test('tombstones hide saved dice from all message packers', async () => {
		const f = fixture();
		await f.send('/dice');
		f.rows[0].deletedAt = new Date();

		for (const method of ['packMessageDetailed', 'packMessageLiteFor1on1', 'packMessageLiteForRoom'] as const) {
			const packed = await f.entity[method](f.rows[0]);
			expect(packed).toMatchObject({ text: null, dice: null });
		}
	});
});

describe('dice federation', () => {
	test('retains the result as JSON through the existing JSON-LD context', async () => {
		const note = buildChatNote({ id: 'm1', text: '/dice', dice }, sender, [recipient], undefined, { baseUrl: 'https://local.test' });
		const expanded = await jsonld.expand({ '@context': CONTEXT, ...note } as never, {
			documentLoader: async (url: string) => ({ documentUrl: url, document: PRELOADED_CONTEXTS[url] }),
		});

		expect(expanded[0]['https://misskey-hub.net/ns#_misskey_dice']).toEqual([{ '@type': '@json', '@value': dice }]);
	});
	test('keeps Note identity, original command, room context and exact stored dice', () => {
		const note = buildChatNote({ id: 'm1', text: '/dice', dice }, sender, [recipient], 'room', { baseUrl: 'https://local.test' });

		expect(note).toMatchObject({ id: 'https://local.test/chat/messages/m1', _misskey_talk: true, _misskey_content: '/dice', context: 'https://local.test/chat/rooms/room', _misskey_chatRoom: 'https://local.test/chat/rooms/room', _misskey_dice: dice });
	});
	test.each([undefined, { ...dice, version: 99 }, { ...dice, output: { deep: [] } }, { ...dice, output: 'bad\0text' }])('does not emit an unsupported result %j', value => {
		const note = buildChatNote({ id: 'm1', text: '/dice', dice: value } as never, sender, [], undefined, { baseUrl: 'https://local.test' });

		expect(note).not.toHaveProperty('_misskey_dice');
		expect(note._misskey_content).toBe('/dice');
	});
	test.each([dice, { ...dice, version: 2 }, { ...dice, total: Infinity }, { ...dice, output: 'bad\0text' }, { ...dice, notation: '\ud800' }, undefined])('remote creation saves valid extension only and never executes its text %j', async value => {
		const f = fixture();
		const remote = { id: 'remote', host: 'remote.test' };

		const created = await f.service.createMessageToUser(remote, recipient as MiUser, { text: '/dice', dice: value });

		expect(created.text).toBe('/dice');
		expect(created.dice).toEqual(value === dice ? dice : null);
		expect(f.roll).not.toHaveBeenCalled();
	});
	test.each([false, true])('inbox preserves the extension through the authorized create path, group=%s', async group => {
		const f = incoming();
		const note = f.note({ _misskey_dice: dice, ...(group ? { context: f.room.uri } : {}) });

		await expect(f.receive(note)).resolves.toBe('ok');

		const create = group ? f.chatService.createMessageToRoom : f.chatService.createMessageToUser;
		expect(create).toHaveBeenCalledWith(f.actor, group ? f.room : f.local, expect.objectContaining({ text: '/dice', dice }));
	});
	test('duplicate delivery never creates another result', async () => {
		const f = incoming();
		f.repository.findOneBy.mockResolvedValue({ id: 'stored', fromUserId: f.actor.id, uri: f.note().id, dice } as never);

		await f.receive(f.note({ _misskey_dice: { ...dice, total: 999 } }));

		expect(f.chatService.createMessageToUser).not.toHaveBeenCalled();
	});
});

function incoming() {
	const actor = { id: 'remote', uri: 'https://remote.test/users/remote', host: 'remote.test', isSuspended: false };
	const local = { id: 'local', uri: 'https://local.test/users/local', host: null };
	const remoteRoom = { id: 'room', uri: 'https://remote.test/chat/rooms/room', ownerId: actor.id };
	const chatService = {
		findMessageByUri: vi.fn(async () => null),
		applyPendingChatReactions: vi.fn(),
		assertCanSendToUser: vi.fn(),
		assertRemoteWriteAllowed: vi.fn(),
		createMessageToUser: vi.fn(),
		createMessageToRoom: vi.fn(),
		isRoomMember: vi.fn(async () => true),
	};
	const repository = { findOneBy: vi.fn(async () => null) };
	const locks = new Map<string, string>();
	const noRooms = { innerJoin: () => noRooms, where: () => noRooms, getMany: async () => [] };
	const inbox = Object.assign(Object.create(ApInboxService.prototype), {
		config: { url: 'https://local.test' },
		utilityService: { extractDbHost: (uri: string) => new URL(uri).host, punyHost: (uri: string) => new URL(uri).host },
		apMfmService: { htmlToMfm: (html: string) => html },
		chatRoomInvitationsRepository: { findOneBy: vi.fn(async () => null) },
		usersRepository: { findOneBy: vi.fn(async () => actor) },
		chatRosterService: { isRoomGone: vi.fn(async () => false) },
		chatService,
		chatMessagesRepository: repository,
		chatRoomsRepository: { findOneBy: vi.fn(async () => remoteRoom), createQueryBuilder: () => noRooms },
		redisClient: { set: vi.fn(async (key: string, token: string) => { locks.set(key, token); return 'OK'; }), get: vi.fn(async (key: string) => key.startsWith('ap-object-lock:') ? locks.get(key) ?? null : null), del: vi.fn(async (key: string) => Number(locks.delete(key))), eval: vi.fn(async () => 1) },
		logger: { warn: vi.fn(), info: vi.fn() },
		apPersonService: { resolvePerson: vi.fn(async () => local) },
		apNoteService: { extractEmojis: vi.fn(async () => []) },
		roleService: { getUserPolicies: vi.fn(async () => ({ chatAvailability: 'available' })) },
		userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null, isRemoteUser: (user: { host: string | null }) => user.host != null },
	});
	const note = (extra: object = {}) => ({ id: 'https://remote.test/chat/messages/m1', type: 'Note', attributedTo: actor.uri, to: [local.uri], content: '/dice', _misskey_talk: true, ...extra });
	const receive = (object: object) => (inbox as unknown as { createChatMessage: (...args: unknown[]) => Promise<string> }).createChatMessage({ resolve: async (x: unknown) => x }, actor, object, { type: 'Create' });
	return { actor, local, room: remoteRoom, chatService, repository, note, receive };
}
