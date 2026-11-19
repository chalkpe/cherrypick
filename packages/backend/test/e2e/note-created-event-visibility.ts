/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type * as Misskey from 'cherrypick-js';
import { api, connectStream, signup, startJobQueue } from '../utils.js';
import type { INestApplicationContext } from '@nestjs/common';

const HOOK_PORT = 15081;

type User = Misskey.entities.SignupResponse;

const post = async (user: User, params: Misskey.Endpoints['notes/create']['req']): Promise<Misskey.entities.Note> => {
	const res = await api('notes/create', params, user);
	if (res.status !== 200) throw new Error(`notes/create failed: ${res.status} ${JSON.stringify(res.body)}`);
	return res.body.createdNote;
};

const follow = async (follower: User, followee: User) => {
	const res = await api('following/create', { userId: followee.id }, follower);
	expect(res.status).toBe(200);
};

function findNote(note: any, id: string): any | null {
	if (note == null || typeof note !== 'object') return null;
	if (note.id === id) return note;
	return findNote(note.reply, id) ?? findNote(note.renote, id);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('Events of newly created notes', () => {
	let alice: User;
	let author: User;
	let carol1: User;
	let carol2: User;
	let hiddenOwner: User;
	let quoted: User;
	let former: User;
	let dmOwner: User;

	const received: { type: string; userId: string; note: any }[] = [];
	let hookServer: Server;
	let queue: INestApplicationContext;

	const waitFor = async <T>(source: () => T | undefined, timeout = 10000): Promise<T> => {
		const limit = Date.now() + timeout;
		while (Date.now() < limit) {
			const found = source();
			if (found !== undefined) return found;
			await sleep(100);
		}
		throw new Error('timeout');
	};

	const listen = async (user: User, type: string) => {
		const messages: any[] = [];
		const ws = await connectStream(user, 'main', msg => {
			if (msg.type === type) messages.push(msg.body);
		});
		return {
			find: (noteId: string) => waitFor(() => messages.find(m => m.id === noteId)),
			close: () => ws.close(),
		};
	};

	const webhook = (userId: string, type: string, noteId: string) =>
		waitFor(() => received.find(x => x.userId === userId && x.type === type && x.note?.id === noteId))
			.then(x => x.note);

	beforeAll(async () => {
		queue = await startJobQueue();
		alice = await signup({ username: 'evtalice' });
		author = await signup({ username: 'evtauthor' });
		carol1 = await signup({ username: 'evtcarolone' });
		carol2 = await signup({ username: 'evtcaroltwo' });
		hiddenOwner = await signup({ username: 'evthiddenowner' });
		quoted = await signup({ username: 'evtquoted' });
		former = await signup({ username: 'evtformer' });
		dmOwner = await signup({ username: 'evtdmowner' });

		await follow(author, alice);
		await follow(carol1, author);
		await follow(carol2, carol1);

		hookServer = createServer((req, res) => {
			let data = '';
			req.on('data', chunk => data += chunk);
			req.on('end', () => {
				try {
					const payload = JSON.parse(data);
					received.push({ type: payload.type, userId: payload.userId, note: payload.body?.note });
				} catch {}
				res.statusCode = 200;
				res.end('ok');
			});
		});
		await new Promise<void>(resolve => hookServer.listen(HOOK_PORT, '127.0.0.1', resolve));

		for (const [user, on] of [[carol2, ['note']], [quoted, ['renote']]] as const) {
			const res = await api('i/webhooks/create', {
				name: 'events',
				url: `http://127.0.0.1:${HOOK_PORT}/`,
				secret: 'secret',
				on: [...on],
			}, user);
			expect(res.status).toBe(200);
		}
		await sleep(1000);
	}, 1000 * 60 * 2);

	afterAll(async () => {
		await new Promise<void>(resolve => hookServer.close(() => resolve()));
		await queue.close();
	});

	describe('thread of followers-only notes', () => {
		const W1_TEXT = 'followers-only thread root text';
		const W2_TEXT = 'followers-only thread reply text';
		const X_TEXT = 'followers-only reply from the follower';
		let x: Misskey.entities.Note;
		let y: Misskey.entities.Note;
		let w2: Misskey.entities.Note;

		beforeAll(async () => {
			const w1 = await post(alice, { text: W1_TEXT, visibility: 'followers' });
			w2 = await post(alice, { text: W2_TEXT, visibility: 'followers', replyId: w1.id });
			x = await post(author, { text: X_TEXT, replyId: w2.id });
			y = await post(carol1, { text: 'reply by carol1', replyId: x.id });
		});

		test('the reply event of a user who can no longer see the replied note does not carry it', async () => {
			const FOLLOWERS_TEXT = 'followers-only note seen before unfollowing';
			await follow(former, alice);
			await follow(alice, former);
			const root = await post(alice, { text: FOLLOWERS_TEXT, visibility: 'followers' });
			const own = await post(former, { text: 'reply written while following', replyId: root.id });
			const res = await api('following/delete', { userId: alice.id }, former);
			expect(res.status).toBe(200);
			await sleep(1000);

			const listener = await listen(former, 'reply');
			try {
				const z = await post(alice, { text: 'reply to the former follower', replyId: own.id });
				const body = await listener.find(z.id);
				expect(JSON.stringify(body)).not.toContain(FOLLOWERS_TEXT);
				expect(body.reply?.id).toBe(own.id);
				const hidden = findNote(body, root.id);
				expect(hidden).not.toBeNull();
				expect(hidden.isHidden).toBe(true);
				expect(hidden.text ?? null).toBeNull();
			} finally {
				listener.close();
			}
		});

		test('the note webhook of the author does not carry notes the author cannot see', async () => {
			const z = await post(carol2, { text: 'webhook reply by carol2', replyId: y.id });
			const note = await webhook(carol2.id, 'note', z.id);
			const json = JSON.stringify(note);
			expect(json).not.toContain(W1_TEXT);
			expect(json).not.toContain(W2_TEXT);
			expect(json).not.toContain(X_TEXT);
			expect(findNote(note, y.id)?.text).toBe('reply by carol1');
		});

		test('a user who can see the thread still receives the visible notes', async () => {
			const listener = await listen(author, 'reply');
			try {
				const reply = await post(carol1, { text: 'reply to the author', replyId: x.id });
				const body = await listener.find(reply.id);
				expect(body.text).toBe('reply to the author');
				expect(body.reply?.id).toBe(x.id);
				expect(body.reply?.text).toBe(X_TEXT);
				expect(body.reply?.reply?.id).toBe(w2.id);
				expect(body.reply?.reply?.text).toBe(W2_TEXT);
				expect(body.reply?.reply?.isHidden).not.toBe(true);
			} finally {
				listener.close();
			}
		});
	});

	describe('thread of direct notes', () => {
		const W_TEXT = 'direct thread root text';
		let w: Misskey.entities.Note;
		let x: Misskey.entities.Note;
		let y: Misskey.entities.Note;

		beforeAll(async () => {
			w = await post(alice, { text: W_TEXT, visibility: 'specified', visibleUserIds: [author.id] });
			x = await post(author, { text: 'direct reply', visibility: 'specified', visibleUserIds: [carol1.id], replyId: w.id });
			y = await post(carol1, { text: 'direct reply to the reply', visibility: 'specified', visibleUserIds: [author.id], replyId: x.id });
		});

		test('the reply event of a recipient does not carry the replied note once its author hid it', async () => {
			const HIDDEN_TEXT = 'direct note hidden afterwards';
			const root = await post(dmOwner, { text: HIDDEN_TEXT, visibility: 'specified', visibleUserIds: [carol1.id] });
			const own = await post(carol1, { text: 'direct reply by the recipient', visibility: 'specified', visibleUserIds: [dmOwner.id, author.id], replyId: root.id });
			const res = await api('i/update', { makeNotesHiddenBefore: Math.floor(Date.now() / 1000) + 3600 }, dmOwner);
			expect(res.status).toBe(200);

			const listener = await listen(carol1, 'reply');
			try {
				const z = await post(author, { text: 'direct reply to the recipient', visibility: 'specified', visibleUserIds: [carol1.id], replyId: own.id });
				const body = await listener.find(z.id);
				expect(JSON.stringify(body)).not.toContain(HIDDEN_TEXT);
				expect(body.reply?.id).toBe(own.id);
				const hidden = findNote(body, root.id);
				expect(hidden).not.toBeNull();
				expect(hidden.isHidden).toBe(true);
				expect(hidden.text ?? null).toBeNull();
				expect(hidden.visibleUserIds).toBeUndefined();
			} finally {
				listener.close();
			}
		});

		test('a recipient of the thread still receives it', async () => {
			const listener = await listen(author, 'reply');
			try {
				const z = await post(carol1, { text: 'direct reply to author', visibility: 'specified', visibleUserIds: [author.id], replyId: x.id });
				const body = await listener.find(z.id);
				expect(body.reply?.id).toBe(x.id);
				expect(body.reply?.reply?.id).toBe(w.id);
				expect(body.reply?.reply?.text).toBe(W_TEXT);
			} finally {
				listener.close();
			}
		});
	});

	describe('quote of a reply to a note hidden by its author', () => {
		const W_TEXT = 'note hidden by time';
		const T_TEXT = 'public reply to the hidden note';
		let t: Misskey.entities.Note;

		beforeAll(async () => {
			const w = await post(hiddenOwner, { text: W_TEXT });
			t = await post(quoted, { text: T_TEXT, replyId: w.id });
			const res = await api('i/update', { makeNotesHiddenBefore: Math.floor(Date.now() / 1000) + 3600 }, hiddenOwner);
			expect(res.status).toBe(200);
		});

		test('the renote event of the quoted user does not carry the hidden note', async () => {
			const listener = await listen(quoted, 'renote');
			try {
				const quote = await post(carol1, { text: 'quote by carol1', renoteId: t.id });
				const body = await listener.find(quote.id);
				expect(JSON.stringify(body)).not.toContain(W_TEXT);
				expect(body.renote?.text).toBe(T_TEXT);
			} finally {
				listener.close();
			}
		});

		test('the renote webhook of the quoted user does not carry the hidden note', async () => {
			const quote = await post(carol1, { text: 'webhook quote by carol1', renoteId: t.id });
			const note = await webhook(quoted.id, 'renote', quote.id);
			expect(JSON.stringify(note)).not.toContain(W_TEXT);
			expect(note.renote?.text).toBe(T_TEXT);
		});
	});
});
