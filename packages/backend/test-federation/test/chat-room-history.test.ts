/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import { beforeAll, describe, test, vi } from 'vitest';
import * as Misskey from 'cherrypick-js';
import { createAccount, fetchAdmin, type LoginUser, resolveRemoteUser, WAIT_FOR_FEDERATION } from './utils.js';

// 큰 기록은 한 번에 받는 25페이지(500글)를 넘겨 이어 받기까지 확인한다
const WAIT_FOR_HISTORY = { timeout: 180000, interval: 1000 };

type Host = 'a.test' | 'b.test';

async function invite(owner: LoginUser, room: Misskey.entities.ChatRoom, invitee: LoginUser, inviteeHost: Host): Promise<string> {
	const remote = await resolveRemoteUser(inviteeHost, invitee.id, owner);
	await owner.client.request('chat/rooms/invitations/create', { roomId: room.id, userId: remote.id });
	return await vi.waitFor(async () => {
		const invitations = await invitee.client.request('chat/rooms/invitations/inbox', {});
		const invitation = invitations.find(candidate => candidate.room.name === room.name);
		if (invitation == null) throw new Error('the invitation has not arrived yet');
		return invitation.roomId;
	}, WAIT_FOR_FEDERATION);
}

async function join(owner: LoginUser, ownerRoom: Misskey.entities.ChatRoom, invitee: LoginUser, inviteeHost: Host): Promise<string> {
	const mirrorId = await invite(owner, ownerRoom, invitee, inviteeHost);
	await invitee.client.request('chat/rooms/join', { roomId: mirrorId });
	const remote = await resolveRemoteUser(inviteeHost, invitee.id, owner);
	await vi.waitFor(async () => {
		const members = await owner.client.request('chat/rooms/members', { roomId: ownerRoom.id });
		strictEqual(members.some(member => member.userId === remote.id), true);
	}, WAIT_FOR_FEDERATION);
	return mirrorId;
}

async function post(user: LoginUser, roomId: string, count: number, prefix: string): Promise<Misskey.entities.ChatMessageLiteForRoom[]> {
	const sent: Misskey.entities.ChatMessageLiteForRoom[] = [];
	for (let i = 0; i < count; i++) {
		sent.push(await user.client.request('chat/messages/create-to-room', { toRoomId: roomId, text: `${prefix} ${i}` }));
	}
	return sent;
}

/** 사본의 전체 타임라인을 옛 글 쪽으로 끝까지 읽는다 */
async function readAll(user: LoginUser, roomId: string): Promise<Misskey.entities.ChatMessageLiteForRoom[]> {
	const all: Misskey.entities.ChatMessageLiteForRoom[] = [];
	let untilId: string | undefined;
	for (;;) {
		const page = await user.client.request('chat/messages/room-timeline', { roomId, limit: 100, untilId });
		all.push(...page);
		if (page.length < 100) return all;
		untilId = page.at(-1)!.id;
	}
}

async function waitForCompleted(user: LoginUser, roomId: string): Promise<void> {
	await vi.waitFor(async () => {
		const room = await user.client.request('chat/rooms/show', { roomId });
		strictEqual(room.historyImportStatus, 'completed');
	}, WAIT_FOR_HISTORY);
}

describe('Chat room history', () => {
	describe.each<[Host, Host]>([['a.test', 'b.test'], ['b.test', 'a.test']])('a room hosted on %s, joined from %s', (hostOf, memberHost) => {
		let alice: LoginUser, carol: LoginUser, eve: LoginUser, bob: LoginUser;

		beforeAll(async () => {
			[alice, carol, eve, bob] = await Promise.all([createAccount(hostOf), createAccount(hostOf), createAccount(hostOf), createAccount(memberHost)]);
		});

		async function joinLocally(room: Misskey.entities.ChatRoom, user: LoginUser): Promise<void> {
			await alice.client.request('chat/rooms/invitations/create', { roomId: room.id, userId: user.id });
			await user.client.request('chat/rooms/join', { roomId: room.id });
		}

		test('a new member sees the whole history the host kept, in the order it was written, without unread marks', async () => {
			const room = await alice.client.request('chat/rooms/create', { name: `history ${crypto.randomUUID()}` });
			const sent = await post(alice, room.id, 45, 'before');

			const mirrorId = await join(alice, room, bob, memberHost);
			await waitForCompleted(bob, mirrorId);

			const copied = await readAll(bob, mirrorId);
			deepStrictEqual(copied.map(message => message.text).reverse(), sent.map(message => message.text));
			const me = await bob.client.request('i', {});
			strictEqual(me.hasUnreadChatMessages, false);
			const found = await bob.client.request('chat/messages/search', { query: 'before 0', roomId: mirrorId });
			strictEqual(found.some(message => message.text === 'before 0'), true);
		});

		test('reactions come with the history, and a deleted author is shown from what the host kept', async () => {
			const room = await alice.client.request('chat/rooms/create', { name: `history ${crypto.randomUUID()}` });
			await joinLocally(room, carol);
			await joinLocally(room, eve);
			const [byAlice] = await post(alice, room.id, 1, 'reacted');
			await post(carol, room.id, 1, 'by carol');
			await eve.client.request('chat/messages/react', { messageId: byAlice.id, reaction: '👍' });
			await carol.client.request('chat/messages/react', { messageId: byAlice.id, reaction: '🎉' });
			await alice.client.request('i/update', { chatScope: 'everyone' });
			const direct = await carol.client.request('chat/messages/create-to-user', { toUserId: alice.id, text: 'direct from carol' });
			// 참여할 서버가 삭제 전에 작성자의 프로필을 이미 알고 있는 경우도 확인한다.
			await resolveRemoteUser(hostOf, carol.id, bob);
			const admin = await fetchAdmin(hostOf);
			await admin.client.request('admin/delete-account', { userId: carol.id });
			await vi.waitFor(async () => {
				const users = await admin.client.request('admin/show-users', { username: carol.username, origin: 'local' });
				strictEqual(users.length, 0);
			}, { timeout: 60000, interval: 1000 });

			// 실제 계정 삭제 뒤 소유 서버에는 그룹 메시지만 남고 일대일 메시지는 기존대로 지워진다
			const kept = await readAll(alice, room.id);
			strictEqual(kept.find(message => message.text === 'by carol 0')?.fromUser, null);
			await rejects(alice.client.request('chat/messages/show', { messageId: direct.id }));

			const mirrorId = await join(alice, room, bob, memberHost);
			await waitForCompleted(bob, mirrorId);

			const copied = await readAll(bob, mirrorId);
			const reacted = copied.find(message => message.text === 'reacted 0')!;
			const byCarol = copied.find(message => message.text === 'by carol 0')!;
			// 지워진 계정의 리액션은 소유 서버가 내주지 않는다
			deepStrictEqual(reacted.reactions.map(reaction => [reaction.reaction, reaction.user.username]), [['👍', eve.username]]);
			strictEqual(byCarol.fromUser, null);
			deepStrictEqual(byCarol.archivedAuthor, { name: null, username: carol.username, host: hostOf });
		});

		test('a member of the other server who was deleted stays in the host record under the original address', async () => {
			const room = await alice.client.request('chat/rooms/create', { name: `history ${crypto.randomUUID()}` });
			const author = await createAccount(memberHost);
			const newcomer = await createAccount(memberHost);
			const authorMirrorId = await join(alice, room, author, memberHost);
			await author.client.request('chat/messages/create-to-room', { toRoomId: authorMirrorId, text: 'by remote member' });
			await vi.waitFor(async () => {
				const messages = await readAll(alice, room.id);
				strictEqual(messages.some(message => message.text === 'by remote member'), true);
			}, WAIT_FOR_FEDERATION);

			const memberAdmin = await fetchAdmin(memberHost);
			await memberAdmin.client.request('admin/delete-account', { userId: author.id });
			const hostAdmin = await fetchAdmin(hostOf);
			await vi.waitFor(async () => {
				const users = await hostAdmin.client.request('admin/show-users', { username: author.username, origin: 'remote', hostname: memberHost });
				strictEqual(users.length, 0);
			}, { timeout: 60000, interval: 1000 });

			const kept = (await readAll(alice, room.id)).find(message => message.text === 'by remote member')!;
			strictEqual(kept.fromUser, null);
			deepStrictEqual(kept.archivedAuthor, { name: null, username: author.username, host: memberHost });
			const mirrorId = await join(alice, room, newcomer, memberHost);
			await waitForCompleted(newcomer, mirrorId);
			const copied = (await readAll(newcomer, mirrorId)).find(message => message.text === 'by remote member')!;
			strictEqual(copied.fromUser, null);
			// 작성자의 원래 주소가 받는 서버 자신의 주소이므로 그 서버에서는 로컬 작성자로 보인다
			deepStrictEqual(copied.archivedAuthor, { name: null, username: author.username, host: null });
		});

		test('a server that already has part of the history fills in what it missed', async () => {
			const room = await alice.client.request('chat/rooms/create', { name: `history ${crypto.randomUUID()}` });
			const mirrorId = await join(alice, room, bob, memberHost);
			const bobOnHost = await resolveRemoteUser(memberHost, bob.id, alice);
			await waitForCompleted(bob, mirrorId);
			await bob.client.request('chat/rooms/leave', { roomId: mirrorId });
			await vi.waitFor(async () => {
				const members = await alice.client.request('chat/rooms/members', { roomId: room.id });
				strictEqual(members.some(member => member.userId === bobOnHost.id), false);
			}, WAIT_FOR_FEDERATION);
			const missed = await post(alice, room.id, 25, 'while away');

			const dave = await createAccount(memberHost);
			const daveMirror = await join(alice, room, dave, memberHost);
			strictEqual(daveMirror, mirrorId);
			await waitForCompleted(dave, mirrorId);

			const copied = await readAll(dave, mirrorId);
			for (const message of missed) strictEqual(copied.filter(copy => copy.text === message.text).length, 1);
		});

		test('messages, edits and deletions that arrive while the history is fetched keep their order and are neither repeated nor brought back', async () => {
			const room = await alice.client.request('chat/rooms/create', { name: `history ${crypto.randomUUID()}` });
			const sent = await post(alice, room.id, 520, 'large');

			const mirrorId = await join(alice, room, bob, memberHost);
			const [live] = await post(alice, room.id, 1, 'live');
			await alice.client.request('chat/messages/update', { messageId: sent[519].id, text: 'large 519 edited' });
			await alice.client.request('chat/messages/delete', { messageId: sent[518].id });
			await waitForCompleted(bob, mirrorId);

			const copied = await readAll(bob, mirrorId);
			const texts = copied.map(message => message.text);
			strictEqual(new Set(copied.map(message => message.id)).size, copied.length);
			strictEqual(texts.filter(text => text === 'live 0').length, 1);
			strictEqual(texts.includes('large 518'), false);
			strictEqual(texts.filter(text => text === 'large 519' || text === 'large 519 edited').length <= 1, true);
			strictEqual(texts.includes('large 0'), true);
			strictEqual(copied.length, 520);
			const ids = copied.map(message => message.id);
			deepStrictEqual(ids, [...ids].sort().reverse());
			strictEqual(live.text, 'live 0');
		});
	});
});
