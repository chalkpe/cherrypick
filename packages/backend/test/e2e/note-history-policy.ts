/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert';
import type * as misskey from 'cherrypick-js';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { api, castAsError, post, signup } from '../utils.js';

describe('notes/history access policy', () => {
	let root: misskey.entities.SignupResponse;
	let author: misskey.entities.SignupResponse;
	let follower: misskey.entities.SignupResponse;
	let stranger: misskey.entities.SignupResponse;
	let remote: misskey.entities.SignupResponse;
	let noteId: string;

	const future = (): number => Math.floor(Date.now() / 1000) + 3600;

	beforeAll(async () => {
		root = await signup({ username: 'histpolicyroot' });
		author = await signup({ username: 'histpolicyauthor' });
		follower = await signup({ username: 'histpolicyfollower' });
		stranger = await signup({ username: 'histpolicystranger' });
		remote = await signup({ username: 'histpolicyremote', host: 'example.com' });

		await api('following/create', { userId: author.id }, follower);

		const note = await post(author, { text: 'original secret' });
		noteId = note.id;

		const edited = await api('notes/update', {
			noteId,
			text: 'edited secret',
			cw: null,
		}, author);
		assert.strictEqual(edited.status, 200);
	}, 1000 * 60 * 2);

	afterAll(async () => {
		await api('i/update', {
			requireSigninToViewContents: false,
			makeNotesHiddenBefore: null,
			makeNotesFollowersOnlyBefore: null,
		}, author);
		await api('admin/update-meta', { ugcVisibilityForVisitor: 'all' }, root);
	});

	test('returns the edit history to the author', async () => {
		const res = await api('notes/history', { noteId }, author);
		assert.strictEqual(res.status, 200);
		assert.ok(res.body.length >= 1);
		assert.ok(res.body.some(history => history.text === 'original secret'));
	});

	test('does not expose history to anonymous viewers when the author requires sign-in', async () => {
		await api('i/update', { requireSigninToViewContents: true }, author);

		const res = await api('notes/history', { noteId });
		assert.strictEqual(res.status, 400);
		assert.strictEqual(castAsError(res.body as any).error.code, 'CONTENT_RESTRICTED_BY_USER');

		const owner = await api('notes/history', { noteId }, author);
		assert.strictEqual(owner.status, 200);
		assert.ok(owner.body.length >= 1);

		await api('i/update', { requireSigninToViewContents: false }, author);
	});

	test('does not expose history to anonymous viewers when the server disallows visitor content', async () => {
		await api('admin/update-meta', { ugcVisibilityForVisitor: 'none' }, root);

		const res = await api('notes/history', { noteId });
		assert.strictEqual(res.status, 400);
		assert.strictEqual(castAsError(res.body as any).error.code, 'CONTENT_RESTRICTED_BY_SERVER');

		const signedIn = await api('notes/history', { noteId }, stranger);
		assert.strictEqual(signedIn.status, 200, JSON.stringify(signedIn.body));

		await api('admin/update-meta', { ugcVisibilityForVisitor: 'all' }, root);
	});

	test('does not expose remote note history to anonymous viewers when only local content is visible', async () => {
		const remoteNote = await post(remote, { text: 'remote secret' });
		await api('admin/update-meta', { ugcVisibilityForVisitor: 'local' }, root);

		const local = await api('notes/history', { noteId });
		assert.strictEqual(local.status, 200);

		const res = await api('notes/history', { noteId: remoteNote.id });
		assert.strictEqual(res.status, 400);
		assert.strictEqual(castAsError(res.body as any).error.code, 'CONTENT_RESTRICTED_BY_SERVER');

		await api('admin/update-meta', { ugcVisibilityForVisitor: 'all' }, root);
	});

	test('does not expose history of notes hidden after a while', async () => {
		await api('i/update', { makeNotesHiddenBefore: future() }, author);

		const anonymous = await api('notes/history', { noteId });
		assert.strictEqual(anonymous.status, 200);
		assert.deepStrictEqual(anonymous.body, []);

		const owner = await api('notes/history', { noteId }, author);
		assert.strictEqual(owner.status, 200);
		assert.ok(owner.body.length >= 1);

		await api('i/update', { makeNotesHiddenBefore: null }, author);
	});

	test('does not expose history of notes that became followers-only to strangers', async () => {
		await api('i/update', { makeNotesFollowersOnlyBefore: future() }, author);

		const anonymous = await api('notes/history', { noteId });
		assert.deepStrictEqual(anonymous.body, []);

		const strangerRes = await api('notes/history', { noteId }, stranger);
		assert.deepStrictEqual(strangerRes.body, []);

		const followerRes = await api('notes/history', { noteId }, follower);
		assert.strictEqual(followerRes.status, 200);
		assert.ok(followerRes.body.length >= 1);

		await api('i/update', { makeNotesFollowersOnlyBefore: null }, author);
	});

	test('does not expose history of notes hidden after a while even to followers', async () => {
		await api('i/update', { makeNotesHiddenBefore: future() }, author);

		const followerRes = await api('notes/history', { noteId }, follower);
		assert.strictEqual(followerRes.status, 200);
		assert.deepStrictEqual(followerRes.body, []);

		await api('i/update', { makeNotesHiddenBefore: null }, author);
	});

	test('does not expose history of an edited followers-only note to non-followers', async () => {
		const note = await post(author, { text: 'followers original', visibility: 'followers' });
		const edited = await api('notes/update', { noteId: note.id, text: 'followers edited', cw: null }, author);
		assert.strictEqual(edited.status, 200);

		const anonymous = await api('notes/history', { noteId: note.id });
		assert.strictEqual(anonymous.status, 400);
		assert.strictEqual(castAsError(anonymous.body as any).error.code, 'NO_SUCH_NOTE');

		const strangerRes = await api('notes/history', { noteId: note.id }, stranger);
		assert.strictEqual(strangerRes.status, 400);
		assert.strictEqual(castAsError(strangerRes.body as any).error.code, 'NO_SUCH_NOTE');

		const followerRes = await api('notes/history', { noteId: note.id }, follower);
		assert.strictEqual(followerRes.status, 200);
		assert.ok(followerRes.body.some(history => history.text === 'followers original'));
	});
});
