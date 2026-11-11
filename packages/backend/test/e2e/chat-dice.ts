/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { api, waitFire } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';
import type * as Misskey from 'cherrypick-js';

async function signupDiceUser(username: string): Promise<Misskey.entities.SignupResponse> {
	const response = await api('signup', { username, password: 'test' });

	expect(response.status, `signup(${username}) status`).toBe(200);
	expect(response.body.id, `signup(${username}) id`).toEqual(expect.any(String));
	expect(response.body.id.length).toBeGreaterThan(0);
	expect(response.body.token, `signup(${username}) token`).toEqual(expect.any(String));
	expect(response.body.token.length).toBeGreaterThan(0);
	expect(response.body.username).toBe(username);

	return response.body;
}

describe('chat dice through HTTP and streaming', () => {
	let alice: Misskey.entities.SignupResponse;
	let bob: Misskey.entities.SignupResponse;
	let outsider: Misskey.entities.SignupResponse;
	let roomId: string;

	beforeAll(async () => {
		alice = await signupDiceUser('dice_alice');
		bob = await signupDiceUser('dice_bob');
		outsider = await signupDiceUser('dice_outsider');
		expect((await api('i/update', { chatScope: 'everyone' }, alice)).status).toBe(200);
		expect((await api('i/update', { chatScope: 'everyone' }, bob)).status).toBe(200);

		const room = await api('chat/rooms/create', { name: 'Dice integration' }, alice);

		expect(room.status).toBe(200);
		expect(room.body.id).toEqual(expect.any(String));
		expect(room.body.id.length).toBeGreaterThan(0);
		roomId = room.body.id;
		expect((await api('chat/rooms/invitations/create', { roomId, userId: bob.id }, alice)).status).toBe(200);
		expect((await api('chat/rooms/join', { roomId }, bob)).status).toBe(204);
	});

	afterAll(waitForChatNotificationTurn, 30000);

	test('persists one default result across response, stream, show, timeline, search and reconnect', async () => {
		let created: Misskey.entities.ChatMessageLiteFor1on1;
		let streamDice: unknown;
		const streamed = await waitFire(bob, 'chatUser', async () => {
			const response = await api('chat/messages/create-to-user', { toUserId: bob.id, text: '/dice' }, alice);
			expect(response.status).toBe(200);
			created = response.body;
		}, event => {
			if (event.type !== 'message') return false;
			streamDice = event.body.dice;
			return true;
		}, { otherId: alice.id });
		expect(streamed).toBe(true);
		expect(streamDice).toEqual(created!.dice);
		expect(created!.text).toBe('/dice');
		expect(created!.dice).toMatchObject({ notation: '1d6', engineVersion: '5.5.1' });

		const shown = await api('chat/messages/show', { messageId: created!.id }, bob);
		const timeline = await api('chat/messages/user-timeline', { userId: alice.id }, bob);
		const searched = await api('chat/messages/search', { query: '/dice', userId: alice.id }, bob);
		expect(shown.body.dice).toEqual(created!.dice);
		expect(timeline.body.find(message => message.id === created!.id)?.dice).toEqual(created!.dice);
		expect(searched.body.find(message => message.id === created!.id)?.dice).toEqual(created!.dice);
		// 스트림을 닫은 뒤 다시 조회해도 같은 저장값을 읽는다.
		expect((await api('chat/messages/show', { messageId: created!.id }, alice)).body.dice).toEqual(created!.dice);
	});

	test.each(['1d20+1', '2d20kh1', '2d20kl1', '{2d6+1,1d8}kh1'])('sends native notation to the room: %s', async notation => {
		const response = await api('chat/messages/create-to-room', { toRoomId: roomId, text: `/dice ${notation}` }, alice);

		expect(response.status).toBe(200);
		expect(response.body.dice?.notation).toBe(notation);
		expect(response.body.dice?.output).toContain(`${notation}: `);
		expect(Number.isFinite(response.body.dice?.total)).toBe(true);
		const history = await api('chat/messages/room-timeline', { roomId }, bob);
		expect(history.body.find(message => message.id === response.body.id)?.dice).toEqual(response.body.dice);
	});

	test('rejects edits of results and permits their ordinary deletion', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: '/dice' }, alice);
		expect(created.status).toBe(200);
		const messageId = created.body.id;

		expect(await api('chat/messages/update', { messageId, text: '/dice 1d20' }, alice)).toMatchObject({ status: 400, body: { error: { code: 'NO_SUCH_MESSAGE' } } });
		expect(await api('chat/messages/update', { messageId, text: 'changed' }, bob)).toMatchObject({ status: 400, body: { error: { code: 'NO_SUCH_MESSAGE' } } });
		expect(await api('chat/messages/delete', { messageId }, bob)).toMatchObject({ status: 400, body: { error: { code: 'NO_SUCH_MESSAGE' } } });
		expect((await api('chat/messages/show', { messageId }, alice)).body.dice).toEqual(created.body.dice);
		expect((await api('chat/messages/delete', { messageId }, alice)).status).toBe(204);
		const tombstone = (await api('chat/messages/user-timeline', { userId: bob.id, includeDeleted: true }, alice)).body.find(message => message.id === messageId);
		expect(tombstone).toMatchObject({ text: null, dice: null });
	});

	test('cannot inject results or create one by editing ordinary text', async () => {
		const response = await api('chat/messages/create-to-user', { toUserId: bob.id, text: '$(x2 /dice) <b>result</b>', dice: { total: 999 }, _misskey_dice: { total: 999 } } as never, alice);
		expect(response.status).toBe(200);
		expect(response.body.dice).toBeNull();

		const edited = await api('chat/messages/update', { messageId: response.body.id, text: '/dice' }, alice);
		expect(edited.status).toBe(200);
		expect(edited.body).toMatchObject({ text: '/dice', dice: null });
	});

	test('checks attachment, membership, archived room and blocked recipient before rolling', async () => {
		expect(await api('chat/messages/create-to-room', { toRoomId: roomId, text: '/dice' }, outsider)).toMatchObject({ status: 400, body: { error: { code: 'NO_SUCH_ROOM' } } });
		expect(await api('chat/messages/create-to-user', { toUserId: bob.id, text: '/dice', fileIds: [roomId] }, alice)).toMatchObject({ status: 400, body: { error: { code: 'NO_SUCH_FILE' } } });
		expect((await api('chat/rooms/update', { roomId, isArchived: true }, alice)).status).toBe(200);
		expect(await api('chat/messages/create-to-room', { toRoomId: roomId, text: '/dice' }, alice)).toMatchObject({ status: 400, body: { error: { code: 'ROOM_IS_ARCHIVED' } } });
		expect((await api('blocking/create', { userId: alice.id }, bob)).status).toBe(200);
		expect(await api('chat/messages/create-to-user', { toUserId: bob.id, text: '/dice' }, alice)).toMatchObject({ status: 400, body: { error: { code: 'YOU_HAVE_BEEN_BLOCKED' } } });
		await api('blocking/delete', { userId: alice.id }, bob);
		await api('chat/rooms/update', { roomId, isArchived: false }, alice);
	});

	test('rejects bad syntax and execution limits without saving partial messages', async () => {
		for (const [text, code] of [
			['/dice no-such-notation', 'DICE_INVALID'],
			['/dice ' + '1'.repeat(513), 'DICE_LIMIT'],
			['/dice ' + '('.repeat(33) + '1d6' + ')'.repeat(33), 'DICE_LIMIT'],
			['/dice 2d6!>0', 'DICE_LIMIT'],
			['/dice 999d6+999d6', 'DICE_LIMIT'],
			['/dice 1d6/0', 'DICE_LIMIT'],
		]) {
			const response = await api('chat/messages/create-to-user', { toUserId: alice.id, text }, bob);
			expect(response.status).toBe(400);
			expect((response.body as unknown as { error: { code: string } }).error.code).toBe(code);
		}
	});

	test('bounds concurrent work and per-user attempt frequency', async () => {
		const requests = await Promise.all(Array.from({ length: 8 }, () => api('chat/messages/create-to-user', { toUserId: alice.id, text: '/dice' }, outsider)));

		expect(requests.some(response => response.status === 200)).toBe(true);
		expect(requests.some(response => (response.body as unknown as { error?: { code: string } }).error?.code === 'DICE_BUSY')).toBe(true);
		const frequent = await signupDiceUser('dice_frequent');
		for (let index = 0; index < 10; index++) {
			const invalid = await api('chat/messages/create-to-user', { toUserId: alice.id, text: '/dice bad-expression' }, frequent);
			expect((invalid.body as unknown as { error: { code: string } }).error.code).toBe('DICE_INVALID');
		}
		const limited = await api('chat/messages/create-to-user', { toUserId: alice.id, text: '/dice' }, frequent);
		expect((limited.body as unknown as { error: { code: string } }).error.code).toBe('DICE_BUSY');
	});
});
