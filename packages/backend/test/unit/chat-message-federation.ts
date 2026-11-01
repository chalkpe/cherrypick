/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import {
	buildChatDelete,
	buildChatNote,
	buildChatReaction,
	buildChatReactionUndo,
	buildChatRoomDelete,
	buildChatRoomUpdate,
	buildChatUpdate,
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
