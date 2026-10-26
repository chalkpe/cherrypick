/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert';
import type * as misskey from 'cherrypick-js';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { api, castAsError, post, signup } from '../utils.js';

describe('notes/update content policy', () => {
	let root: misskey.entities.SignupResponse;
	let editor: misskey.entities.SignupResponse;

	beforeAll(async () => {
		root = await signup({ username: 'editpolicyroot' });
		editor = await signup({ username: 'editpolicyeditor' });
	}, 1000 * 60 * 2);

	afterAll(async () => {
		await api('admin/update-meta', {
			prohibitedWords: [],
			sensitiveWords: [],
		}, root);
	});

	test('rejects prohibited words added by an edit', async () => {
		await api('admin/update-meta', { prohibitedWords: ['editbanned'] }, root);
		const note = await post(editor, { text: 'clean note' });

		const res = await api('notes/update', {
			noteId: note.id,
			text: 'now editbanned content',
			cw: null,
		}, editor);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(castAsError(res.body as any).error.code, 'CONTAINS_PROHIBITED_WORDS');

		await api('admin/update-meta', { prohibitedWords: [] }, root);
	});

	test('downgrades a public note containing sensitive words to home', async () => {
		await api('admin/update-meta', { sensitiveWords: ['editsensitive'] }, root);
		const note = await post(editor, { text: 'clean note', visibility: 'public' });

		const res = await api('notes/update', {
			noteId: note.id,
			text: 'now editsensitive content',
			cw: null,
		}, editor);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.updatedNote.visibility, 'home');

		await api('admin/update-meta', { sensitiveWords: [] }, root);
	});

	test('rejects prohibited words hidden in a percent-encoded URL added by an edit', async () => {
		await api('admin/update-meta', { prohibitedWords: ['editbanned'] }, root);
		const note = await post(editor, { text: 'clean note' });

		const res = await api('notes/update', {
			noteId: note.id,
			text: 'see https://example.com/%65ditbanned',
			cw: null,
		}, editor);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(castAsError(res.body as any).error.code, 'CONTAINS_PROHIBITED_WORDS');

		await api('admin/update-meta', { prohibitedWords: [] }, root);
	});

	test('downgrades a public note whose sensitive words are hidden in a percent-encoded URL', async () => {
		await api('admin/update-meta', { sensitiveWords: ['editsensitive'] }, root);
		const note = await post(editor, { text: 'clean note', visibility: 'public' });

		const res = await api('notes/update', {
			noteId: note.id,
			text: 'see https://example.com/%65ditsensitive',
			cw: null,
		}, editor);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.updatedNote.visibility, 'home');

		await api('admin/update-meta', { sensitiveWords: [] }, root);
	});
});
