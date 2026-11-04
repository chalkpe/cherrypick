/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { QueryFailedError } from 'typeorm';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatMessageAccessError, ChatService, ChatRoomArchivedError } from '@/core/ChatService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { Resolver } from '@/core/activitypub/ApResolverService.js';
import { StatusError } from '@/misc/status-error.js';
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
		expect(note.updated).toBe('2026-11-02T00:01:00.000Z');
	});

	test('group note uses a normal property for the room URI', () => {
		const note = buildChatNote(message, alice, [bob], 'r1', options);

		expect(note.context).toBe(`${BASE}/chat/rooms/r1`);
		expect(note._misskey_chatRoom).toBe(`${BASE}/chat/rooms/r1`);
		expect(note['@context']).toBeUndefined();
	});

	test('group note can use a mirror room URI from the owner host', () => {
		const note = buildChatNote(message, alice, [bob], 'r1', {
			...options,
			roomUri: 'https://remote.test/chat/rooms/r1',
		});

		expect(note.context).toBe('https://remote.test/chat/rooms/r1');
		expect(note._misskey_chatRoom).toBe('https://remote.test/chat/rooms/r1');
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

	test.each([':wave:', ':wave@.:'])('federates the custom emoji reaction %s as an unqualified name', (reaction) => {
		const react = buildChatReaction(message, alice, [bob], reaction, options);
		const undo = buildChatReactionUndo(message, alice, [bob], reaction, options);

		expect(react.content).toBe(':wave:');
		expect(react._misskey_reaction).toBe(':wave:');
		expect(undo.object).toMatchObject({ content: ':wave:', _misskey_reaction: ':wave:' });
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

	test.each([true, false])('room update sends the archived state %s, including when false', (isArchived) => {
		const activity = buildChatRoomUpdate({ id: 'r1', name: 'Room', isArchived }, alice, [bob], options);

		expect(JSON.parse(JSON.stringify(activity)).object._misskey_chatArchived).toBe(isArchived);
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
				isLocalUser: (user: { host: string | null }) => user.host == null,
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

	test('derives a remote mirror room URI when the stored uri is missing', () => {
		const renderer = createRenderer();
		const room = renderer.renderChatRoom({ id: 'r1', name: 'Room', description: '' }, bob as never);

		expect(room.id).toBe('https://remote.test/chat/rooms/r1');
	});

	test('a room object always names its description, so that an Invite can clear the one on a mirror', () => {
		const renderer = createRenderer();

		expect(renderer.renderChatRoom({ id: 'r1', name: 'Room', description: '' }, bob as never).summary).toBe('');
		expect(renderer.renderChatRoom({ id: 'r1', name: 'Room', description: null }, bob as never).summary).toBe('');
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
			text: 'old', editedAt: null, deletedAt: null as Date | null, reactions: [] as string[], emojis: [], uri: null as string | null,
		};
		const roomMessage = {
			id: 'm2', fromUserId: 'bob', toUserId: null, toRoomId: 'r1',
			text: 'room', editedAt: null, deletedAt: null as Date | null, reactions: [] as string[], emojis: [], uri: null as string | null,
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

		const roomQueryBuilder = {
			pending: {} as Record<string, unknown>,
			update: vi.fn().mockReturnThis(),
			set: vi.fn(function (this: typeof roomQueryBuilder, patch: Record<string, unknown>) {
				Object.assign(roomQueryBuilder.pending, patch);
				return this;
			}),
			where: vi.fn().mockReturnThis(),
			returning: vi.fn().mockReturnThis(),
			execute: vi.fn(async () => {
				Object.assign(room, roomQueryBuilder.pending);
				return { raw: [room] };
			}),
		};

		const queueService = { deliver: vi.fn() };
		const apRendererService = {
			renderChatUpdate: vi.fn().mockReturnValue({ type: 'Update' }),
			renderChatDelete: vi.fn().mockReturnValue({ type: 'Delete' }),
			renderChatReaction: vi.fn().mockReturnValue({ type: 'EmojiReact' }),
			renderChatReactionUndo: vi.fn().mockReturnValue({ type: 'Undo' }),
			renderChatRoomUpdate: vi.fn().mockReturnValue({ type: 'Update' }),
			renderChatRoomDelete: vi.fn().mockReturnValue({ type: 'Delete' }),
			addContext: vi.fn((activity: unknown) => activity),
		};
		const globalEventService = {
			publishChatUserStream: vi.fn(),
			publishChatRoomStream: vi.fn(),
		};
		const redisPipeline = {
			del: vi.fn().mockReturnThis(),
			srem: vi.fn().mockReturnThis(),
			exec: vi.fn().mockResolvedValue([]),
		};
		const pendingReactions = new Map<string, string[]>();
		const pendingReactionCounts = new Map<string, number>();
		const reactionActivityIds = new Map<string, string>();
		const redisClient = {
			pipeline: vi.fn(() => redisPipeline),
			multi: () => {
				const commands: (() => unknown)[] = [];
				const transaction = {
					rpush: (key: string, value: string) => {
						commands.push(() => {
							const events = pendingReactions.get(key) ?? [];
							pendingReactions.set(key, events);
							return events.push(value);
						});
						return transaction;
					},
					ltrim: (key: string, start: number, stop: number) => {
						commands.push(() => pendingReactions.set(key, (pendingReactions.get(key) ?? []).slice(start, stop + 1)));
						return transaction;
					},
					expire: () => {
						commands.push(() => 1);
						return transaction;
					},
					incr: (key: string) => {
						commands.push(() => {
							const count = (pendingReactionCounts.get(key) ?? 0) + 1;
							pendingReactionCounts.set(key, count);
							return count;
						});
						return transaction;
					},
					lrange: (key: string) => {
						commands.push(() => [...(pendingReactions.get(key) ?? [])]);
						return transaction;
					},
					del: (key: string) => {
						commands.push(() => pendingReactions.delete(key));
						return transaction;
					},
					exec: async () => commands.map(command => [null, command()]),
				};
				return transaction;
			},
			get: vi.fn(async (key: string) => reactionActivityIds.get(key) ?? null),
			expire: vi.fn().mockResolvedValue(1),
			setex: vi.fn(async (key: string, _ttl: number, value: string) => {
				reactionActivityIds.set(key, value);
				return 'OK';
			}),
			del: vi.fn(async (key: string) => {
				pendingReactions.delete(key);
				reactionActivityIds.delete(key);
				return 1;
			}),
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
				createQueryBuilder: vi.fn(() => roomQueryBuilder),
				delete: vi.fn(async () => ({ affected: 1 })),
			},
			chatRoomMembershipsRepository: {
				findBy: vi.fn(async () => [{ roomId: 'r1', userId: 'bob' }, { roomId: 'r1', userId: 'carol' }]),
				findOneBy: vi.fn(async ({ roomId, userId }: { roomId: string; userId: string }) =>
					roomId === 'r1' && (userId === 'bob' || userId === 'carol') ? { roomId, userId } : null),
			},
			chatRoomInvitationsRepository: {
				findBy: vi.fn(async () => []),
			},
			usersRepository: {
				findOneBy: vi.fn(async ({ id }: { id: string }) => users.get(id) ?? null),
				findOneByOrFail: vi.fn(async ({ id }: { id: string }) => users.get(id)),
				findBy: vi.fn(async ({ id }: { id: { value: string[] } }) => (id.value ?? []).map(value => users.get(value)).filter(Boolean)),
			},
			userEntityService: {
				isLocalUser: (user: { host: string | null }) => user.host == null,
				isRemoteUser: (user: { host: string | null }) => user.host != null,
				genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
				pack: vi.fn(async (id: string) => users.get(id)),
			},
			globalEventService,
			liveKitService: {
				deleteRoom: vi.fn().mockResolvedValue(undefined),
			},
			roleService: {
				isModerator: vi.fn(async (user: { id: string }) => user.id === 'moderator'),
			},
			moderationLogService: {
				log: vi.fn(),
			},
			redisClient,
			apRendererService,
			queueService,
			customEmojiService: {
				localEmojisCache: { fetch: vi.fn().mockResolvedValue(new Map()) },
				populateEmojis: vi.fn().mockResolvedValue({}),
			},
			userBlockingService: { checkBlocked: vi.fn().mockResolvedValue(false) },
		}) as ChatService;

		return { service, alice, bob, carol, directMessage, roomMessage, roomDeleteMessage, room, queueService, apRendererService, globalEventService, redisClient };
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

	test('a server with several members gets one copy at its shared inbox', async () => {
		const f = createService();
		Object.assign(f.bob, { sharedInbox: 'https://remote.test/inbox' });
		Object.assign(f.carol, { sharedInbox: 'https://remote.test/inbox' });

		await f.service.deleteMessage(f.roomDeleteMessage as never);

		expect(f.queueService.deliver).toHaveBeenCalledOnce();
		expect(f.queueService.deliver).toHaveBeenCalledWith(f.alice, expect.objectContaining({ type: 'Delete' }), 'https://remote.test/inbox', true);
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

	test('reuses the original reaction activity id for Undo', async () => {
		const f = createService();

		await f.service.react('m2', 'alice', '👍');
		const reactionActivityId = (f.apRendererService.renderChatReaction as ReturnType<typeof vi.fn>).mock.calls[0][4] as string;
		await f.service.unreact('m2', 'alice', '👍');
		const undoActivityId = (f.apRendererService.renderChatReactionUndo as ReturnType<typeof vi.fn>).mock.calls[0][4] as string;

		expect(reactionActivityId).toContain('/chat-reactions/');
		expect(undoActivityId).toBe(reactionActivityId);
	});

	test('1:1 unreact events include the reacting user', async () => {
		const f = createService();

		await f.service.unreact('m1', 'bob', '👍');

		expect(f.globalEventService.publishChatUserStream).toHaveBeenCalledWith(
			'alice',
			'bob',
			'unreact',
			expect.objectContaining({ user: expect.objectContaining({ id: 'bob' }) }),
		);
	});

	test('remote 1:1 unreact events include the reacting user', async () => {
		const f = createService();

		await f.service.unreactRemote(f.bob as never, f.directMessage as never, '👍');

		expect(f.globalEventService.publishChatUserStream).toHaveBeenCalledWith(
			'alice',
			'bob',
			'unreact',
			expect.objectContaining({ user: expect.objectContaining({ id: 'bob' }) }),
		);
	});

	test.each([
		{ events: ['undo1', 'react1'], expected: [] },
		{ events: ['react1', 'undo1', 'react1'], expected: [] },
		{ events: ['react2', 'react1', 'undo1'], expected: ['bob/👍'] },
		{ events: ['undo1', 'react2', 'react1'], expected: ['bob/👍'] },
	])('keeps reaction identity across reordered $events', async ({ events, expected }) => {
		const f = createService();
		for (const event of events) {
			const method = event.startsWith('undo') ? 'unreactRemote' : 'reactRemote';
			await f.service[method](f.bob as never, f.directMessage as never, '👍', `https://remote.test/reactions/${event.at(-1)}`);
		}
		expect(f.directMessage.reactions).toEqual(expected);
	});

	test('preserves reaction cancellation when the events arrive before the message', async () => {
		const f = createService();
		f.directMessage.uri = 'https://local.test/chat/messages/m1';
		const activityId = 'https://remote.test/reactions/1';
		await f.service.storePendingChatReaction(f.bob.id, f.directMessage.uri, '👍', true, activityId);
		await f.service.storePendingChatReaction(f.bob.id, f.directMessage.uri, '👍', false, activityId);

		await f.service.applyPendingChatReactions(f.directMessage as never);

		expect(f.directMessage.reactions).toEqual([]);
	});

	test('bounds remembered reaction IDs per actor', async () => {
		const f = createService();
		for (let i = 0; i < 1000; i++) {
			await f.service.unreactRemote(f.bob as never, f.directMessage as never, '👍', `https://remote.test/reactions/${i}`);
		}
		await expect(f.service.reactRemote(f.bob as never, f.directMessage as never, '👍', 'https://remote.test/reactions/overflow')).rejects.toThrow('too many reaction activities');
		expect(f.directMessage.reactions).toEqual([]);
	});

	test.each([0, {}, '', 'x'.repeat(2049)])('rejects malformed reaction IDs (%j)', async (activityId) => {
		const f = createService();
		await expect(f.service.reactRemote(f.bob as never, f.directMessage as never, '👍', activityId as never)).rejects.toThrow('invalid reaction id');
		expect(await f.service.storePendingChatReaction(f.bob.id, 'https://local.test/chat/messages/m1', '👍', false, activityId as never)).toBe(false);
	});

	test('room updates publish a stream event and federate to remote members', async () => {
		const f = createService();

		const updated = await f.service.updateRoom(f.room as never, { name: 'renamed' });

		expect(updated.name).toBe('renamed');
		expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith('r1', 'roomUpdated', expect.objectContaining({ roomId: 'r1', name: 'renamed' }));
		expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
	});

	test('room updates can skip federation for an inbound remote update', async () => {
		const f = createService();

		await f.service.updateRoom(f.room as never, { name: 'remote rename' }, { federate: false });

		expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith('r1', 'roomUpdated', expect.objectContaining({ name: 'remote rename' }));
		expect(f.queueService.deliver).not.toHaveBeenCalled();
	});

	test('room updates publish the archived state', async () => {
		const f = createService();

		await f.service.updateRoom(f.room as never, { isArchived: true }, { federate: false });

		expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith('r1', 'roomUpdated', expect.objectContaining({ roomId: 'r1', isArchived: true }));
	});

	describe('the owner archiving a room', () => {
		test('federates the state to members and pending invitees and ends the call', async () => {
			const f = createService();
			const dave = { id: 'dave', host: 'invited.test', uri: 'https://invited.test/users/dave', inbox: 'https://invited.test/users/dave/inbox' };
			Object.assign(f.service, {
				chatRoomInvitationsRepository: { findBy: vi.fn(async () => [{ roomId: 'r1', userId: 'dave' }]) },
			});
			const service = f.service as never as { usersRepository: { findBy: ReturnType<typeof vi.fn> }; liveKitService: { deleteRoom: ReturnType<typeof vi.fn> } };
			const members = [f.alice, f.bob, f.carol];
			service.usersRepository.findBy.mockImplementation(async ({ id }: { id: { value: string[] } }) => id.value.includes('dave') ? [dave] : members);

			await f.service.updateRoom(f.room as never, { isArchived: true });

			const inboxes = f.queueService.deliver.mock.calls.map(call => call[2]);
			expect(inboxes.sort()).toEqual([f.carol.inbox, dave.inbox, f.bob.inbox].sort());
			expect(service.liveKitService.deleteRoom).toHaveBeenCalledWith('r1');
		});

		test('unarchiving does not touch the call', async () => {
			const f = createService();
			Object.assign(f.room, { isArchived: true });

			await f.service.updateRoom(f.room as never, { isArchived: false });

			expect((f.service as never as { liveKitService: { deleteRoom: ReturnType<typeof vi.fn> } }).liveKitService.deleteRoom).not.toHaveBeenCalled();
		});

		test('an inbound update to a mirror leaves the call of the owner server alone', async () => {
			const f = createService();
			Object.assign(f.room, { ownerId: 'bob' });

			await f.service.updateRoom(f.room as never, { isArchived: true }, { federate: false });

			expect((f.service as never as { liveKitService: { deleteRoom: ReturnType<typeof vi.fn> } }).liveKitService.deleteRoom).not.toHaveBeenCalled();
		});

		test('refuses new invitations', async () => {
			const f = createService();
			Object.assign(f.room, { isArchived: true });

			await expect(f.service.createRoomInvitation('alice', 'r1', 'carol')).rejects.toBeInstanceOf(ChatRoomArchivedError);
			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});
	});

	describe('remote activity in an archived room', () => {
		function archivedBy(ownerId: 'alice' | 'bob') {
			const f = createService();
			Object.assign(f.room, { isArchived: true, ownerId });
			return f;
		}

		test('a room this server owns refuses a message for good, so the inbox does not retry it', async () => {
			const f = archivedBy('alice');

			await expect(f.service.createMessageToRoom(f.bob, f.room as never, { text: 'late', uri: 'https://remote.test/m' })).rejects.toBeInstanceOf(ChatMessageAccessError);
			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});

		test('a room this server owns refuses an edit', async () => {
			const f = archivedBy('alice');

			await expect(f.service.updateRemoteMessage(f.bob as never, f.roomMessage as never, 'changed', new Date('2026-11-02T00:02:00.000Z'))).rejects.toBeInstanceOf(ChatMessageAccessError);
			expect(f.roomMessage.text).toBe('room');
		});

		test.each(['reactRemote', 'unreactRemote'] as const)('a room this server owns refuses %s', async (method) => {
			const f = archivedBy('alice');

			await expect(f.service[method](f.carol as never, f.roomMessage as never, '👍')).rejects.toBeInstanceOf(ChatMessageAccessError);
		});

		test('a mirror still accepts what crossed the archive notification', async () => {
			const f = archivedBy('bob');

			await f.service.updateRemoteMessage(f.bob as never, f.roomMessage as never, 'changed', new Date('2026-11-02T00:02:00.000Z'));
			const sent = await f.service.createMessageToRoom(f.carol, f.room as never, { text: 'late', uri: 'https://other.test/m' }).catch((err: unknown) => err);

			expect(f.roomMessage.text).toBe('changed');
			expect(sent).not.toBeInstanceOf(ChatMessageAccessError);
			expect(sent).not.toBeInstanceOf(ChatRoomArchivedError);
		});

		test('a member can still delete their message, like on Mastodon', async () => {
			const f = archivedBy('alice');

			await f.service.deleteRemoteMessage(f.bob as never, f.roomMessage as never);

			expect(f.roomMessage.deletedAt).not.toBeNull();
		});
	});

	describe('archived rooms are read-only for local users', () => {
		function archived() {
			const f = createService();
			Object.assign(f.room, { isArchived: true });
			return f;
		}

		test('a local user cannot send a message', async () => {
			const f = archived();

			await expect(f.service.createMessageToRoom(f.alice, f.room as never, { text: 'hello' })).rejects.toBeInstanceOf(ChatRoomArchivedError);
			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});

		test('a local user cannot edit a message', async () => {
			const f = archived();

			await expect(f.service.updateMessage('alice', 'm3', 'edited')).rejects.toBeInstanceOf(ChatRoomArchivedError);
			expect(f.roomDeleteMessage.text).toBe('room');
			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});

		test('a local user cannot delete a message', async () => {
			const f = archived();

			await expect(f.service.deleteMessage(f.roomDeleteMessage as never)).rejects.toBeInstanceOf(ChatRoomArchivedError);
			expect(f.roomDeleteMessage.deletedAt).toBeNull();
			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});

		test.each(['react', 'unreact'] as const)('a local user cannot %s to a message', async (method) => {
			const f = archived();

			await expect(f.service[method]('m2', 'alice', '👍')).rejects.toBeInstanceOf(ChatRoomArchivedError);
			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});

		test('a local user cannot join, and keeps the invitation', async () => {
			const f = archived();
			const invitations = {
				findOneBy: vi.fn(async () => ({ id: 'inv', roomId: 'r1', userId: 'alice' })),
				delete: vi.fn(),
			};
			Object.assign(f.service, { chatRoomInvitationsRepository: invitations });

			await expect(f.service.joinToRoom('alice', 'r1')).rejects.toBeInstanceOf(ChatRoomArchivedError);
			expect(invitations.delete).not.toHaveBeenCalled();
		});

		test('direct messages are unaffected', async () => {
			const f = archived();

			await expect(f.service.updateMessage('alice', 'm1', 'edited')).resolves.toMatchObject({ text: 'edited' });
		});
	});

	test('moderators deleting another user room still federate the room deletion', async () => {
		const f = createService();
		const moderator = { id: 'moderator', host: null, uri: null };

		await f.service.deleteRoom(f.room as never, moderator as never);

		expect(f.queueService.deliver).toHaveBeenCalledTimes(2);
		expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith('r1', 'roomDeleted');
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

	test('applies a deferred reaction once the message exists', async () => {
		const f = createService();
		f.roomMessage.uri = 'https://remote.test/chat/messages/m2';
		const reactRemote = vi.spyOn(f.service, 'reactRemote').mockResolvedValue(undefined);

		await f.service.storePendingChatReaction('bob', f.roomMessage.uri, '👍', false);
		await f.service.applyPendingChatReactions(f.roomMessage as never);

		expect(reactRemote).toHaveBeenCalledWith(f.bob, f.roomMessage, '👍', undefined);
	});

	test('applies a deferred unreaction once the message exists', async () => {
		const f = createService();
		f.roomMessage.uri = 'https://remote.test/chat/messages/m2';
		const unreactRemote = vi.spyOn(f.service, 'unreactRemote').mockResolvedValue(undefined);

		await f.service.storePendingChatReaction('bob', f.roomMessage.uri, '👍', true);
		await f.service.applyPendingChatReactions(f.roomMessage as never);

		expect(unreactRemote).toHaveBeenCalledWith(f.bob, f.roomMessage, '👍', undefined);
	});

	test.each([
		{ events: [false, true], expected: [] },
		{ events: [false, true, false], expected: ['carol/👍'] },
		{ events: [true, false, true], expected: [] },
	])('preserves deferred reaction order for $events', async ({ events, expected }) => {
		const f = createService();
		f.roomMessage.uri = 'https://remote.test/chat/messages/m2';

		for (const undo of events) {
			await f.service.storePendingChatReaction('carol', f.roomMessage.uri, '👍', undo);
		}
		await f.service.applyPendingChatReactions(f.roomMessage as never);

		expect(f.roomMessage.reactions).toEqual(expected);
	});

	test('reactRemote qualifies an unqualified custom emoji with the actor host', async () => {
		const f = createService();

		await f.service.reactRemote(f.carol as never, f.roomMessage as never, ':wave:');

		expect(f.roomMessage.reactions).toEqual(['carol/:wave@other.test:']);
	});

	test('scopes the custom emoji name that CherryPick federates to the actor host, and removes it on Undo', async () => {
		const f = createService();
		const sent = buildChatReaction(f.roomMessage as never, f.carol as never, [], ':wave:', options).content!;
		expect(sent).toBe(':wave:');

		await f.service.reactRemote(f.carol as never, f.roomMessage as never, sent);
		expect(f.roomMessage.reactions).toEqual(['carol/:wave@other.test:']);

		await f.service.unreactRemote(f.carol as never, f.roomMessage as never, sent);
		expect(f.roomMessage.reactions).toEqual([]);
	});

	test('does not defer a reaction string that cannot be a reaction', async () => {
		const f = createService();

		expect(await f.service.storePendingChatReaction('carol', 'https://remote.test/chat/messages/m2', `:${'x'.repeat(300)}:`, false)).toBe(false);
	});

	test('caps deferred reactions per actor across message URIs', async () => {
		const f = createService();
		const results = [];
		for (let i = 0; i < 1001; i++) {
			results.push(await f.service.storePendingChatReaction('carol', `https://remote.test/chat/messages/m${i}`, '👍', false));
		}

		expect(results.slice(0, 1000).every(stored => stored)).toBe(true);
		expect(results[1000]).toBe(false);
		expect(await f.service.storePendingChatReaction('bob', 'https://remote.test/chat/messages/m0', '👍', false)).toBe(true);
	});

	test('does not track or render a reaction when every participant is local', async () => {
		const f = createService();
		const participants = vi.spyOn(f.service as never as { participantsForMessage: () => Promise<unknown[]> }, 'participantsForMessage')
			.mockResolvedValue([{ id: 'alice', host: null }, { id: 'erin', host: null }]);
		Object.assign(f.directMessage, { fromUserId: 'erin', toUserId: 'alice' });

		await f.service.react(f.directMessage.id, 'alice', '👍');
		await f.service.unreact(f.directMessage.id, 'alice', '👍');

		expect(participants).toHaveBeenCalledTimes(2);
		expect(f.redisClient.setex).not.toHaveBeenCalled();
		expect(f.apRendererService.renderChatReaction).not.toHaveBeenCalled();
		expect(f.apRendererService.renderChatReactionUndo).not.toHaveBeenCalled();
	});

	test('local reactions and unreactions reject a deleted message', async () => {
		const f = createService();
		f.roomMessage.deletedAt = new Date();

		await expect(f.service.react('m2', 'alice', '👍')).rejects.toThrow('deleted');
		await expect(f.service.unreact('m2', 'alice', '👍')).rejects.toThrow('deleted');
	});

	test('findMessageByUri resolves a local message without a stored URI', async () => {
		const f = createService();

		await expect(f.service.findMessageByUri('https://local.test/chat/messages/m1')).resolves.toBe(f.directMessage);
	});

	test.each(['reactRemote', 'unreactRemote'] as const)('%s refuses instead of failing the job when the room is being deleted', async (method) => {
		const f = createService();
		f.roomMessage.toRoomId = 'gone';

		await expect(f.service[method](f.alice as never, f.roomMessage as never, '👍')).rejects.toBeInstanceOf(ChatMessageAccessError);
	});

	test('unreactRemote announces nothing when another copy of the Undo already removed the reaction', async () => {
		const f = createService();
		f.roomMessage.reactions = [];
		const repository = (f.service as never as { chatMessagesRepository: { createQueryBuilder: () => { execute: ReturnType<typeof vi.fn> } } }).chatMessagesRepository;
		repository.createQueryBuilder().execute.mockResolvedValueOnce({ affected: 0 });

		await f.service.unreactRemote(f.carol as never, f.roomMessage as never, '👍');

		expect(f.globalEventService.publishChatRoomStream).not.toHaveBeenCalled();
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

		test('a remote user blocked by the author cannot react to a direct message', async () => {
			const f = createService();
			const blocking = (f.service as never as { userBlockingService: { checkBlocked: ReturnType<typeof vi.fn> } }).userBlockingService;
			blocking.checkBlocked.mockResolvedValue(true);

			await expect(f.service.reactRemote(f.bob as never, f.directMessage as never, '👍')).rejects.toBeInstanceOf(ChatMessageAccessError);

			expect(blocking.checkBlocked).toHaveBeenCalledWith('alice', 'bob');
			expect(f.directMessage.reactions).toEqual([]);
			expect(f.globalEventService.publishChatUserStream).not.toHaveBeenCalled();
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

		test('a room deletion also reaches a remote user who has not accepted yet', async () => {
			const owner = { id: 'alice', host: null, uri: null, inbox: null };
			const f = createRoomService(owner);
			const dave = { id: 'dave', host: 'pending.test', uri: 'https://pending.test/users/dave', inbox: 'https://pending.test/users/dave/inbox' };
			const s = f.service as never as {
				chatRoomInvitationsRepository: { findBy: ReturnType<typeof vi.fn> };
				usersRepository: { findBy: ReturnType<typeof vi.fn> };
			};
			s.chatRoomInvitationsRepository.findBy = vi.fn(async () => [{ roomId: 'r1', userId: 'dave' }]);
			s.usersRepository.findBy = vi.fn(async ({ id }: { id: { value: string[] } }) => [owner, f.bob, f.carol, dave].filter(user => id.value.includes(user.id)));

			await f.service.deleteRoom(f.room as never);

			expect(f.queueService.deliver).toHaveBeenCalledWith(owner, expect.objectContaining({ type: 'Delete' }), dave.inbox, false);
			expect(f.apRendererService.renderChatRoomDelete).toHaveBeenCalledWith(f.room, owner, expect.arrayContaining([dave]));
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

	test('unreactRemote removes a remote custom emoji reaction', async () => {
		const f = createService();
		f.roomMessage.reactions = ['carol/:wave@other.test:'];

		await f.service.unreactRemote(f.carol as never, f.roomMessage as never, ':wave:');

		expect(f.roomMessage.reactions).toEqual([]);
	});

	describe('relaying a remote member message', () => {
		afterEach(() => vi.useRealTimers());

		function createRelayService(ownerId: string) {
			vi.useFakeTimers();
			const f = createService();
			const dave = { id: 'dave', host: 'remote.test', uri: 'https://remote.test/users/dave', inbox: 'https://remote.test/users/dave/inbox' };
			const erin = { id: 'erin', host: 'third.test', uri: 'https://third.test/users/erin', inbox: 'https://third.test/users/erin/inbox' };
			const users = new Map([f.alice, f.bob, f.carol, dave, erin].map(user => [user.id, user]));
			const pipeline = { set: vi.fn().mockReturnThis(), sadd: vi.fn().mockReturnThis(), get: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) };
			const renderChatRoomRelay = vi.fn((_message: unknown, owner: unknown, toUsers: unknown) => ({ type: 'Announce', owner, toUsers }));
			Object.assign((f.service as never as { apRendererService: object }).apRendererService, {
				renderChatRoomRelay,
				renderChatMessage: vi.fn(async () => ({ type: 'Note' })),
			});
			Object.assign((f.service as never as { redisClient: object }).redisClient, { pipeline: () => pipeline });
			Object.assign((f.service as never as { chatMessagesRepository: object }).chatMessagesRepository, {
				insertOne: vi.fn(async (message: object) => message),
			});
			Object.assign((f.service as never as { chatRoomMembershipsRepository: object }).chatRoomMembershipsRepository, {
				findBy: vi.fn(async () => ['alice', 'bob', 'carol', 'dave', 'erin'].filter(id => id !== ownerId).map(userId => ({ roomId: 'r1', userId, isMuted: false }))),
			});
			Object.assign((f.service as never as { usersRepository: object }).usersRepository, {
				findOneBy: vi.fn(async ({ id }: { id: string }) => users.get(id) ?? null),
				findOneByOrFail: vi.fn(async ({ id }: { id: string }) => users.get(id)),
				findBy: vi.fn(async ({ id }: { id: { value: string[] } }) => id.value.map(value => users.get(value)).filter(Boolean)),
			});
			Object.assign(f.service, {
				idService: { gen: () => 'new-message', parse: () => ({ date: new Date(0) }) },
				chatEntityService: { packMessageLiteForRoom: vi.fn(async (message: object) => message) },
			});
			const room = { id: 'r1', ownerId, isArchived: false, uri: null };
			return { ...f, room, dave, erin, renderChatRoomRelay };
		}

		const params = { text: 'hello', uri: 'https://remote.test/chat/messages/from-bob', emojis: [] };

		test('the owner server relays it to the members on other servers', async () => {
			const f = createRelayService('alice');

			await f.service.createMessageToRoom(f.bob as never, f.room as never, params);

			expect(f.renderChatRoomRelay).toHaveBeenCalledOnce();
			const inboxes = f.queueService.deliver.mock.calls.map(call => call[2]);
			expect(inboxes.sort()).toEqual([f.carol.inbox, f.erin.inbox].sort());
			for (const call of f.queueService.deliver.mock.calls) {
				expect(call[0]).toBe(f.alice);
				expect(call[1]).toMatchObject({ type: 'Announce' });
			}
		});

		test('the relay does not return to any member on the sender server', async () => {
			const f = createRelayService('alice');

			await f.service.createMessageToRoom(f.bob as never, f.room as never, params);

			expect(f.queueService.deliver.mock.calls.map(call => call[2])).not.toContain(f.dave.inbox);
			expect(f.queueService.deliver.mock.calls.map(call => call[2])).not.toContain(f.bob.inbox);
		});

		test('a mirror of a remote room does not relay', async () => {
			const f = createRelayService('carol');

			await f.service.createMessageToRoom(f.bob as never, f.room as never, params);

			expect(f.renderChatRoomRelay).not.toHaveBeenCalled();
			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});

		test('a local sender still delivers its own Create instead of a relay', async () => {
			const f = createRelayService('alice');

			await f.service.createMessageToRoom({ ...f.alice, username: 'alice' } as never, f.room as never, { text: 'hello' });

			expect(f.renderChatRoomRelay).not.toHaveBeenCalled();
			expect(f.queueService.deliver.mock.calls.every(call => (call[1] as { type: string }).type === 'Create')).toBe(true);
		});

		test('the Create also names the room in the @context of its Note, the only place earlier servers read it', async () => {
			const f = createRelayService('alice');

			await f.service.createMessageToRoom({ ...f.alice, username: 'alice' } as never, f.room as never, { text: 'hello' });

			expect(f.queueService.deliver).toHaveBeenCalled();
			for (const call of f.queueService.deliver.mock.calls) {
				expect((call[1] as { object: Record<string, unknown> }).object['@context']).toEqual(expect.stringMatching(/\/chat\/rooms\/r1$/));
			}
		});
	});

	test('a room owner sending an update states when the state was current', () => {
		const update = buildChatRoomUpdate(
			{ id: 'r1', name: 'room' },
			alice,
			[bob],
			{ baseUrl: BASE, updated: '2026-11-03T00:00:00.000Z' },
		);

		expect((update.object as { updated?: string }).updated).toBe('2026-11-03T00:00:00.000Z');
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
			storePendingChatReaction: vi.fn().mockResolvedValue(true),
			applyPendingChatReactions: vi.fn().mockResolvedValue(undefined),
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
			scard: vi.fn().mockResolvedValue(0),
			sadd: vi.fn().mockResolvedValue(1),
			expire: vi.fn().mockResolvedValue(1),
			llen: vi.fn().mockResolvedValue(0),
			multi: () => {
				const transaction = {
					rpush: () => transaction,
					expire: () => transaction,
					lrange: () => transaction,
					del: () => transaction,
					exec: async () => [[null, []], [null, 0]],
				};
				return transaction;
			},
		};
		const chatRoomsRepository = { findOneBy: vi.fn().mockResolvedValue({ id: 'r1', uri: 'https://remote.test/chat/rooms/r1' }) };
		const apPersonService = { resolvePerson: vi.fn(async (uri: string) => uri === localUser.uri ? localUser : null) };
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			chatService,
			redisClient,
			apNoteService: { fetchNote: vi.fn().mockResolvedValue(null), extractEmojis: vi.fn().mockResolvedValue([]) },
			apResolverService: { createResolver: vi.fn(() => ({ resolve: async (x: unknown) => x })) },
			utilityService: { extractDbHost: (uri: string) => new URL(uri).host, punyHost: (uri: string) => new URL(uri).host, isFederationAllowedUri: () => true },
			apMfmService: { htmlToMfm: (html: string) => html },
			logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
			apPersonService,
			apImageService: { resolveImage: vi.fn() },
			roleService: { getUserPolicies: vi.fn().mockResolvedValue({ chatAvailability: 'available' }) },
			userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null, isRemoteUser: (user: { host: string | null }) => user.host != null },
			chatRoomsRepository,
			chatMessagesRepository: { findOneBy: vi.fn().mockResolvedValue(null) },
		}) as ApInboxService;

		return { inbox, actor, message, chatService, redisClient, chatRoomsRepository, localUser };
	}

	describe('a message with nothing to show', () => {
		const note = (actorUri: string, to: string, overrides: Record<string, unknown>) => ({
			id: 'https://remote.test/chat/messages/empty',
			type: 'Note',
			attributedTo: actorUri,
			to: [to],
			_misskey_talk: true,
			...overrides,
		});
		const create = (f: ReturnType<typeof createInbox>, object: unknown, type = 'Create') => (f.inbox as never as { createChatMessage: (...args: unknown[]) => Promise<string> }).createChatMessage(
			{ resolve: async (x: unknown) => x },
			f.actor,
			object,
			{ type },
		);

		test('is not stored as an empty bubble', async () => {
			const f = createInbox();

			await expect(create(f, note(f.actor.uri, f.localUser.uri, { content: '  ' }))).resolves.toBe('skip: chat message has no content');

			expect(f.chatService.createMessageToUser).not.toHaveBeenCalled();
		});

		test('is retried when only its attachment failed to download', async () => {
			const f = createInbox();
			(f.inbox as never as { apImageService: { resolveImage: ReturnType<typeof vi.fn> } }).apImageService.resolveImage.mockRejectedValue(new Error('timeout'));

			await expect(create(f, note(f.actor.uri, f.localUser.uri, { content: '', attachment: [{ type: 'Document', url: 'https://remote.test/file.png' }] }))).rejects.toThrow('attachment');

			expect(f.chatService.createMessageToUser).not.toHaveBeenCalled();
		});

		test('keeps its text when the attachment beside it failed to download', async () => {
			const f = createInbox();
			(f.inbox as never as { apImageService: { resolveImage: ReturnType<typeof vi.fn> } }).apImageService.resolveImage.mockRejectedValue(new Error('timeout'));

			await create(f, note(f.actor.uri, f.localUser.uri, { content: 'hello', attachment: [{ type: 'Document', url: 'https://remote.test/file.png' }] }));

			expect(f.chatService.createMessageToUser).toHaveBeenCalledOnce();
		});

		test.each([
			['the Update names no attachment', {}],
			['the attachment in the Update failed to download', { attachment: [{ type: 'Document', url: 'https://remote.test/file.png' }] }],
		])('an edit can still clear the text of a stored message with a file when %s', async (_name, overrides) => {
			const f = createInbox();
			const stored = { ...f.message, fileId: 'file1' };
			const { chatMessagesRepository, apImageService } = f.inbox as never as {
				chatMessagesRepository: { findOneBy: ReturnType<typeof vi.fn> };
				apImageService: { resolveImage: ReturnType<typeof vi.fn> };
			};
			chatMessagesRepository.findOneBy.mockResolvedValue(stored);
			apImageService.resolveImage.mockRejectedValue(new Error('timeout'));

			await expect(create(f, note(f.actor.uri, f.localUser.uri, { content: '', ...overrides }), 'Update')).resolves.toBe('ok: chat message updated');

			expect(f.chatService.updateRemoteMessage).toHaveBeenCalledWith(f.actor, stored, '', expect.any(Date), []);
		});
	});

	test('Delete of an actor does not look for a chat message', async () => {
		const f = createInbox();

		await (f.inbox as never as { delete: (...args: unknown[]) => Promise<string> }).delete(f.actor, { type: 'Delete', actor: f.actor.uri, object: f.actor.uri }).catch(() => undefined);

		expect(f.chatService.findMessageByUri).not.toHaveBeenCalled();
	});

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
			context: 'https://remote.test/chat/rooms/r1',
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

	test('accepts the legacy room URI in @context', async () => {
		const f = createInbox();
		f.chatService.isRoomMember.mockResolvedValue(true);
		const object = {
			id: 'https://remote.test/chat/messages/group-2',
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
	});

	test.each(['missing room', 'pending invitation'])('retries a group Create while waiting for %s', async (state) => {
		const f = createInbox();
		const rooms = { findOneBy: vi.fn().mockResolvedValue(state === 'missing room' ? null : { id: 'r1' }) };
		Object.assign(f.inbox, {
			chatRoomsRepository: rooms,
			chatRoomInvitationsRepository: { findOneBy: vi.fn().mockResolvedValue({ id: 'invite1' }) },
		});
		f.chatService.isRoomMember.mockResolvedValue(false);
		const object = {
			id: 'https://remote.test/chat/messages/early', type: 'Note', attributedTo: f.actor.uri,
			_misskey_talk: true, _misskey_content: 'hello', to: [f.localUser.uri], context: 'https://remote.test/chat/rooms/r1',
		};
		const create = () => (f.inbox as never as { createChatMessage: (...args: unknown[]) => Promise<string> }).createChatMessage({}, f.actor, object, { type: 'Create' });

		await expect(create()).rejects.toThrow(/not ready/);
		expect(f.chatService.createMessageToRoom).not.toHaveBeenCalled();
		rooms.findOneBy.mockResolvedValue({ id: 'r1' });
		f.chatService.isRoomMember.mockResolvedValue(true);
		await create();
		expect(f.chatService.createMessageToRoom).toHaveBeenCalledOnce();
	});

	test.each(['like', 'undo'])('preserves the reaction ID and reloads its message under the lock for %s', async (method) => {
		const f = createInbox();
		const current = { ...f.message, reactions: ['someone/👍'] };
		f.chatService.findMessageByUri.mockResolvedValueOnce(f.message).mockResolvedValue(current);
		const reaction = { id: 'https://remote.test/reactions/1', type: 'EmojiReact', actor: f.actor.uri, object: f.message.uri, content: '👍' };
		const activity = method === 'like' ? reaction : { type: 'Undo', actor: f.actor.uri, object: reaction };

		await (f.inbox as never as Record<string, (...args: unknown[]) => Promise<string>>)[method](f.actor, activity);

		expect(f.redisClient.set).toHaveBeenCalled();
		expect(f.chatService[method === 'like' ? 'reactRemote' : 'unreactRemote']).toHaveBeenCalledWith(f.actor, current, '👍', reaction.id);
	});

	test.each(['x', '🦈'])('accepts a remote message with 4096 characters (%s)', async (character) => {
		const f = createInbox();
		const text = character.repeat(4096);
		const object = {
			id: 'https://remote.test/chat/messages/long-valid',
			type: 'Note',
			attributedTo: f.actor.uri,
			_misskey_talk: true,
			_misskey_content: text,
			to: [f.localUser.uri],
		};

		await (f.inbox as never as { createChatMessage: (...args: unknown[]) => Promise<string> }).createChatMessage(
			{ resolve: async (x: unknown) => x }, f.actor, object, { type: 'Create' },
		);

		expect(f.chatService.createMessageToUser).toHaveBeenCalledWith(f.actor, f.localUser, expect.objectContaining({ text }));
	});

	test('rejects an oversized chat message before inserting it', async () => {
		const f = createInbox();
		const object = {
			id: 'https://remote.test/chat/messages/long-1',
			type: 'Note',
			attributedTo: f.actor.uri,
			_misskey_talk: true,
			_misskey_content: 'x'.repeat(4097),
			to: [f.localUser.uri],
		};

		const result = await (f.inbox as never as { createChatMessage: (...args: unknown[]) => Promise<string> }).createChatMessage(
			{ resolve: async (x: unknown) => x },
			f.actor,
			object,
			{ type: 'Create' },
		);

		expect(result).toContain('too long');
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

	test.each([{}, null])('ignores a malformed Delete object instead of failing the inbox job (%s)', async object => {
		const f = createInbox();

		await expect((f.inbox as never as { delete: (...args: unknown[]) => Promise<string> }).delete(f.actor, {
			type: 'Delete',
			actor: f.actor.uri,
			object,
		})).resolves.toContain('skip');
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

		expect(f.chatService.reactRemote).toHaveBeenCalledWith(f.actor, f.message, '👍', undefined);
	});

	test('does not query chat messages for ordinary note reactions', async () => {
		const f = createInbox();
		Object.assign(f.inbox, {
			apNoteService: { fetchNote: vi.fn().mockResolvedValue({ id: 'n1' }), extractEmojis: vi.fn().mockResolvedValue([]) },
			reactionService: { create: vi.fn().mockResolvedValue(undefined) },
		});

		await (f.inbox as never as { like: (...args: unknown[]) => Promise<string> }).like(f.actor, {
			type: 'Like',
			actor: f.actor.uri,
			object: 'https://remote.test/notes/n1',
			content: '👍',
		});

		expect(f.chatService.findMessageByUri).not.toHaveBeenCalled();
	});

	test('routes Undo EmojiReact to unreactRemote', async () => {
		const f = createInbox();
		const react = { type: 'EmojiReact', actor: f.actor.uri, object: f.message.uri, content: '👍' };

		await (f.inbox as never as { undo: (...args: unknown[]) => Promise<string> }).undo(f.actor, {
			type: 'Undo',
			actor: f.actor.uri,
			object: react,
		});

		expect(f.chatService.unreactRemote).toHaveBeenCalledWith(f.actor, f.message, '👍', undefined);
	});

	test.each(['Like', 'EmojiReaction'])('routes Undo %s of a chat reaction to unreactRemote', async (type) => {
		const f = createInbox();
		const react = { type, actor: f.actor.uri, object: f.message.uri, _misskey_reaction: '👍' };

		await (f.inbox as never as { undo: (...args: unknown[]) => Promise<string> }).undo(f.actor, {
			type: 'Undo',
			actor: f.actor.uri,
			object: react,
		});

		expect(f.chatService.unreactRemote).toHaveBeenCalledWith(f.actor, f.message, '👍', undefined);
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

	test('defers a chat reaction that arrives before its message', async () => {
		const f = createInbox();
		f.chatService.findMessageByUri.mockResolvedValue(null);

		const result = await (f.inbox as never as { like: (...args: unknown[]) => Promise<string> }).like(f.actor, {
			type: 'EmojiReact',
			actor: f.actor.uri,
			object: f.message.uri,
			content: '👍',
		});

		expect(result).toContain('pending');
		expect(f.chatService.storePendingChatReaction).toHaveBeenCalledWith(f.actor.id, f.message.uri, '👍', false, undefined);
	});

	test('defers a chat unreact that arrives before its message', async () => {
		const f = createInbox();
		f.chatService.findMessageByUri.mockResolvedValue(null);

		const result = await (f.inbox as never as { undo: (...args: unknown[]) => Promise<string> }).undo(f.actor, {
			type: 'Undo',
			actor: f.actor.uri,
			object: { type: 'EmojiReact', actor: f.actor.uri, object: f.message.uri, content: '👍' },
		});

		expect(result).toContain('pending');
		expect(f.chatService.storePendingChatReaction).toHaveBeenCalledWith(f.actor.id, f.message.uri, '👍', true, undefined);
	});

	test('rechecks under the object lock so a reaction cannot miss a message stored after the first lookup', async () => {
		const f = createInbox();
		f.chatService.findMessageByUri.mockResolvedValueOnce(null).mockResolvedValue(f.message);

		const result = await (f.inbox as never as { like: (...args: unknown[]) => Promise<string> }).like(f.actor, {
			type: 'EmojiReact', actor: f.actor.uri, object: f.message.uri, content: '👍',
		});

		expect(result).toBe('ok');
		expect(f.chatService.reactRemote).toHaveBeenCalledWith(f.actor, f.message, '👍', undefined);
		expect(f.chatService.storePendingChatReaction).not.toHaveBeenCalled();
	});

	test('rechecks under the object lock so an unreact cannot miss a message stored after the first lookup', async () => {
		const f = createInbox();
		f.chatService.findMessageByUri.mockResolvedValueOnce(null).mockResolvedValue(f.message);

		const result = await (f.inbox as never as { undo: (...args: unknown[]) => Promise<string> }).undo(f.actor, {
			type: 'Undo', actor: f.actor.uri,
			object: { type: 'EmojiReact', actor: f.actor.uri, object: f.message.uri, content: '👍' },
		});

		expect(result).toBe('ok');
		expect(f.chatService.unreactRemote).toHaveBeenCalledWith(f.actor, f.message, '👍', undefined);
		expect(f.chatService.storePendingChatReaction).not.toHaveBeenCalled();
	});

	test('reports a deferred reaction that was refused', async () => {
		const f = createInbox();
		f.chatService.findMessageByUri.mockResolvedValue(null);
		f.chatService.storePendingChatReaction.mockResolvedValue(false);

		const result = await (f.inbox as never as { like: (...args: unknown[]) => Promise<string> }).like(f.actor, {
			type: 'EmojiReact', actor: f.actor.uri, object: f.message.uri, content: '👍',
		});

		expect(result).toMatch(/^skip:/);
	});

	describe('creating a chat message', () => {
		const object = (f: ReturnType<typeof createInbox>) => ({
			id: 'https://remote.test/chat/messages/new', type: 'Note', attributedTo: f.actor.uri,
			content: 'hello', to: [f.localUser.uri], _misskey_talk: true,
		});
		const create = (f: ReturnType<typeof createInbox>) => (f.inbox as never as { createChatMessage: (...args: unknown[]) => Promise<string> }).createChatMessage(
			{}, f.actor, object(f), { type: 'Create', actor: f.actor.uri },
		);

		test('a Create that loses the insert race to the unique URI is a duplicate, not a retry', async () => {
			const f = createInbox();
			const duplicate = new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate key'), { code: '23505' }));
			f.chatService.createMessageToUser.mockRejectedValue(duplicate);

			expect(await create(f)).toBe('skip: chat message exists');
		});

		test('skips a duplicate Create before resolving recipients', async () => {
			const f = createInbox();
			(f.inbox as never as { chatMessagesRepository: { findOneBy: ReturnType<typeof vi.fn> } }).chatMessagesRepository.findOneBy.mockResolvedValue(f.message);

			expect(await create(f)).toBe('skip: chat message exists');
			expect((f.inbox as never as { apPersonService: { resolvePerson: ReturnType<typeof vi.fn> } }).apPersonService.resolvePerson).not.toHaveBeenCalled();
		});

		test('does not retry a final refusal from the recipient', async () => {
			const f = createInbox();
			f.chatService.createMessageToUser.mockRejectedValue(new ChatMessageAccessError('blocked'));

			expect(await create(f)).toBe('skip: blocked');
		});

		test('does not store a direct message addressed to a user of another server', async () => {
			const f = createInbox();
			const elsewhere = { id: 'elsewhere', uri: 'https://other.test/users/elsewhere', host: 'other.test' };
			(f.inbox as never as { apPersonService: { resolvePerson: ReturnType<typeof vi.fn> } }).apPersonService.resolvePerson.mockResolvedValue(elsewhere);

			expect(await create(f)).toBe('skip: recipient is not a local user');
			expect(f.chatService.createMessageToUser).not.toHaveBeenCalled();
		});

		test('retries a membership refusal, as the roster update may still be on its way', async () => {
			const f = createInbox();
			f.chatService.createMessageToUser.mockRejectedValue(new Error('you are not a member of the room'));

			await expect(create(f)).rejects.toThrow('you are not a member of the room');
		});

		test('retries a room message that overtakes the sender joining the room', async () => {
			const f = createInbox();
			f.chatService.isRoomMember.mockImplementation(async (_room: unknown, userId: string) => userId === f.localUser.id);
			// The service refuses a non-member with the same error class it uses for final refusals.
			f.chatService.createMessageToRoom.mockRejectedValue(new ChatMessageAccessError('you are not a member of the room'));

			await expect((f.inbox as never as { createChatMessage: (...args: unknown[]) => Promise<string> }).createChatMessage(
				{},
				f.actor,
				{ ...object(f), context: 'https://remote.test/chat/rooms/r1' },
				{ type: 'Create', actor: f.actor.uri },
			)).rejects.toThrow('membership is not ready');
			expect(f.chatService.createMessageToRoom).not.toHaveBeenCalled();
		});
	});

	describe('a chat message stored under a foreign URI', () => {
		const foreignUri = 'https://remote.test/users/remote-user/statuses/1';
		const foreignInbox = (f: ReturnType<typeof createInbox>) => f.inbox as never as Record<string, (...args: unknown[]) => Promise<string>>;

		test('Delete removes the chat message instead of looking for a note', async () => {
			const f = createInbox();

			const result = await foreignInbox(f).delete(f.actor, { type: 'Delete', actor: f.actor.uri, object: foreignUri });

			expect(result).toBe('ok: chat message deleted');
			expect(f.chatService.deleteRemoteMessage).toHaveBeenCalledWith(f.actor, f.message);
		});

		test('Update without the talk flag edits the chat message', async () => {
			const f = createInbox();

			const result = await foreignInbox(f).update(f.actor, {
				type: 'Update',
				actor: f.actor.uri,
				object: { id: foreignUri, type: 'Note', attributedTo: f.actor.uri, content: 'edited', updated: '2026-11-03T00:00:00.000Z' },
			});

			expect(result).toBe('ok: chat message updated');
			expect(f.chatService.updateRemoteMessage).toHaveBeenCalledWith(f.actor, f.message, 'edited', new Date('2026-11-03T00:00:00.000Z'), []);
		});

		test('Like reacts to the chat message', async () => {
			const f = createInbox();

			await foreignInbox(f).like(f.actor, { type: 'Like', actor: f.actor.uri, object: foreignUri, content: '👍', id: 'https://remote.test/likes/1' });

			expect(f.chatService.reactRemote).toHaveBeenCalledWith(f.actor, f.message, '👍', 'https://remote.test/likes/1');
		});

		test('Undo(Like) removes the reaction from the chat message', async () => {
			const f = createInbox();

			await foreignInbox(f).undo(f.actor, {
				type: 'Undo',
				actor: f.actor.uri,
				object: { type: 'Like', actor: f.actor.uri, object: foreignUri, content: '👍', id: 'https://remote.test/likes/1' },
			});

			expect(f.chatService.unreactRemote).toHaveBeenCalledWith(f.actor, f.message, '👍', 'https://remote.test/likes/1');
		});
	});

	describe('a relayed room message', () => {
		const roomUri = 'https://remote.test/chat/rooms/r1';
		const noteUri = 'https://other.test/chat/messages/from-carol';
		const author = { id: 'carol', uri: 'https://other.test/users/carol', host: 'other.test' };

		function createRelay() {
			const f = createInbox();
			const note = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: noteUri,
				type: 'Note',
				attributedTo: author.uri,
				content: 'relayed',
				to: [f.actor.uri],
				_misskey_talk: true,
				_misskey_chatRoom: roomUri,
			};
			const resolver = { resolve: vi.fn(async () => note), signAs: vi.fn() };
			(f.inbox as never as { apResolverService: { createResolver: ReturnType<typeof vi.fn> } }).apResolverService.createResolver.mockResolvedValue(resolver);
			const room = { id: 'r1', ownerId: f.actor.id, uri: roomUri };
			f.chatRoomsRepository.findOneBy.mockResolvedValue(room);
			f.chatService.isRoomMember.mockResolvedValue(true);
			f.chatService.findMessageByUri.mockResolvedValue(null);
			(f.inbox as never as { apPersonService: { resolvePerson: ReturnType<typeof vi.fn> } }).apPersonService.resolvePerson.mockImplementation(async (uri: string) => {
				if (uri === f.localUser.uri) return f.localUser;
				if (uri === author.uri) return author;
				if (uri === f.actor.uri) return f.actor;
				return null;
			});
			const announce = {
				id: `${roomUri}#relay/1`,
				type: 'Announce',
				actor: f.actor.uri,
				object: noteUri,
				to: [f.localUser.uri],
				context: roomUri,
				_misskey_chatRoom: roomUri,
			};
			const inboundResolver = { resolve: vi.fn(async (value: unknown) => value) };
			const send = (activity: object = announce) => (f.inbox as never as { announce: (...args: unknown[]) => Promise<string> }).announce(f.actor, activity, inboundResolver);
			return { ...f, note, resolver, inboundResolver, room, announce, send };
		}

		test('fetches the original as a local member and stores it from its author', async () => {
			const f = createRelay();

			await f.send();

			expect(f.resolver.signAs).toHaveBeenCalledWith(f.localUser);
			expect(f.resolver.resolve).toHaveBeenCalledWith(noteUri);
			expect(f.chatService.createMessageToRoom).toHaveBeenCalledWith(author, f.room, expect.objectContaining({ text: 'relayed', uri: noteUri }));
		});

		/** Real resolvers over a recording network, to see which requests carry the key of the member. */
		function useRealResolvers(f: ReturnType<typeof createRelay>) {
			const serve = (uri: string) => uri === noteUri ? f.note : { '@context': 'https://www.w3.org/ns/activitystreams', id: uri, type: 'Note' };
			const signedGet = vi.fn(async (uri: string, _user: unknown) => serve(uri));
			const getActivityJson = vi.fn(async (uri: string) => serve(uri));
			const createResolver = async () => new Resolver(
				{} as never,
				{ signToActivityPubGet: false } as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{ extractDbHost: (uri: string) => new URL(uri).host, isSelfHost: () => false, isFederationAllowedHost: () => true } as never,
				{} as never,
				{ signedGet } as never,
				{ getActivityJson } as never,
				{} as never,
				{} as never,
				{ getLogger: () => ({}) } as never,
			);
			(f.inbox as never as { apResolverService: { createResolver: unknown } }).apResolverService.createResolver = createResolver;
			Object.assign(f.actor, { lastFetchedAt: new Date() });
			return { signedGet, getActivityJson };
		}

		test('does not lend the key of the member to the next item of a collection', async () => {
			const f = createRelay();
			const { signedGet, getActivityJson } = useRealResolvers(f);
			const featured = `${f.actor.uri}/featured`;
			const followersOnlyNote = 'https://third.test/notes/followers-only';
			Object.assign(f.actor, { featured });
			Object.assign((f.inbox as never as { apNoteService: object }).apNoteService, {
				resolveNote: async (uri: string, options: { resolver: Resolver }) => {
					await options.resolver.resolve(uri);
					return { id: 'pinned' };
				},
			});
			Object.assign(f.inbox, { notePiningService: { addPinned: vi.fn() } });

			await f.inbox.performActivity(f.actor as never, {
				type: 'Collection',
				items: [
					f.announce,
					{ id: `${f.actor.uri}/add/1`, type: 'Add', actor: f.actor.uri, target: featured, object: followersOnlyNote },
				],
			} as never);

			expect(signedGet.mock.calls.map(([uri, user]) => [uri, user])).toEqual([[noteUri, f.localUser]]);
			expect(getActivityJson.mock.calls.map(([uri]) => uri)).toEqual([followersOnlyNote]);
		});

		test('does not lend the key of the member to the actors the message names', async () => {
			const f = createRelay();
			const { signedGet, getActivityJson } = useRealResolvers(f);
			const namedActor = 'https://third.test/users/named';
			f.note.to.push(namedActor);
			const { resolvePerson } = (f.inbox as never as { apPersonService: { resolvePerson: ReturnType<typeof vi.fn> } }).apPersonService;
			const known = resolvePerson.getMockImplementation() as (uri: string) => Promise<unknown>;
			resolvePerson.mockImplementation(async (uri: string, resolver: Resolver) => {
				if (uri === namedActor) await resolver.resolve(uri);
				return known(uri);
			});

			await f.inbox.performActivity(f.actor as never, f.announce as never);

			expect(signedGet.mock.calls.map(([uri, user]) => [uri, user])).toEqual([[noteUri, f.localUser]]);
			expect(getActivityJson.mock.calls.map(([uri]) => uri)).toEqual([namedActor]);
			expect(f.chatService.createMessageToRoom).toHaveBeenCalledWith(author, f.room, expect.objectContaining({ uri: noteUri }));
		});

		test('only the room owner can relay', async () => {
			const f = createRelay();
			f.chatRoomsRepository.findOneBy.mockResolvedValue({ ...f.room, ownerId: 'someone-else' });

			expect(await f.send()).toMatch(/^skip:/);
			expect(f.resolver.resolve).not.toHaveBeenCalled();
		});

		test('does not fetch a message that is already stored', async () => {
			const f = createRelay();
			f.chatService.findMessageByUri.mockResolvedValue(f.message);

			expect(await f.send()).toMatch(/^skip:/);
			expect(f.resolver.resolve).not.toHaveBeenCalled();
		});

		test('skips when no addressed local user is a member', async () => {
			const f = createRelay();
			f.chatService.isRoomMember.mockResolvedValue(false);

			expect(await f.send()).toMatch(/^skip:/);
			expect(f.resolver.resolve).not.toHaveBeenCalled();
		});

		test('retries while the sender server still refuses to serve the message', async () => {
			const f = createRelay();
			f.resolver.resolve.mockRejectedValue(new StatusError('Not Found', 404));

			await expect(f.send()).rejects.toThrow('not available yet');
		});

		test('does not accept a message from a different room', async () => {
			const f = createRelay();
			f.resolver.resolve.mockResolvedValue({ ...f.note, _misskey_chatRoom: 'https://remote.test/chat/rooms/other' });

			expect(await f.send()).toMatch(/^skip:/);
			expect(f.chatService.createMessageToRoom).not.toHaveBeenCalled();
		});

		test('an Announce without a room context is still an ordinary boost', async () => {
			const f = createRelay();
			f.inboundResolver.resolve.mockResolvedValue({ type: 'Unknown' });

			expect(await f.send({ id: 'https://remote.test/announces/1', type: 'Announce', actor: f.actor.uri, object: noteUri })).toBe('skip: unknown object type Unknown');
			expect(f.resolver.signAs).not.toHaveBeenCalled();
		});
	});
});

describe('unread chat notification', () => {
	afterEach(() => vi.useRealTimers());

	function createNotifyingService(current: () => Record<string, unknown> | null) {
		const publishMainStream = vi.fn();
		const pushNotification = vi.fn();
		const packMessageDetailed = vi.fn(async (message: unknown) => message);
		const pipeline = { set: () => pipeline, sadd: () => pipeline, exec: async () => [] };
		const service = Object.assign(Object.create(ChatService.prototype), {
			config: { url: 'https://local.test' },
			chatApprovalsRepository: {
				createQueryBuilder: () => ({
					where() { return this; }, orWhere() { return this; }, take() { return this; },
					getMany: async () => [{ userId: 'alice' }, { userId: 'bob' }],
				}),
			},
			chatMessagesRepository: {
				insertOne: async (message: unknown) => message,
				findOneBy: async () => current(),
			},
			roleService: { getUserPolicies: async () => ({ chatAvailability: 'available' }) },
			userBlockingService: { checkBlocked: async () => false },
			idService: { gen: () => 'm1' },
			chatEntityService: { packMessageLiteFor1on1: async (message: unknown) => message, packMessageDetailed },
			userEntityService: {
				isLocalUser: (user: { host: string | null }) => user.host == null,
				isRemoteUser: (user: { host: string | null }) => user.host != null,
			},
			globalEventService: { publishChatUserStream: vi.fn(), publishMainStream },
			pushNotificationService: { pushNotification },
			redisClient: { pipeline: () => pipeline, get: async () => 'm1' },
		});
		const send = () => service.createMessageToUser(
			{ id: 'bob', host: 'remote.test' }, { id: 'alice', host: null, chatScope: 'everyone' }, { text: 'secret', uri: 'https://remote.test/chat/messages/m1' },
		);
		return { send, publishMainStream, pushNotification, packMessageDetailed };
	}

	test('does not push the text of a message deleted before the notification fires', async () => {
		vi.useFakeTimers();
		const f = createNotifyingService(() => ({ id: 'm1', text: null, deletedAt: new Date() }));

		await f.send();
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.publishMainStream).not.toHaveBeenCalled();
		expect(f.pushNotification).not.toHaveBeenCalled();
	});

	test('pushes the latest revision of a message edited before the notification fires', async () => {
		vi.useFakeTimers();
		const edited = { id: 'm1', text: 'edited', deletedAt: null };
		const f = createNotifyingService(() => edited);

		await f.send();
		await vi.advanceTimersByTimeAsync(3000);

		expect(f.pushNotification).toHaveBeenCalledWith('alice', 'newChatMessage', edited);
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
			userEntityService: { pack: async (id: string) => ({ id }) },
			userBlockingService: { checkBlocked: async () => false },
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
