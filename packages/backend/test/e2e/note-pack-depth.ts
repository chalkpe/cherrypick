/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeAll, describe, expect, test } from 'vitest';
import type * as Misskey from 'cherrypick-js';
import { api, post, react, signup } from '../utils.js';

// Counts every note object nested in reply/renote below (and including) the given note.
function countNotes(note: any): number {
	if (note == null || typeof note !== 'object') return 0;
	return 1 + countNotes(note.reply) + countNotes(note.renote);
}

describe('Nested note packing', () => {
	let alice: Misskey.entities.SignupResponse;

	beforeAll(async () => {
		alice = await signup({ username: 'packdepth' });
	}, 1000 * 60 * 2);

	test('the number of nested notes grows with the chain length when reply and renote point at the same note', async () => {
		const length = 10;
		let current = await post(alice, { text: 'chain root', visibility: 'public' });
		for (let i = 1; i <= length; i++) {
			current = await post(alice, { text: `chain ${i}`, replyId: current.id, renoteId: current.id });
		}

		const res = await api('notes/show', { noteId: current.id }, alice);
		expect(res.status).toBe(200);

		const count = countNotes(res.body);
		expect(count).toBeGreaterThanOrEqual(length);
		expect(count).toBeLessThanOrEqual(5 * (length + 1));
	}, 1000 * 60 * 5);

	test('a reply target keeps its poll and myReaction', async () => {
		const target = await post(alice, { text: 'poll target', poll: { choices: ['a', 'b'] } });
		await react(alice, target, '👍');
		const reply = await post(alice, { text: 'reply to poll', replyId: target.id });

		const res = await api('notes/show', { noteId: reply.id }, alice);
		expect(res.status).toBe(200);
		expect(res.body.reply?.poll?.choices.map((c: any) => c.text)).toEqual(['a', 'b']);
		expect(res.body.reply?.myReaction).toBe('👍');
	});

	test('the reply target of a renoted reply keeps its myReaction', async () => {
		const target = await post(alice, { text: 'reaction target' });
		await react(alice, target, '👍');
		const reply = await post(alice, { text: 'reply to reaction target', replyId: target.id });
		const renote = await post(alice, { renoteId: reply.id });

		const res = await api('notes/show', { noteId: renote.id }, alice);
		expect(res.status).toBe(200);
		expect(res.body.renote?.id).toBe(reply.id);
		expect(res.body.renote?.reply?.id).toBe(target.id);
		expect(res.body.renote?.reply?.myReaction).toBe('👍');
	});

	test('notes above the reply target are packed without detail fields', async () => {
		const root = await post(alice, { text: 'thread root', poll: { choices: ['a', 'b'] } });
		const middle = await post(alice, { text: 'thread middle', replyId: root.id });
		const leaf = await post(alice, { text: 'thread leaf', replyId: middle.id });

		const res = await api('notes/show', { noteId: leaf.id }, alice);
		expect(res.status).toBe(200);
		expect(res.body.reply?.id).toBe(middle.id);
		expect(res.body.reply?.reply?.id).toBe(root.id);
		expect(res.body.reply?.reply?.poll).toBeUndefined();
		expect(res.body.reply?.reply?.reply).toBeUndefined();
	});
});
