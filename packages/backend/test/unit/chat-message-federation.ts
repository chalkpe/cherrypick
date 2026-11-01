/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
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

	test('room update and delete carry Group/Tombstone objects', () => {
		const room = { id: 'r1', name: 'Room', description: 'desc' };
		const update = buildChatRoomUpdate(room, alice, [bob], options);
		const remove = buildChatRoomDelete(room, alice, [bob], options);

		expect(update.object).toMatchObject({ type: 'Group', name: 'Room', summary: 'desc' });
		expect(remove.object).toMatchObject({ type: 'Tombstone', formerType: 'Group' });
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
				update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
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
			customEmojiService: { localEmojisCache: { fetch: vi.fn().mockResolvedValue(new Map()) } },
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

	test('unreactRemote removes a member reaction', async () => {
		const f = createService();
		f.roomMessage.reactions = ['alice/👍'];

		await f.service.unreactRemote(f.alice as never, f.roomMessage as never, '👍');

		expect(f.roomMessage.reactions).toEqual([]);
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
		const redisClient = { exists: vi.fn().mockResolvedValue(0), setex: vi.fn().mockResolvedValue('OK') };
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			chatService,
			redisClient,
			apNoteService: { fetchNote: vi.fn().mockResolvedValue(null) },
			apResolverService: { createResolver: vi.fn(() => ({ resolve: async (x: unknown) => x })) },
			utilityService: { extractDbHost: () => 'remote.test' },
			apMfmService: { htmlToMfm: (html: string) => html },
			logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
			apPersonService: { resolvePerson: vi.fn() },
			apImageService: { resolveImage: vi.fn() },
			chatMessagesRepository: { findOneBy: vi.fn().mockResolvedValue(null) },
		}) as ApInboxService;

		return { inbox, actor, message, chatService, redisClient };
	}

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

		expect(f.chatService.updateRemoteMessage).toHaveBeenCalledWith(f.actor, f.message, 'edited', expect.any(Date));
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
			'chat_delete_upon_arrival:https://remote.test/chat/messages/missing',
			6 * 60 * 60,
			'1',
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
});
