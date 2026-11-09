/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { api, signup } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';
import type * as misskey from 'cherrypick-js';

// A failed insert nobody waits for is an unhandled rejection in the server, and that fails the whole run.
describe('the first messages to someone, sent at the same moment', () => {
	let alice: misskey.entities.SignupResponse;
	const friends: misskey.entities.SignupResponse[] = [];

	beforeAll(async () => {
		await signup({ username: 'root' });
		alice = await signup({ username: 'alice' });
		await api('i/update', { chatScope: 'everyone' }, alice);
		for (const username of ['bob', 'carol', 'dave', 'erin', 'frank', 'grace']) {
			const friend = await signup({ username });
			await api('i/update', { chatScope: 'everyone' }, friend);
			friends.push(friend);
		}
	}, 1000 * 60 * 2);

	afterAll(waitForChatNotificationTurn, 30_000);

	test('all arrive, in both directions', async () => {
		for (const friend of friends) {
			const sent = await Promise.all([
				...['one', 'two', 'three', 'four', 'five', 'six'].map(text => api('chat/messages/create-to-user', { toUserId: friend.id, text }, alice)),
				...['back one', 'back two', 'back three'].map(text => api('chat/messages/create-to-user', { toUserId: alice.id, text }, friend)),
			]);

			assert.deepStrictEqual(sent.map(result => result.status), sent.map(() => 200));
			const { body } = await api('chat/messages/user-timeline', { userId: friend.id, limit: 20 }, alice);
			assert.strictEqual(body.length, 9);
		}
	});
});
