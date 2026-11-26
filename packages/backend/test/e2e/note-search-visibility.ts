/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeAll, describe, expect, test } from 'vitest';
import type * as Misskey from 'cherrypick-js';
import { api, post, signup } from '../utils.js';

describe('Note search visibility', () => {
	let root: Misskey.entities.SignupResponse;
	let viewer: Misskey.entities.SignupResponse;

	beforeAll(async () => {
		root = await signup({ username: 'search_root' });
		viewer = await signup({ username: 'search_viewer' });
		expect((await api('admin/update-meta', { ugcVisibilityForVisitor: 'all' }, root)).status).toBe(204);
		const policies = { canSearchNotes: true };
		expect((await api('admin/roles/update-default-policies', { policies: policies as never }, root)).status).toBe(204);
	});

	test('omits older hidden matches for other users and keeps the author’s result', async () => {
		const author = await signup({ username: 'search_author' });
		const query = 'gardenflowers';
		const note = await post(author, { text: query, localOnly: true });
		expect((await api('i/update', { makeNotesHiddenBefore: 0 }, author)).status).toBe(200);

		const other = await api('notes/search', { query }, viewer);
		const own = await api('notes/search', { query }, author);

		expect(other.status).toBe(200);
		expect(other.body).toEqual([]);
		expect(own.status).toBe(200);
		expect(own.body.map(result => result.id)).toEqual([note.id]);
	});

	test('fills the page with visible matches for visitors and keeps sign-in-only matches for members', async () => {
		const author = await signup({ username: 'search_members' });
		const query = 'terraceflowers';
		const visible = await post(viewer, { text: query, localOnly: true });
		expect((await api('i/update', { requireSigninToViewContents: true }, author)).status).toBe(200);
		await Promise.all(Array.from({ length: 32 }, () => post(author, { text: query, localOnly: true })));
		const membersOnly = await post(author, { text: query, localOnly: true });

		const visitor = await api('notes/search', { query, limit: 1 });
		const member = await api('notes/search', { query, limit: 1 }, viewer);

		expect(visitor.status).toBe(200);
		expect(visitor.body.map(result => result.id)).toEqual([visible.id]);
		expect(member.status).toBe(200);
		expect(member.body.map(result => result.id)).toEqual([membersOnly.id]);
	});

	test('pages through replies and quotes while omitting those that point at suspended users', async () => {
		const author = await signup({ username: 'search_thread' });
		const target = await signup({ username: 'search_target' });
		const suspended = await signup({ username: 'search_suspended' });
		const query = 'meadowflowers';
		const parent = await post(target, { text: 'garden', localOnly: true });
		const hiddenParent = await post(suspended, { text: 'garden', localOnly: true });
		const reply = await post(author, { text: query, replyId: parent.id, localOnly: true });
		await post(author, { text: query, replyId: hiddenParent.id, localOnly: true });
		const quote = await post(author, { text: query, renoteId: parent.id, localOnly: true });
		await post(author, { text: query, renoteId: hiddenParent.id, localOnly: true });
		const plain = await post(author, { text: query, localOnly: true });
		expect((await api('admin/suspend-user', { userId: suspended.id }, root)).status).toBe(204);

		const first = await api('notes/search', { query, limit: 2 }, viewer);
		const next = await api('notes/search', { query, limit: 2, untilId: quote.id }, viewer);
		const previous = await api('notes/search', { query, limit: 2, sinceId: reply.id }, viewer);

		expect(first.status).toBe(200);
		expect(first.body.map(result => result.id)).toEqual([plain.id, quote.id]);
		expect(first.body[1].renote?.user.id).toBe(target.id);
		expect(next.status).toBe(200);
		expect(next.body.map(result => result.id)).toEqual([reply.id]);
		expect(next.body[0].reply?.user.id).toBe(target.id);
		expect(previous.status).toBe(200);
		expect(previous.body.map(result => result.id)).toEqual([quote.id, plain.id]);
	});

	test('applies the same age-based visibility to text, tags, and clip searches', async () => {
		const author = await signup({ username: 'search_tag_author' });
		const tag = 'ridgeflowers';
		const note = await post(author, { text: `#${tag}`, localOnly: true });
		const clip = await api('clips/create', { name: 'garden', isPublic: true }, viewer);
		expect((await api('following/create', { userId: author.id }, viewer)).status).toBe(200);
		expect((await api('i/update', { makeNotesFollowersOnlyBefore: 0 }, author)).status).toBe(200);
		expect((await api('clips/add-note', { clipId: clip.body.id, noteId: note.id }, viewer)).status).toBe(204);

		const text = () => api('notes/search', { query: tag }, viewer);
		const tags = () => api('notes/search-by-tag', { tag }, viewer);
		const clipText = () => api('clips/notes', { clipId: clip.body.id, search: tag }, viewer);
		for (const search of [text, tags, clipText]) {
			const result = await search();
			expect(result.status).toBe(200);
			expect(result.body.map(match => match.id)).toEqual([note.id]);
		}

		expect((await api('following/delete', { userId: author.id }, viewer)).status).toBe(200);
		for (const search of [text, tags, clipText]) {
			const result = await search();
			expect(result.status).toBe(200);
			expect(result.body).toEqual([]);
		}
	});

	test('lets only the clip owner remove a hidden entry without returning its body', async () => {
		const author = await signup({ username: 'search_clip_author' });
		const note = await post(author, { text: 'springorchids', cw: 'garden notes', localOnly: true });
		const clip = await api('clips/create', { name: 'Spring garden', isPublic: true }, viewer);
		const params = { clipId: clip.body.id, noteId: note.id };
		expect((await api('clips/add-note', params, viewer)).status).toBe(204);
		expect((await api('i/update', { makeNotesHiddenBefore: Math.ceil(Date.now() / 1000) + 1 }, author)).status).toBe(200);

		const list = await api('clips/notes', { clipId: params.clipId }, viewer);
		expect(list.status).toBe(200);
		expect(list.body).toEqual([expect.objectContaining({ id: note.id, isHidden: true, text: null, cw: null, files: [] })]);
		expect((await api('clips/notes', { clipId: params.clipId })).body).toEqual([]);
		for (const search of ['springorchids', 'garden', 'unmatched']) {
			const matches = await api('clips/notes', { clipId: params.clipId, search }, viewer);
			expect(matches.status).toBe(200);
			expect(matches.body).toEqual([]);
		}

		expect((await api('clips/remove-note', params, viewer)).status).toBe(204);
		expect((await api('clips/show', { clipId: params.clipId }, viewer)).body.notesCount).toBe(0);
		expect((await api('clips/notes', { clipId: params.clipId }, viewer)).body).toEqual([]);
		expect((await api('clips/delete', { clipId: params.clipId }, viewer)).status).toBe(204);
	});
});
