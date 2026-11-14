/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import * as Misskey from 'cherrypick-js';
import { createAccount, createRole, fetchAdmin, resolveRemoteUser, waitForFollowRelation, WAIT_FOR_FEDERATION, type LoginUser } from './utils.js';

/**
 * 받는 서버는 소유 서버가 보관한 과거 기록을 그대로 믿고 전부 사본으로 저장한다.
 * 실제 HTTPS 요청으로 일반 노트 삭제 무간섭, 제3 서버 글의 사본 저장과 수정 건너뜀·작성자 삭제,
 * 바뀐 본문 수용, 보관 사본의 삭제, 삭제된 글의 사본 저장, 재수신 시 사본 유지를 확인한다.
 */
const FAKE = 'https://fake.test';
const AS = 'https://www.w3.org/ns/activitystreams';
const WAIT_FOR_HISTORY = { timeout: 120000, interval: 1000 };

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
// 보관 사본에 닿으면 안 되는 무관한 제3자. 소유자와 다른 키로 서명한다
const { privateKey: malloryPrivateKey, publicKey: malloryPublicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ownerName = `owner${crypto.randomUUID().replaceAll('-', '')}`;
const owner = `${FAKE}/users/${ownerName}`;
const malloryName = `mallory${crypto.randomUUID().replaceAll('-', '')}`;
const mallory = `${FAKE}/users/${malloryName}`;
const attackRoom = `r${Date.now()}`;
const legitRoom = `r${Date.now() + 1}`;
const archivedRoom = `r${Date.now() + 2}`;
const tombstoneRoom = `r${Date.now() + 3}`;
const forgedRoom = `r${Date.now() + 4}`;
const upgradeRoom = `r${Date.now() + 6}`;
const noteCopyRoom = `r${Date.now() + 7}`;

function person(username: string, publicKeyPem: string) {
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
		publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem },
	};
}

/** 과거 기록 한 항목. id는 작성자 서버의 실제 메시지 주소여야 한다 */
function message(roomUri: string, messageId: string, authorUri: string, text: string, overrides: Record<string, unknown> = {}) {
	return {
		id: messageId,
		type: 'Note',
		attributedTo: authorUri,
		content: text,
		_misskey_content: text,
		_misskey_talk: true,
		published: '2026-01-01T00:00:00.000Z',
		context: roomUri,
		_misskey_chatRoom: roomUri,
		_misskey_chatReactions: [],
		...overrides,
	};
}

function page(roomUri: string, items: unknown[]) {
	return { '@context': AS, id: `${roomUri}/history`, type: 'OrderedCollectionPage', partOf: `${roomUri}/history`, orderedItems: items };
}

/** 받는 서버의 받은편지함은 서명을 확인하므로 지정한 가짜 계정의 키로 서명해 보낸다 */
async function deliver(inbox: string, activity: object, signer: { uri: string; privateKey: string } = { uri: owner, privateKey }): Promise<void> {
	const body = JSON.stringify(activity);
	const url = new URL(inbox);
	const date = new Date().toUTCString();
	const digest = `SHA-256=${createHash('sha256').update(body).digest('base64')}`;
	const signed = `(request-target): post ${url.pathname}\nhost: ${url.host}\ndate: ${date}\ndigest: ${digest}`;
	const signature = createSign('sha256').update(signed).sign(signer.privateKey, 'base64');
	const res = await fetch(inbox, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/activity+json',
			Date: date,
			Digest: digest,
			Signature: `keyId="${signer.uri}#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`,
		},
		body,
	});
	strictEqual(res.status < 300, true, `inbox answered ${res.status}`);
}

describe('Chat room history and third-party message URIs', () => {
	let server: Server;
	let alice: LoginUser, bob: LoginUser;
	let aliceUri: string, bobUri: string;
	let aliceOnB: { id: string }, bobOnA: { id: string };
	const pages = new Map<string, object>();
	const rosters = new Map<string, string[]>();

	function json(res: ServerResponse, status: number, body?: object) {
		res.writeHead(status, { 'Content-Type': 'application/activity+json; charset=utf-8' });
		res.end(body != null ? JSON.stringify(body) : undefined);
	}

	function handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? '/', FAKE);
		if (req.method === 'POST') {
			// 수락과 그 밖의 활동은 받기만 한다
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
		if (url.pathname === `/users/${ownerName}`) return json(res, 200, person(ownerName, publicKey));
		if (url.pathname === `/users/${malloryName}`) return json(res, 200, person(malloryName, malloryPublicKey));
		const pageBody = pages.get(`${FAKE}${url.pathname}${url.search}`);
		if (pageBody != null) return json(res, 200, pageBody);
		const room = url.pathname.match(/^\/chat\/rooms\/(r\d+)$/)?.[1];
		if (room != null) {
			const roomUri = `${FAKE}/chat/rooms/${room}`;
			return json(res, 200, {
				'@context': AS,
				id: roomUri,
				type: 'Group',
				name: room,
				attributedTo: owner,
				summary: '',
				_misskey_chatRoomMembers: rosters.get(roomUri) ?? [],
				_misskey_chatRoomRosterAt: new Date().toISOString(),
			});
		}
		json(res, 404);
	}

	/** 소유 서버의 초대를 받아 사용자가 그룹에 참여하면 미러 그룹 ID를 돌려준다 */
	async function invite(host: 'a.test' | 'b.test', user: LoginUser, roomUri: string, name: string): Promise<string> {
		await deliver(`https://${host}/inbox`, {
			'@context': AS,
			id: `${FAKE}/invites/${crypto.randomUUID()}`,
			type: 'Invite',
			actor: owner,
			object: { id: roomUri, type: 'Group', name, summary: '', attributedTo: owner },
			target: `https://${host}/users/${user.id}`,
			published: new Date().toISOString(),
		});
		const mirrorId = await vi.waitFor(async () => {
			const invitations = await user.client.request('chat/rooms/invitations/inbox', {});
			const invitation = invitations.find(candidate => candidate.room.name === name);
			if (invitation == null) throw new Error('the invitation has not arrived yet');
			return invitation.roomId;
		}, WAIT_FOR_FEDERATION);
		await user.client.request('chat/rooms/join', { roomId: mirrorId });
		return mirrorId;
	}

	/** 소유 서버가 구성원의 서버에 Add를 보내 멤버를 알린다. 소유 서버의 시계가 조금 앞서 있을 수 있으므로 여유를 둔다 */
	async function addMember(roomUri: string, memberUri: string, inbox: string): Promise<void> {
		await deliver(inbox, {
			'@context': AS,
			id: `${FAKE}/adds/${crypto.randomUUID()}`,
			type: 'Add',
			actor: owner,
			object: memberUri,
			target: roomUri,
			published: new Date(Date.now() + 5000).toISOString(),
		});
	}

	async function waitCompleted(user: LoginUser, mirrorId: string): Promise<void> {
		await vi.waitFor(async () => {
			const room = await user.client.request('chat/rooms/show', { roomId: mirrorId });
			strictEqual(room.historyImportStatus, 'completed');
		}, WAIT_FOR_HISTORY);
	}

	async function timeline(user: LoginUser, mirrorId: string) {
		return await user.client.request('chat/messages/room-timeline', { roomId: mirrorId, limit: 100 });
	}

	beforeAll(async () => {
		[alice, bob] = await Promise.all([createAccount('a.test'), createAccount('b.test')]);
		aliceUri = `https://a.test/users/${alice.id}`;
		bobUri = `https://b.test/users/${bob.id}`;
		[aliceOnB, bobOnA] = await Promise.all([
			resolveRemoteUser('a.test', alice.id, bob),
			resolveRemoteUser('b.test', bob.id, alice),
		]);
		const admin = await fetchAdmin('b.test');
		await admin.client.request('admin/update-meta', { federation: 'all' });
		server = createServer({
			cert: readFileSync(new URL('../certificates/fake.test.crt', import.meta.url)),
			key: readFileSync(new URL('../certificates/fake.test.key', import.meta.url)),
		}, handle);
		await new Promise<void>(resolve => server.listen(443, process.env.CHERRYPICK_FED_FAKE_BIND ?? '0.0.0.0', resolve));
	});

	afterAll(async () => {
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	test('과거 기록이 일반 노트 URI를 선점해도 노트 삭제는 그대로 처리된다', async () => {
		const roomUri = `${FAKE}/chat/rooms/${attackRoom}`;
		rosters.set(roomUri, [bobUri]);

		// 노트의 Create와 Delete가 b.test로 배달되도록 팔로우 관계를 맺는다
		await bob.client.request('following/create', { userId: aliceOnB.id });
		await waitForFollowRelation(bob, alice, 1);
		const created = await alice.client.request('notes/create', { text: `public note ${crypto.randomUUID()}`, visibility: 'public' });
		const noteUri = `https://a.test/notes/${created.createdNote.id}`;
		const mirrored = await vi.waitFor(async () => {
			const shown = await bob.client.request('ap/show', { uri: noteUri });
			strictEqual(shown.type, 'Note');
			return shown.object;
		}, WAIT_FOR_FEDERATION);

		// 소유 서버의 과거 기록이 그 노트를 채팅 메시지라고 주장한다
		pages.set(`${roomUri}/history`, page(roomUri, [
			message(roomUri, noteUri, aliceUri, 'forged note claim'),
		]));
		const mirrorId = await invite('b.test', bob, roomUri, `attack ${crypto.randomUUID()}`);
		await waitCompleted(bob, mirrorId);

		// 작성자의 정상 Delete가 채팅 삭제에 가로채이지 않고 노트를 지운다
		await alice.client.request('notes/delete', { noteId: created.createdNote.id });
		await vi.waitFor(async () => await rejects(
			async () => await bob.client.request('notes/show', { noteId: mirrored.id }),
			(err: any) => {
				strictEqual(err.code, 'NO_SUCH_NOTE');
				return true;
			},
		), WAIT_FOR_FEDERATION);

		// 호스트 기록을 믿으므로 채팅 사본은 남는다. 사본은 노트 URI를 선점하지 않아 노트 삭제에는 간섭하지 않는다
		const messages = await timeline(bob, mirrorId);
		strictEqual(messages.length, 1);
		strictEqual(messages[0].text, 'forged note claim');
	});

	test('제3 서버의 채팅 메시지는 사본으로 저장되고 수정은 건너뛰며 작성자의 삭제만 닿는다', async () => {
		const roomUri = `${FAKE}/chat/rooms/${legitRoom}`;
		rosters.set(roomUri, [aliceUri, bobUri]);

		// alice가 먼저 참여해 글을 쓴다. 아직 bob이 모르므로 실시간 배달은 소유 서버뿐이다
		const aliceMirror = await invite('a.test', alice, roomUri, `legit ${crypto.randomUUID()}`);
		const sent = await alice.client.request('chat/messages/create-to-room', { toRoomId: aliceMirror, text: 'third-party chat' });
		const messageUri = `https://a.test/chat/messages/${sent.id}`;

		// bob의 검증을 위해 작성자 서버가 bob을 멤버로 알아야 한다
		await addMember(roomUri, bobUri, 'https://a.test/inbox');
		await vi.waitFor(async () => {
			const members = await alice.client.request('chat/rooms/members', { roomId: aliceMirror, limit: 100 });
			strictEqual(members.some(member => member.userId === bobOnA.id), true);
		}, WAIT_FOR_FEDERATION);

		pages.set(`${roomUri}/history`, page(roomUri, [
			message(roomUri, messageUri, aliceUri, 'third-party chat'),
		]));
		const mirrorId = await invite('b.test', bob, roomUri, `legit ${crypto.randomUUID()}`);
		// 실시간 수정·삭제가 작성자를 멤버로 확인하므로 소유 서버가 알린다
		await addMember(roomUri, aliceUri, 'https://b.test/inbox');
		await vi.waitFor(async () => {
			const members = await bob.client.request('chat/rooms/members', { roomId: mirrorId, limit: 100 });
			strictEqual(members.some(member => member.userId === aliceOnB.id), true);
		}, WAIT_FOR_FEDERATION);
		await waitCompleted(bob, mirrorId);

		const messages = await timeline(bob, mirrorId);
		strictEqual(messages.length, 1);
		strictEqual(messages[0].text, 'third-party chat');
		strictEqual(messages[0].fromUser?.id, aliceOnB.id);

		// 사본만 있는 글의 수정은 건너뛴다. 수정 시도가 배달되었음은 뒤따르는 새 글의 도착으로 확인한다
		await alice.client.request('chat/messages/update', { messageId: sent.id, text: 'edited third-party' });
		await alice.client.request('chat/messages/create-to-room', { toRoomId: aliceMirror, text: 'after the edit' });
		await vi.waitFor(async () => {
			const later = await timeline(bob, mirrorId);
			strictEqual(later.some(m => m.text === 'after the edit'), true);
		}, WAIT_FOR_FEDERATION);
		await new Promise(resolve => setTimeout(resolve, 2000));
		const kept = await timeline(bob, mirrorId);
		strictEqual(kept.some(m => m.text === 'third-party chat'), true);
		strictEqual(kept.some(m => m.text === 'edited third-party'), false);

		// 작성자의 Delete는 원래 URI로 오고, 사본은 sourceUri 연결로 지워진다
		await alice.client.request('chat/messages/delete', { messageId: sent.id });
		await vi.waitFor(async () => {
			const after = await timeline(bob, mirrorId);
			strictEqual(after.some(m => m.text === 'third-party chat'), false);
		}, WAIT_FOR_FEDERATION);
	});

	// 정지는 작성자 서버가 아는 모든 받은편지함으로 작성자 Delete를 보내므로, 정지되는 작성자는 이 시험에서만 쓰는 계정으로 둔다.
	test('보관 사본은 무관한 Delete에 지워지지 않고 작성자의 Delete에 지워진다', async () => {
		const roomUri = `${FAKE}/chat/rooms/${archivedRoom}`;
		const charlie = await createAccount('a.test');
		const charlieUri = `https://a.test/users/${charlie.id}`;
		rosters.set(roomUri, [charlieUri, aliceUri, bobUri]);

		const charlieMirror = await invite('a.test', charlie, roomUri, `archived ${crypto.randomUUID()}`);
		const sent = await charlie.client.request('chat/messages/create-to-room', { toRoomId: charlieMirror, text: 'archived original' });
		const messageUri = `https://a.test/chat/messages/${sent.id}`;

		// 삭제 처리가 지나갔음을 확인할 새 메시지는 정지되지 않는 alice가 보낸다
		const aliceMirror = await invite('a.test', alice, roomUri, `archived ${crypto.randomUUID()}`);

		await addMember(roomUri, bobUri, 'https://a.test/inbox');
		await vi.waitFor(async () => {
			const members = await charlie.client.request('chat/rooms/members', { roomId: charlieMirror, limit: 100 });
			strictEqual(members.some(member => member.userId === bobOnA.id), true);
		}, WAIT_FOR_FEDERATION);

		// 작성자가 정지되면 작성자 서버가 메시지를 내주지 않는다(404)
		const adminA = await fetchAdmin('a.test');
		await adminA.client.request('admin/suspend-user', { userId: charlie.id });
		let mirrorId: string;
		try {
			pages.set(`${roomUri}/history`, page(roomUri, [
				message(roomUri, messageUri, charlieUri, 'archived original', {
					_misskey_chatAuthorArchived: true,
					_misskey_chatAuthor: { name: 'Archived Charlie', username: charlie.username, host: 'a.test' },
				}),
			]));
			mirrorId = await invite('b.test', bob, roomUri, `archived ${crypto.randomUUID()}`);
			// 실시간 수신은 보낸이를 멤버로 확인하므로 소유 서버가 alice를 알린다
			await addMember(roomUri, aliceUri, 'https://b.test/inbox');
			await vi.waitFor(async () => {
				const members = await bob.client.request('chat/rooms/members', { roomId: mirrorId, limit: 100 });
				strictEqual(members.some(member => member.userId === aliceOnB.id), true);
			}, WAIT_FOR_FEDERATION);
			await waitCompleted(bob, mirrorId);

			const messages = await timeline(bob, mirrorId);
			strictEqual(messages.length, 1);
			strictEqual(messages[0].text, 'archived original');
			strictEqual(messages[0].fromUser, null);
			deepStrictEqual(messages[0].archivedAuthor, { name: 'Archived Charlie', username: charlie.username, host: 'a.test' });

			// 무관한 제3자가 원래 URI로 보내는 Delete는 사본을 지우지 못한다
			await deliver('https://b.test/inbox', {
				'@context': AS,
				id: `${FAKE}/deletes/${crypto.randomUUID()}`,
				type: 'Delete',
				actor: mallory,
				object: messageUri,
				published: new Date().toISOString(),
			}, { uri: mallory, privateKey: malloryPrivateKey });
			// 삭제 처리가 지나갔음을 새 메시지의 도착으로 확인한다
			await alice.client.request('chat/messages/create-to-room', { toRoomId: aliceMirror, text: 'after the unrelated delete' });
			await vi.waitFor(async () => {
				const later = await timeline(bob, mirrorId);
				strictEqual(later.some(m => m.text === 'after the unrelated delete'), true);
			}, WAIT_FOR_FEDERATION);
			await new Promise(resolve => setTimeout(resolve, 2000));

			const kept = await timeline(bob, mirrorId);
			const archived = kept.find(m => m.text === 'archived original');
			strictEqual(archived != null, true, 'the archived copy was deleted by an unrelated Delete');
			strictEqual(archived!.fromUser, null);
		} finally {
			await adminA.client.request('admin/unsuspend-user', { userId: charlie.id }).catch(() => {});
		}

		// 정지 해제는 인증 캐시 갱신까지 비동기로 이어지므로, 해제된 계정의 요청이 통과할 때까지 기다린다
		await vi.waitFor(async () => {
			await charlie.client.request('i', {});
		}, WAIT_FOR_FEDERATION);

		// 정지가 풀린 작성자가 원래 URI로 지우면 보관 사본도 지워진다
		await charlie.client.request('chat/messages/delete', { messageId: sent.id });
		await vi.waitFor(async () => {
			const after = await timeline(bob, mirrorId);
			strictEqual(after.some(m => m.text === 'archived original'), false);
		}, WAIT_FOR_FEDERATION);
	});

	test('소유 서버가 바꾼 본문도 호스트 기록 그대로 받는다', async () => {
		const roomUri = `${FAKE}/chat/rooms/${forgedRoom}`;
		rosters.set(roomUri, [aliceUri, bobUri]);

		const aliceMirror = await invite('a.test', alice, roomUri, `forged ${crypto.randomUUID()}`);
		const sent = await alice.client.request('chat/messages/create-to-room', { toRoomId: aliceMirror, text: 'the real text' });
		const messageUri = `https://a.test/chat/messages/${sent.id}`;

		await addMember(roomUri, bobUri, 'https://a.test/inbox');
		await vi.waitFor(async () => {
			const members = await alice.client.request('chat/rooms/members', { roomId: aliceMirror, limit: 100 });
			strictEqual(members.some(member => member.userId === bobOnA.id), true);
		}, WAIT_FOR_FEDERATION);

		// 소유 서버의 기록은 본문을 바꿔 싣는다
		pages.set(`${roomUri}/history`, page(roomUri, [
			message(roomUri, messageUri, aliceUri, 'forged by the owner'),
		]));
		const mirrorId = await invite('b.test', bob, roomUri, `forged ${crypto.randomUUID()}`);
		await waitCompleted(bob, mirrorId);

		const messages = await timeline(bob, mirrorId);
		strictEqual(messages.length, 1);
		strictEqual(messages[0].text, 'forged by the owner');
		strictEqual(messages[0].fromUser?.id, aliceOnB.id);
	});

	test('사본으로 남은 글은 작성자가 회복되어 다시 받아도 사본으로 남는다', async () => {
		const roomUri = `${FAKE}/chat/rooms/${upgradeRoom}`;
		const charlie = await createAccount('a.test');
		const charlieUri = `https://a.test/users/${charlie.id}`;
		const bob2 = await createAccount('b.test');
		const bob2Uri = `https://b.test/users/${bob2.id}`;
		rosters.set(roomUri, [charlieUri, bobUri, bob2Uri]);

		const charlieMirror = await invite('a.test', charlie, roomUri, `upgrade ${crypto.randomUUID()}`);
		const sent = await charlie.client.request('chat/messages/create-to-room', { toRoomId: charlieMirror, text: 'upgrade me' });
		const messageUri = `https://a.test/chat/messages/${sent.id}`;

		await addMember(roomUri, bobUri, 'https://a.test/inbox');
		await addMember(roomUri, bob2Uri, 'https://a.test/inbox');
		const bob2OnA = await resolveRemoteUser('b.test', bob2.id, charlie);
		await vi.waitFor(async () => {
			const members = await charlie.client.request('chat/rooms/members', { roomId: charlieMirror, limit: 100 });
			strictEqual(members.some(member => member.userId === bobOnA.id), true);
			strictEqual(members.some(member => member.userId === bob2OnA.id), true);
		}, WAIT_FOR_FEDERATION);

		const adminA = await fetchAdmin('a.test');
		await adminA.client.request('admin/suspend-user', { userId: charlie.id });
		let mirrorId: string;
		let copyId: string;
		try {
			pages.set(`${roomUri}/history`, page(roomUri, [
				message(roomUri, messageUri, charlieUri, 'upgrade me', {
					_misskey_chatAuthorArchived: true,
					_misskey_chatAuthor: { name: 'Archived Charlie', username: charlie.username, host: 'a.test' },
				}),
			]));
			mirrorId = await invite('b.test', bob, roomUri, `upgrade ${crypto.randomUUID()}`);
			await waitCompleted(bob, mirrorId);

			const copies = await timeline(bob, mirrorId);
			strictEqual(copies.length, 1);
			strictEqual(copies[0].fromUser, null);
			strictEqual(copies[0].text, 'upgrade me');
			copyId = copies[0].id;
		} finally {
			await adminA.client.request('admin/unsuspend-user', { userId: charlie.id }).catch(() => {});
		}

		// 작성자가 회복된 뒤 다른 로컬 사용자가 참여하면 처음부터 다시 받는다
		await invite('b.test', bob2, roomUri, `upgrade ${crypto.randomUUID()}`);
		await waitCompleted(bob, mirrorId);

		const messages = await timeline(bob, mirrorId);
		// 다시 받아도 같은 사본 행이 그대로다. 원래 URI로 승격하지 않는다
		strictEqual(messages.length, 1);
		strictEqual(messages[0].id, copyId);
		strictEqual(messages[0].text, 'upgrade me');
		strictEqual(messages[0].fromUser, null);
		deepStrictEqual(messages[0].archivedAuthor, { name: 'Archived Charlie', username: charlie.username, host: 'a.test' });
	});

	test('참여 전에 삭제된 메시지도 소유 서버가 싣고 있으면 사본으로 받는다', async () => {
		const roomUri = `${FAKE}/chat/rooms/${tombstoneRoom}`;
		rosters.set(roomUri, [aliceUri, bobUri]);

		const aliceMirror = await invite('a.test', alice, roomUri, `tombstone ${crypto.randomUUID()}`);
		const sent = await alice.client.request('chat/messages/create-to-room', { toRoomId: aliceMirror, text: 'deleted before join' });
		const messageUri = `https://a.test/chat/messages/${sent.id}`;
		await alice.client.request('chat/messages/delete', { messageId: sent.id });

		await addMember(roomUri, bobUri, 'https://a.test/inbox');
		await vi.waitFor(async () => {
			const members = await alice.client.request('chat/rooms/members', { roomId: aliceMirror, limit: 100 });
			strictEqual(members.some(member => member.userId === bobOnA.id), true);
		}, WAIT_FOR_FEDERATION);

		// 소유 서버의 기록은 아직 그 글을 싣고 있다
		pages.set(`${roomUri}/history`, page(roomUri, [
			message(roomUri, messageUri, aliceUri, 'deleted before join'),
		]));
		const mirrorId = await invite('b.test', bob, roomUri, `tombstone ${crypto.randomUUID()}`);
		await waitCompleted(bob, mirrorId);

		// 삭제가 이 서버에 도착한 적이 없으므로 호스트가 싣고 있는 기록을 그대로 받는다
		const messages = await timeline(bob, mirrorId);
		strictEqual(messages.length, 1);
		strictEqual(messages[0].text, 'deleted before join');
	});

	test('작성자의 Delete는 보관 사본과 같은 주소의 개인 노트를 함께 지운다', async () => {
		const roomUri = `${FAKE}/chat/rooms/${noteCopyRoom}`;
		const dmRecipient = await createAccount('b.test');
		// 기본 chatScope(mutual)이면 보내는 서버에서 먼저 거절하므로 누구나 받을 수 있게 연다
		await dmRecipient.client.request('i/update', { chatScope: 'everyone' });
		const adminB = await fetchAdmin('b.test');
		// policies の型は自動生成で never になるので、実際の形に合わせてキャストする
		const role = await createRole('b.test', { name: 'Chat disabled', target: 'manual', policies: { chatAvailability: 'unavailable' } as unknown as Misskey.entities.AdminRolesCreateRequest['policies'] });
		await adminB.client.request('admin/roles/assign', { roleId: role.id, userId: dmRecipient.id });

		// 채팅을 쓸 수 없는 수신자에게 온 DM은 원래 주소의 개인 노트로 저장된다
		const recipientOnA = await resolveRemoteUser('b.test', dmRecipient.id, alice);
		const sent = await alice.client.request('chat/messages/create-to-user', { toUserId: recipientOnA.id, text: 'converted dm' });
		const dmUri = `https://a.test/chat/messages/${sent.id}`;
		const mirrored = await vi.waitFor(async () => {
			const shown = await dmRecipient.client.request('ap/show', { uri: dmUri });
			strictEqual(shown.type, 'Note');
			return shown.object;
		}, WAIT_FOR_FEDERATION);

		// 같은 주소를 출처로 하는 보관 사본도 이 서버에 있는 상태
		rosters.set(roomUri, [aliceUri, bobUri]);
		pages.set(`${roomUri}/history`, page(roomUri, [
			message(roomUri, dmUri, aliceUri, 'converted dm'),
		]));
		const mirrorId = await invite('b.test', bob, roomUri, `note-copy ${crypto.randomUUID()}`);
		await waitCompleted(bob, mirrorId);
		const copies = await timeline(bob, mirrorId);
		strictEqual(copies.length, 1);
		strictEqual(copies[0].text, 'converted dm');

		// 작성자의 Delete는 사본 삭제에서 끝나지 않고 개인 노트의 삭제와 작성자 검사까지 이어져야 한다
		await alice.client.request('chat/messages/delete', { messageId: sent.id });
		await vi.waitFor(async () => {
			const after = await timeline(bob, mirrorId);
			strictEqual(after.some(m => m.text === 'converted dm'), false);
		}, WAIT_FOR_FEDERATION);
		await new Promise(resolve => setTimeout(resolve, 1000));
		await rejects(
			async () => await dmRecipient.client.request('notes/show', { noteId: mirrored.id }),
			(err: any) => {
				strictEqual(err.code, 'NO_SUCH_NOTE');
				return true;
			},
		);
	});
});
