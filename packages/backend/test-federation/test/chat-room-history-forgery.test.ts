/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import { createAccount, fetchAdmin, type LoginUser, WAIT_FOR_FEDERATION } from './utils.js';

/**
 * tester가 fake.test라는 그룹 소유 서버가 되어 b.test의 사용자를 초대하고, 위조한 과거 기록을 내준다.
 * b.test가 의도한 검사로 위조 항목을 버리는지 실제 HTTPS 요청으로 확인한다.
 */
const FAKE = 'https://fake.test';
const AS = 'https://www.w3.org/ns/activitystreams';
const WAIT_FOR_HISTORY = { timeout: 120000, interval: 1000 };

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const owner = `${FAKE}/users/owner`;
const member = `${FAKE}/users/m1`;

function person(username: string) {
	const id = `${FAKE}/users/${username}`;
	return {
		'@context': [AS, 'https://w3id.org/security/v1'],
		id,
		type: 'Person',
		preferredUsername: username,
		name: username,
		inbox: `${id}/inbox`,
		outbox: `${id}/outbox`,
		endpoints: { sharedInbox: `${FAKE}/inbox` },
		publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: publicKey },
	};
}

function note(roomUri: string, id: string, overrides: Record<string, unknown> = {}) {
	return {
		id: `${FAKE}/chat/messages/${id}`,
		type: 'Note',
		attributedTo: member,
		content: id,
		_misskey_content: id,
		_misskey_talk: true,
		published: '2026-01-01T00:00:00.000Z',
		context: roomUri,
		_misskey_chatRoom: roomUri,
		_misskey_chatReactions: [],
		...overrides,
	};
}

function page(roomUri: string, items: unknown[], next?: string) {
	return { '@context': AS, id: `${roomUri}/history`, type: 'OrderedCollectionPage', partOf: `${roomUri}/history`, orderedItems: items, ...(next != null ? { next } : {}) };
}

/** b.test의 받은편지함은 서명을 확인하므로 가짜 소유자의 키로 서명해 보낸다 */
async function deliver(inbox: string, activity: object): Promise<void> {
	const body = JSON.stringify(activity);
	const url = new URL(inbox);
	const date = new Date().toUTCString();
	const digest = `SHA-256=${createHash('sha256').update(body).digest('base64')}`;
	const signed = `(request-target): post ${url.pathname}\nhost: ${url.host}\ndate: ${date}\ndigest: ${digest}`;
	const signature = createSign('sha256').update(signed).sign(privateKey, 'base64');
	const res = await fetch(inbox, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/activity+json',
			Date: date,
			Digest: digest,
			Signature: `keyId="${owner}#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`,
		},
		body,
	});
	strictEqual(res.status < 300, true, `inbox answered ${res.status}`);
}

describe('Chat room history from a forging owner', () => {
	let server: Server;
	let alice: LoginUser, bob: LoginUser;
	const pages = new Map<string, object>();

	function json(res: ServerResponse, status: number, body?: object) {
		res.writeHead(status, { 'Content-Type': 'application/activity+json; charset=utf-8' });
		res.end(body != null ? JSON.stringify(body) : undefined);
	}

	function handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? '/', FAKE);
		if (req.method === 'POST') {
			// b.test의 수락과 그 밖의 활동은 받기만 한다
			req.resume();
			res.writeHead(202).end();
			return;
		}
		if (url.pathname === '/.well-known/webfinger') {
			const name = url.searchParams.get('resource')?.match(/^acct:([^@]+)@fake\.test$/)?.[1];
			if (name == null) return json(res, 404);
			res.writeHead(200, { 'Content-Type': 'application/jrd+json' });
			res.end(JSON.stringify({ subject: `acct:${name}@fake.test`, links: [{ rel: 'self', type: 'application/activity+json', href: `${FAKE}/users/${name}` }] }));
			return;
		}
		const user = url.pathname.match(/^\/users\/(owner|m1)$/)?.[1];
		if (user != null) return json(res, 200, person(user));
		const pageBody = pages.get(`${FAKE}${url.pathname}${url.search}`);
		if (pageBody != null) return json(res, 200, pageBody);
		const room = url.pathname.match(/^\/chat\/rooms\/(r\d)$/)?.[1];
		if (room != null) return json(res, 200, { '@context': AS, id: `${FAKE}/chat/rooms/${room}`, type: 'Group', name: room, attributedTo: owner, summary: '' });
		// 지워진 계정처럼 답한다
		if (url.pathname === '/users/gone') return json(res, 410);
		json(res, 404);
	}

	async function inviteBob(roomUri: string, name: string): Promise<string> {
		await deliver('https://b.test/inbox', {
			'@context': AS,
			id: `${FAKE}/invites/${crypto.randomUUID()}`,
			type: 'Invite',
			actor: owner,
			object: { id: roomUri, type: 'Group', name, summary: '', attributedTo: owner },
			target: `https://b.test/users/${bob.id}`,
			published: new Date().toISOString(),
		});
		const mirrorId = await vi.waitFor(async () => {
			const invitations = await bob.client.request('chat/rooms/invitations/inbox', {});
			const invitation = invitations.find(candidate => candidate.room.name === name);
			if (invitation == null) throw new Error('the invitation has not arrived yet');
			return invitation.roomId;
		}, WAIT_FOR_FEDERATION);
		await bob.client.request('chat/rooms/join', { roomId: mirrorId });
		return mirrorId;
	}

	beforeAll(async () => {
		[alice, bob] = await Promise.all([createAccount('a.test'), createAccount('b.test')]);
		const admin = await fetchAdmin('b.test');
		await admin.client.request('admin/update-meta', { federation: 'all' });
		server = createServer({
			cert: readFileSync(new URL('../certificates/fake.test.crt', import.meta.url)),
			key: readFileSync(new URL('../certificates/fake.test.key', import.meta.url)),
		}, handle);
		await new Promise<void>(resolve => server.listen(443, resolve));
	});

	afterAll(async () => {
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	test('only what passes the checks is kept, and nothing is told about the rest', async () => {
		const roomUri = `${FAKE}/chat/rooms/r1`;
		const bobUri = `https://b.test/users/${bob.id}`;
		const aliceUri = `https://a.test/users/${alice.id}`;
		pages.set(`${roomUri}/history`, page(roomUri, [
			note(roomUri, 'valid', {
				_misskey_chatReactions: [
					{ actor: bobUri, reaction: '👍' },
					{ actor: aliceUri, reaction: ':evil:', tag: { id: `${FAKE}/emojis/evil`, type: 'Emoji', name: ':evil:', updated: '2026-01-01T00:00:00.000Z', icon: { type: 'Image', url: `${FAKE}/evil.png` } } },
				],
			}),
			note(roomUri, 'orphan', { attributedTo: `${FAKE}/users/gone`, _misskey_chatAuthor: { name: 'Gone', username: 'gone', host: 'fake.test' } }),
			note(roomUri, 'other-room', { context: `${FAKE}/chat/rooms/r9`, _misskey_chatRoom: `${FAKE}/chat/rooms/r9` }),
			note(roomUri, 'self', { id: `https://b.test/chat/messages/${crypto.randomUUID().replaceAll('-', '')}`, attributedTo: bobUri }),
			note(roomUri, 'author-elsewhere', { attributedTo: aliceUri }),
			note(roomUri, 'future', { published: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }),
		]));

		const mirrorId = await inviteBob(roomUri, `forged ${crypto.randomUUID()}`);
		await vi.waitFor(async () => {
			const room = await bob.client.request('chat/rooms/show', { roomId: mirrorId });
			strictEqual(room.historyImportStatus, 'completed');
		}, WAIT_FOR_HISTORY);

		const messages = await bob.client.request('chat/messages/room-timeline', { roomId: mirrorId, limit: 100 });
		deepStrictEqual(messages.map(message => message.text).sort(), ['orphan', 'valid']);
		const valid = messages.find(message => message.text === 'valid')!;
		deepStrictEqual(valid.reactions.map(reaction => [reaction.reaction, reaction.user.username]), [[':evil@a.test:', alice.username]]);
		const orphan = messages.find(message => message.text === 'orphan')!;
		strictEqual(orphan.fromUser, null);
		deepStrictEqual(orphan.archivedAuthor, { name: 'Gone', username: 'gone', host: 'fake.test' });

		// 리액션의 그림은 누른 계정의 서버에서만 확인하므로 가짜 소유자가 내준 그림은 등록되지 않는다
		const admin = await fetchAdmin('b.test');
		const emojis = await admin.client.request('admin/emoji/list-remote', { host: 'a.test', query: 'evil' });
		strictEqual(emojis.length, 0);
	});

	test('a page that points elsewhere for the rest is not used at all', async () => {
		const roomUri = `${FAKE}/chat/rooms/r2`;
		pages.set(`${roomUri}/history`, page(roomUri, [note(roomUri, 'misdirected')], 'https://a.test/chat/rooms/r2/history?until=abc'));

		const mirrorId = await inviteBob(roomUri, `forged ${crypto.randomUUID()}`);
		await vi.waitFor(async () => {
			const room = await bob.client.request('chat/rooms/show', { roomId: mirrorId });
			strictEqual(room.historyImportStatus, 'unavailable');
		}, WAIT_FOR_HISTORY);

		const messages = await bob.client.request('chat/messages/room-timeline', { roomId: mirrorId, limit: 100 });
		deepStrictEqual(messages, []);
	});
});
