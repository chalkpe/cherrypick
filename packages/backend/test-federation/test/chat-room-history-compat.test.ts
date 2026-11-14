/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { deepStrictEqual, strictEqual } from 'node:assert';
import { beforeAll, describe, test, vi } from 'vitest';
import * as Misskey from 'cherrypick-js';
import { createAccount, type LoginUser, resolveRemoteUser, WAIT_FOR_FEDERATION } from './utils.js';

/**
 * b.test를 과거 기록 조회가 없는 이전 버전으로 띄웠을 때만 돈다 (CHERRYPICK_FED_OLD_HOST=b.test).
 * 두 서버가 모두 새 버전인 평소 구성에서는 건너뛴다.
 */
const oldHost = process.env.CHERRYPICK_FED_OLD_HOST;
const WAIT_FOR_HISTORY = { timeout: 600000, interval: 2000 };

async function join(owner: LoginUser, room: Misskey.entities.ChatRoom, invitee: LoginUser, inviteeHost: 'a.test' | 'b.test'): Promise<string> {
	const remote = await resolveRemoteUser(inviteeHost, invitee.id, owner);
	await owner.client.request('chat/rooms/invitations/create', { roomId: room.id, userId: remote.id });
	const mirrorId = await vi.waitFor(async () => {
		const invitations = await invitee.client.request('chat/rooms/invitations/inbox', {});
		const invitation = invitations.find(candidate => candidate.room.name === room.name);
		if (invitation == null) throw new Error('the invitation has not arrived yet');
		return invitation.roomId;
	}, WAIT_FOR_FEDERATION);
	await invitee.client.request('chat/rooms/join', { roomId: mirrorId });
	await vi.waitFor(async () => {
		const members = await owner.client.request('chat/rooms/members', { roomId: room.id });
		strictEqual(members.length >= 2, true);
	}, WAIT_FOR_FEDERATION);
	return mirrorId;
}

async function texts(user: LoginUser, roomId: string): Promise<string[]> {
	return (await user.client.request('chat/messages/room-timeline', { roomId, limit: 100 })).map(message => message.text ?? '').reverse();
}

describe.runIf(oldHost === 'b.test')('Chat room history with a server from before it', () => {
	let alice: LoginUser, bob: LoginUser;

	beforeAll(async () => {
		[alice, bob] = await Promise.all([createAccount('a.test'), createAccount('b.test')]);
	});

	test('an older member server keeps chatting as before and asks for nothing new', async () => {
		const room = await alice.client.request('chat/rooms/create', { name: `compat ${crypto.randomUUID()}` });
		await alice.client.request('chat/messages/create-to-room', { toRoomId: room.id, text: 'before joining' });

		const mirrorId = await join(alice, room, bob, 'b.test');
		await alice.client.request('chat/messages/create-to-room', { toRoomId: room.id, text: 'from the new host' });
		await vi.waitFor(async () => deepStrictEqual(await texts(bob, mirrorId), ['from the new host']), WAIT_FOR_FEDERATION);
		await bob.client.request('chat/messages/create-to-room', { toRoomId: mirrorId, text: 'from the older member' });

		await vi.waitFor(async () => deepStrictEqual(await texts(alice, room.id), ['before joining', 'from the new host', 'from the older member']), WAIT_FOR_FEDERATION);
	});

	test('a newer member of a room on an older server is told that no more can be fetched, and keeps chatting', async () => {
		const room = await bob.client.request('chat/rooms/create', { name: `compat ${crypto.randomUUID()}` });
		await bob.client.request('chat/messages/create-to-room', { toRoomId: room.id, text: 'kept only on the older server' });

		const mirrorId = await join(bob, room, alice, 'a.test');
		await vi.waitFor(async () => {
			const shown = await alice.client.request('chat/rooms/show', { roomId: mirrorId });
			strictEqual(shown.historyImportStatus, 'unavailable');
		}, WAIT_FOR_HISTORY);

		await alice.client.request('chat/messages/create-to-room', { toRoomId: mirrorId, text: 'from the newer member' });
		await vi.waitFor(async () => strictEqual((await texts(bob, room.id)).includes('from the newer member'), true), WAIT_FOR_FEDERATION);
		await bob.client.request('chat/messages/create-to-room', { toRoomId: room.id, text: 'from the older host' });
		await vi.waitFor(async () => deepStrictEqual(await texts(alice, mirrorId), ['from the newer member', 'from the older host']), WAIT_FOR_FEDERATION);
	});
});
