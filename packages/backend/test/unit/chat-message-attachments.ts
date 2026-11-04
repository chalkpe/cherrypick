/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { StatusError } from '@/misc/status-error.js';
import { isLastInboxAttempt } from '@/queue/processors/InboxProcessorService.js';
import type { MiLocalUser } from '@/models/User.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApImageService } from '@/core/activitypub/models/ApImageService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { buildChatNote } from '@/core/activitypub/misc/chat-payloads.js';
import { ChatMessageAccessError, ChatService, MAX_CHAT_MESSAGE_FILES, MAX_REMOTE_CHAT_MESSAGE_FILES } from '@/core/ChatService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import { DriveFileUsageService } from '@/core/DriveFileUsageService.js';
import CreateToRoomEndpoint, { paramDef as createToRoomParams } from '@/server/api/endpoints/chat/messages/create-to-room.js';
import CreateToUserEndpoint, { paramDef as createToUserParams } from '@/server/api/endpoints/chat/messages/create-to-user.js';
import { chatRosterOver, forgetfulRedis } from '../misc/chat-roster-stub.js';

const me = { id: 'me' } as MiLocalUser;
const document = (name: string) => ({ type: 'Document', url: `https://remote.test/${name}.png`, name });
const file = (id: string, userId = 'me') => ({ id, userId, type: 'image/png', comment: id, properties: {}, isSensitive: false });

describe('what a chat message says about its attachments', () => {
	const alice = { id: 'alice', host: null };
	const options = { baseUrl: 'https://local.test' };

	test('a Note lists them all in order', () => {
		const attachment = [document('b'), document('a'), document('d'), document('c')] as never[];

		const note = buildChatNote({ id: 'm1', text: 'hello' }, alice, [], undefined, { ...options, attachment });

		expect(note.attachment).toEqual(attachment);
	});

	test('a Note with no attachment does not name any', () => {
		const note = buildChatNote({ id: 'm1', text: 'hello' }, alice, [], undefined, { ...options, attachment: [] });

		expect(note).not.toHaveProperty('attachment');
	});

	function createRenderer(stored: ReturnType<typeof file>[]) {
		return Object.assign(Object.create(ApRendererService.prototype), {
			config: { url: 'https://local.test' },
			idService: { parse: () => ({ date: new Date('2026-11-04T00:00:00Z') }) },
			driveFilesRepository: { findBy: vi.fn(async () => stored) },
			driveFileEntityService: { getPublicUrl: (f: { id: string }) => `https://local.test/${f.id}.png` },
			customEmojiService: { localEmojisCache: { fetch: vi.fn().mockResolvedValue(new Map()) } },
		}) as ApRendererService;
	}

	test('the renderer keeps the order the sender chose, whatever order the database returns', async () => {
		const renderer = createRenderer([file('f1'), file('f2'), file('f3'), file('f4')]);

		const note = await renderer.renderChatMessage({ id: 'm1', text: 'hello', fileIds: ['f3', 'f1', 'f4', 'f2'], emojis: [] }, alice as never, []);

		expect(note.attachment?.map((x: { url: string }) => x.url)).toEqual(['f3', 'f1', 'f4', 'f2'].map(id => `https://local.test/${id}.png`));
	});

	test('the renderer leaves out a file deleted since', async () => {
		const renderer = createRenderer([file('f2')]);

		const note = await renderer.renderChatMessage({ id: 'm1', text: 'hello', fileIds: ['gone', 'f2'], emojis: [] }, alice as never, []);

		expect(note.attachment?.map((x: { url: string }) => x.url)).toEqual(['https://local.test/f2.png']);
	});
});

describe('packing the attachments of a chat message', () => {
	function createService(existing: string[]) {
		const pack = (id: string) => ({ id, name: id });
		const driveFileEntityService = {
			packManyByIdsMap: vi.fn(async (ids: string[]) => new Map(ids.map(id => [id, existing.includes(id) ? pack(id) : null]))),
		};
		const service = Object.assign(Object.create(ChatEntityService.prototype), {
			driveFileEntityService,
			idService: { parse: () => ({ date: new Date('2026-11-04T00:00:00Z') }) },
			usersRepository: { findOneBy: vi.fn().mockResolvedValue({ id: 'u1', host: null }) },
			userEntityService: { pack: vi.fn().mockResolvedValue({ id: 'u1' }), packMany: vi.fn().mockResolvedValue([]) },
			customEmojiService: { populateEmojis: vi.fn().mockResolvedValue({}) },
		}) as ChatEntityService;
		return { service, driveFileEntityService };
	}

	const message = (overrides: object = {}) => ({
		id: 'm1', text: 'hello', fromUserId: 'u1', fromUser: { id: 'u1', host: null }, toUserId: 'u2', toRoomId: null,
		editedAt: null, deletedAt: null, reactions: [], emojis: [], fileIds: ['f2', 'f1'], ...overrides,
	}) as never;

	test.each([
		['packMessageDetailed'],
		['packMessageLiteFor1on1'],
		['packMessageLiteForRoom'],
	] as const)('%s gives every file in order, and the first one under the older names', async method => {
		const { service } = createService(['f1', 'f2']);

		const packed = await service[method](message(), {} as never);

		expect(packed.fileIds).toEqual(['f2', 'f1']);
		expect(packed.files?.map(f => f.id)).toEqual(['f2', 'f1']);
		expect(packed.fileId).toBe('f2');
		expect(packed.file?.id).toBe('f2');
	});

	test('a message with no attachment gives empty lists and no first file', async () => {
		const { service } = createService([]);

		const packed = await service.packMessageLiteFor1on1(message({ fileIds: [] }));

		expect(packed).toMatchObject({ fileIds: [], files: [], fileId: null, file: null });
	});

	test('a file deleted since is left out of all the names', async () => {
		const { service } = createService(['f1']);

		const packed = await service.packMessageLiteFor1on1(message());

		expect(packed.fileIds).toEqual(['f1']);
		expect(packed.fileId).toBe('f1');
	});

	test('a deleted message shows no attachment', async () => {
		const { service, driveFileEntityService } = createService(['f1', 'f2']);

		const packed = await service.packMessageLiteFor1on1(message({ deletedAt: new Date() }));

		expect(packed).toMatchObject({ fileIds: [], files: [], fileId: null, file: null });
		expect(driveFileEntityService.packManyByIdsMap).not.toHaveBeenCalled();
	});

	test('packing many messages looks up their files together', async () => {
		const { service, driveFileEntityService } = createService(['f1', 'f2', 'f3']);

		const packed = await service.packMessagesLiteFor1on1([message(), message({ id: 'm2', fileIds: ['f3'] })]);

		expect(driveFileEntityService.packManyByIdsMap).toHaveBeenCalledOnce();
		expect(packed.map(m => m.fileIds)).toEqual([['f2', 'f1'], ['f3']]);
	});
});

describe('choosing the attachments of a new message', () => {
	function createService(stored: ReturnType<typeof file>[]) {
		const findBy = vi.fn(async () => stored);
		return { service: Object.assign(Object.create(ChatService.prototype), { driveFilesRepository: { findBy } }) as ChatService, findBy };
	}

	test('keeps the order of the request', async () => {
		const { service } = createService([file('f1'), file('f2'), file('f3')]);

		const files = await service.findOwnFilesForMessage('me', ['f3', 'f1', 'f2']);

		expect(files?.map(f => f.id)).toEqual(['f3', 'f1', 'f2']);
	});

	test('is refused when one of them is not the sender\'s', async () => {
		const { service } = createService([file('f1')]);

		await expect(service.findOwnFilesForMessage('me', ['f1', 'someone-elses'])).resolves.toBeNull();
	});

	test('looks only among the files of the sender', async () => {
		const { service, findBy } = createService([file('f1')]);

		await service.findOwnFilesForMessage('me', ['f1']);

		expect(findBy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'me' }));
	});

	test('needs no query for a message with none', async () => {
		const { service, findBy } = createService([]);

		await expect(service.findOwnFilesForMessage('me', [])).resolves.toEqual([]);
		expect(findBy).not.toHaveBeenCalled();
	});

	test.each([
		['chat/messages/create-to-user', createToUserParams],
		['chat/messages/create-to-room', createToRoomParams],
	])('%s takes up to the limit under fileIds and still takes fileId', (_name, params) => {
		expect(params.properties.fileIds).toMatchObject({ type: 'array', uniqueItems: true, minItems: 1, maxItems: MAX_CHAT_MESSAGE_FILES });
		expect(params.properties.fileId).toMatchObject({ type: 'string' });
		expect(MAX_CHAT_MESSAGE_FILES).toBe(4);
	});

	function createEndpointService(files: ReturnType<typeof file>[] | null) {
		return {
			checkChatAvailability: vi.fn(),
			findRoomById: vi.fn().mockResolvedValue({ id: 'r1' }),
			isRoomMember: vi.fn().mockResolvedValue(true),
			findOwnFilesForMessage: vi.fn().mockResolvedValue(files),
			createMessageToRoom: vi.fn().mockResolvedValue({ id: 'm1' }),
			createMessageToUser: vi.fn().mockResolvedValue({ id: 'm1' }),
		};
	}

	const toRoom = (service: ReturnType<typeof createEndpointService>, ps: object) => new CreateToRoomEndpoint({} as never, service as never).exec({ toRoomId: 'r1', ...ps }, me, null, null);
	const toUser = (service: ReturnType<typeof createEndpointService>, ps: object) => new CreateToUserEndpoint({ getUser: vi.fn().mockResolvedValue({ id: 'u2' }) } as never, service as never).exec({ toUserId: 'u2', ...ps }, me, null, null);

	test.each([
		['fileIds', { fileIds: ['f1', 'f2'] }, ['f1', 'f2']],
		['fileId', { fileId: 'f1' }, ['f1']],
		['both, with the older name first', { fileId: 'f3', fileIds: ['f1', 'f2'] }, ['f3', 'f1', 'f2']],
		['both, naming the same file', { fileId: 'f1', fileIds: ['f1', 'f2'] }, ['f1', 'f2']],
	])('a request can name files with %s', async (_name, ps, expected) => {
		const service = createEndpointService(expected.map(id => file(id)));

		await toRoom(service, ps);

		expect(service.findOwnFilesForMessage).toHaveBeenCalledWith('me', expected);
		expect(service.createMessageToRoom).toHaveBeenCalledWith(me, { id: 'r1' }, expect.objectContaining({ files: expected.map(id => file(id)) }));
	});

	test('the older name cannot go past the limit', async () => {
		const service = createEndpointService([]);

		await expect(toRoom(service, { fileId: 'f5', fileIds: ['f1', 'f2', 'f3', 'f4'] })).rejects.toMatchObject({ code: 'TOO_MANY_FILES' });
		await expect(toUser(service, { fileId: 'f5', fileIds: ['f1', 'f2', 'f3', 'f4'] })).rejects.toMatchObject({ code: 'TOO_MANY_FILES' });
		expect(service.findOwnFilesForMessage).not.toHaveBeenCalled();
	});

	test.each([
		['a room', toRoom],
		['a user', toUser],
	])('a message to %s naming a file that is not the sender\'s is refused', async (_name, send) => {
		const service = createEndpointService(null);

		await expect(send(service, { fileIds: ['f1'] })).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
	});

	test.each([
		['a room', toRoom],
		['a user', toUser],
	])('a message to %s still needs text or a file', async (_name, send) => {
		const service = createEndpointService([]);

		await expect(send(service, {})).rejects.toMatchObject({ code: 'CONTENT_REQUIRED' });
	});
});

describe('storing the attachments of a new message', () => {
	function createService() {
		const insertOne = vi.fn(async (message: object) => message);
		const service = Object.assign(Object.create(ChatService.prototype), {
			config: { url: 'https://local.test' },
			idService: { gen: () => 'generated', parse: () => ({ date: new Date('2026-11-04T00:00:00Z') }) },
			chatMessagesRepository: { insertOne },
			chatApprovalsRepository: { createQueryBuilder: () => ({ where() { return this; }, orWhere() { return this; }, take() { return this; }, getMany: async () => [] }), insertOne: vi.fn() },
			chatRoomMembershipsRepository: { findBy: async () => [] },
			chatEntityService: { packMessageLiteFor1on1: async (message: unknown) => message, packMessageLiteForRoom: async (message: unknown) => message },
			roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
			userBlockingService: { checkBlocked: async () => false },
			globalEventService: { publishChatUserStream: vi.fn(), publishChatRoomStream: vi.fn() },
			redisClient: { pipeline: () => ({ set() { return this; }, sadd() { return this; }, exec: async () => [] }) },
			userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null, isRemoteUser: (user: { host: string | null }) => user.host != null },
			usersRepository: { findOneBy: async () => null },
		}) as ChatService;
		return { service, insertOne };
	}

	test('a direct message keeps them in order', async () => {
		const f = createService();

		await f.service.createMessageToUser({ id: 'bob', host: 'remote.test' }, { id: 'carol', host: 'other.test', chatScope: 'everyone', isSuspended: false } as never, { files: [file('f2'), file('f1')] as never[] });

		expect(f.insertOne.mock.calls[0][0]).toMatchObject({ fileIds: ['f2', 'f1'] });
	});

	test('a room message keeps them in order', async () => {
		const f = createService();

		await f.service.createMessageToRoom({ id: 'bob', host: 'remote.test' }, { id: 'r1', ownerId: 'bob', isArchived: false } as never, { files: [file('f2'), file('f1')] as never[] });

		expect(f.insertOne.mock.calls[0][0]).toMatchObject({ fileIds: ['f2', 'f1'] });
	});

	test('a message with no file stores an empty list', async () => {
		const f = createService();

		await f.service.createMessageToRoom({ id: 'bob', host: 'remote.test' }, { id: 'r1', ownerId: 'bob', isArchived: false } as never, { text: 'hello' });

		expect(f.insertOne.mock.calls[0][0]).toMatchObject({ fileIds: [] });
	});
});

describe('receiving the attachments of a remote message', () => {
	const roomUri = 'https://remote.test/chat/rooms/r1';

	function createInbox() {
		const actor = { id: 'remote-user', uri: 'https://remote.test/users/remote-user', host: 'remote.test', isSuspended: false };
		const localUser = { id: 'local-user', uri: 'https://local.test/users/local', host: null };
		const room = { id: 'r1', uri: roomUri, ownerId: actor.id };
		const locks = new Map<string, string>();
		const chatService = {
			findMessageByUri: vi.fn().mockResolvedValue(null),
			applyPendingChatReactions: vi.fn(),
			assertCanSendToUser: vi.fn().mockResolvedValue({ iApprovedOther: false }),
			assertRemoteWriteAllowed: vi.fn().mockResolvedValue(undefined),
			createMessageToUser: vi.fn(),
			createMessageToRoom: vi.fn(),
			updateRemoteMessage: vi.fn(),
			isRoomMember: vi.fn().mockResolvedValue(true),
		};
		const chatRosterService = chatRosterOver(forgetfulRedis());
		const apImageService = { resolveImage: vi.fn(async (_actor: unknown, attach: { name: string }) => ({ id: attach.name })), findStoredImage: vi.fn().mockResolvedValue(null) };
		const noRooms = { innerJoin: () => noRooms, where: () => noRooms, getMany: async () => [] };
		const chatRoomsRepository = { findOneBy: vi.fn().mockResolvedValue(room), createQueryBuilder: () => noRooms };
		const chatMessagesRepository = { findOneBy: vi.fn().mockResolvedValue(null) };
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			chatService,
			chatRosterService,
			apImageService,
			chatRoomsRepository,
			chatMessagesRepository,
			usersRepository: { findOneBy: vi.fn().mockResolvedValue(actor) },
			chatRoomInvitationsRepository: { findOneBy: vi.fn().mockResolvedValue(null) },
			redisClient: {
				get: vi.fn(async (key: string) => locks.get(key) ?? null),
				set: vi.fn(async (key: string, value: string) => { locks.set(key, value); return 'OK'; }),
				del: vi.fn(async (key: string) => Number(locks.delete(key))),
			},
			apNoteService: { extractEmojis: vi.fn().mockResolvedValue([]) },
			utilityService: { extractDbHost: (uri: string) => new URL(uri).host, punyHost: (uri: string) => new URL(uri).host },
			apMfmService: { htmlToMfm: (html: string) => html },
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			apPersonService: { resolvePerson: vi.fn(async (uri: string) => uri === localUser.uri ? localUser : null) },
			roleService: { getUserPolicies: vi.fn().mockResolvedValue({ chatAvailability: 'available' }) },
			userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null, isRemoteUser: (user: { host: string | null }) => user.host != null },
		});
		const note = (overrides: object = {}) => ({
			id: 'https://remote.test/chat/messages/m1', type: 'Note', attributedTo: actor.uri, to: [localUser.uri], content: 'hello', _misskey_talk: true, ...overrides,
		});
		const receive = (object: object, type = 'Create', options?: { isLastAttempt?: boolean }) => (inbox as never as { createChatMessage: (...args: unknown[]) => Promise<string> }).createChatMessage({ resolve: async (x: unknown) => x }, actor, object, { type }, options);
		return { actor, localUser, room, chatService, apImageService, chatRoomsRepository, chatMessagesRepository, note, receive };
	}

	const storedIds = (mock: ReturnType<typeof vi.fn>) => (mock.mock.calls[0][2] as { files: { id: string }[] }).files.map(x => x.id);

	test('stores every attachment in order', async () => {
		const f = createInbox();

		await f.receive(f.note({ attachment: ['d', 'b', 'a', 'c'].map(document) }));

		expect(storedIds(f.chatService.createMessageToUser)).toEqual(['d', 'b', 'a', 'c']);
	});

	test('takes one attachment that is not in an array', async () => {
		const f = createInbox();

		await f.receive(f.note({ attachment: document('a') }));

		expect(storedIds(f.chatService.createMessageToUser)).toEqual(['a']);
	});

	test('follows the limit of remote notes rather than what this server sends', async () => {
		const f = createInbox();
		const attachment = Array.from({ length: MAX_REMOTE_CHAT_MESSAGE_FILES + 3 }, (_, i) => document(`f${i}`));

		await f.receive(f.note({ attachment }));

		expect(MAX_REMOTE_CHAT_MESSAGE_FILES).toBe(16);
		expect(storedIds(f.chatService.createMessageToUser)).toEqual(attachment.slice(0, MAX_REMOTE_CHAT_MESSAGE_FILES).map(x => x.name));
	});

	test('names one file only once', async () => {
		const f = createInbox();
		f.apImageService.resolveImage.mockResolvedValue({ id: 'same' } as never);

		await f.receive(f.note({ attachment: [document('a'), document('b')] }));

		expect(storedIds(f.chatService.createMessageToUser)).toEqual(['same']);
	});

	test('applies the sensitive flag of the Note to each attachment that does not state one', async () => {
		const f = createInbox();
		const attachment = [document('a'), { ...document('b'), sensitive: false }];

		await f.receive(f.note({ sensitive: true, attachment }));

		expect(f.apImageService.resolveImage.mock.calls.map(call => (call[1] as { sensitive?: boolean }).sensitive)).toEqual([true, false]);
	});

	test('keeps what arrived when another attachment fails', async () => {
		const f = createInbox();
		f.apImageService.resolveImage.mockImplementationOnce(async () => { throw new Error('timeout'); });

		await expect(f.receive(f.note({ content: '', attachment: [document('a'), document('b')] }))).resolves.toBe('ok');

		expect(storedIds(f.chatService.createMessageToUser)).toEqual(['b']);
	});

	test('a retry does not download again what the first attempt stored', async () => {
		const f = createInbox();
		const attachment = [document('a'), document('b')];
		f.apImageService.resolveImage.mockImplementation(async () => { throw new Error('timeout'); });
		await expect(f.receive(f.note({ content: '', attachment }))).rejects.toThrow('attachment');

		f.apImageService.resolveImage.mockClear();
		f.apImageService.findStoredImage.mockImplementation(async (_actor: unknown, attach: { name: string }) => attach.name === 'a' ? { id: 'a' } : null);
		f.apImageService.resolveImage.mockImplementation(async (_actor: unknown, attach: { name: string }) => ({ id: attach.name }));
		await f.receive(f.note({ content: '', attachment }));

		expect(f.apImageService.resolveImage.mock.calls.map(call => (call[1] as { name: string }).name)).toEqual(['b']);
		expect(storedIds(f.chatService.createMessageToUser)).toEqual(['a', 'b']);
	});

	describe('an attachment that cannot be fetched right now', () => {
		const failOn = (f: ReturnType<typeof createInbox>, name: string, err: unknown) => {
			f.apImageService.resolveImage.mockImplementation(async (_actor: unknown, attach: { name: string }) => {
				if (attach.name === name) throw err;
				return { id: attach.name } as never;
			});
		};

		test.each([
			['a 429', new StatusError('429 Too Many Requests', 429)],
			['a 503', new StatusError('503 Service Unavailable', 503)],
			['a broken connection', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
		])('%s keeps the message back for a retry, though it has text', async (_name, err) => {
			const f = createInbox();
			failOn(f, 'a', err);

			await expect(f.receive(f.note({ attachment: [document('a')] }))).rejects.toThrow('temporarily');

			expect(f.chatService.createMessageToUser).not.toHaveBeenCalled();
		});

		test('a later attempt that succeeds keeps every file', async () => {
			const f = createInbox();
			const attachment = [document('a'), document('b')];
			failOn(f, 'b', new StatusError('429 Too Many Requests', 429));
			await expect(f.receive(f.note({ attachment }))).rejects.toThrow('temporarily');

			f.apImageService.findStoredImage.mockImplementation(async (_actor: unknown, attach: { name: string }) => attach.name === 'a' ? { id: 'a' } as never : null);
			f.apImageService.resolveImage.mockClear();
			f.apImageService.resolveImage.mockImplementation(async (_actor: unknown, attach: { name: string }) => ({ id: attach.name }) as never);
			await f.receive(f.note({ attachment }));

			expect(f.apImageService.resolveImage.mock.calls.map(call => (call[1] as { name: string }).name)).toEqual(['b']);
			expect(storedIds(f.chatService.createMessageToUser)).toEqual(['a', 'b']);
		});

		test('the last attempt keeps what did arrive, and the text', async () => {
			const f = createInbox();
			failOn(f, 'b', new StatusError('429 Too Many Requests', 429));

			await f.receive(f.note({ attachment: [document('a'), document('b')] }), 'Create', { isLastAttempt: true });

			expect(storedIds(f.chatService.createMessageToUser)).toEqual(['a']);
			expect(f.chatService.createMessageToUser.mock.calls[0][2]).toMatchObject({ text: 'hello' });
		});

		test('the last attempt of a message that is only that file has nothing to keep', async () => {
			const f = createInbox();
			failOn(f, 'a', new StatusError('429 Too Many Requests', 429));

			await expect(f.receive(f.note({ content: '', attachment: [document('a')] }), 'Create', { isLastAttempt: true })).rejects.toThrow('not available');

			expect(f.chatService.createMessageToUser).not.toHaveBeenCalled();
		});

		test('another delivery of the message that got there first ends the wait', async () => {
			const f = createInbox();
			failOn(f, 'a', new StatusError('429 Too Many Requests', 429));
			f.chatMessagesRepository.findOneBy.mockResolvedValueOnce(null).mockResolvedValue({ id: 'stored' });

			await expect(f.receive(f.note({ attachment: [document('a')] }))).resolves.toBe('skip: chat message exists');
		});

		test.each([
			['a 404', new StatusError('404 Not Found', 404)],
			['a 410', new StatusError('410 Gone', 410)],
			['something that will not change', new Error('Max file size exceeded.')],
		])('%s is not waited for: the message is kept with the text', async (_name, err) => {
			const f = createInbox();
			failOn(f, 'a', err);

			await expect(f.receive(f.note({ attachment: [document('a'), document('b')] }))).resolves.toBe('ok');

			expect(storedIds(f.chatService.createMessageToUser)).toEqual(['b']);
		});

		test('one that may work later is still waited for when another will never work', async () => {
			const f = createInbox();
			f.apImageService.resolveImage.mockImplementation(async (_actor: unknown, attach: { name: string }) => {
				throw attach.name === 'a' ? new StatusError('404 Not Found', 404) : new StatusError('503 Service Unavailable', 503);
			});

			await expect(f.receive(f.note({ attachment: [document('a'), document('b')] }))).rejects.toThrow('temporarily');
		});
	});

	test('skips an attachment that cannot be stored instead of retrying', async () => {
		const f = createInbox();
		f.apImageService.resolveImage.mockResolvedValue(null as never);

		await expect(f.receive(f.note({ content: '', attachment: [{ type: 'Link', href: 'https://remote.test/' }] }))).resolves.toBe('skip: chat message has no content');
	});

	describe('downloads nothing for a message that would be refused', () => {
		const attachment = [document('a')];

		test('a direct message the recipient does not accept', async () => {
			const f = createInbox();
			f.chatService.assertCanSendToUser.mockRejectedValue(new ChatMessageAccessError('blocked'));

			await expect(f.receive(f.note({ attachment }))).resolves.toBe('skip: blocked');

			expect(f.apImageService.resolveImage).not.toHaveBeenCalled();
		});

		test('a room this server has not heard of yet', async () => {
			const f = createInbox();
			f.chatRoomsRepository.findOneBy.mockResolvedValue(null);

			await expect(f.receive(f.note({ attachment, context: roomUri }))).rejects.toThrow('chat room is not ready');

			expect(f.apImageService.resolveImage).not.toHaveBeenCalled();
		});

		test('a sender who is not a member of the room', async () => {
			const f = createInbox();
			f.chatService.isRoomMember.mockImplementation(async (_room: unknown, id: string) => id !== f.actor.id);

			await expect(f.receive(f.note({ attachment, context: roomUri }))).rejects.toThrow('membership is not ready');

			expect(f.apImageService.resolveImage).not.toHaveBeenCalled();
		});

		test('a room with no member here', async () => {
			const f = createInbox();
			f.chatService.isRoomMember.mockResolvedValue(false);

			await expect(f.receive(f.note({ attachment, context: roomUri }))).resolves.toBe('skip: no local members in room');

			expect(f.apImageService.resolveImage).not.toHaveBeenCalled();
		});

		test('an archived room owned here', async () => {
			const f = createInbox();
			f.chatService.assertRemoteWriteAllowed.mockRejectedValue(new ChatMessageAccessError('room is archived'));

			await expect(f.receive(f.note({ attachment, context: roomUri }))).resolves.toBe('skip: room is archived');

			expect(f.apImageService.resolveImage).not.toHaveBeenCalled();
		});
	});

	test('an edit of a stored message downloads nothing', async () => {
		const f = createInbox();
		f.chatMessagesRepository.findOneBy.mockResolvedValue({ id: 'm1', uri: 'https://remote.test/chat/messages/m1', fromUserId: f.actor.id, fileIds: ['a'] });

		await expect(f.receive(f.note({ attachment: [document('a')] }), 'Update')).resolves.toBe('ok: chat message updated');

		expect(f.apImageService.resolveImage).not.toHaveBeenCalled();
	});

	test('a message allowed through stores the attachments in a room too', async () => {
		const f = createInbox();

		await f.receive(f.note({ attachment: [document('b'), document('a')], context: roomUri }));

		expect(storedIds(f.chatService.createMessageToRoom)).toEqual(['b', 'a']);
	});
});

describe('finding an attachment this actor has already stored', () => {
	function createService(stored: object | null) {
		const findOneBy = vi.fn().mockResolvedValue(stored);
		return { service: Object.assign(Object.create(ApImageService.prototype), { driveFilesRepository: { findOneBy } }) as ApImageService, findOneBy };
	}

	const actor = { id: 'remote-user' } as never;

	test('looks by the URL among the files of that actor only', async () => {
		const f = createService({ id: 'f1', isSensitive: false });

		await expect(f.service.findStoredImage(actor, { url: 'https://remote.test/a.png' } as never)).resolves.toMatchObject({ id: 'f1' });

		expect(f.findOneBy).toHaveBeenCalledWith({ userId: 'remote-user', uri: 'https://remote.test/a.png' });
	});

	test('goes back to the download when the file has to become sensitive, as the download does this', async () => {
		const f = createService({ id: 'f1', isSensitive: false });

		await expect(f.service.findStoredImage(actor, { url: 'https://remote.test/a.png', sensitive: true } as never)).resolves.toBeNull();
	});

	test.each([
		['the attachment is only a URI to fetch', 'https://remote.test/documents/1'],
		['the attachment has no plain URL', { url: { href: 'https://remote.test/a.png' } }],
	])('has nothing to look for when %s', async (_name, attach) => {
		const f = createService({ id: 'f1', isSensitive: false });

		await expect(f.service.findStoredImage(actor, attach as never)).resolves.toBeNull();

		expect(f.findOneBy).not.toHaveBeenCalled();
	});
});

describe('a file used by a chat message', () => {
	test('counts as used whichever attachment it is', () => {
		const andWhere = vi.fn().mockReturnThis();

		new DriveFileUsageService().applyUnusedFilter({ andWhere } as never, 'me');

		const chatCondition = andWhere.mock.calls.map(call => call[0] as string).find(sql => sql.includes('"chat_message"'));
		expect(chatCondition).toContain('"chat_message"."fileIds" @> ARRAY[file.id]::varchar[]');
	});
});

describe('clearing the text of a message', () => {
	function createService(remaining: number) {
		const message = { id: 'm1', fromUserId: 'u1', toUserId: 'u2', toRoomId: null, text: 'old', editedAt: null, deletedAt: null, fileIds: ['f1'], emojis: [] };
		const service = Object.assign(Object.create(ChatService.prototype), {
			chatMessagesRepository: { findOneBy: vi.fn().mockResolvedValue(message), update: vi.fn().mockResolvedValue({ affected: 1 }) },
			driveFilesRepository: { countBy: vi.fn().mockResolvedValue(remaining) },
			userBlockingService: { checkBlocked: vi.fn().mockResolvedValue(false) },
			usersRepository: { findOneByOrFail: vi.fn().mockResolvedValue({ id: 'u1', host: null }), findBy: vi.fn().mockResolvedValue([]) },
			globalEventService: { publishChatUserStream: vi.fn() },
			customEmojiService: { populateEmojis: vi.fn().mockResolvedValue({}) },
			apRendererService: { renderChatUpdate: vi.fn().mockResolvedValue({ type: 'Update' }), addContext: (x: unknown) => x },
			userEntityService: { isLocalUser: () => true, isRemoteUser: () => false },
		}) as ChatService;
		return { service, message };
	}

	test('is allowed while one of its files remains', async () => {
		const f = createService(1);

		await expect(f.service.updateMessage('u1', 'm1', '')).resolves.toMatchObject({ text: '' });
	});

	test('is refused once its files are gone, as it would leave nothing to show', async () => {
		const f = createService(0);

		await expect(f.service.updateMessage('u1', 'm1', '')).rejects.toThrow('invalid text');
	});

	test('from another server follows the same rule', async () => {
		const f = createService(0);

		await expect(f.service.updateRemoteMessage({ id: 'u1', host: 'remote.test' } as never, f.message as never, '', new Date())).rejects.toThrow('invalid text');
	});
});

describe('the last attempt of an inbox job', () => {
	test.each([
		[0, 8, false],
		[6, 8, false],
		[7, 8, true],
		[0, 1, true],
		[0, undefined, true],
	])('after %i attempts of %s: %s', (attemptsMade, attempts, expected) => {
		expect(isLastInboxAttempt({ attemptsMade, opts: { attempts } })).toBe(expected);
	});
});
