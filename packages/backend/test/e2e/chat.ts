/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { ChatMessageAccessError, ChatService } from '@/core/ChatService.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
import type { MiUser } from '@/models/User.js';
import { api, failedApiCall, initTestDb, signup } from '../utils.js';
import type * as misskey from 'cherrypick-js';

describe('chat/messages/update', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;

	beforeAll(async () => {
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
		await api('i/update', { chatScope: 'everyone' }, alice);
		await api('i/update', { chatScope: 'everyone' }, bob);
	}, 1000 * 60 * 2);

	afterAll(async () => {
		// Let the 3-second unread-notification timers drain before the test server closes.
		await new Promise((resolve) => setTimeout(resolve, 3500));
	});

	test('updates an authored message', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'hello' }, alice);
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));

		const updated = await api('chat/messages/update', { messageId: created.body.id, text: ' edited ' }, alice);

		assert.strictEqual(updated.status, 200, JSON.stringify(updated.body));
		assert.strictEqual(updated.body.text, 'edited');
		assert.ok(updated.body.editedAt != null);
	});

	test('does not reveal a message owned by another user', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'hello' }, alice);
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));

		await failedApiCall({
			endpoint: 'chat/messages/update',
			parameters: { messageId: created.body.id, text: 'hijacked' },
			user: bob,
		}, {
			status: 400,
			code: 'NO_SUCH_MESSAGE',
			id: '31846552-b85d-4908-808f-64bf91000151',
		});
	});

	test('rejects whitespace-only edits', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'hello' }, alice);
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));

		await failedApiCall({
			endpoint: 'chat/messages/update',
			parameters: { messageId: created.body.id, text: '   ' },
			user: alice,
		}, {
			status: 400,
			code: 'NO_SUCH_MESSAGE',
			id: '31846552-b85d-4908-808f-64bf91000151',
		});
	});

	test('rejects edits to a deleted message', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'hello' }, alice);
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));

		const deleted = await api('chat/messages/delete', { messageId: created.body.id }, alice);
		assert.strictEqual(deleted.status, 204, JSON.stringify(deleted.body));

		await failedApiCall({
			endpoint: 'chat/messages/update',
			parameters: { messageId: created.body.id, text: 'edited' },
			user: alice,
		}, {
			status: 400,
			code: 'NO_SUCH_MESSAGE',
			id: '31846552-b85d-4908-808f-64bf91000151',
		});
	});

	test('a deleted message cannot be deleted again or reacted to', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'hello' }, alice);
		assert.strictEqual(created.status, 200, JSON.stringify(created.body));
		const deleted = await api('chat/messages/delete', { messageId: created.body.id }, alice);
		assert.strictEqual(deleted.status, 204, JSON.stringify(deleted.body));

		await failedApiCall({
			endpoint: 'chat/messages/delete',
			parameters: { messageId: created.body.id },
			user: alice,
		}, {
			status: 400,
			code: 'NO_SUCH_MESSAGE',
			id: '36b67f0e-66a6-414b-83df-992a55294f17',
		});

		await failedApiCall({
			endpoint: 'chat/messages/react',
			parameters: { messageId: created.body.id, reaction: '👍' },
			user: bob,
		}, {
			status: 400,
			code: 'NO_SUCH_MESSAGE',
			id: '9b5839b9-0ba0-4351-8c35-37082093d200',
		});
	});

	test('the conversation list falls back to the latest message that is not deleted', async () => {
		const carol = await signup({ username: 'carol' });
		await api('i/update', { chatScope: 'everyone' }, carol);
		const kept = await api('chat/messages/create-to-user', { toUserId: carol.id, text: 'kept' }, alice);
		const removed = await api('chat/messages/create-to-user', { toUserId: carol.id, text: 'removed' }, alice);
		assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
		const deleted = await api('chat/messages/delete', { messageId: removed.body.id }, alice);
		assert.strictEqual(deleted.status, 204, JSON.stringify(deleted.body));

		const history = await api('chat/history', { room: false, limit: 100 }, carol);

		assert.strictEqual(history.status, 200, JSON.stringify(history.body));
		assert.deepStrictEqual(history.body.map(message => message.id), [kept.body.id]);
	});

	test('a user who left a room cannot edit their old message, and the room list skips deleted messages', async () => {
		const room = await api('chat/rooms/create', { name: 'room' }, alice);
		assert.strictEqual(room.status, 200, JSON.stringify(room.body));
		const invited = await api('chat/rooms/invitations/create', { roomId: room.body.id, userId: bob.id }, alice);
		assert.strictEqual(invited.status, 200, JSON.stringify(invited.body));
		const joined = await api('chat/rooms/join', { roomId: room.body.id }, bob);
		assert.strictEqual(joined.status, 204, JSON.stringify(joined.body));
		const kept = await api('chat/messages/create-to-room', { toRoomId: room.body.id, text: 'kept' }, bob);
		const removed = await api('chat/messages/create-to-room', { toRoomId: room.body.id, text: 'removed' }, alice);
		assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
		const deleted = await api('chat/messages/delete', { messageId: removed.body.id }, alice);
		assert.strictEqual(deleted.status, 204, JSON.stringify(deleted.body));

		const history = await api('chat/history', { room: true, limit: 100 }, alice);
		assert.strictEqual(history.status, 200, JSON.stringify(history.body));
		assert.strictEqual(history.body.find(message => message.toRoomId === room.body.id)?.id, kept.body.id);

		const left = await api('chat/rooms/leave', { roomId: room.body.id }, bob);
		assert.strictEqual(left.status, 204, JSON.stringify(left.body));

		await failedApiCall({
			endpoint: 'chat/messages/update',
			parameters: { messageId: kept.body.id, text: 'edited after leaving' },
			user: bob,
		}, {
			status: 400,
			code: 'NO_SUCH_MESSAGE',
			id: '31846552-b85d-4908-808f-64bf91000151',
		});
	});

	test('keeps the latest stored revision when inbox workers hold stale snapshots', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'original' }, alice);
		assert.strictEqual(created.status, 200);
		const db = await initTestDb(true);
		try {
			const messages = db.getRepository(MiChatMessage);
			const snapshot = await messages.findOneByOrFail({ id: created.body.id });
			const events: unknown[] = [];
			const service = Object.assign(Object.create(ChatService.prototype), {
				chatMessagesRepository: messages,
				customEmojiService: { populateEmojis: async () => ({}) },
				userBlockingService: { checkBlocked: async () => false },
				globalEventService: { publishChatUserStream: (...args: unknown[]) => events.push(args) },
			}) as ChatService;
			const actor = { id: alice.id, host: 'remote.test' } as MiUser;
			await service.updateRemoteMessage(actor, { ...snapshot }, 'latest', new Date('2026-11-02T12:02:00Z'), ['wave']);
			await service.updateRemoteMessage(actor, { ...snapshot }, 'older', new Date('2026-11-02T12:01:00Z'), ['old']);
			await service.updateRemoteMessage(actor, { ...snapshot }, 'duplicate', new Date('2026-11-02T12:02:00Z'), []);
			const stored = await messages.findOneByOrFail({ id: snapshot.id });
			assert.strictEqual(stored.text, 'latest');
			assert.deepStrictEqual(stored.emojis, ['wave']);
			assert.strictEqual(stored.editedAt?.toISOString(), '2026-11-02T12:02:00.000Z');
			assert.strictEqual(events.length, 2);

			await messages.update(snapshot.id, { deletedAt: new Date(), text: null, emojis: [] });
			await service.updateRemoteMessage(actor, { ...snapshot }, 'resurrected', new Date('2026-11-02T12:03:00Z'), ['wave']);
			assert.strictEqual((await messages.findOneByOrFail({ id: snapshot.id })).text, null);
			assert.strictEqual(events.length, 2);
		} finally {
			await db.destroy();
		}
	});

	test('a local edit cannot restore text after a concurrent deletion', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'original' }, alice);
		assert.strictEqual(created.status, 200);
		const db = await initTestDb(true);
		try {
			const messages = db.getRepository(MiChatMessage);
			const events: unknown[] = [];
			const service = Object.assign(Object.create(ChatService.prototype), {
				chatMessagesRepository: {
					findOneBy: async () => {
						const snapshot = await messages.findOneByOrFail({ id: created.body.id });
						await messages.update(snapshot.id, { text: null, deletedAt: new Date() });
						return snapshot;
					},
					update: messages.update.bind(messages),
				},
				customEmojiService: { populateEmojis: async () => ({}) },
				userBlockingService: { checkBlocked: async () => false },
				globalEventService: { publishChatUserStream: (...args: unknown[]) => events.push(args) },
			}) as ChatService;
			await assert.rejects(service.updateMessage(alice.id, created.body.id, 'late edit'), ChatMessageAccessError);
			assert.strictEqual((await messages.findOneByOrFail({ id: created.body.id })).text, null);
			assert.deepStrictEqual(events, []);
		} finally {
			await db.destroy();
		}
	});

	test('duplicate remote reactions and stale reactions after deletion do not change stored state twice', async () => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'original' }, alice);
		assert.strictEqual(created.status, 200);
		const db = await initTestDb(true);
		try {
			const messages = db.getRepository(MiChatMessage);
			const snapshot = await messages.findOneByOrFail({ id: created.body.id });
			const events: unknown[] = [];
			const service = Object.assign(Object.create(ChatService.prototype), {
				chatMessagesRepository: messages,
				globalEventService: { publishChatUserStream: (...args: unknown[]) => events.push(args) },
			}) as ChatService;
			const actor = { id: bob.id, host: 'remote.test' } as MiUser;
			await Promise.all([0, 1].map(() => service.reactRemote(actor, { ...snapshot, reactions: [] }, '👍')));
			assert.deepStrictEqual((await messages.findOneByOrFail({ id: snapshot.id })).reactions, [`${bob.id}/👍`]);
			assert.strictEqual(events.length, 2);

			await messages.update(snapshot.id, { text: null, reactions: [], deletedAt: new Date() });
			await service.reactRemote(actor, { ...snapshot, reactions: [] }, '👍');
			assert.deepStrictEqual((await messages.findOneByOrFail({ id: snapshot.id })).reactions, []);
			assert.strictEqual(events.length, 2);
		} finally {
			await db.destroy();
		}
	});

	test.each(['react', 'unreact'] as const)('local %s does not change or publish a message deleted after lookup', async method => {
		const created = await api('chat/messages/create-to-user', { toUserId: bob.id, text: 'original' }, alice);
		assert.strictEqual(created.status, 200);
		const db = await initTestDb(true);
		try {
			const messages = db.getRepository(MiChatMessage);
			const events: unknown[] = [];
			const service = Object.assign(Object.create(ChatService.prototype), {
				chatMessagesRepository: {
					findOneBy: async () => {
						const snapshot = await messages.findOneByOrFail({ id: created.body.id });
						await messages.update(snapshot.id, { text: null, reactions: [], deletedAt: new Date() });
						return snapshot;
					},
					createQueryBuilder: messages.createQueryBuilder.bind(messages),
				},
				globalEventService: { publishChatUserStream: (...args: unknown[]) => events.push(args) },
			}) as ChatService;
			const error = await service[method](created.body.id, bob.id, '👍').then(() => null, error => error);
			assert.deepStrictEqual((await messages.findOneByOrFail({ id: created.body.id })).reactions, []);
			assert.deepStrictEqual(events, []);
			assert.strictEqual(error, null);
		} finally {
			await db.destroy();
		}
	});
});
