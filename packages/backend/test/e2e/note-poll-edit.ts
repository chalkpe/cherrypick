/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert';
import type * as misskey from 'cherrypick-js';
import { beforeAll, describe, test } from 'vitest';
import { api, castAsError, post, signup } from '../utils.js';

describe('notes/update poll votes', () => {
	let pollAuthor: misskey.entities.SignupResponse;

	beforeAll(async () => {
		pollAuthor = await signup({ username: 'editpolicypoll' });
	}, 1000 * 60 * 2);

	test('lets a previous voter vote again after the choices change', async () => {
		const note = await post(pollAuthor, { text: 'poll', poll: { choices: ['alpha', 'beta'] } });
		const firstVote = await api('notes/polls/vote', { noteId: note.id, choice: 0 }, pollAuthor);
		assert.strictEqual(firstVote.status, 204);

		const edited = await api('notes/update', {
			noteId: note.id,
			text: 'poll',
			cw: null,
			poll: { choices: ['gamma', 'delta'] },
		}, pollAuthor);
		assert.strictEqual(edited.status, 200);

		const secondVote = await api('notes/polls/vote', { noteId: note.id, choice: 1 }, pollAuthor);
		assert.strictEqual(secondVote.status, 204);
	});

	test('lets a previous voter vote again after the poll is removed and re-added', async () => {
		const note = await post(pollAuthor, { text: 'poll', poll: { choices: ['alpha', 'beta'] } });
		await api('notes/polls/vote', { noteId: note.id, choice: 0 }, pollAuthor);

		const removed = await api('notes/update', {
			noteId: note.id,
			text: 'poll',
			cw: null,
			poll: null,
		}, pollAuthor);
		assert.strictEqual(removed.status, 200);

		const readded = await api('notes/update', {
			noteId: note.id,
			text: 'poll',
			cw: null,
			poll: { choices: ['epsilon', 'zeta'] },
		}, pollAuthor);
		assert.strictEqual(readded.status, 200);

		const vote = await api('notes/polls/vote', { noteId: note.id, choice: 0 }, pollAuthor);
		assert.strictEqual(vote.status, 204);
	});

	test('clears every multiple-choice vote and its counts when the choices change', async () => {
		const note = await post(pollAuthor, { text: 'poll', poll: { choices: ['alpha', 'beta', 'gamma'], multiple: true } });
		assert.strictEqual((await api('notes/polls/vote', { noteId: note.id, choice: 0 }, pollAuthor)).status, 204);
		assert.strictEqual((await api('notes/polls/vote', { noteId: note.id, choice: 1 }, pollAuthor)).status, 204);

		const edited = await api('notes/update', {
			noteId: note.id,
			text: 'poll',
			cw: null,
			poll: { choices: ['delta', 'epsilon', 'zeta'], multiple: true },
		}, pollAuthor);
		assert.strictEqual(edited.status, 200);

		const before = await api('notes/show', { noteId: note.id }, pollAuthor);
		assert.deepStrictEqual(before.body.poll?.choices.map(choice => [choice.votes, choice.isVoted]), [[0, false], [0, false], [0, false]]);

		assert.strictEqual((await api('notes/polls/vote', { noteId: note.id, choice: 0 }, pollAuthor)).status, 204);
		assert.strictEqual((await api('notes/polls/vote', { noteId: note.id, choice: 1 }, pollAuthor)).status, 204);

		const after = await api('notes/show', { noteId: note.id }, pollAuthor);
		assert.deepStrictEqual(after.body.poll?.choices.map(choice => choice.votes), [1, 1, 0]);
	});

	test('lets a previous voter vote again after only the multiple flag changes', async () => {
		const note = await post(pollAuthor, { text: 'poll', poll: { choices: ['alpha', 'beta'], multiple: true } });
		assert.strictEqual((await api('notes/polls/vote', { noteId: note.id, choice: 0 }, pollAuthor)).status, 204);
		assert.strictEqual((await api('notes/polls/vote', { noteId: note.id, choice: 1 }, pollAuthor)).status, 204);

		const edited = await api('notes/update', {
			noteId: note.id,
			text: 'poll',
			cw: null,
			poll: { choices: ['alpha', 'beta'], multiple: false },
		}, pollAuthor);
		assert.strictEqual(edited.status, 200);

		const vote = await api('notes/polls/vote', { noteId: note.id, choice: 1 }, pollAuthor);
		assert.strictEqual(vote.status, 204);
	});

	test('keeps votes when the poll choices are unchanged', async () => {
		const note = await post(pollAuthor, { text: 'poll', poll: { choices: ['alpha', 'beta'] } });
		assert.strictEqual((await api('notes/polls/vote', { noteId: note.id, choice: 0 }, pollAuthor)).status, 204);

		const edited = await api('notes/update', {
			noteId: note.id,
			text: 'poll edited',
			cw: null,
			poll: { choices: ['alpha', 'beta'] },
		}, pollAuthor);
		assert.strictEqual(edited.status, 200);

		const vote = await api('notes/polls/vote', { noteId: note.id, choice: 1 }, pollAuthor);
		assert.strictEqual(vote.status, 400);
		assert.strictEqual(castAsError(vote.body as any).error.code, 'ALREADY_VOTED');
	});
});
