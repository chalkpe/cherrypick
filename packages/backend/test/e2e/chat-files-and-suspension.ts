/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { api, signup, uploadFile } from '../utils.js';
import type * as misskey from 'cherrypick-js';

// Let the 3-second unread-notification timers drain before the test server closes.
const drainTimers = () => new Promise(resolve => setTimeout(resolve, 3500));

let root: misskey.entities.SignupResponse;

// The first account of a server is its administrator.
beforeAll(async () => {
	root = await signup({ username: 'root' });
}, 1000 * 60 * 2);

async function upload(user: misskey.entities.SignupResponse): Promise<string> {
	const { status, body } = await uploadFile(user);
	assert.strictEqual(status, 200);
	return body!.id;
}

describe('the files of a chat message', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;
	let files: string[];
	let roomId: string;

	beforeAll(async () => {
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
		await api('i/update', { chatScope: 'everyone' }, alice);
		await api('i/update', { chatScope: 'everyone' }, bob);
		files = [];
		for (let i = 0; i < 5; i++) files.push(await upload(alice));
		const room = await api('chat/rooms/create', { name: 'files' }, alice);
		roomId = room.body.id;
		await api('chat/rooms/invitations/create', { roomId, userId: bob.id }, alice);
		await api('chat/rooms/join', { roomId }, bob);
	}, 1000 * 60 * 2);

	afterAll(drainTimers);

	test.each([
		['user', () => ({ endpoint: 'chat/messages/create-to-user' as const, target: { toUserId: bob.id } })],
		['room', () => ({ endpoint: 'chat/messages/create-to-room' as const, target: { toRoomId: roomId } })],
	])('a message to a %s holds four files in order, and names the first under the older fields', async (_name, build) => {
		const { endpoint, target } = build();
		const fileIds = [files[3], files[0], files[2], files[1]];

		const { status, body } = await api(endpoint, { ...target, fileIds } as never, alice);

		assert.strictEqual(status, 200, JSON.stringify(body));
		assert.deepStrictEqual(body.fileIds, fileIds);
		assert.deepStrictEqual(body.files.map(file => file.id), fileIds);
		assert.strictEqual(body.fileId, files[3]);
		assert.strictEqual(body.file?.id, files[3]);
	});

	test('the timelines return them too', async () => {
		const fileIds = [files[1], files[0]];
		await api('chat/messages/create-to-user', { toUserId: bob.id, fileIds }, alice);
		await api('chat/messages/create-to-room', { toRoomId: roomId, fileIds }, alice);

		const direct = await api('chat/messages/user-timeline', { userId: alice.id, limit: 1 }, bob);
		const room = await api('chat/messages/room-timeline', { roomId, limit: 1 }, bob);

		assert.strictEqual(direct.status, 200, JSON.stringify(direct.body));
		assert.deepStrictEqual(direct.body[0].files.map(file => file.id), fileIds);
		assert.strictEqual(room.status, 200, JSON.stringify(room.body));
		assert.deepStrictEqual(room.body[0].files.map(file => file.id), fileIds);
	});

	test('fileId alone still works', async () => {
		const { status, body } = await api('chat/messages/create-to-user', { toUserId: bob.id, fileId: files[0] }, alice);

		assert.strictEqual(status, 200, JSON.stringify(body));
		assert.deepStrictEqual(body.fileIds, [files[0]]);
	});

	test('a message with neither text nor file is refused', async () => {
		const { status, body } = await api('chat/messages/create-to-user', { toUserId: bob.id }, alice);

		assert.strictEqual(status, 400);
		assert.strictEqual((body as unknown as { error: { code: string } }).error.code, 'CONTENT_REQUIRED');
	});

	test('five files are refused, also by adding fileId to four', async () => {
		const tooMany = await api('chat/messages/create-to-user', { toUserId: bob.id, fileIds: files }, alice);
		const combined = await api('chat/messages/create-to-user', { toUserId: bob.id, fileId: files[4], fileIds: files.slice(0, 4) }, alice);

		assert.strictEqual(tooMany.status, 400);
		assert.strictEqual(combined.status, 400);
		assert.strictEqual((combined.body as unknown as { error: { code: string } }).error.code, 'TOO_MANY_FILES');
	});

	test('a file of someone else is refused', async () => {
		const { status, body } = await api('chat/messages/create-to-user', { toUserId: alice.id, fileIds: [files[0]] }, bob);

		assert.strictEqual(status, 400);
		assert.strictEqual((body as unknown as { error: { code: string } }).error.code, 'NO_SUCH_FILE');
	});

	test('drive/files/attached-chat-messages finds a message by any of its files', async () => {
		const second = await upload(alice);
		const { body: message } = await api('chat/messages/create-to-user', { toUserId: bob.id, fileIds: [files[0], second] }, alice);

		const { status, body } = await api('drive/files/attached-chat-messages', { fileId: second }, alice);

		assert.strictEqual(status, 200, JSON.stringify(body));
		assert.deepStrictEqual(body.map(found => found.id), [message.id]);
	});

	test('a file deleted later is left out, and the message can no longer lose its text', async () => {
		const only = await upload(alice);
		const { body: message } = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'caption', fileIds: [only] }, alice);

		assert.strictEqual((await api('chat/messages/update', { messageId: message.id, text: '' }, alice)).status, 200);
		assert.strictEqual((await api('chat/messages/update', { messageId: message.id, text: 'caption' }, alice)).status, 200);
		assert.strictEqual((await api('drive/files/delete', { fileId: only }, alice)).status, 204);

		const shown = await api('chat/messages/show', { messageId: message.id }, alice);
		assert.deepStrictEqual(shown.body.fileIds, []);
		assert.strictEqual(shown.body.file, null);
		assert.strictEqual((await api('chat/messages/update', { messageId: message.id, text: '' }, alice)).status, 400);
	});

	test('deleting a message clears its files', async () => {
		const { body: message } = await api('chat/messages/create-to-user', { toUserId: bob.id, fileIds: [files[0], files[1]] }, alice);

		assert.strictEqual((await api('chat/messages/delete', { messageId: message.id }, alice)).status, 204);

		const shown = await api('chat/messages/show', { messageId: message.id }, alice);
		assert.deepStrictEqual(shown.body.fileIds, []);
		assert.deepStrictEqual(shown.body.files, []);
	});

	test.each([
		['chat/messages/create-to-user', () => ({ endpoint: 'chat/messages/create-to-user' as const, target: { toUserId: bob.id } })],
		['chat/messages/create-to-room', () => ({ endpoint: 'chat/messages/create-to-room' as const, target: { toRoomId: roomId } })],
	])('%s takes 4096 code points and no more', async (_name, build) => {
		const { endpoint, target } = build();

		assert.strictEqual((await api(endpoint, { ...target, text: '🦈'.repeat(4096) } as never, alice)).status, 200);
		assert.strictEqual((await api(endpoint, { ...target, text: '🦈'.repeat(4097) } as never, alice)).status, 400);
	});

	test('an edit takes 4096 code points and no more', async () => {
		const { body: message } = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'short' }, alice);

		assert.strictEqual((await api('chat/messages/update', { messageId: message.id, text: '🦈'.repeat(4096) }, alice)).status, 200);
		assert.strictEqual((await api('chat/messages/update', { messageId: message.id, text: '🦈'.repeat(4097) }, alice)).status, 400);
	});
});

describe('a suspended account in chat', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;
	let roomId: string;
	let directFromBob: string;
	let roomFromBob: string;

	beforeAll(async () => {
		alice = await signup({ username: 'chatalice' });
		bob = await signup({ username: 'chatbob' });
		await api('i/update', { chatScope: 'everyone' }, alice);
		await api('i/update', { chatScope: 'everyone' }, bob);
		const room = await api('chat/rooms/create', { name: 'suspension' }, alice);
		roomId = room.body.id;
		await api('chat/rooms/invitations/create', { roomId, userId: bob.id }, alice);
		await api('chat/rooms/join', { roomId }, bob);
		directFromBob = (await api('chat/messages/create-to-user', { toUserId: alice.id, text: 'findme direct' }, bob)).body.id;
		roomFromBob = (await api('chat/messages/create-to-room', { toRoomId: roomId, text: 'findme room' }, bob)).body.id;
		await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'findme reply' }, alice);
		assert.strictEqual((await api('admin/suspend-user', { userId: bob.id }, root)).status, 204);
	}, 1000 * 60 * 2);

	afterAll(drainTimers);

	const seen = async () => {
		const direct = await api('chat/messages/user-timeline', { userId: bob.id, limit: 10 }, alice);
		const room = await api('chat/messages/room-timeline', { roomId, limit: 10 }, alice);
		const search = await api('chat/messages/search', { query: 'findme', limit: 10 }, alice);
		const userHistory = await api('chat/history', { room: false, limit: 10 }, alice);
		const roomHistory = await api('chat/history', { room: true, limit: 10 }, alice);
		for (const res of [direct, room, search, userHistory, roomHistory]) assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		return {
			direct: direct.body.map(message => message.id),
			room: room.body.map(message => message.id),
			search: search.body.map(message => message.id),
			history: [...userHistory.body, ...roomHistory.body].map(message => message.id),
		};
	};

	test('a direct message to it is refused and not stored', async () => {
		const { status, body } = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'hello' }, alice);

		assert.strictEqual(status, 400);
		assert.strictEqual((body as unknown as { error: { code: string } }).error.code, 'RECIPIENT_IS_SUSPENDED');
		assert.ok(!(await api('chat/messages/search', { query: 'hello', limit: 10 }, alice)).body.some(message => message.toUserId === bob.id));
	});

	test('an invitation to it is refused', async () => {
		const other = await api('chat/rooms/create', { name: 'another' }, alice);

		const { status, body } = await api('chat/rooms/invitations/create', { roomId: other.body.id, userId: bob.id }, alice);

		assert.strictEqual(status, 400);
		assert.strictEqual((body as unknown as { error: { code: string } }).error.code, 'USER_IS_SUSPENDED');
	});

	test('its messages are out of sight, while the same conversation stays open', async () => {
		const { direct, room, search, history } = await seen();

		assert.ok(direct.length > 0);
		for (const list of [direct, room, search, history]) {
			assert.ok(!list.includes(directFromBob), 'direct message shown');
			assert.ok(!list.includes(roomFromBob), 'room message shown');
		}
	});

	test('its messages cannot be opened directly, except by a moderator', async () => {
		assert.strictEqual((await api('chat/messages/show', { messageId: directFromBob }, alice)).status, 400);
		assert.strictEqual((await api('chat/messages/show', { messageId: directFromBob }, root)).status, 200);
	});

	test('they come back when the suspension ends', async () => {
		assert.strictEqual((await api('admin/unsuspend-user', { userId: bob.id }, root)).status, 204);

		const { direct, room, search } = await seen();

		assert.ok(direct.includes(directFromBob));
		assert.ok(room.includes(roomFromBob));
		assert.ok(search.includes(directFromBob) && search.includes(roomFromBob));
		assert.strictEqual((await api('chat/messages/show', { messageId: directFromBob }, alice)).status, 200);
	});
});
