/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, test } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import type * as misskey from 'cherrypick-js';
import type { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { ChatService } from '@/core/ChatService.js';
import { MiChatRoom, MiUser } from '@/models/_.js';
import { api, initTestDb, signup, startJobQueue } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';

type Account = misskey.entities.SignupResponse;

// OC5.4: 창·압축 Lua는 실제 Redis에서 검증한다. 메모리 대역은 스크립트 계약만 흉내 낸다.
// 압축 한도(1256)를 넘는 수신, 부분 읽음, 창 밖 미읽음, 뮤트 제외 구간, 모두 읽음을 실제 서버에서 확인한다.
describe('chat unread window on real Redis', () => {
	let root: Account;
	let queue: INestApplicationContext;
	let redis: Redis;
	let db: DataSource;
	let service: ChatService;
	let count = 0;

	const CAP = 1256;

	async function person() {
		const account = await signup({ username: `window${++count}` });
		assert.strictEqual((await api('i/update', { chatScope: 'everyone' }, account)).status, 200);
		return account;
	}

	const hasUnread = async (reader: Account) => (await api('i', {}, reader)).body.hasUnreadChatMessages;
	const userOf = (account: Account) => db.getRepository(MiUser).findOneByOrFail({ id: account.id });

	async function roomOf(owner: Account, ...members: Account[]) {
		const room = (await api('chat/rooms/create', { name: 'Window' }, owner)).body;
		for (const member of members) {
			assert.strictEqual((await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, owner)).status, 200);
			assert.strictEqual((await api('chat/rooms/join', { roomId: room.id }, member)).status, 204);
		}
		return room;
	}

	beforeAll(async () => {
		queue = await startJobQueue();
		root = await signup({ username: 'root' });
		redis = new Redis(loadConfig().redis);
		db = await initTestDb(true);
		service = queue.get(ChatService);
		assert.strictEqual((await api('i', {}, root)).body.isAdmin, true);
	}, 120_000);

	afterAll(async () => {
		await waitForChatNotificationTurn();
		await queue.close();
		await redis.quit();
		await db.destroy();
	}, 30_000);

	test('a long unread history compresses, and reads clear it down to the keys', async () => {
		const [reader, sender] = [await person(), await person()];
		const [readerEntity, senderEntity] = [await userOf(reader), await userOf(sender)];
		const ids: string[] = [];
		for (let i = 0; i < CAP + 44; i++) {
			ids.push((await service.createMessageToUser(senderEntity, readerEntity, { text: `bulk ${i}` })).id);
		}
		const key = `newUserChatMessageExists:${reader.id}:${sender.id}`;

		// 창은 유계이고, 넘친 ID는 압축 경계로 모인다. 첫 미읽음 ID는 창에 남는다.
		assert.ok(await redis.scard(`${key}:messages`) <= CAP);
		assert.strictEqual(await redis.get(`${key}:first`), ids[0]);
		assert.strictEqual(await redis.get(`${key}:trimmed`), ids[257]);
		assert.strictEqual(await redis.sismember(`${key}:messages`, ids[0]), 1);
		assert.strictEqual(await redis.sismember(`${key}:messages`, ids[257]), 0);
		assert.strictEqual(await hasUnread(reader), true);

		// 압축 구간 안으로 올라간 부분 읽음: 읽음 경계 하한이 함께 올라간다.
		await service.readUserChatMessage(reader.id, sender.id, { seenIds: [], upTo: ids[100] });
		assert.strictEqual(await redis.get(`${key}:first`), ids[100]);
		assert.strictEqual(await redis.get(`${key}:readbound`), ids[100]);
		assert.strictEqual(await redis.get(`${key}:trimmed`), ids[257]);
		assert.strictEqual(await hasUnread(reader), true);

		// 압축 경계를 덮는 읽음은 경계와 하한을 거두고, 남은 창도 모두 읽는다.
		await service.readUserChatMessage(reader.id, sender.id, { seenIds: [], upTo: ids[CAP + 43] });
		assert.strictEqual(await hasUnread(reader), false);
		for (const suffix of ['', ':first', ':revision', ':messages', ':pending', ':trimmed', ':excluded', ':readbound']) {
			assert.strictEqual(await redis.exists(`${key}${suffix}`), 0, `key ${key}${suffix} should be gone`);
		}
		assert.strictEqual(await redis.sismember(`newChatMessagesExists:${reader.id}`, `user:${sender.id}`), 0);

		// 모두 읽음 뒤의 새 쪽지는 다시 미읽음이 된다.
		assert.strictEqual((await api('chat/messages/create-to-user', { toUserId: reader.id, text: 'after read-all' }, sender)).status, 200);
		assert.strictEqual(await hasUnread(reader), true);
		assert.strictEqual((await api('chat/read-all', {}, reader)).status, 204);
		assert.strictEqual(await hasUnread(reader), false);
	}, 240_000);

	test('an active legacy mark stays bounded and keeps its unknown boundary until read-all', async () => {
		const [reader, sender] = [await person(), await person()];
		const [readerEntity, senderEntity] = [await userOf(reader), await userOf(sender)];
		await service.createMessageToUser(senderEntity, readerEntity, { text: 'before upgrade' });
		const key = `newUserChatMessageExists:${reader.id}:${sender.id}`;
		// 이전 형식에는 첫 미읽음 위치가 없다.
		await redis.del(`${key}:first`);
		for (let i = 0; i < CAP + 44; i++) {
			await service.createMessageToUser(senderEntity, readerEntity, { text: `legacy bulk ${i}` });
		}

		assert.ok(await redis.scard(`${key}:messages`) <= CAP);
		assert.strictEqual(await redis.get(`${key}:first`), null);
		assert.notStrictEqual(await redis.get(`${key}:trimmed`), null);
		assert.strictEqual(await hasUnread(reader), true);

		// 경계 없는 읽음은 레거시의 알 수 없는 읽음 경계를 만들어 내지 않는다.
		await service.readUserChatMessage(reader.id, sender.id, { seenIds: [], upTo: null });
		assert.strictEqual(await redis.get(`${key}:first`), null);
		assert.strictEqual(await hasUnread(reader), true);

		assert.strictEqual((await api('chat/read-all', {}, reader)).status, 204);
		assert.strictEqual(await hasUnread(reader), false);
		assert.strictEqual(await redis.exists(key), 0);
	}, 240_000);

	test('out-of-window unread survives compression, and a muted interval is never promoted', async () => {
		const [owner, member, third] = [await person(), await person(), await person()];
		const room = await roomOf(owner, member, third);
		const roomEntity = await db.getRepository(MiChatRoom).findOneByOrFail({ id: room.id });
		const [memberEntity, thirdEntity] = [await userOf(member), await userOf(third)];
		const key = `newRoomChatMessageExists:${owner.id}:${room.id}`;

		// 뮤트 구간이 나중에 압축될 영역 안에 끼도록, 뮤트 앞뒤로 이력을 만든다.
		const early: string[] = [];
		for (let i = 0; i < 10; i++) early.push((await service.createMessageToRoom(thirdEntity, roomEntity, { text: `before ${i}` })).id);
		assert.strictEqual((await api('chat/rooms/mute', { roomId: room.id, mute: true }, owner)).status, 204);
		const muted: string[] = [];
		for (let i = 0; i < 5; i++) muted.push((await service.createMessageToRoom(thirdEntity, roomEntity, { text: `muted ${i}` })).id);
		assert.strictEqual((await api('chat/rooms/mute', { roomId: room.id, mute: false }, owner)).status, 204);
		for (let i = 0; i < 40; i++) early.push((await service.createMessageToRoom(thirdEntity, roomEntity, { text: `after ${i}` })).id);
		for (let i = 0; i < CAP + 44; i++) {
			await service.createMessageToRoom(memberEntity, roomEntity, { text: `bulk ${i}` });
		}

		assert.deepStrictEqual(await redis.lrange(`${key}:excluded`, 0, -1), [`${early[9]}|${muted[4]}`]);
		assert.ok(await redis.scard(`${key}:messages`) <= CAP);
		assert.strictEqual(await hasUnread(owner), true);

		// 부분 읽음 뒤 창 밖 미읽음: 창의 저자를 정지해도 압축 구간의 다른 저자 쪽지가 미읽음을 유지한다.
		await service.readRoomChatMessage(owner.id, room.id, { seenIds: [], upTo: early[25] });
		assert.strictEqual(await redis.get(`${key}:first`), early[25]);
		assert.strictEqual(await redis.get(`${key}:readbound`), early[25]);
		assert.strictEqual((await api('admin/suspend-user', { userId: member.id }, root)).status, 204);
		assert.strictEqual(await hasUnread(owner), true);

		// 남은 저자도 정지하면 압축 구간에는 뮤트 중 쪽지만 남는다. 미읽음으로 승격하지 않는다.
		assert.strictEqual((await api('admin/suspend-user', { userId: third.id }, root)).status, 204);
		assert.strictEqual(await hasUnread(owner), false);

		assert.strictEqual((await api('chat/read-all', {}, owner)).status, 204);
		assert.strictEqual(await hasUnread(owner), false);
		for (const suffix of ['', ':first', ':revision', ':messages', ':pending', ':trimmed', ':excluded', ':readbound']) {
			assert.strictEqual(await redis.exists(`${key}${suffix}`), 0, `key ${key}${suffix} should be gone`);
		}
	}, 240_000);
});
