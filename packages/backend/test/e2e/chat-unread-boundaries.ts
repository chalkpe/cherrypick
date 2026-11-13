/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import type * as misskey from 'cherrypick-js';
import type { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { ChatService } from '@/core/ChatService.js';
import { QueueService } from '@/core/QueueService.js';
import { MiUser } from '@/models/_.js';
import { api, connectStream, initTestDb, signup, startJobQueue, waitFire } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';

type Account = misskey.entities.SignupResponse;

describe('chat unread boundaries', () => {
	let root: Account;
	let queue: INestApplicationContext;
	let redis: Redis;
	let db: DataSource;
	let count = 0;

	async function person() {
		const account = await signup({ username: `boundary${++count}` });
		assert.strictEqual((await api('i/update', { chatScope: 'everyone' }, account)).status, 200);
		return account;
	}

	async function roomOf(owner: Account, ...members: Account[]) {
		const room = (await api('chat/rooms/create', { name: 'Harbor' }, owner)).body;
		for (const member of members) {
			assert.strictEqual((await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, owner)).status, 200);
			assert.strictEqual((await api('chat/rooms/join', { roomId: room.id }, member)).status, 204);
		}
		return room;
	}

	const hasUnread = async (reader: Account) => (await api('i', {}, reader)).body.hasUnreadChatMessages;
	const say = (from: Account, to: Account, text: string) => api('chat/messages/create-to-user', { toUserId: to.id, text }, from);
	const roomSay = (owner: Account, roomId: string) => api('chat/messages/create-to-room', { toRoomId: roomId, text: 'Plans for Saturday' }, owner);
	const receiveNotice = async (reader: Account, sender: Account, text: string) => {
		let resolve: () => void = () => {};
		const received = new Promise<void>(done => { resolve = done; });
		const stream = await connectStream(reader, 'main', message => {
			if (message.type === 'newChatMessage' && message.body.text === text) resolve();
		});
		try {
			assert.strictEqual((await say(sender, reader, text)).status, 200);
			await Promise.race([received, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('chat notice timed out')), 7000))]);
		} finally {
			stream.close();
		}
	};

	beforeAll(async () => {
		queue = await startJobQueue();
		root = await signup({ username: 'root' });
		redis = new Redis(loadConfig().redis);
		db = await initTestDb(true);
		assert.strictEqual((await api('i', {}, root)).body.isAdmin, true);
	}, 120_000);

	afterAll(async () => {
		await waitForChatNotificationTurn();
		await queue.close();
		await redis.quit();
		await db.destroy();
	}, 30_000);

	test('orphan markers do not make a conversation unread before cleanup', async () => {
		const [reader, sender] = [await person(), await person()];
		assert.strictEqual((await say(sender, reader, 'Already read')).status, 200);
		await redis.del(`newChatMessagesExists:${reader.id}`);
		assert.strictEqual(await hasUnread(reader), false);
		assert.deepStrictEqual((await api('chat/history', { room: false }, reader)).body.map(message => message.isRead), [true]);
		assert.strictEqual((await api('chat/read-all', {}, reader)).status, 204);
		assert.notStrictEqual(await redis.get(`newUserChatMessageExists:${reader.id}:${sender.id}`), null);
		await receiveNotice(reader, sender, 'New message');
		assert.strictEqual(await hasUnread(reader), true);
		assert.deepStrictEqual((await api('chat/history', { room: false }, reader)).body.map(message => message.isRead), [false]);
		assert.strictEqual((await api('chat/read-all', {}, reader)).status, 204);
		assert.strictEqual(await hasUnread(reader), false);
	});

	test('reading a conversation does not rebuild an unindexed orphan marker', async () => {
		const [reader, sender] = [await person(), await person()];
		assert.strictEqual((await say(sender, reader, 'Already read')).status, 200);
		const key = `newUserChatMessageExists:${reader.id}:${sender.id}`;
		await redis.del(`newChatMessagesExists:${reader.id}`, key, `${key}:first`, `${key}:revision`, `${key}:messages`, `${key}:pending`);
		await redis.sadd(`${key}:messages`, 'pending-id');
		await redis.sadd(`${key}:pending`, 'pending-id');
		assert.strictEqual((await api('chat/messages/user-timeline', { userId: sender.id }, reader)).status, 200);
		assert.strictEqual(await redis.get(key), null);
		assert.strictEqual(await redis.sismember(`${key}:pending`, 'pending-id'), 1);
	});

	test('legacy cleanup resumes and preserves active and pending marks', async () => {
		const systemQueue = queue.get(QueueService).systemQueue;
		await systemQueue.pause();
		const blocker = db.createQueryRunner();
		try {
			await vi.waitFor(async () => assert.strictEqual(await redis.exists('chatLegacyUnreadCleanup:lock'), 0));
			await redis.del('chatLegacyUnreadCleanup:cursor', 'chatLegacyUnreadCleanup:deferred');
			let service = queue.get(ChatService) as ChatService & { cleanupLegacyUnreadMarks?: () => Promise<boolean> };
			assert.strictEqual(typeof service.cleanupLegacyUnreadMarks, 'function');
			const clean = () => service.cleanupLegacyUnreadMarks!();
			const [reader, sender, other, arriving] = [await person(), await person(), await person(), await person()];
			assert.strictEqual((await say(sender, reader, 'Active unread')).status, 200);
			const active = `newUserChatMessageExists:${reader.id}:${sender.id}`;
			const orphan = `newUserChatMessageExists:${reader.id}:${other.id}`;
			const pending = `newRoomChatMessageExists:${reader.id}:pendingroom`;
			await redis.set(orphan, 'old');
			await redis.set(`${orphan}:first`, 'old');
			await redis.set(pending, 'sending');
			await redis.sadd(`${pending}:pending`, 'sending');
			await blocker.connect();
			await blocker.startTransaction();
			await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['chat-message-send:sending']);
			const pipeline = redis.pipeline();
			for (let i = 0; i < 5000; i++) pipeline.set(`cleanup-fixture:${i}`, 'x');
			await pipeline.exec();
			assert.strictEqual(await clean(), false);
			assert.notStrictEqual(await redis.get('chatLegacyUnreadCleanup:cursor'), null);
			service = Object.assign(Object.create(ChatService.prototype), service);
			const renewed = `newUserChatMessageExists:${reader.id}:${arriving.id}`;
			await redis.set(renewed, 'old');
			assert.strictEqual((await say(arriving, reader, 'Arrived during cleanup')).status, 200);
			for (let i = 0; i < 20 && await redis.exists(orphan); i++) await clean();
			assert.strictEqual(await redis.get(orphan), null);
			assert.notStrictEqual(await redis.get(active), null);
			assert.notStrictEqual(await redis.get(renewed), null);
			assert.notStrictEqual(await redis.get(pending), null);
			await blocker.rollbackTransaction();
			let complete = false;
			for (let i = 0; i < 20 && !complete; i++) complete = await clean();
			assert.strictEqual(complete, true);
			assert.strictEqual(await redis.get(pending), null);
			assert.notStrictEqual(await redis.get(active), null);
			assert.strictEqual(await clean(), true);
			await receiveNotice(reader, other, 'Arrived after cleanup');
			assert.strictEqual(await hasUnread(reader), true);
			assert.strictEqual((await api('chat/read-all', {}, reader)).status, 204);
			assert.strictEqual(await hasUnread(reader), false);
		} finally {
			if (blocker.isTransactionActive) await blocker.rollbackTransaction();
			await blocker.release();
			const cleanup = redis.pipeline();
			for (let i = 0; i < 5000; i++) cleanup.del(`cleanup-fixture:${i}`);
			await cleanup.exec();
			await systemQueue.resume();
		}
	});

	test('read-all recovers direct and room markers left by an older read-all', async () => {
		const [reader, owner, otherReader] = [await person(), await person(), await person()];
		const room = await roomOf(owner, reader, otherReader);
		assert.strictEqual((await say(owner, reader, 'hello')).status, 200);
		assert.strictEqual((await roomSay(owner, room.id)).status, 200);
		// 이전 버전의 전체 읽음은 집계 set만 지웠다. 그 업그레이드 잔여 상태를 만든다.
		await redis.del(`newChatMessagesExists:${reader.id}`);

		assert.strictEqual((await api('chat/read-all', {}, reader)).status, 204);

		assert.strictEqual(await hasUnread(reader), false);
		assert.deepStrictEqual((await api('chat/history', { room: false }, reader)).body.map(message => message.isRead), [true]);
		assert.deepStrictEqual((await api('chat/history', { room: true }, reader)).body.map(message => message.isRead), [true]);
		assert.strictEqual(await hasUnread(otherReader), true);
	});

	test('overlapping receive and read-all leave the account and conversation markers consistent', async () => {
		const [reader, sender] = [await person(), await person()];
		for (let index = 0; index < 12; index++) {
			const results = await Promise.all([
				say(sender, reader, `hello ${index}`),
				api('chat/read-all', {}, reader),
			]);
			assert.strictEqual(results[0].status, 200);
			assert.strictEqual(results[1].status, 204);

			const history = (await api('chat/history', { room: false }, reader)).body;
			assert.strictEqual(await hasUnread(reader), history.some(message => !message.isRead));
		}
	});

	test.each(['conversation', 'all'] as const)('legacy markers are cleared by reading %s and the next receive uses the new format', async mode => {
		const [reader, sender] = [await person(), await person()];
		assert.strictEqual((await say(sender, reader, 'Old unread content')).status, 200);
		const oldLatest = (await say(sender, reader, 'Old latest')).body;
		const key = `newUserChatMessageExists:${reader.id}:${sender.id}`;
		// 이전 형식에는 첫 미읽음 위치가 없다. 그 정보가 없는 상태를 명시적으로 준비한다.
		await redis.del(`${key}:first`);
		const duringLegacy = (await say(sender, reader, 'Received before the legacy marker was read')).body;
		assert.strictEqual(await redis.get(`${key}:first`), null);
		assert.strictEqual((await api('chat/messages/delete', { messageId: duringLegacy.id }, sender)).status, 204);
		assert.strictEqual((await api('chat/messages/delete', { messageId: oldLatest.id }, sender)).status, 204);
		assert.strictEqual(await hasUnread(reader), true);

		const read = mode === 'all'
			? await api('chat/read-all', {}, reader)
			: await api('chat/messages/user-timeline', { userId: sender.id }, reader);
		assert.strictEqual(read.status, mode === 'all' ? 204 : 200);
		assert.strictEqual(await hasUnread(reader), false);
		assert.strictEqual(await redis.get(key), null);
		assert.strictEqual(await redis.get(`${key}:first`), null);

		const latest = (await say(sender, reader, 'New unread content')).body;
		assert.strictEqual(await redis.get(`${key}:first`), latest.id);
		const told = await waitFire(reader, 'main', () => api('chat/messages/delete', { messageId: latest.id }, sender), message => message.type === 'readAllChatMessages');

		assert.strictEqual(told, true);
		assert.strictEqual(await hasUnread(reader), false);
	});

	test.each(['read', 'sent'] as const)('withdrawing the only unread direct message clears the sign while %s content remains', async remaining => {
		const [reader, sender] = [await person(), await person()];
		if (remaining === 'read') {
			assert.strictEqual((await say(sender, reader, 'Already read')).status, 200);
			assert.strictEqual((await api('chat/messages/user-timeline', { userId: sender.id }, reader)).status, 200);
		} else {
			assert.strictEqual((await say(reader, sender, 'My own message')).status, 200);
		}
		const latest = (await say(sender, reader, 'Withdraw this')).body;
		assert.strictEqual(await hasUnread(reader), true);

		const told = await waitFire(reader, 'main', () => api('chat/messages/delete', { messageId: latest.id }, sender), message => message.type === 'readAllChatMessages');

		assert.strictEqual(told, true);
		assert.strictEqual(await hasUnread(reader), false);
		assert.deepStrictEqual((await api('chat/history', { room: false }, reader)).body.map(message => message.isRead), [true]);
	});

	test('withdrawing the only unread room message clears the sign while read content remains', async () => {
		const [reader, owner] = [await person(), await person()];
		const room = await roomOf(owner, reader);
		assert.strictEqual((await roomSay(owner, room.id)).status, 200);
		assert.strictEqual((await api('chat/messages/room-timeline', { roomId: room.id }, reader)).status, 200);
		const latest = (await roomSay(owner, room.id)).body;

		const told = await waitFire(reader, 'main', () => api('chat/messages/delete', { messageId: latest.id }, owner), message => message.type === 'readAllChatMessages');

		assert.strictEqual(told, true);
		assert.strictEqual(await hasUnread(reader), false);
	});

	test('suspending the only room author clears the unread sign on open screens', async () => {
		const [reader, owner] = [await person(), await person()];
		const room = await roomOf(owner, reader);
		assert.strictEqual((await roomSay(owner, room.id)).status, 200);
		assert.strictEqual(await hasUnread(reader), true);

		const told = await waitFire(reader, 'main', async () => {
			assert.strictEqual((await api('admin/suspend-user', { userId: owner.id }, root)).status, 204);
		}, message => message.type === 'readAllChatMessages');

		assert.strictEqual(told, true);
		assert.strictEqual(await hasUnread(reader), false);
		assert.deepStrictEqual((await api('chat/history', { room: true }, reader)).body, []);
	});

	test('suspending one room author keeps unread content from another author', async () => {
		const [reader, owner, member] = [await person(), await person(), await person()];
		const room = await roomOf(owner, reader, member);
		assert.strictEqual((await roomSay(owner, room.id)).status, 200);
		assert.strictEqual((await roomSay(member, room.id)).status, 200);

		assert.strictEqual((await api('admin/suspend-user', { userId: owner.id }, root)).status, 204);

		assert.strictEqual(await hasUnread(reader), true);
		assert.deepStrictEqual((await api('chat/history', { room: true }, reader)).body.map(message => message.fromUserId), [member.id]);
	});

	test('room messages leave no unread marks for a member on another server', async () => {
		const [owner, reader, faraway] = [await person(), await person(), await person()];
		const room = await roomOf(owner, reader, faraway);
		// fixture: 참가자 한 명을 다른 서버 계정으로 바꾼다. 그 사람은 이 서버에서 쪽지를 읽지 않는다.
		await db.getRepository(MiUser).update(faraway.id, {
			host: 'remote.test',
			uri: `https://remote.test/users/${faraway.id}`,
			inbox: `https://remote.test/users/${faraway.id}/inbox`,
			sharedInbox: null,
		});
		for (let i = 0; i < 5; i++) assert.strictEqual((await roomSay(owner, room.id)).status, 200);

		const marks = async (account: Account) => ({
			conversation: await redis.sismember(`newChatMessagesExists:${account.id}`, `room:${room.id}`),
			latest: await redis.exists(`newRoomChatMessageExists:${account.id}:${room.id}`),
			messages: await redis.scard(`newRoomChatMessageExists:${account.id}:${room.id}:messages`),
		});
		const state = { reader: await marks(reader), faraway: await marks(faraway) };
		console.log('CHAT_REMOTE_READER_MARKS', JSON.stringify(state));
		assert.deepStrictEqual(state, {
			reader: { conversation: 1, latest: 1, messages: 5 },
			faraway: { conversation: 0, latest: 0, messages: 0 },
		});
	});

	test('physically deleting an owner clears owned rooms without clearing another conversation', async () => {
		const [owner, reader, otherReader, sender] = [await person(), await person(), await person(), await person()];
		const room = await roomOf(owner, reader, otherReader);
		assert.strictEqual((await roomSay(owner, room.id)).status, 200);
		assert.strictEqual((await say(sender, otherReader, 'Another conversation')).status, 200);

		const told = await waitFire(reader, 'main', async () => {
			assert.strictEqual((await api('admin/delete-account', { userId: owner.id }, root)).status, 204);
			await vi.waitFor(async () => {
				assert.strictEqual((await api('users/show', { userId: owner.id }, root)).status, 404);
			}, { timeout: 15_000, interval: 50 });
		}, message => message.type === 'readAllChatMessages');

		assert.strictEqual(told, true);
		assert.strictEqual(await hasUnread(reader), false);
		assert.strictEqual(await hasUnread(otherReader), true);
		assert.strictEqual((await api('chat/rooms/show', { roomId: room.id }, reader)).status, 400);
		assert.strictEqual(await redis.sismember(`newChatMessagesExists:${reader.id}`, `room:${room.id}`), 0);
	});

	test('physical account deletion removes its own unread markers', async () => {
		const [reader, sender, other] = [await person(), await person(), await person()];
		const room = await roomOf(sender, reader, other);
		assert.strictEqual((await say(sender, reader, 'Unread direct')).status, 200);
		assert.strictEqual((await roomSay(sender, room.id)).status, 200);
		const direct = `newUserChatMessageExists:${reader.id}:${sender.id}`;
		const roomKey = `newRoomChatMessageExists:${reader.id}:${room.id}`;
		assert.strictEqual(await redis.exists(direct, roomKey, `newChatMessagesExists:${reader.id}`), 3);
		assert.strictEqual((await api('admin/delete-account', { userId: reader.id }, root)).status, 204);
		await vi.waitFor(async () => {
			assert.strictEqual(await db.getRepository(MiUser).findOneBy({ id: reader.id }), null);
		}, { timeout: 15_000, interval: 50 });

		const keys = await redis.keys(`${redis.options.keyPrefix ?? ''}new*ChatMessage*:${reader.id}*`);
		console.log('CHAT_DELETED_READER_KEYS', JSON.stringify(keys.sort()));
		assert.deepStrictEqual(keys, []);
		assert.strictEqual(await hasUnread(other), true);
	});

	test('account deletion clears known orphan conversations without a keyspace scan', async () => {
		const [reader, sender] = [await person(), await person()];
		assert.strictEqual((await say(sender, reader, 'Old unread')).status, 200);
		const known = `newUserChatMessageExists:${reader.id}:${sender.id}`;
		const unknown = `newUserChatMessageExists:${reader.id}:unknown`;
		await redis.del(`newChatMessagesExists:${reader.id}`);
		await redis.set(unknown, 'old');
		assert.strictEqual((await api('admin/delete-account', { userId: reader.id }, root)).status, 204);
		await vi.waitFor(async () => assert.strictEqual(await db.getRepository(MiUser).findOneBy({ id: reader.id }), null), { timeout: 15_000, interval: 50 });
		assert.strictEqual(await redis.get(known), null);
		assert.strictEqual(await redis.get(unknown), 'old');
		await redis.del('chatLegacyUnreadCleanup:cursor');
		const service = queue.get(ChatService);
		let complete = false;
		for (let i = 0; i < 30 && !complete; i++) complete = await service.cleanupLegacyUnreadMarks();
		assert.strictEqual(complete, true);
		assert.strictEqual(await redis.get(unknown), null);
	});

	test('muting and withdrawing a legacy direct message preserves unread on unmute', async () => {
		const [reader, sender] = [await person(), await person()];
		await say(sender, reader, 'Remaining legacy content');
		const removed = (await say(sender, reader, 'Withdrawn legacy content')).body;
		const key = `newUserChatMessageExists:${reader.id}:${sender.id}`;
		await redis.del(`${key}:first`);
		assert.strictEqual((await api('mute/create', { userId: sender.id }, reader)).status, 204);

		assert.strictEqual((await api('chat/messages/delete', { messageId: removed.id }, sender)).status, 204);
		assert.strictEqual((await api('mute/delete', { userId: sender.id }, reader)).status, 204);

		assert.strictEqual(await hasUnread(reader), true);
		assert.notStrictEqual(await redis.get(key), null);
	});

	test('withdrawal never promotes room messages received during a mute', async () => {
		const [reader, sender] = [await person(), await person()];
		const room = await roomOf(reader, sender);
		const eligible = (await roomSay(sender, room.id)).body;
		assert.strictEqual((await api('chat/rooms/mute', { roomId: room.id, mute: true }, reader)).status, 204);
		await roomSay(sender, room.id);
		assert.strictEqual((await api('chat/rooms/mute', { roomId: room.id, mute: false }, reader)).status, 204);

		assert.strictEqual((await api('chat/messages/delete', { messageId: eligible.id }, sender)).status, 204);

		assert.strictEqual(await hasUnread(reader), false);
	});

	test('suspending the only unread room author ignores already read history', async () => {
		const [reader, owner, member] = [await person(), await person(), await person()];
		const room = await roomOf(owner, reader, member);
		await roomSay(owner, room.id);
		await api('chat/messages/room-timeline', { roomId: room.id }, reader);
		await roomSay(member, room.id);

		assert.strictEqual((await api('admin/suspend-user', { userId: member.id }, root)).status, 204);

		assert.strictEqual(await hasUnread(reader), false);
		assert.strictEqual(await redis.get(`newRoomChatMessageExists:${reader.id}:${room.id}`), null);
	});

	test('physically deleting an ordinary member clears only their unread room messages', async () => {
		const [reader, owner, member] = [await person(), await person(), await person()];
		const room = await roomOf(owner, reader, member);
		await roomSay(owner, room.id);
		await api('chat/messages/room-timeline', { roomId: room.id }, reader);
		await roomSay(member, room.id);

		assert.strictEqual((await api('admin/delete-account', { userId: member.id }, root)).status, 204);
		await vi.waitFor(async () => assert.strictEqual((await api('users/show', { userId: member.id }, root)).status, 404), { timeout: 20_000, interval: 100 });

		assert.strictEqual(await hasUnread(reader), false);
		assert.strictEqual(await redis.get(`newRoomChatMessageExists:${reader.id}:${room.id}`), null);
		assert.strictEqual((await api('chat/rooms/show', { roomId: room.id }, reader)).status, 200);
	});

	describe('a read covers what the reader was given', () => {
		const timeline = (reader: Account, sender: Account, params: Record<string, unknown>) => api('chat/messages/user-timeline', { userId: sender.id, ...params }, reader);
		const isRead = async (reader: Account, sender: Account) => (await api('chat/history', { room: false }, reader)).body.find(message => message.fromUserId === sender.id)?.isRead;

		test('an older page leaves a newer message unread', async () => {
			const [reader, sender] = [await person(), await person()];
			const older = (await say(sender, reader, 'Older')).body;
			const newer = (await say(sender, reader, 'Newer')).body;

			const page = await timeline(reader, sender, { untilId: newer.id, limit: 10 });

			assert.deepStrictEqual(page.body.map(message => message.id), [older.id]);
			assert.strictEqual(await hasUnread(reader), true);
			assert.strictEqual(await isRead(reader, sender), false);
			assert.strictEqual((await timeline(reader, sender, { limit: 10 })).status, 200);
			assert.strictEqual(await hasUnread(reader), false);
		});

		test('a page after a known message leaves what comes after the page unread', async () => {
			const [reader, sender] = [await person(), await person()];
			const known = (await say(sender, reader, 'Known')).body;
			const next = (await say(sender, reader, 'Next')).body;
			assert.strictEqual((await say(sender, reader, 'Beyond the page')).status, 200);

			const page = await timeline(reader, sender, { sinceId: known.id, limit: 1 });

			assert.deepStrictEqual(page.body.map(message => message.id), [next.id]);
			assert.strictEqual(await hasUnread(reader), true);
		});

		test('a read sent over the stream stops at the message the screen names', async () => {
			const [reader, sender] = [await person(), await person()];
			const shown = (await say(sender, reader, 'Shown')).body;
			assert.strictEqual((await say(sender, reader, 'Not shown yet')).status, 200);
			const stream = await connectStream(reader, 'chatUser', () => {}, { otherId: sender.id });

			try {
				stream.send(JSON.stringify({ type: 'ch', body: { id: 'a', type: 'read', body: { id: shown.id } } }));
				// 같은 연결의 다음 읽기는 앞의 읽기 뒤에 처리된다. 그 결과가 보일 때까지 기다린다.
				await vi.waitFor(async () => assert.strictEqual((await redis.smembers(`newUserChatMessageExists:${reader.id}:${sender.id}:messages`)).includes(shown.id), false));
			} finally {
				stream.close();
			}

			assert.strictEqual(await hasUnread(reader), true);
		});

		test('the reader’s own reply does not keep a mark from an older version on', async () => {
			const [reader, sender] = [await person(), await person()];
			const only = (await say(sender, reader, 'Only one')).body;
			const key = `newUserChatMessageExists:${reader.id}:${sender.id}`;
			// 이전 버전의 표식: 최신 ID와 집계 set만 있다.
			await redis.del(`${key}:first`, `${key}:revision`, `${key}:messages`, `${key}:pending`);
			assert.strictEqual((await say(reader, sender, 'A reply')).status, 200);

			assert.strictEqual((await api('chat/messages/delete', { messageId: only.id }, sender)).status, 204);

			assert.strictEqual(await hasUnread(reader), false);
		});
	});
});
