/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { api, createAppToken, signup, waitFire } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';
import type * as misskey from 'cherrypick-js';

type Account = misskey.entities.SignupResponse;

// The sign is `hasUnreadChatMessages` on the account. Screens already open learn that it went off from the main stream.
describe('chat unread sign', () => {
	let count = 0;

	/** Each test gets accounts of its own, so that no unread mark is carried from one test into the next. */
	async function person(): Promise<Account> {
		const account = await signup({ username: `person${++count}` });
		await api('i/update', { chatScope: 'everyone' }, account);
		return account;
	}

	const hasUnread = async (account: Account) => (await api('i', {}, account)).body.hasUnreadChatMessages;
	const toldEverythingIsRead = (account: Account, action: () => Promise<unknown>) => waitFire(account, 'main', action, message => message.type === 'readAllChatMessages');
	const send = (from: Account, to: Account, text: string) => api('chat/messages/create-to-user', { toUserId: to.id, text }, from);
	const open = (reader: Account, other: Account) => api('chat/messages/user-timeline', { userId: other.id }, reader);

	async function roomWith(owner: Account, member: Account) {
		const room = (await api('chat/rooms/create', { name: 'room' }, owner)).body;
		await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, owner);
		await api('chat/rooms/join', { roomId: room.id }, member);
		return room;
	}

	beforeAll(async () => {
		await signup({ username: 'root' });
	}, 1000 * 60 * 2);

	afterAll(waitForChatNotificationTurn, 30_000);

	test('reading the only unread conversation tells the screens already open', async () => {
		const [reader, sender] = [await person(), await person()];
		await send(sender, reader, 'hello');
		assert.strictEqual(await hasUnread(reader), true);

		const told = await toldEverythingIsRead(reader, () => open(reader, sender));

		assert.strictEqual(told, true);
		assert.strictEqual(await hasUnread(reader), false);
	});

	test('reading one conversation says nothing while another is unread', async () => {
		const [reader, first, second] = [await person(), await person(), await person()];
		await send(first, reader, 'hello');
		await send(second, reader, 'hi');

		const toldEarly = await toldEverythingIsRead(reader, () => open(reader, first));

		assert.strictEqual(toldEarly, false);
		assert.strictEqual(await hasUnread(reader), true);

		const told = await toldEverythingIsRead(reader, () => open(reader, second));

		assert.strictEqual(told, true);
		assert.strictEqual(await hasUnread(reader), false);
	});

	test('reading the only unread room tells the screens already open', async () => {
		const [reader, owner] = [await person(), await person()];
		const room = await roomWith(owner, reader);
		await api('chat/messages/create-to-room', { toRoomId: room.id, text: 'hello' }, owner);
		assert.strictEqual(await hasUnread(reader), true);

		const told = await toldEverythingIsRead(reader, () => api('chat/messages/room-timeline', { roomId: room.id }, reader));

		assert.strictEqual(told, true);
		assert.strictEqual(await hasUnread(reader), false);
	});

	test('marking everything read clears the mark of each conversation in the list', async () => {
		const [reader, sender] = [await person(), await person()];
		await send(sender, reader, 'hello');

		const told = await toldEverythingIsRead(reader, () => api('chat/read-all', {}, reader));

		assert.strictEqual(told, true);
		assert.strictEqual(await hasUnread(reader), false);
		const history = (await api('chat/history', { room: false }, reader)).body;
		assert.deepStrictEqual(history.map(message => message.isRead), [true]);
	});

	test('a direct message from a muted account is not unread until the mute ends', async () => {
		const [reader, muted, other] = [await person(), await person(), await person()];
		await api('mute/create', { userId: muted.id }, reader);
		await send(muted, reader, 'hello');
		assert.strictEqual(await hasUnread(reader), false);

		// What the list shows is all read once this one is, whatever the muted account sent.
		await send(other, reader, 'hi');
		const told = await toldEverythingIsRead(reader, () => open(reader, other));
		assert.strictEqual(told, true);
		assert.strictEqual(await hasUnread(reader), false);

		const accountSent = await waitFire(reader, 'main', () => api('mute/delete', { userId: muted.id }, reader), message => message.type === 'meUpdated' && message.body.hasUnreadChatMessages === true);

		assert.strictEqual(accountSent, false);
		assert.strictEqual(await hasUnread(reader), true);
	});

	test('refreshing the account after a mute turns the unread sign off', async () => {
		const [reader, sender] = [await person(), await person()];
		await send(sender, reader, 'hello');

		const accountSent = await waitFire(reader, 'main', () => api('mute/create', { userId: sender.id }, reader), message => message.type === 'meUpdated' && message.body.hasUnreadChatMessages === false);

		assert.strictEqual(accountSent, false);
		assert.strictEqual(await hasUnread(reader), false);
	});

	test('an app can refresh the unread sign after muting without receiving private account fields', async () => {
		const [reader, sender] = [await person(), await person()];
		await send(sender, reader, 'hello');
		const app = { token: await createAppToken(reader, ['read:account', 'write:mutes']) };

		const accountSent = await waitFire(app, 'main', () => api('mute/create', { userId: sender.id }, app), message => message.type === 'meUpdated');

		assert.strictEqual(accountSent, false);
		const fromApi = (await api('i', {}, app)).body as Record<string, unknown>;
		assert.strictEqual(fromApi.hasUnreadChatMessages, false);
		for (const secret of ['email', 'emailVerified', 'securityKeysList', 'signupReason']) {
			assert.strictEqual(secret in fromApi, false, `i: ${secret}`);
		}
	});

	test('a conversation left empty by taking back its only message is not unread', async () => {
		const [reader, sender, other] = [await person(), await person(), await person()];
		await send(other, reader, 'stays');
		await open(reader, other);
		const sent = (await send(sender, reader, 'hello')).body;
		assert.strictEqual(await hasUnread(reader), true);

		const told = await toldEverythingIsRead(reader, () => api('chat/messages/delete', { messageId: sent.id }, sender));

		assert.strictEqual(told, true);
		assert.strictEqual(await hasUnread(reader), false);
	});

	test('taking back one of two unread messages leaves the conversation unread', async () => {
		const [reader, sender] = [await person(), await person()];
		await send(sender, reader, 'first');
		const second = (await send(sender, reader, 'second')).body;

		const told = await toldEverythingIsRead(reader, () => api('chat/messages/delete', { messageId: second.id }, sender));

		assert.strictEqual(told, false);
		assert.strictEqual(await hasUnread(reader), true);
	});
});
