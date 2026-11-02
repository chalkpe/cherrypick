/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatMessageAccessError, ChatService } from '@/core/ChatService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import {
	buildChatDelete,
	buildChatNote,
	buildChatReaction,
	buildChatReactionUndo,
	buildChatRoomDelete,
	buildChatRoomUpdate,
	buildChatUpdate,
	normalizeChatScope,
} from '@/core/activitypub/misc/chat-payloads.js';

const BASE = 'https://local.test';
const alice = { id: 'alice', host: null };
const bob = { id: 'bob', host: 'remote.test', uri: 'https://remote.test/users/bob' };
const message = {
	id: 'm1',
	uri: `${BASE}/chat/messages/m1`,
	text: '<b>hi</b>',
	editedAt: new Date('2026-11-02T00:01:00.000Z'),
};

const options = { baseUrl: BASE, published: '2026-11-02T00:00:00.000Z' };

describe('chat scope normalization', () => {
	test.each([
		['everyone', 'everyone'],
		['followers', 'followers'],
		['following', 'following'],
		['mutual', 'mutual'],
		['none', 'none'],
		['bogus', 'mutual'],
		[undefined, 'mutual'],
	] as const)('normalizes %s to %s', (input, expected) => {
		expect(normalizeChatScope(input)).toBe(expected);
	});
});

describe('chat federation payloads', () => {
	test('canonical note escapes HTML and keeps raw misskey content', () => {
		const note = buildChatNote(message, alice, [bob], undefined, options);

		expect(note.content).toBe('&lt;b&gt;hi&lt;/b&gt;');
		expect(note._misskey_content).toBe('<b>hi</b>');
		expect(note.source).toEqual({ content: '<b>hi</b>', mediaType: 'text/x.misskeymarkdown' });
		expect(note._misskey_talk).toBe(true);
		expect(note.to).toEqual(['https://remote.test/users/bob']);
	});

	test('group note uses the room URI as @context', () => {
		const note = buildChatNote(message, alice, [bob], 'r1', options);

		expect(note['@context']).toBe(`${BASE}/chat/rooms/r1`);
	});

	test('group note can use a mirror room URI from the owner host', () => {
		const note = buildChatNote(message, alice, [bob], 'r1', {
			...options,
			roomUri: 'https://remote.test/chat/rooms/r1',
		});

		expect(note['@context']).toBe('https://remote.test/chat/rooms/r1');
	});

	test('update carries the same object id and updated timestamp', () => {
		const update = buildChatUpdate(message, alice, [bob], undefined, options);

		expect(update.type).toBe('Update');
		expect(update.object).toMatchObject({
			id: `${BASE}/chat/messages/m1`,
			type: 'Note',
			updated: '2026-11-02T00:01:00.000Z',
		});
	});

	test('delete uses a Tombstone with formerType Note', () => {
		const activity = buildChatDelete(message, alice, [bob], options);

		expect(activity.object).toMatchObject({ type: 'Tombstone', formerType: 'Note' });
	});

	test('reaction and undo use deterministic ids', () => {
		const react = buildChatReaction(message, bob, [alice], '👍', options);
		const undo = buildChatReactionUndo(message, bob, [alice], '👍', options);

		expect(react.content).toBe('👍');
		expect(react.object).toBe(`${BASE}/chat/messages/m1`);
		expect(undo.object).toMatchObject({ id: react.id, type: 'EmojiReact' });
	});

	test('reactions to remote messages have reactor-owned activity IDs', () => {
		const remoteMessage = { ...message, uri: 'https://remote.test/chat/messages/m1' };
		const reaction = buildChatReaction(remoteMessage, alice, [bob], '👍', options);
		const undo = buildChatReactionUndo(remoteMessage, alice, [bob], '👍', options);

		for (const activity of [reaction, undo]) {
			expect(new URL(activity.id!).origin).toBe(BASE);
		}
		expect(reaction.object).toBe(remoteMessage.uri);
		expect(undo.object).toMatchObject({ id: reaction.id });
		expect(buildChatReaction({ ...remoteMessage, uri: 'https://other.test/chat/messages/m1' }, alice, [bob], '👍', options).id).not.toBe(reaction.id);
	});

	test('clearing a room description sends an explicit empty summary', () => {
		const activity = buildChatRoomUpdate({ id: 'r1', name: 'Room', description: '' }, alice, [bob], options);
		expect(JSON.parse(JSON.stringify(activity)).object.summary).toBe('');
	});

	test('room update and delete carry Group/Tombstone objects', () => {
		const room = { id: 'r1', name: 'Room', description: 'desc' };
		const update = buildChatRoomUpdate(room, alice, [bob], options);
		const remove = buildChatRoomDelete(room, alice, [bob], options);

		expect(update.object).toMatchObject({ type: 'Group', name: 'Room', summary: 'desc' });
		expect(remove.object).toMatchObject({ type: 'Tombstone', formerType: 'Group' });
	});

	test('mirror room activities keep the remote room URI', () => {
		const room = { id: 'r1', name: 'Room', description: 'desc', uri: 'https://remote.test/chat/rooms/r1' };
		const update = buildChatRoomUpdate(room, alice, [bob], options);
		const remove = buildChatRoomDelete(room, alice, [bob], options);

		expect(update.object).toMatchObject({ id: 'https://remote.test/chat/rooms/r1' });
		expect(remove.object).toMatchObject({ id: 'https://remote.test/chat/rooms/r1' });
	});
});

describe('ApRendererService chat wrappers', () => {
	function createRenderer() {
		return Object.assign(Object.create(ApRendererService.prototype), {
			config: { url: BASE },
			userEntityService: {
				genLocalUserUri: (id: string) => `${BASE}/users/${id}`,
				isRemoteUser: (user: { host: string | null }) => user.host != null,
			},
			driveFilesRepository: { findOneBy: vi.fn().mockResolvedValue(null) },
			customEmojiService: { localEmojisCache: { fetch: vi.fn().mockResolvedValue(new Map()) } },
			idService: { parse: vi.fn().mockReturnValue({ date: new Date('2026-11-02T00:00:00.000Z') }) },
		}) as ApRendererService;
	}

	test('renderChatMessage uses the canonical note body', async () => {
		const renderer = createRenderer();
		const note = await renderer.renderChatMessage({ ...message, fileId: null, emojis: [] }, alice as never, [bob as never]);

		expect(note.content).toBe('&lt;b&gt;hi&lt;/b&gt;');
		expect(note._misskey_content).toBe('<b>hi</b>');
		expect(note.source).toEqual({ content: '<b>hi</b>', mediaType: 'text/x.misskeymarkdown' });
		expect(note.published).toBe('2026-11-02T00:00:00.000Z');
	});

	test('renderChatDelete uses a Note Tombstone', () => {
		const renderer = createRenderer();
		const activity = renderer.renderChatDelete(message, alice as never, [bob as never]);

		expect(activity.object).toMatchObject({ type: 'Tombstone', formerType: 'Note' });
	});

	test('message updates preserve the attachment, emoji tags and original publication time', async () => {
		const renderer = createRenderer();
		Object.assign(renderer, {
			driveFilesRepository: { findOneBy: vi.fn().mockResolvedValue({ id: 'f1' }) },
			customEmojiService: { localEmojisCache: { fetch: vi.fn().mockResolvedValue(new Map([
				['wave', { name: 'wave', localOnly: false, publicUrl: 'https://local.test/wave.png' }],
				['private', { name: 'private', localOnly: true }],
			])) } },
			driveFileEntityService: { getPublicUrl: () => 'https://local.test/file.png' },
		});

		const activity = await renderer.renderChatUpdate({ ...message, fileId: 'f1', emojis: ['wave', 'private'] }, alice as never, [bob as never]);
		expect(activity.object).toMatchObject({
			id: message.uri,
			published: '2026-11-02T00:00:00.000Z',
			updated: message.editedAt.toISOString(),
			attachment: [{ type: 'Document', url: 'https://local.test/file.png' }],
			tag: [{ type: 'Emoji', name: ':wave:' }],
		});
	});
});

describe('ChatService chat federation delivery', () => {
	function createService() {
		const alice = { id: 'alice', host: null, uri: null, inbox: null };
		const bob = { id: 'bob', host: 'remote.test', uri: 'https://remote.test/users/bob', inbox: 'https://remote.test/users/bob/inbox' };
		const carol = { id: 'carol', host: 'other.test', uri: 'https://other.test/users/carol', inbox: 'https://other.test/users/carol/inbox' };
		const users = new Map([alice, bob, carol].map(user => [user.id, user]));

		const directMessage = {
			id: 'm1', fromUserId: 'alice', toUserId: 'bob', toRoomId: null,
			text: 'old', editedAt: null, deletedAt: null, reactions: [] as string[], emojis: [],
		};
		const roomMessage = {
			id: 'm2', fromUserId: 'bob', toUserId: null, toRoomId: 'r1',
			text: 'room', editedAt: null, deletedAt: null, reactions: [] as string[], emojis: [],
		};
		const roomDeleteMessage = { ...roomMessage, id: 'm3', fromUserId: 'alice' };
		const room = { id: 'r1', ownerId: 'alice' };
		const messages = new Map([directMessage, roomMessage, roomDeleteMessage].map(message => [message.id, message]));

		const queryBuilder = {
			update: vi.fn().mockReturnThis(),
			set: vi.fn().mockReturnThis(),
			where: vi.fn().mockReturnThis(),
			andWhere: vi.fn().mockReturnThis(),
			setParameter: vi.fn().mockReturnThis(),
			execute: vi.fn().mockResolvedValue({}),
		};

		const queueService = { deliver: vi.fn() };
		const apRendererService = {
			renderChatUpdate: vi.fn().mockReturnValue({ type: 'Update' }),
			renderChatDelete: vi.fn().mockReturnValue({ type: 'Delete' }),
			renderChatReaction: vi.fn().mockReturnValue({ type: 'EmojiReact' }),
			renderChatReactionUndo: vi.fn().mockReturnValue({ type: 'Undo' }),
			addContext: vi.fn((activity: unknown) => activity),
		};

		const service = Object.assign(Object.create(ChatService.prototype), {
			config: { url: 'https://local.test' },
			chatMessagesRepository: {
				findOneBy: vi.fn(async ({ id }: { id: string }) => messages.get(id) ?? null),
				update: vi.fn(async (where: string | { id: string } | { id: string }[], patch: Record<string, unknown>) => {
					const id = typeof where === 'string' ? where : Array.isArray(where) ? where[0].id : where.id;
					const target = messages.get(id);
					if (target) Object.assign(target, patch);
					return { affected: target ? 1 : 0 };
				}),
				createQueryBuilder: vi.fn(() => queryBuilder),
			},
			chatRoomsRepository: {
				findOneBy: vi.fn(async ({ id }: { id: string }) => id === room.id ? room : null),
				findOneByOrFail: vi.fn(async ({ id }: { id: string }) => id === room.id ? room : Promise.reject(new Error('room not found'))),
			},
			chatRoomMembershipsRepository: {
				findBy: vi.fn(async () => [{ roomId: 'r1', userId: 'bob' }, { roomId: 'r1', userId: 'carol' }]),
				findOneBy: vi.fn(async ({ roomId, userId }: { roomId: string; userId: string }) =>
					roomId === 'r1' && (userId === 'bob' || userId === 'carol') ? { roomId, userId } : null),
			},
			usersRepository: {
				findOneByOrFail: vi.fn(async ({ id }: { id: string }) => users.get(id)),
				findBy: vi.fn(async ({ id }: { id: { value: string[] } }) => (id.value ?? []).map(value => users.get(value)).filter(Boolean)),
			},
			userEntityService: {
				isLocalUser: (user: { host: string | null }) => user.host == null,
				isRemoteUser: (user: { host: string | null }) => user.host != null,
				pack: vi.fn(async (id: string) => users.get(id)),
			},
			globalEventService: {
				publishChatUserStream: vi.fn(),
				publishChatRoomStream: vi.fn(),
			},
			apRendererService,
			queueService,
			customEmojiService: {
				localEmojisCache: { fetch: vi.fn().mockResolvedValue(new Map()) },
				populateEmojis: vi.fn().mockResolvedValue({}),
			},
			userBlockingService: { checkBlocked: vi.fn().mockResolvedValue(false) },
		}) as ChatService;

		return { service, alice, bob, carol, directMessage, roomMessage, roomDeleteMessage, queueService, apRendererService };
	}

	test('delivers Update to the remote 1:1 counterpart', async () => {
		const f = createService();

		await f.service.updateMessage('alice', 'm1', 'edited');

		expect(f.queueService.deliver).toHaveBeenCalledWith(
			f.alice,
			expect.objectContaining({ type: 'Update' }),
			f.bob.inbox,
			false,
		);
	});

	test('soft-deletes and delivers Delete to every remote room member', async () => {
		const f = createService();

		await f.service.deleteMessage(f.roomDeleteMessage as never);

		expect(f.roomDeleteMessage.deletedAt).toBeInstanceOf(Date);
		expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
		expect(f.queueService.deliver).toHaveBeenCalledWith(f.alice, expect.objectContaining({ type: 'Delete' }), f.bob.inbox, false);
		expect(f.queueService.deliver).toHaveBeenCalledWith(f.alice, expect.objectContaining({ type: 'Delete' }), f.carol.inbox, false);
	});

	test('delivers EmojiReact and Undo to every remote room member', async () => {
		const f = createService();

		await f.service.react('m2', 'alice', '👍');
		await f.service.unreact('m2', 'alice', '👍');

		expect(f.queueService.deliver).toHaveBeenCalledTimes(4);
		expect(f.queueService.deliver).toHaveBeenCalledWith(f.alice, expect.objectContaining({ type: 'EmojiReact' }), f.bob.inbox, false);
		expect(f.queueService.deliver).toHaveBeenCalledWith(f.alice, expect.objectContaining({ type: 'Undo' }), f.carol.inbox, false);
	});

	test.each(['react', 'unreact'] as const)('%s rejects a deleted message without publishing or federating a reaction', async method => {
		const f = createService();
		Object.assign(f.roomMessage, { deletedAt: new Date(), text: null });

		await expect(f.service[method]('m2', 'alice', '👍')).rejects.toThrow('deleted');
		expect(f.queueService.deliver).not.toHaveBeenCalled();
	});

	test('updateRemoteMessage updates the author message', async () => {
		const f = createService();

		await f.service.updateRemoteMessage(f.bob as never, f.roomMessage as never, 'changed', new Date('2026-11-02T00:02:00.000Z'));

		expect(f.roomMessage.text).toBe('changed');
		expect(f.roomMessage.editedAt).toEqual(new Date('2026-11-02T00:02:00.000Z'));
	});

	test('updateRemoteMessage rejects a non-author', async () => {
		const f = createService();

		await expect(f.service.updateRemoteMessage(f.alice as never, f.roomMessage as never, 'changed', new Date()))
			.rejects.toThrow('cannot edit');
	});

	test('deleteRemoteMessage soft-deletes an author message', async () => {
		const f = createService();

		await f.service.deleteRemoteMessage(f.bob as never, f.roomMessage as never);

		expect(f.roomMessage.deletedAt).toBeInstanceOf(Date);
		expect(f.roomMessage.text).toBeNull();
	});

	test('reactRemote adds a member reaction once', async () => {
		const f = createService();

		await f.service.reactRemote(f.alice as never, f.roomMessage as never, '👍');
		await f.service.reactRemote(f.alice as never, f.roomMessage as never, '👍');

		expect(f.roomMessage.reactions).toEqual(['alice/👍']);
	});

	test('findMessageByUri resolves a local message without a stored URI', async () => {
		const f = createService();

		await expect(f.service.findMessageByUri('https://local.test/chat/messages/m1')).resolves.toBe(f.directMessage);
	});

	test('unreactRemote removes a member reaction', async () => {
		const f = createService();
		f.roomMessage.reactions = ['alice/👍'];

		await f.service.unreactRemote(f.alice as never, f.roomMessage as never, '👍');

		expect(f.roomMessage.reactions).toEqual([]);
	});

	describe('tombstones', () => {
		test('unreactRemote rejects a deleted message', async () => {
			const f = createService();
			Object.assign(f.roomMessage, { deletedAt: new Date() });

			await expect(f.service.unreactRemote(f.alice as never, f.roomMessage as never, '👍')).rejects.toBeInstanceOf(ChatMessageAccessError);
		});

		test('a repeated remote Delete keeps the first deletion time and does not publish again', async () => {
			const f = createService();
			await f.service.deleteRemoteMessage(f.bob as never, f.roomMessage as never);
			const firstDeletedAt = f.roomMessage.deletedAt;
			const publish = (f.service as never as { globalEventService: { publishChatRoomStream: ReturnType<typeof vi.fn> } }).globalEventService.publishChatRoomStream;
			publish.mockClear();

			await f.service.deleteRemoteMessage(f.bob as never, f.roomMessage as never);

			expect(f.roomMessage.deletedAt).toBe(firstDeletedAt);
			expect(publish).not.toHaveBeenCalled();
		});

		test('findMyMessageById does not return a tombstone, so the delete endpoint cannot redeliver', async () => {
			const f = createService();
			const findOneBy = (f.service as never as { chatMessagesRepository: { findOneBy: ReturnType<typeof vi.fn> } }).chatMessagesRepository.findOneBy;

			await f.service.findMyMessageById('alice', 'm1');

			expect(findOneBy).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', fromUserId: 'alice', deletedAt: expect.objectContaining({ _type: 'isNull' }) }));
		});
	});

	describe('editing authority', () => {
		test('a former room member cannot edit their old message', async () => {
			const f = createService();
			Object.assign(f.roomMessage, { fromUserId: 'dave' });

			await expect(f.service.updateMessage('dave', 'm2', 'changed')).rejects.toThrow('cannot edit');

			expect(f.roomMessage.text).toBe('room');
			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});

		test('a former remote room member cannot edit their old message', async () => {
			const f = createService();
			const dave = { id: 'dave', host: 'other.test', uri: 'https://other.test/users/dave', inbox: 'https://other.test/users/dave/inbox' };
			Object.assign(f.roomMessage, { fromUserId: 'dave' });

			await expect(f.service.updateRemoteMessage(dave as never, f.roomMessage as never, 'changed', new Date())).rejects.toThrow('cannot edit');

			expect(f.roomMessage.text).toBe('room');
		});

		test('a user blocked by the recipient cannot edit a direct message', async () => {
			const f = createService();
			const blocking = (f.service as never as { userBlockingService: { checkBlocked: ReturnType<typeof vi.fn> } }).userBlockingService;
			blocking.checkBlocked.mockResolvedValue(true);

			await expect(f.service.updateMessage('alice', 'm1', 'changed')).rejects.toThrow('cannot edit');

			expect(blocking.checkBlocked).toHaveBeenCalledWith('bob', 'alice');
			expect(f.directMessage.text).toBe('old');
		});

		test('a remote user blocked by the recipient cannot edit a direct message', async () => {
			const f = createService();
			const blocking = (f.service as never as { userBlockingService: { checkBlocked: ReturnType<typeof vi.fn> } }).userBlockingService;
			blocking.checkBlocked.mockResolvedValue(true);
			Object.assign(f.directMessage, { fromUserId: 'bob', toUserId: 'alice' });

			await expect(f.service.updateRemoteMessage(f.bob as never, f.directMessage as never, 'changed', new Date())).rejects.toThrow('cannot edit');

			expect(blocking.checkBlocked).toHaveBeenCalledWith('alice', 'bob');
		});
	});

	describe('remote reactions', () => {
		test('undoing a custom emoji removes the host-qualified reaction even if the emoji is gone', async () => {
			const f = createService();
			f.roomMessage.reactions = ['carol/:gone@other.test:'];

			await f.service.unreactRemote(f.carol as never, f.roomMessage as never, ':gone:');

			expect(f.roomMessage.reactions).toEqual([]);
		});

		test.each([':blob@elsewhere.test:', 'not an emoji'])('rejects %s as a non-retriable access error', async (reaction) => {
			const f = createService();

			await expect(f.service.reactRemote(f.carol as never, f.roomMessage as never, reaction)).rejects.toBeInstanceOf(ChatMessageAccessError);
			await expect(f.service.unreactRemote(f.carol as never, f.roomMessage as never, reaction)).rejects.toBeInstanceOf(ChatMessageAccessError);
		});

		test('the per-message reaction limit is a non-retriable access error', async () => {
			const f = createService();
			f.roomMessage.reactions = Array.from({ length: 100 }, (_, i) => `u${i}/👍`);

			await expect(f.service.reactRemote(f.carol as never, f.roomMessage as never, '👍')).rejects.toBeInstanceOf(ChatMessageAccessError);
		});
	});

	describe('room deletion', () => {
		function createRoomService(owner: { id: string; host: string | null; uri: string | null; inbox: string | null }) {
			const f = createService();
			const room = { id: 'r1', ownerId: owner.id, name: 'room' };
			const users = new Map([owner, f.bob, f.carol].map(user => [user.id, user]));
			const pipeline = { del: vi.fn().mockReturnThis(), srem: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) };
			Object.assign(f.service, {
				redisClient: { pipeline: () => pipeline },
				liveKitService: { deleteRoom: vi.fn().mockResolvedValue(undefined) },
				roleService: { isModerator: vi.fn().mockResolvedValue(true) },
				moderationLogService: { log: vi.fn() },
			});
			const s = f.service as never as {
				chatRoomsRepository: { delete: ReturnType<typeof vi.fn> };
				usersRepository: { findOneBy: ReturnType<typeof vi.fn>; findBy: ReturnType<typeof vi.fn> };
				apRendererService: { renderChatRoomDelete: ReturnType<typeof vi.fn> };
			};
			s.chatRoomsRepository.delete = vi.fn().mockResolvedValue({ affected: 1 });
			s.usersRepository.findOneBy = vi.fn(async ({ id }: { id: string }) => users.get(id) ?? null);
			s.usersRepository.findBy = vi.fn(async () => [...users.values()]);
			s.apRendererService.renderChatRoomDelete = vi.fn().mockReturnValue({ type: 'Delete' });
			return { ...f, room, owner };
		}

		test('a moderator deleting a local room still tells the remote members', async () => {
			const owner = { id: 'alice', host: null, uri: null, inbox: null };
			const f = createRoomService(owner);
			const moderator = { id: 'moderator', host: null };

			await f.service.deleteRoom(f.room as never, moderator as never);

			expect(f.queueService.deliver).toHaveBeenCalledWith(owner, expect.objectContaining({ type: 'Delete' }), f.bob.inbox, false);
			expect(f.queueService.deliver).toHaveBeenCalledWith(owner, expect.objectContaining({ type: 'Delete' }), f.carol.inbox, false);
		});

		test('deleting a mirror of a remote room delivers nothing but still cleans up', async () => {
			const owner = { id: 'bob', host: 'remote.test', uri: 'https://remote.test/users/bob', inbox: 'https://remote.test/users/bob/inbox' };
			const f = createRoomService(owner);

			await f.service.deleteRoom(f.room as never);

			expect(f.queueService.deliver).not.toHaveBeenCalled();
			expect((f.service as never as { chatRoomsRepository: { delete: ReturnType<typeof vi.fn> } }).chatRoomsRepository.delete).toHaveBeenCalledWith('r1');
			expect((f.service as never as { liveKitService: { deleteRoom: ReturnType<typeof vi.fn> } }).liveKitService.deleteRoom).toHaveBeenCalledWith('r1');
		});
	});
});

describe('ApInboxService chat activity routing', () => {
	function createInbox() {
		const actor = { id: 'remote-user', uri: 'https://remote.test/users/remote-user', host: 'remote.test' };
		const message = { id: 'm1', uri: 'https://remote.test/chat/messages/m1', fromUserId: 'remote-user', reactions: [] as string[] };
		const chatService = {
			findMessageByUri: vi.fn().mockResolvedValue(message),
			updateRemoteMessage: vi.fn().mockResolvedValue(message),
			deleteRemoteMessage: vi.fn().mockResolvedValue(message),
			reactRemote: vi.fn().mockResolvedValue(undefined),
			unreactRemote: vi.fn().mockResolvedValue(undefined),
			createMessageToUser: vi.fn(),
			createMessageToRoom: vi.fn(),
			isRoomMember: vi.fn(),
		};
		const localUser = { id: 'local-user', uri: 'https://local.test/users/local', host: null };
		const locks = new Map<string, string>();
		const redisClient = {
			get: vi.fn(async (key: string) => locks.get(key) ?? null),
			set: vi.fn(async (key: string, value: string) => { locks.set(key, value); return 'OK'; }),
			del: vi.fn(async (key: string) => Number(locks.delete(key))),
			setex: vi.fn().mockResolvedValue('OK'),
		};
		const chatRoomsRepository = { findOneBy: vi.fn().mockResolvedValue({ id: 'r1', uri: 'https://remote.test/chat/rooms/r1' }) };
		const apPersonService = { resolvePerson: vi.fn(async (uri: string) => uri === localUser.uri ? localUser : null) };
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			chatService,
			redisClient,
			apNoteService: { fetchNote: vi.fn().mockResolvedValue(null), extractEmojis: vi.fn().mockResolvedValue([]) },
			apResolverService: { createResolver: vi.fn(() => ({ resolve: async (x: unknown) => x })) },
			utilityService: { extractDbHost: (uri: string) => new URL(uri).host, punyHost: (uri: string) => new URL(uri).host },
			apMfmService: { htmlToMfm: (html: string) => html },
			logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
			apPersonService,
			apImageService: { resolveImage: vi.fn() },
			roleService: { getUserPolicies: vi.fn().mockResolvedValue({ chatAvailability: 'available' }) },
			userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null },
			chatRoomsRepository,
			chatMessagesRepository: { findOneBy: vi.fn().mockResolvedValue(null) },
		}) as ApInboxService;

		return { inbox, actor, message, chatService, redisClient, chatRoomsRepository, localUser };
	}

	describe('room context in a flat @context array', () => {
		const note = (context: unknown, actorUri: string, to: string) => ({
			id: 'https://remote.test/chat/messages/array-context',
			type: 'Note',
			attributedTo: actorUri,
			content: 'hello',
			to: [to],
			_misskey_talk: true,
			'@context': context,
		});

		test('a room URI among the context elements makes it a group message, not a DM', async () => {
			const f = createInbox();
			f.chatService.isRoomMember.mockResolvedValue(true);

			await (f.inbox as never as { createChatMessage: (...args: unknown[]) => Promise<string> }).createChatMessage(
				{ resolve: async (x: unknown) => x },
				f.actor,
				note(['https://www.w3.org/ns/activitystreams', { sensitive: 'as:sensitive' }, 'https://remote.test/chat/rooms/r1'], f.actor.uri, f.localUser.uri),
				{ type: 'Create' },
			);

			expect(f.chatService.createMessageToRoom).toHaveBeenCalledOnce();
			expect(f.chatService.createMessageToUser).not.toHaveBeenCalled();
		});

		test('a context array without a room URI stays a direct message', async () => {
			const f = createInbox();

			await (f.inbox as never as { createChatMessage: (...args: unknown[]) => Promise<string> }).createChatMessage(
				{ resolve: async (x: unknown) => x },
				f.actor,
				note(['https://www.w3.org/ns/activitystreams', { sensitive: 'as:sensitive' }], f.actor.uri, f.localUser.uri),
				{ type: 'Create' },
			);

			expect(f.chatService.createMessageToUser).toHaveBeenCalledOnce();
			expect(f.chatService.createMessageToRoom).not.toHaveBeenCalled();
		});
	});

	test('treats a room-context message with one local recipient as a group message', async () => {
		const f = createInbox();
		f.chatService.isRoomMember.mockResolvedValue(true);
		const object = {
			id: 'https://remote.test/chat/messages/group-1',
			type: 'Note',
			attributedTo: f.actor.uri,
			_misskey_talk: true,
			_misskey_content: 'group hello',
			to: [f.localUser.uri],
			'@context': 'https://remote.test/chat/rooms/r1',
		};

		await (f.inbox as never as { createChatMessage: (...args: unknown[]) => Promise<string> }).createChatMessage(
			{ resolve: async (x: unknown) => x },
			f.actor,
			object,
			{ type: 'Create' },
		);

		expect(f.chatService.createMessageToRoom).toHaveBeenCalledWith(f.actor, expect.objectContaining({ id: 'r1' }), expect.objectContaining({ text: 'group hello' }));
		expect(f.chatService.createMessageToUser).not.toHaveBeenCalled();
	});

	test('routes a chat Note Update to updateRemoteMessage', async () => {
		const f = createInbox();
		const note = {
			id: f.message.uri,
			type: 'Note',
			attributedTo: f.actor.uri,
			_misskey_talk: true,
			_misskey_content: 'edited',
		};

		await (f.inbox as never as { update: (...args: unknown[]) => Promise<string> }).update(f.actor, { type: 'Update', actor: f.actor.uri, object: note });

		expect(f.chatService.updateRemoteMessage).toHaveBeenCalledWith(f.actor, f.message, 'edited', expect.any(Date), []);
	});

	test('routes ChatMessage Delete to deleteRemoteMessage', async () => {
		const f = createInbox();

		await (f.inbox as never as { delete: (...args: unknown[]) => Promise<string> }).delete(f.actor, {
			type: 'Delete',
			actor: f.actor.uri,
			object: { id: f.message.uri, type: 'Tombstone', formerType: 'Note' },
		});

		expect(f.chatService.deleteRemoteMessage).toHaveBeenCalledWith(f.actor, f.message);
	});

	test('stores a tombstone when Delete arrives before Create', async () => {
		const f = createInbox();
		f.chatService.findMessageByUri.mockResolvedValue(null);

		await (f.inbox as never as { delete: (...args: unknown[]) => Promise<string> }).delete(f.actor, {
			type: 'Delete',
			actor: f.actor.uri,
			object: { id: 'https://remote.test/chat/messages/missing', type: 'Tombstone', formerType: 'Note' },
		});

		expect(f.redisClient.setex).toHaveBeenCalledWith(
			`chat_delete_upon_arrival:https://remote.test/chat/messages/missing:${encodeURIComponent(f.actor.uri)}`,
			6 * 60 * 60,
			f.actor.uri,
		);
	});

	test('routes EmojiReact to reactRemote', async () => {
		const f = createInbox();

		await (f.inbox as never as { like: (...args: unknown[]) => Promise<string> }).like(f.actor, {
			type: 'EmojiReact',
			actor: f.actor.uri,
			object: f.message.uri,
			content: '👍',
		});

		expect(f.chatService.reactRemote).toHaveBeenCalledWith(f.actor, f.message, '👍');
	});

	test('routes Undo EmojiReact to unreactRemote', async () => {
		const f = createInbox();
		const react = { type: 'EmojiReact', actor: f.actor.uri, object: f.message.uri, content: '👍' };

		await (f.inbox as never as { undo: (...args: unknown[]) => Promise<string> }).undo(f.actor, {
			type: 'Undo',
			actor: f.actor.uri,
			object: react,
		});

		expect(f.chatService.unreactRemote).toHaveBeenCalledWith(f.actor, f.message, '👍');
	});

	test.each(['Like', 'EmojiReaction'])('routes Undo %s of a chat reaction to unreactRemote', async (type) => {
		const f = createInbox();
		const react = { type, actor: f.actor.uri, object: f.message.uri, _misskey_reaction: '👍' };

		await (f.inbox as never as { undo: (...args: unknown[]) => Promise<string> }).undo(f.actor, {
			type: 'Undo',
			actor: f.actor.uri,
			object: react,
		});

		expect(f.chatService.unreactRemote).toHaveBeenCalledWith(f.actor, f.message, '👍');
	});

	test('skips a reaction rejected by the chat service instead of retrying the job', async () => {
		const f = createInbox();
		f.chatService.reactRemote.mockRejectedValue(new ChatMessageAccessError('deleted'));

		const result = await (f.inbox as never as { like: (...args: unknown[]) => Promise<string> }).like(f.actor, {
			type: 'EmojiReact',
			actor: f.actor.uri,
			object: f.message.uri,
			content: '👍',
		});

		expect(result).toBe('skip: deleted');
	});

	test('a reaction with a non-string value is skipped', async () => {
		const f = createInbox();

		const result = await (f.inbox as never as { like: (...args: unknown[]) => Promise<string> }).like(f.actor, {
			type: 'EmojiReact',
			actor: f.actor.uri,
			object: f.message.uri,
			content: { unexpected: true },
		});

		expect(result).toBe('skip: empty reaction');
		expect(f.chatService.reactRemote).not.toHaveBeenCalled();
	});
});

describe('chat custom emoji federation', () => {
	function createRenderer(localOnly = false) {
		return Object.assign(Object.create(ApRendererService.prototype), {
			config: { url: BASE },
			customEmojiService: { localEmojisCache: { fetch: async () => new Map([
				['wave', { name: 'wave', localOnly, publicUrl: 'https://local.test/wave.png', originalUrl: 'https://local.test/wave.png' }],
			]) } },
		}) as ApRendererService;
	}

	test.each([':wave:', ':wave@.:'])('attaches the public emoji image to %s reactions and Undo', async reaction => {
		const renderer = createRenderer();
		const activity = await renderer.renderChatReaction(message, alice as never, [bob as never], reaction);
		const undo = await renderer.renderChatReactionUndo(message, alice as never, [bob as never], reaction);
		const tag = [{ type: 'Emoji', name: ':wave:', icon: { type: 'Image', url: 'https://local.test/wave.png' } }];

		expect(activity).toMatchObject({ tag });
		expect(undo.object).toMatchObject({ id: activity.id, tag });
	});

	test('does not federate local-only emoji images', async () => {
		const renderer = createRenderer(true);
		const activity = await renderer.renderChatReaction(message, alice as never, [bob as never], ':wave:');
		const undo = await renderer.renderChatReactionUndo(message, alice as never, [bob as never], ':wave:');

		expect(activity.tag).toBeUndefined();
		expect(undo.object).not.toHaveProperty('tag');
	});

	test('imports the reaction emoji before storing its qualified name and removes it on Undo', async () => {
		const chatMessage = {
			id: 'm1', fromUserId: 'alice', toUserId: 'bob', toRoomId: null,
			deletedAt: null, reactions: [] as string[],
		};
		const queryBuilder = {
			update: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
			andWhere: vi.fn().mockReturnThis(),
			setParameter: vi.fn().mockReturnThis(), execute: vi.fn().mockResolvedValue({ affected: 1 }),
		};
		const publishChatUserStream = vi.fn();
		const chatService = Object.assign(Object.create(ChatService.prototype), {
			chatMessagesRepository: { findOneBy: async () => chatMessage, createQueryBuilder: () => queryBuilder },
			globalEventService: { publishChatUserStream },
		}) as ChatService;
		const extractEmojis = vi.fn(async () => []);
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			chatService,
			apNoteService: { extractEmojis },
			apResolverService: { createResolver: async () => ({ resolve: async (object: unknown) => object }) },
			logger: { info: vi.fn() },
		}) as ApInboxService;
		const activity = {
			type: 'EmojiReact', actor: bob.uri, object: message.uri, content: ':wave:',
			tag: [{ type: 'Emoji', name: ':wave:', icon: { type: 'Image', url: 'https://remote.test/wave.png' } }],
		};

		await inbox.performOneActivity(bob as never, activity);
		expect(extractEmojis).toHaveBeenCalledWith(activity.tag, 'remote.test');
		expect(chatMessage.reactions).toEqual(['bob/:wave@remote.test:']);
		expect(publishChatUserStream).toHaveBeenCalledWith('alice', 'bob', 'react', { messageId: 'm1', reaction: ':wave@remote.test:' });

		const undo = { type: 'Undo', actor: bob.uri, object: activity };
		await inbox.performOneActivity(bob as never, undo);
		expect(chatMessage.reactions).toEqual([]);
		expect(queryBuilder.setParameter).toHaveBeenLastCalledWith('pair', 'bob/:wave@remote.test:');
	});
});
