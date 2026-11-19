/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { parse } from 'node-html-parser';
import type * as Misskey from 'cherrypick-js';
import { MiEmoji } from '@/models/Emoji.js';
import { MiNote } from '@/models/Note.js';
import { api, initTestDb, post, relativeFetch, signup, uploadFile } from '../utils.js';

describe('Remote notes embedded in local notes', () => {
	let author: Misskey.entities.SignupResponse;
	let target: Misskey.entities.Note;
	let replyTarget: Misskey.entities.Note;
	const reaction = ':boundary_flower@fixture.test:';
	const emojiUrl = 'http://localhost/fixture-boundary-flower.png';

	beforeAll(async () => {
		author = await signup({ username: 'visitor_local' });
		const remote = await signup({ username: 'visitor_remote', host: 'fixture.test' });
		const file = await uploadFile(remote, { path: 'drive-delete.png' });
		expect(file.status).toBe(200);
		replyTarget = await post(author, { text: 'Local parent', localOnly: true });
		target = await post(remote, {
			text: 'Remote note #garden',
			cw: 'Note title',
			replyId: replyTarget.id,
			fileIds: [file.body!.id],
			poll: { choices: ['A', 'B'] },
			localOnly: true,
		});
		const db = await initTestDb(true);
		try {
			await db.getRepository(MiEmoji).insert({ id: target.id, host: 'fixture.test', name: 'boundary_flower', originalUrl: emojiUrl });
			await db.getRepository(MiNote).update(target.id, {
				mentions: [author.id],
				emojis: ['boundary_flower'],
				reactions: { [reaction]: 1 },
			});
		} finally {
			await db.destroy();
		}
		expect((await api('admin/update-meta', { ugcVisibilityForVisitor: 'local' }, author)).status).toBe(204);
	});

	test.each(['renote', 'quote', 'reply'] as const)('hides a remote %s target for visitors only', async (kind) => {
		const relation = kind === 'reply' ? 'reply' : 'renote';
		const field = relation === 'reply' ? 'replyId' : 'renoteId';
		const text = kind === 'renote' ? null : 'Local note';
		const local = await post(author, { [field]: target.id, text, localOnly: true });

		const visitor = await api('notes/show', { noteId: local.id });
		const member = await api('notes/show', { noteId: local.id }, author);
		const embed = await relativeFetch(`/embed/notes/${local.id}`);

		expect(visitor.status).toBe(200);
		expect(embed.status).toBe(200);
		expect(embed.headers.get('cache-control')).toBe('no-store');
		const context = parse(await embed.text()).getElementById('cherrypick_clientCtx');
		expect(context).not.toBeNull();
		const embedded = (JSON.parse(context!.rawText) as { note: Misskey.entities.Note }).note;
		for (const visible of [visitor.body, embedded]) {
			expect(visible.text).toBe(text);
			expect(visible[field]).toBe(target.id);
			expect(visible[relation]).toMatchObject({
				id: target.id, replyId: replyTarget.id, isHidden: true, text: null, cw: null, files: [], fileIds: [],
				reactions: {}, reactionCount: 0, reactionEmojis: {},
			});
			expect(visible[relation]?.mentions).toBeUndefined();
			expect(visible[relation]?.emojis).toBeUndefined();
			expect(visible[relation]?.reply).toBeUndefined();
			expect(visible[relation]?.tags).toBeUndefined();
			expect(visible[relation]?.poll).toBeUndefined();
		}

		expect(member.status).toBe(200);
		expect(member.body[relation]?.text).toBe(target.text);
		expect(member.body[relation]?.cw).toBe(target.cw);
		expect(member.body[relation]?.fileIds).toEqual(target.fileIds);
		expect(member.body[relation]?.poll?.choices.map(choice => choice.text)).toEqual(['A', 'B']);
		expect(member.body[relation]?.mentions).toEqual([author.id]);
		expect(member.body[relation]?.reactions).toEqual({ [reaction]: 1 });
		expect(member.body[relation]?.reactionEmojis).toEqual({ 'boundary_flower@fixture.test': emojiUrl });
	});

	test('applies the same reaction policy to partial updates', async () => {
		const visibleReaction = {
			id: target.id,
			reactions: { [reaction]: 1 },
			reactionEmojis: { 'boundary_flower@fixture.test': emojiUrl },
		};
		const params = { noteIds: [target.id] };
		const visitor = await api('notes/show-partial-bulk', params);
		const member = await api('notes/show-partial-bulk', params, author);
		expect(visitor.status).toBe(200);
		expect(visitor.body).toEqual([{ id: target.id, reactions: {}, reactionEmojis: {} }]);
		expect(member.status).toBe(200);
		expect(member.body).toEqual([visibleReaction]);

		try {
			expect((await api('admin/update-meta', { ugcVisibilityForVisitor: 'all' }, author)).status).toBe(204);
			const publicUpdate = await api('notes/show-partial-bulk', params);
			expect(publicUpdate.status).toBe(200);
			expect(publicUpdate.body).toEqual([visibleReaction]);
		} finally {
			await api('admin/update-meta', { ugcVisibilityForVisitor: 'local' }, author);
		}
	});
});
