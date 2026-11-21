/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { buildChatNote } from '@/core/activitypub/misc/chat-payloads.js';
import { CHAT_REPLY_PREVIEW_LENGTH, chatReplyPreviewText, isReplyTargetInScope, parseChatReplyUri } from '@/core/chat-reply.js';
import { ChatReplyTargetError, ChatService } from '@/core/ChatService.js';
import jsonld from 'jsonld';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { CONTEXT, PRELOADED_CONTEXTS } from '@/core/activitypub/misc/contexts.js';
import { canReadRoomTimeline } from '@/core/chat-room-access.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import type { ChatPayloadOptions } from '@/core/activitypub/misc/chat-payloads.js';
import type { ChatReplyScope } from '@/core/chat-reply.js';
import type { MiChatMessage } from '@/models/ChatMessage.js';

const base = { toRoomId: null, toRoomChannelId: null, toUserId: null, fromUserId: null, deletedAt: null };
const roomMessage = (patch: Partial<MiChatMessage> = {}) => ({ ...base, id: 'target', toRoomId: 'room1', fromUserId: 'alice', fileIds: [], unavailableFileCount: 0, text: 'hello', uri: null, ...patch }) as MiChatMessage;
const directMessage = (patch: Partial<MiChatMessage> = {}) => ({ ...base, id: 'target', fromUserId: 'alice', toUserId: 'bob', fileIds: [], unavailableFileCount: 0, text: 'hello', uri: null, ...patch }) as MiChatMessage;

describe('which messages a reply may point at', () => {
	const room = { kind: 'room', roomId: 'room1', channelId: null } as const;

	test('a message in the same room and channel', () => {
		expect(isReplyTargetInScope(roomMessage(), room)).toBe(true);
		expect(isReplyTargetInScope(roomMessage({ toRoomChannelId: 'c1' }), { ...room, channelId: 'c1' })).toBe(true);
	});

	test('not a message in another room, another channel, or one that was deleted', () => {
		expect(isReplyTargetInScope(roomMessage({ toRoomId: 'room2' }), room)).toBe(false);
		expect(isReplyTargetInScope(roomMessage({ toRoomChannelId: 'c2' }), { ...room, channelId: 'c1' })).toBe(false);
		expect(isReplyTargetInScope(roomMessage({ toRoomChannelId: 'c1' }), room)).toBe(false);
		expect(isReplyTargetInScope(roomMessage({ deletedAt: new Date() }), room)).toBe(false);
	});

	test('a direct message only between the same two accounts, in either direction', () => {
		const scope: ChatReplyScope = { kind: 'user', userIds: ['bob', 'alice'] };
		expect(isReplyTargetInScope(directMessage(), scope)).toBe(true);
		expect(isReplyTargetInScope(directMessage({ fromUserId: 'bob', toUserId: 'alice' }), scope)).toBe(true);
		expect(isReplyTargetInScope(directMessage({ toUserId: 'carol' }), scope)).toBe(false);
		expect(isReplyTargetInScope(roomMessage(), scope)).toBe(false);
		expect(isReplyTargetInScope(directMessage(), room)).toBe(false);
	});
});

describe('the preview text of a reply', () => {
	test('folds line breaks and cuts a long sentence', () => {
		expect(chatReplyPreviewText('a\n\n b')).toBe('a b');
		const long = chatReplyPreviewText('가'.repeat(CHAT_REPLY_PREVIEW_LENGTH + 50))!;
		expect(Array.from(long)).toHaveLength(CHAT_REPLY_PREVIEW_LENGTH + 1);
		expect(long.endsWith('…')).toBe(true);
	});

	test('has none for a message with only attachments', () => {
		expect(chatReplyPreviewText(null)).toBeNull();
		expect(chatReplyPreviewText('  \n ')).toBeNull();
	});

	test('a reply address from another server must be a bounded string', () => {
		expect(parseChatReplyUri('https://remote.test/chat/messages/1')).toBe('https://remote.test/chat/messages/1');
		expect(parseChatReplyUri({ id: 'x' })).toBeNull();
		expect(parseChatReplyUri('a'.repeat(513))).toBeNull();
	});
});

describe('what a reply says on the wire', () => {
	const alice = { id: 'alice', host: null };

	test('only the address of the original, in an optional field', () => {
		const note = buildChatNote({ id: 'm2', text: 'yes' }, alice, [], 'room1', { baseUrl: 'https://local.test', replyToUri: 'https://local.test/chat/messages/m1' });

		expect(note._misskey_chatReplyTo).toBe('https://local.test/chat/messages/m1');
		expect(JSON.stringify(note)).not.toContain('"inReplyTo"');
	});

	test('a message that is no reply carries no such field', () => {
		expect(buildChatNote({ id: 'm2', text: 'yes' }, alice, [], 'room1', { baseUrl: 'https://local.test' })).not.toHaveProperty('_misskey_chatReplyTo');
	});
});

describe('finding the original of a reply', () => {
	function createService(rows: Partial<MiChatMessage>[], suspended: string[] = []) {
		const match = (where: Record<string, unknown>) => rows.find(row => Object.entries(where).every(([key, value]) => key === 'deletedAt' ? row.deletedAt == null : (row as Record<string, unknown>)[key] === value)) ?? null;
		return Object.assign(Object.create(ChatService.prototype), {
			config: { url: 'https://local.test' },
			chatMessagesRepository: { findOneBy: vi.fn(async (where: Record<string, unknown>) => match(where)) },
			usersRepository: { existsBy: vi.fn(async ({ id }: { id: string }) => suspended.includes(id)) },
		}) as ChatService;
	}

	const room = { kind: 'room', roomId: 'room1', channelId: null } as const;

	test('a local sender names a message of the room', async () => {
		const service = createService([roomMessage()]);

		await expect(service.resolveReplyTarget(room, { replyToId: 'target' })).resolves.toEqual({ replyToId: 'target', replyToUri: null });
	});

	test.each([
		['one that does not exist', []],
		['one of another room', [roomMessage({ toRoomId: 'room2' })]],
		['a deleted one', [roomMessage({ deletedAt: new Date() })]],
		['one of a suspended account', [roomMessage()]],
	])('a local sender is refused %s', async (_name, rows) => {
		const service = createService(rows, _name === 'one of a suspended account' ? ['alice'] : []);

		await expect(service.resolveReplyTarget(room, { replyToId: 'target' })).rejects.toBeInstanceOf(ChatReplyTargetError);
	});

	const none = { replyToId: null, replyToUri: null };

	test('a remote reply to another conversation loses its mark, but the message itself is kept', async () => {
		const service = createService([roomMessage({ toRoomId: 'room2', uri: 'https://remote.test/m1' })]);

		await expect(service.resolveReplyTarget(room, { replyToUri: 'https://remote.test/m1' })).resolves.toEqual(none);
		await expect(service.resolveReplyTarget(room, { replyToUri: { id: 1 } })).resolves.toEqual(none);
	});

	test('a remote reply that came before its original keeps only the checked address', async () => {
		const service = createService([]);

		await expect(service.resolveReplyTarget(room, { replyToUri: 'https://remote.test/later' })).resolves.toEqual({ replyToId: null, replyToUri: 'https://remote.test/later' });
	});

	test('a remote message finds a stored original by its address, also through a history copy', async () => {
		const service = createService([
			roomMessage({ id: 'stored', uri: 'https://remote.test/m1' }),
			roomMessage({ id: 'copy', uri: 'https://local.test/chat/history/x', sourceUri: 'https://remote.test/m2' } as Partial<MiChatMessage>),
			roomMessage({ id: 'mine' }),
		]);

		await expect(service.resolveReplyTarget(room, { replyToUri: 'https://remote.test/m1' })).resolves.toEqual({ replyToId: 'stored', replyToUri: null });
		await expect(service.resolveReplyTarget(room, { replyToUri: 'https://remote.test/m2' })).resolves.toEqual({ replyToId: 'copy', replyToUri: null });
		await expect(service.resolveReplyTarget(room, { replyToUri: 'https://local.test/chat/messages/mine' })).resolves.toEqual({ replyToId: 'mine', replyToUri: null });
	});

	test('a message with no reply needs no lookup', async () => {
		const service = createService([]);

		await expect(service.resolveReplyTarget(room, {})).resolves.toEqual(none);
	});
});

type PackedReplyResult = { replyToId: string | null; reply: Record<string, unknown> | null };

function createEntityService(rows: MiChatMessage[], users: Record<string, unknown> = { alice: { id: 'alice', name: 'Alice', username: 'alice', host: null, isSuspended: false, isDeleted: false } }, access: { memberRooms?: string[]; ownedRooms?: string[]; moderator?: boolean } = { memberRooms: ['room1'] }) {
	const matches = (row: MiChatMessage, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => {
		const actual = (row as unknown as Record<string, unknown>)[key];
		return value != null && typeof value === 'object' && '_value' in value ? (value._value as unknown[]).includes(actual) : actual === value;
	});
	const chatMessagesRepository = {
		findOneBy: vi.fn(async (where: Record<string, unknown>) => rows.find(row => matches(row, where)) ?? null),
		findBy: vi.fn(async (where: Record<string, unknown>) => rows.filter(row => matches(row, where))),
	};
	const usersRepository = {
		findBy: vi.fn(async ({ id }: { id: { _value: string[] } }) => id._value.map(x => users[x]).filter(x => x != null)),
	};
	const chatRoomMembershipsRepository = {
		findBy: vi.fn(async ({ roomId }: { roomId: { _value: string[] } }) => roomId._value.filter(x => access.memberRooms?.includes(x)).map(x => ({ roomId: x }))),
	};
	const chatRoomsRepository = {
		findBy: vi.fn(async ({ id }: { id: { _value: string[] } }) => id._value.map(x => ({ id: x, ownerId: access.ownedRooms?.includes(x) ? 'viewer' : 'someone' }))),
	};
	const roleService = { isModerator: vi.fn(async () => access.moderator === true) };
	const userEntityService = { pack: vi.fn(async (user: { id: string } | string) => ({ id: typeof user === 'string' ? user : user.id })) };
	const service = Object.assign(Object.create(ChatEntityService.prototype), {
		chatMessagesRepository, usersRepository, chatRoomMembershipsRepository, chatRoomsRepository, roleService, userEntityService,
		config: { url: 'https://local.test' },
	}) as unknown as {
		loadReplyHints(messages: MiChatMessage[], me?: { id: string }): Promise<unknown>;
		packReply(message: MiChatMessage, me: { id: string } | undefined, withAuthor: boolean, hints: unknown): Promise<PackedReplyResult>;
	};
	return Object.assign(service, {
		repositories: { chatMessagesRepository, usersRepository },
		async packReply(message: MiChatMessage, me?: { id: string }, withAuthor = true) {
			const hints = await service.loadReplyHints([message], me);
			return Object.getPrototypeOf(service).packReply.call(service, message, me, withAuthor, hints) as Promise<PackedReplyResult>;
		},
		async loadHints(messages: MiChatMessage[], me?: { id: string }) {
			return service.loadReplyHints(messages, me);
		},
	});
}

describe('the preview packed for a reply', () => {
	const reply = (patch: Partial<MiChatMessage> = {}) => roomMessage({ id: 'reply', fromUserId: 'bob', replyToId: 'target', replyToUri: null, ...patch });

	test('shows the author and a short text from the stored original', async () => {
		const service = createEntityService([roomMessage({ text: 'line1\nline2' })]);

		const packed = await service.packReply(reply());

		expect(packed.reply).toMatchObject({ id: 'target', isDeleted: false, text: 'line1 line2', fileCount: 0, fromUserId: 'alice', fromUser: { id: 'alice' } });
	});

	test('counts the files of an original that has only attachments', async () => {
		const service = createEntityService([roomMessage({ text: null, fileIds: ['f1', 'f2'] })]);

		const packed = await service.packReply(reply());

		expect(packed.reply).toMatchObject({ text: null, fileCount: 2, isDeleted: false });
	});

	test.each([
		['deleted', [roomMessage({ deletedAt: new Date(), text: null })]],
		['gone', []],
		['of another room', [roomMessage({ toRoomId: 'room2' })]],
	])('says nothing of an original that is %s', async (_name, rows) => {
		const service = createEntityService(rows);

		const packed = await service.packReply(reply());

		expect(packed.replyToId).toBe('target');
		expect(packed.reply).toEqual({ id: 'target', isDeleted: true, text: null, fileCount: 0, fromUserId: null, fromUser: null, archivedAuthor: null });
	});

	test('says nothing of an original whose author is suspended', async () => {
		const service = createEntityService([roomMessage()], { alice: { id: 'alice', isSuspended: true, isDeleted: false } });

		const packed = await service.packReply(reply());

		expect(packed.reply).toMatchObject({ isDeleted: true, text: null });
	});

	test('finds again an original that arrived after its reply, only if it is in the same room', async () => {
		const pending = reply({ replyToId: null, replyToUri: 'https://remote.test/m1' } as Partial<MiChatMessage>);

		const before = await createEntityService([]).packReply(pending);
		const after = await createEntityService([roomMessage({ uri: 'https://remote.test/m1' })]).packReply(pending);
		const elsewhere = await createEntityService([roomMessage({ uri: 'https://remote.test/m1', toRoomId: 'room2' })]).packReply(pending);

		expect(before).toEqual({ replyToId: null, reply: null });
		expect(after.reply).toMatchObject({ id: 'target', text: 'hello', isDeleted: false });
		expect(elsewhere).toEqual({ replyToId: null, reply: null });
	});

	test('a message that is deleted itself no longer points anywhere', async () => {
		const service = createEntityService([roomMessage()]);

		await expect(service.packReply(reply({ deletedAt: new Date() }))).resolves.toEqual({ replyToId: null, reply: null });
	});
});

describe('who may still see the original of a reply', () => {
	const reply = roomMessage({ id: 'reply', fromUserId: 'bob', replyToId: 'target', replyToUri: null } as Partial<MiChatMessage>);
	const viewer = { id: 'viewer' };

	test('a member sees the current text, so an edit shows up', async () => {
		const service = createEntityService([roomMessage({ text: 'new text' })], undefined, { memberRooms: ['room1'] });

		expect((await service.packReply(reply, viewer)).reply).toMatchObject({ isDeleted: false, text: 'new text' });
	});

	test('someone who has left, was removed or is banned no longer sees what the original says now', async () => {
		const service = createEntityService([roomMessage({ text: 'new text' })], undefined, { memberRooms: [] });

		const packed = await service.packReply(reply, viewer);

		expect(packed.reply).toEqual({ id: 'target', isDeleted: true, text: null, fileCount: 0, fromUserId: null, fromUser: null, archivedAuthor: null });
		expect(JSON.stringify(packed)).not.toContain('new text');
	});

	test('the owner and a moderator keep the access they had', async () => {
		const asOwner = createEntityService([roomMessage()], undefined, { memberRooms: [], ownedRooms: ['room1'] });
		const asModerator = createEntityService([roomMessage()], undefined, { memberRooms: [], moderator: true });

		expect((await asOwner.packReply(reply, viewer)).reply).toMatchObject({ isDeleted: false, text: 'hello' });
		expect((await asModerator.packReply(reply, viewer)).reply).toMatchObject({ isDeleted: false, text: 'hello' });
	});

	test('a direct message stays readable by its two accounts', async () => {
		const direct = directMessage({ id: 'reply', fromUserId: 'bob', toUserId: 'alice', replyToId: 'target', replyToUri: null } as Partial<MiChatMessage>);
		const service = createEntityService([directMessage()], undefined, { memberRooms: [] });

		expect((await service.packReply(direct, viewer)).reply).toMatchObject({ isDeleted: false, text: 'hello' });
	});

	test('without a viewer, as for a notification that already chose its recipients, nothing is checked', async () => {
		const service = createEntityService([roomMessage()], undefined, { memberRooms: [] });

		expect((await service.packReply(reply)).reply).toMatchObject({ isDeleted: false, text: 'hello' });
	});
});

describe('packing many replies', () => {
	test('reads the originals and their authors once, however many replies there are', async () => {
		const originals = [roomMessage({ id: 't1' }), roomMessage({ id: 't2', fromUserId: 'carol' })];
		const service = createEntityService(originals, { alice: { id: 'alice', isSuspended: false }, carol: { id: 'carol', isSuspended: false } });
		const replies = Array.from({ length: 6 }, (_, i) => roomMessage({ id: `r${i}`, fromUserId: 'bob', replyToId: i % 2 === 0 ? 't1' : 't2', replyToUri: null } as Partial<MiChatMessage>));

		await service.loadHints(replies, { id: 'viewer' });

		expect(service.repositories.chatMessagesRepository.findBy).toHaveBeenCalledTimes(1);
		expect(service.repositories.usersRepository.findBy).toHaveBeenCalledTimes(1);
		expect(service.repositories.chatMessagesRepository.findOneBy).not.toHaveBeenCalled();
	});
});

describe('packing replies whose original is only known by address', () => {
	const pendingReply = (i: number, uri: string) => roomMessage({ id: `r${i}`, fromUserId: 'bob', replyToId: null, replyToUri: uri } as Partial<MiChatMessage>);

	test('finds history copies of the same room with a fixed number of reads, never one of another room', async () => {
		const rows = [
			...Array.from({ length: 5 }, (_, i) => roomMessage({ id: `c${i}`, uri: `https://local.test/chat/history/${i}`, sourceUri: `https://remote.test/m${i}` } as Partial<MiChatMessage>)),
			roomMessage({ id: 'other', toRoomId: 'room2', uri: 'https://local.test/chat/history/x', sourceUri: 'https://remote.test/mx' } as Partial<MiChatMessage>),
		];
		const service = createEntityService(rows);
		const replies = [...Array.from({ length: 5 }, (_, i) => pendingReply(i, `https://remote.test/m${i}`)), pendingReply(9, 'https://remote.test/mx')];

		const hints = await service.loadHints(replies, { id: 'viewer' }) as { targets: Map<string, MiChatMessage | null> };

		expect(service.repositories.chatMessagesRepository.findOneBy).not.toHaveBeenCalled();
		expect(service.repositories.chatMessagesRepository.findBy.mock.calls.length).toBeLessThanOrEqual(3);
		expect(hints.targets.get('r3')?.id).toBe('c3');
		expect(hints.targets.get('r9')).toBeNull();
	});

	test('finds originals of this server by the id inside the address', async () => {
		const service = createEntityService([roomMessage({ id: 'abc' })]);
		const hints = await service.loadHints([pendingReply(1, 'https://local.test/chat/messages/abc')], { id: 'viewer' }) as { targets: Map<string, MiChatMessage | null> };

		expect(hints.targets.get('r1')?.id).toBe('abc');
	});
});

describe('who can read a group timeline', () => {
	test('the owner, a member and a moderator only', () => {
		const room = { id: 'room1', ownerId: 'owner' };
		expect(canReadRoomTimeline(room, 'owner', new Set(), false)).toBe(true);
		expect(canReadRoomTimeline(room, 'm', new Set(['room1']), false)).toBe(true);
		expect(canReadRoomTimeline(room, 'x', new Set(['room2']), false)).toBe(false);
		expect(canReadRoomTimeline(room, 'x', new Set(), true)).toBe(true);
	});
});

describe('the original of a reply that was deleted', () => {
	const room = { kind: 'room', roomId: 'room1', channelId: null } as const;

	test('a message received afterwards still shows as a deleted message in the same room', async () => {
		const service = Object.assign(Object.create(ChatService.prototype), {
			config: { url: 'https://local.test' },
			chatMessagesRepository: { findOneBy: vi.fn(async () => roomMessage({ uri: 'https://remote.test/m1', deletedAt: new Date(), text: null })) },
		}) as ChatService;

		await expect(service.resolveReplyTarget(room, { replyToUri: 'https://remote.test/m1' })).resolves.toEqual({ replyToId: 'target', replyToUri: null });
	});

	test('shows it as deleted with no content', async () => {
		const pending = roomMessage({ id: 'reply', fromUserId: 'bob', replyToId: 'target', replyToUri: null } as Partial<MiChatMessage>);
		const service = createEntityService([roomMessage({ deletedAt: new Date(), text: null })]);

		expect((await service.packReply(pending, { id: 'viewer' })).reply).toMatchObject({ isDeleted: true, text: null });
	});
});

describe('what the sender renders for a reply', () => {
	const renderer = (rows: MiChatMessage[]) => Object.assign(Object.create(ApRendererService.prototype), {
		config: { url: 'https://local.test' },
		idService: { parse: () => ({ date: new Date(0) }) },
		driveFilesRepository: { findBy: vi.fn(async () => []) },
		chatMessagesRepository: { findOneBy: vi.fn(async ({ id }: { id: string }) => rows.find(row => row.id === id) ?? null) },
		usersRepository: { findOneBy: vi.fn(async ({ id }: { id: string }) => ({ id, isSuspended: id === 'banned' })) },
	}) as unknown as { chatPayloadOptions(message: MiChatMessage, roomUri?: string, forHistory?: boolean): Promise<ChatPayloadOptions> };

	const reply = roomMessage({ id: 'reply', replyToId: 'target', emojis: [] } as Partial<MiChatMessage>);

	test('the address of an original of this server', async () => {
		const options = await renderer([roomMessage({ id: 'target' })]).chatPayloadOptions(reply);

		expect(options.replyToUri).toBe('https://local.test/chat/messages/target');
	});

	test('the source address of an original that is a history copy, which other servers can find', async () => {
		const copy = roomMessage({ id: 'target', uri: 'https://local.test/chat/history/abc', sourceUri: 'https://remote.test/chat/messages/m1' } as Partial<MiChatMessage>);

		const options = await renderer([copy]).chatPayloadOptions(reply);

		expect(options.replyToUri).toBe('https://remote.test/chat/messages/m1');
	});

	test('no address for an original the history does not carry, while live messages keep it', async () => {
		const deleted = roomMessage({ id: 'target', deletedAt: new Date(), text: null });
		const suspended = roomMessage({ id: 'target', fromUserId: 'banned' });

		expect((await renderer([deleted]).chatPayloadOptions(reply, undefined, true)).replyToUri).toBeUndefined();
		expect((await renderer([suspended]).chatPayloadOptions(reply, undefined, true)).replyToUri).toBeUndefined();
		expect((await renderer([suspended]).chatPayloadOptions(reply)).replyToUri).toBe('https://local.test/chat/messages/target');
		expect((await renderer([roomMessage({ id: 'target' })]).chatPayloadOptions(reply, undefined, true)).replyToUri).toBe('https://local.test/chat/messages/target');
	});

	test('the address of a deleted original too, without its content', async () => {
		const options = await renderer([roomMessage({ id: 'target', deletedAt: new Date(), text: null })]).chatPayloadOptions(reply);

		expect(options.replyToUri).toBe('https://local.test/chat/messages/target');
	});
});

describe('the reply field in JSON-LD', () => {
	test('is declared in the context, so a signature over the note can be normalized', async () => {
		const note = buildChatNote({ id: 'm2', text: 'yes' }, { id: 'alice', host: null }, [], 'room1', { baseUrl: 'https://local.test', replyToUri: 'https://local.test/chat/messages/m1' });

		const normalized = await jsonld.normalize({ '@context': CONTEXT, ...note } as never, {
			algorithm: 'URDNA2015',
			format: 'application/n-quads',
			safe: true,
			documentLoader: async (url: string) => ({ documentUrl: url, document: PRELOADED_CONTEXTS[url] }),
		} as never);

		expect(normalized).toContain('_misskey_chatReplyTo');
	});
});

describe('a notification of a reply', () => {
	function pack(options?: { omitReply?: boolean }) {
		const entity = Object.assign(createEntityService([directMessage()]), {
			usersRepository: { findOneBy: vi.fn(async ({ id }: { id: string }) => ({ id, host: null })), findBy: vi.fn(async () => []) },
			idService: { parse: () => ({ date: new Date(0) }) },
			driveFileEntityService: { packManyByIdsMap: vi.fn(async () => new Map()) },
			customEmojiService: { populateEmojis: vi.fn(async () => ({})) },
			packMessageChannel: vi.fn(async () => ({})),
			packMessageFiles: vi.fn(async () => ({ fileId: null, file: null, fileIds: [], files: [] })),
		}) as unknown as ChatEntityService;
		const message = directMessage({ id: 'reply', fromUserId: 'bob', toUserId: 'alice', replyToId: 'target', replyToUri: null, reactions: [], emojis: [], archivedAuthor: null } as Partial<MiChatMessage>);
		return entity.packMessageDetailed(message, { id: 'alice' }, options);
	}

	test('is packed without the quoted original, which a notification does not show', async () => {
		const packed = await pack({ omitReply: true });

		expect(packed).not.toHaveProperty('reply');
		expect(packed).not.toHaveProperty('replyToId');
		expect(packed).toMatchObject({ id: 'reply', fromUserId: 'bob' });
	});

	test('an ordinary pack of the same message still has it', async () => {
		expect((await pack()).reply).toMatchObject({ id: 'target', text: 'hello' });
	});
});
