/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { StatusError } from '@/misc/status-error.js';
import { getApId } from '@/core/activitypub/type.js';
import type { IPost } from '@/core/activitypub/type.js';
import { chatTransactions } from '../misc/chat-transactions.js';

const actor = { id: 'author', host: 'remote.test', uri: 'https://remote.test/users/author' };
const otherActor = { id: 'other', host: 'remote.test', uri: 'https://remote.test/users/other' };
const recipient = { id: 'recipient', host: null, uri: null };
const messageUri = 'https://remote.test/chat/messages/message1';
const object: IPost = {
	id: messageUri,
	type: 'Note',
	attributedTo: actor.uri,
	_misskey_talk: true,
	_misskey_content: 'original',
	to: ['https://local.test/users/recipient'],
};

function fixture(options: { beforeNoteInsert?: () => Promise<void>; resolveImage?: () => Promise<null> } = {}) {
	type StoredNote = { id: string; uri: string; userId: string; text: string };
	const notes = new Map<string, StoredNote>();
	const chatTexts: string[] = [];
	const locks = new Map<string, string>();
	const tombstones = new Map<string, string>();
	const policy = { chatAvailability: 'unavailable' };
	const reactionService = {
		create: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
	};
	const storePendingChatReaction = vi.fn(async () => true);
	let creationAttempts = 0;
	const inbox = Object.assign(Object.create(ApInboxService.prototype), {
		db: chatTransactions(),
		chatService: {
			findMessageByUri: async () => null,
			createMessageToUser: async (_actor: unknown, _recipient: unknown, params: { text: string }) => { chatTexts.push(params.text); },
			storePendingChatReaction,
		},
		reactionService,
		chatMessagesRepository: { findOneBy: async () => null },
		redisClient: {
			get: async (key: string) => locks.get(key) ?? tombstones.get(key) ?? null,
			set: async (key: string, value: string) => {
				if (locks.has(key)) return null;
				locks.set(key, value);
				return 'OK';
			},
			del: async (key: string) => Number(locks.delete(key)),
			setex: async (key: string, _ttl: number, value: string) => { tombstones.set(key, value); },
			scard: async () => 0,
			sadd: async () => 1,
			expire: async () => 1,
			smembers: async () => [],
		},
		notesRepository: { findOneBy: async ({ uri }: { uri: string }) => notes.get(uri) ?? null },
		apDbResolverService: { getNoteFromApId: async (uri: string) => notes.get(uri) ?? null },
		apNoteService: {
			fetchNote: async (value: string | IPost) => notes.get(getApId(value)) ?? null,
			extractEmojis: async () => [],
			createNote: async (note: IPost) => {
				creationAttempts++;
				await options.beforeNoteInsert?.();
				if (!notes.has(note.id!)) {
					notes.set(note.id!, { id: 'note1', uri: note.id!, userId: actor.id, text: note._misskey_content! });
				}
				return notes.get(note.id!);
			},
			updateNote: async (note: IPost, target: StoredNote) => {
				target.text = note._misskey_content!;
				return target;
			},
		},
		noteDeleteService: { delete: async (_actor: unknown, note: StoredNote) => { notes.delete(note.uri); } },
		apImageService: { resolveImage: options.resolveImage ?? (async () => null) },
		apPersonService: { resolvePerson: async () => recipient },
		apResolverService: { createResolver: async () => ({ resolve: async (value: unknown) => value }) },
		roleService: { getUserPolicies: async () => policy },
		userEntityService: { isLocalUser: (user: { host: string | null }) => user.host == null },
		utilityService: new UtilityService({ host: 'local.test', url: 'https://local.test' } as never, {} as never),
		logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
	});
	return { inbox, notes, chatTexts, tombstones, policy, reactionService, storePendingChatReaction, creationAttempts: () => creationAttempts };
}

describe('ordinary note likes', () => {
	test('undoes a plain Like without emoji reaction fields', async () => {
		const f = fixture();
		const note = { id: 'ordinary-note', uri: 'https://remote.test/notes/ordinary-note', userId: actor.id, text: 'ordinary note' };
		f.notes.set(note.uri, note);

		const result = await f.inbox.performOneActivity(otherActor, {
			type: 'Undo', actor: otherActor.uri,
			object: { type: 'Like', actor: otherActor.uri, object: note.uri },
		});

		expect(result).toBe('ok');
		expect(f.reactionService.delete).toHaveBeenCalledWith(otherActor, note);
		expect(f.storePendingChatReaction).not.toHaveBeenCalled();
	});
});

describe('chat messages converted to private notes', () => {
	test.each([
		{ type: 'Like', reaction: undefined },
		{ type: 'EmojiReact', reaction: '👍' },
	])('applies $type to the existing note instead of deferring a chat reaction', async ({ type, reaction }) => {
		const f = fixture();
		await f.inbox.createChatMessage({}, actor, object, { type: 'Create', actor: actor.uri });

		const result = await f.inbox.performOneActivity(otherActor, {
			type, actor: otherActor.uri, object: messageUri, content: reaction,
		});

		expect(result).toBe('ok');
		expect(f.reactionService.create).toHaveBeenCalledWith(otherActor, f.notes.get(messageUri), reaction);
		expect(f.storePendingChatReaction).not.toHaveBeenCalled();
	});

	test.each([
		{ type: 'Like', reaction: undefined },
		{ type: 'EmojiReact', reaction: '👍' },
	])('undoes $type on the existing note instead of deferring a chat reaction', async ({ type, reaction }) => {
		const f = fixture();
		await f.inbox.createChatMessage({}, actor, object, { type: 'Create', actor: actor.uri });

		const result = await f.inbox.performOneActivity(otherActor, {
			type: 'Undo', actor: otherActor.uri,
			object: { type, actor: otherActor.uri, object: messageUri, content: reaction },
		});

		expect(result).toBe('ok');
		expect(f.reactionService.delete).toHaveBeenCalledWith(otherActor, f.notes.get(messageUri));
		expect(f.storePendingChatReaction).not.toHaveBeenCalled();
	});

	test.each(['unavailable', 'available'])('updates the existing note when current chat availability is %s', async (availability) => {
		const f = fixture();
		await f.inbox.createChatMessage({}, actor, object, { type: 'Create', actor: actor.uri });
		f.policy.chatAvailability = availability;

		await f.inbox.update(actor, {
			type: 'Update', actor: actor.uri,
			object: { ...object, attributedTo: [actor.uri], _misskey_content: 'edited' },
		});

		expect([...f.notes.values()]).toEqual([{ id: 'note1', uri: messageUri, userId: actor.id, text: 'edited' }]);
		expect(f.creationAttempts()).toBe(1);
		expect(f.chatTexts).toEqual([]);
	});

	test('deletes the existing note instead of storing a chat tombstone', async () => {
		const f = fixture();
		await f.inbox.createChatMessage({}, actor, object, { type: 'Create', actor: actor.uri });

		await f.inbox.delete(actor, {
			type: 'Delete', actor: actor.uri,
			object: { id: messageUri, type: 'Tombstone', formerType: 'Note' },
		});

		expect(f.notes.size).toBe(0);
		expect(f.tombstones.size).toBe(0);
	});

	test('keeps note deletion restricted to the original author', async () => {
		const f = fixture();
		await f.inbox.createChatMessage({}, actor, object, { type: 'Create', actor: actor.uri });

		await f.inbox.delete(otherActor, { type: 'Delete', actor: otherActor.uri, object: messageUri });

		expect(f.notes.get(messageUri)?.text).toBe('original');
		expect(f.tombstones.size).toBe(0);
	});

	test('rejects updates whose attribution does not match the authenticated actor', async () => {
		const f = fixture();
		await f.inbox.createChatMessage({}, actor, object, { type: 'Create', actor: actor.uri });

		await f.inbox.update(otherActor, {
			type: 'Update', actor: otherActor.uri, object: { ...object, _misskey_content: 'forged' },
		});

		expect(f.notes.get(messageUri)?.text).toBe('original');
		expect(f.creationAttempts()).toBe(1);
	});

	test('leaves the attachments of a converted message to the note, which downloads them itself', async () => {
		const resolveImage = vi.fn(async () => null);
		const f = fixture({ resolveImage });

		await f.inbox.createChatMessage({}, actor, {
			...object, attachment: [{ type: 'Document', url: 'https://remote.test/file.png' }],
		}, { type: 'Create', actor: actor.uri });

		expect(resolveImage).not.toHaveBeenCalled();
		expect(f.notes.size).toBe(1);
	});

	test('does not retry a note conversion that failed permanently', async () => {
		const f = fixture({ beforeNoteInsert: async () => { throw new StatusError('gone', 410); } });

		expect(await f.inbox.createChatMessage({}, actor, object, { type: 'Create', actor: actor.uri })).toBe('skip 410');
	});

	test('retries a note conversion that failed temporarily', async () => {
		const f = fixture({ beforeNoteInsert: async () => { throw new StatusError('unavailable', 503); } });

		await expect(f.inbox.createChatMessage({}, actor, object, { type: 'Create', actor: actor.uri })).rejects.toThrow('unavailable');
	});

	test('removes the converted note when Delete arrives during note creation', async () => {
		const inserting = Promise.withResolvers<void>();
		const finishInsertion = Promise.withResolvers<void>();
		const f = fixture({ beforeNoteInsert: async () => {
			inserting.resolve();
			await finishInsertion.promise;
		} });
		const creating = f.inbox.createChatMessage({}, actor, object, { type: 'Create', actor: actor.uri });
		await inserting.promise;
		await f.inbox.delete(actor, { type: 'Delete', actor: actor.uri, object: messageUri });
		finishInsertion.resolve();
		await creating;

		expect(f.notes.size).toBe(0);
	});
});
