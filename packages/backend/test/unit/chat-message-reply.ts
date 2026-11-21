/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { buildChatNote } from '@/core/activitypub/misc/chat-payloads.js';
import { CHAT_REPLY_PREVIEW_LENGTH, chatReplyPreviewText, isReplyTargetInScope, parseChatReplyUri } from '@/core/chat-reply.js';
import { ChatReplyTargetError, ChatService } from '@/core/ChatService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
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

describe('the preview packed for a reply', () => {
	function createEntityService(rows: MiChatMessage[], users: Record<string, unknown> = { alice: { id: 'alice', name: 'Alice', username: 'alice', host: null, isSuspended: false, isDeleted: false } }) {
		return Object.assign(Object.create(ChatEntityService.prototype), {
			chatMessagesRepository: { findOneBy: vi.fn(async (where: Record<string, unknown>) => rows.find(row => Object.entries(where).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value)) ?? null) },
			usersRepository: { findOneBy: vi.fn(async ({ id }: { id: string }) => users[id] ?? null) },
			userEntityService: { pack: vi.fn(async (user: { id: string } | string) => ({ id: typeof user === 'string' ? user : user.id })) },
			config: { url: 'https://local.test' },
		}) as unknown as { packReply(message: MiChatMessage, me?: { id: string }, withAuthor?: boolean): Promise<{ replyToId: string | null; reply: Record<string, unknown> | null }> };
	}

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
