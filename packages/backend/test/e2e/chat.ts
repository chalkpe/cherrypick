/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
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
});
