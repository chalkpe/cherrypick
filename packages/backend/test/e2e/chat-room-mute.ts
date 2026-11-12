/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { api, castAsError, connectStream, randomString, signup, waitFire } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';
import type * as misskey from 'cherrypick-js';

type Account = misskey.entities.SignupResponse;
type Room = misskey.entities.ChatRoom;

const NOTICE_TIMEOUT = 15_000;

// A participant who muted a room gets no unread mark for new messages there, and no notice of them three seconds later.
// The owner has no membership to keep that choice on, and used to be refused.
describe('muting a chat room', () => {
	let count = 0;
	let courier: Account;

	/** Each test gets accounts of its own, so that no unread mark is carried from one test into the next. */
	async function person(): Promise<Account> {
		const account = await signup({ username: `muter${++count}` });
		await api('i/update', { chatScope: 'everyone' }, account);
		return account;
	}

	async function roomOf(owner: Account, ...members: Account[]): Promise<Room> {
		const room = (await api('chat/rooms/create', { name: 'room' }, owner)).body;
		for (const member of members) {
			await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, owner);
			await api('chat/rooms/join', { roomId: room.id }, member);
		}
		return room;
	}

	const setMuted = async (who: Account, room: Room, mute: boolean) => {
		const res = await api('chat/rooms/mute', { roomId: room.id, mute }, who);
		assert.strictEqual(res.status, 204, JSON.stringify(res.body));
	};
	const shownMuted = async (who: Account, room: Room) => (await api('chat/rooms/show', { roomId: room.id }, who)).body.isMuted;
	const hasUnread = async (account: Account) => (await api('i', {}, account)).body.hasUnreadChatMessages;
	const roomIsRead = async (account: Account) => (await api('chat/history', { room: true }, account)).body.map(message => message.isRead);
	const say = (from: Account, room: Room, text: string) => api('chat/messages/create-to-room', { toRoomId: room.id, text }, from);

	/** Opens the account's main stream, runs the action and waits there until `until` is satisfied by a notice of a new message. */
	async function noticesWhile(account: Account, action: () => Promise<unknown>, until: (text: string) => boolean): Promise<string[]> {
		const texts: string[] = [];
		let satisfied!: () => void;
		const done = new Promise<void>(resolve => { satisfied = resolve; });
		const stream = await connectStream(account, 'main', message => {
			if (message.type !== 'newChatMessage') return;
			texts.push(message.body?.text);
			if (until(message.body?.text)) satisfied();
		});
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			await action();
			await Promise.race([
				done,
				new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('the awaited notice did not arrive')), NOTICE_TIMEOUT); }),
			]);
		} finally {
			if (timeout != null) clearTimeout(timeout);
			stream.close();
		}

		return texts;
	}

	/** Runs the action and waits until the account is told of the new message with this text. */
	const told = (account: Account, text: string, action: () => Promise<unknown>) => noticesWhile(account, action, heard => heard === text);

	/**
	 * The notices of new room messages that reach the account while the action runs. The action has to wait until
	 * someone else was told of the same messages. A direct message sent after that is noticed later than anything
	 * the action caused, so the account's notices are complete once that one arrives.
	 */
	async function roomNoticesWhile(account: Account, action: () => Promise<unknown>): Promise<string[]> {
		const later = `later-${randomString()}`;

		const texts = await noticesWhile(account, async () => {
			await action();
			await api('chat/messages/create-to-user', { toUserId: account.id, text: later }, courier);
		}, text => text === later);

		// The courier's message was only there to be waited for.
		await api('chat/messages/user-timeline', { userId: courier.id }, account);
		return texts.filter(text => text !== later);
	}

	beforeAll(async () => {
		await signup({ username: 'root' });
		courier = await person();
	}, 1000 * 60 * 2);

	afterAll(waitForChatNotificationTurn, 30_000);

	test('the owner mutes and unmutes the room, and the room says so when read again', async () => {
		const [owner, member] = [await person(), await person()];
		const room = await roomOf(owner, member);
		assert.strictEqual(await shownMuted(owner, room), false);

		await setMuted(owner, room, true);

		assert.strictEqual(await shownMuted(owner, room), true);
		const owned = (await api('chat/rooms/owned', {}, owner)).body;
		assert.deepStrictEqual(owned.map(listed => [listed.id, listed.isMuted]), [[room.id, true]]);

		await setMuted(owner, room, false);

		assert.strictEqual(await shownMuted(owner, room), false);
	});

	test('the owner mutes for themselves alone and stays out of the member list', async () => {
		const [owner, member] = [await person(), await person()];
		const room = await roomOf(owner, member);

		await setMuted(owner, room, true);

		assert.strictEqual(await shownMuted(member, room), false);
		const members = (await api('chat/rooms/members', { roomId: room.id }, owner)).body;
		assert.deepStrictEqual(members.map(membership => membership.userId), [member.id]);
		const joining = (await api('chat/rooms/joining', {}, member)).body;
		assert.deepStrictEqual(joining.map(membership => [membership.roomId, membership.room?.isMuted]), [[room.id, false]]);
		assert.strictEqual((await api('chat/rooms/leave', { roomId: room.id }, owner)).status, 400);
	});

	test('a muted owner gets no unread sign and no notice, while a member still does', async () => {
		const [owner, speaker, listener] = [await person(), await person(), await person()];
		const room = await roomOf(owner, speaker, listener);
		await setMuted(owner, room, true);

		const noticed = await roomNoticesWhile(owner, () => told(listener, 'hello', () => say(speaker, room, 'hello')));

		assert.deepStrictEqual(noticed, []);
		assert.strictEqual(await hasUnread(owner), false);
		assert.deepStrictEqual(await roomIsRead(owner), [true]);
		assert.strictEqual(await hasUnread(listener), true);
	});

	test('an owner who unmuted gets the sign and the notice for later messages', async () => {
		const [owner, speaker, listener] = [await person(), await person(), await person()];
		const room = await roomOf(owner, speaker, listener);
		await setMuted(owner, room, true);
		await told(listener, 'during the mute', () => say(speaker, room, 'during the mute'));
		await setMuted(owner, room, false);

		const noticed = await told(owner, 'after the mute', () => say(speaker, room, 'after the mute'));

		assert.deepStrictEqual(noticed, ['after the mute']);
		assert.strictEqual(await hasUnread(owner), true);
		assert.deepStrictEqual(await roomIsRead(owner), [false]);
	});

	test('a muted member gets no unread sign and no notice, while the owner still does', async () => {
		const [owner, speaker, muted] = [await person(), await person(), await person()];
		const room = await roomOf(owner, speaker, muted);
		await setMuted(muted, room, true);

		const noticed = await roomNoticesWhile(muted, () => told(owner, 'hello', () => say(speaker, room, 'hello')));

		assert.deepStrictEqual(noticed, []);
		assert.strictEqual(await hasUnread(muted), false);
		assert.strictEqual(await shownMuted(muted, room), true);
		assert.strictEqual(await shownMuted(owner, room), false);
		assert.strictEqual(await hasUnread(owner), true);
	});

	test('a mark from before the mute stays in the list until the owner reads the room', async () => {
		const [owner, speaker] = [await person(), await person()];
		const room = await roomOf(owner, speaker);
		await say(speaker, room, 'hello');
		assert.strictEqual(await hasUnread(owner), true);

		await setMuted(owner, room, true);

		assert.strictEqual(await hasUnread(owner), true);
		assert.deepStrictEqual(await roomIsRead(owner), [false]);

		const toldEverythingIsRead = await waitFire(owner, 'main', () => api('chat/messages/room-timeline', { roomId: room.id }, owner), message => message.type === 'readAllChatMessages');

		assert.strictEqual(toldEverythingIsRead, true);
		assert.strictEqual(await hasUnread(owner), false);
	});

	test('someone outside the room cannot mute it', async () => {
		const [owner, outsider] = [await person(), await person()];
		const room = await roomOf(owner);

		const refused = await api('chat/rooms/mute', { roomId: room.id, mute: true }, outsider);

		assert.strictEqual(refused.status, 400);
		assert.strictEqual(castAsError(refused.body as unknown as Record<string, unknown>).error.code, 'NO_SUCH_ROOM');
		assert.strictEqual(await shownMuted(owner, room), false);
	});
});
