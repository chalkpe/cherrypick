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

// 검토 지적 재현: 같은 뮤트 요청의 중복 구간(Sol2), 구간 목록의 무상한 누적(Sol3/OC5.3), 토글-토글 경합(OC5.2).
// 구간 기록의 상태 전이(열기·닫기·중복 요청·빈 구간·합치기·하한 아래 제거·상한 초과)를 실제 Redis에서 확인한다.
describe('chat room mute intervals on real Redis', () => {
	let root: Account;
	let queue: INestApplicationContext;
	let redis: Redis;
	let db: DataSource;
	let service: ChatService;
	let count = 0;

	const CAP = 1256;
	// 구간 목록의 고정 상한. 초과분은 뮤트 중 쪽지를 승격시키지 않는 보수적 덮개 하나로 모은다.
	const INTERVAL_CAP = 64;

	async function person() {
		const account = await signup({ username: `muteiv${++count}` });
		assert.strictEqual((await api('i/update', { chatScope: 'everyone' }, account)).status, 200);
		return account;
	}

	const hasUnread = async (reader: Account) => (await api('i', {}, reader)).body.hasUnreadChatMessages;
	const userOf = (account: Account) => db.getRepository(MiUser).findOneByOrFail({ id: account.id });
	const excludedKey = (reader: Account, room: { id: string }) => `newRoomChatMessageExists:${reader.id}:${room.id}:excluded`;
	const intervals = (reader: Account, room: { id: string }) => redis.lrange(excludedKey(reader, room), 0, -1);
	const openIntervals = (list: string[]) => list.filter(interval => interval.endsWith('|'));

	async function roomOf(owner: Account, ...members: Account[]) {
		const room = (await api('chat/rooms/create', { name: 'Mute intervals' }, owner)).body;
		for (const member of members) {
			assert.strictEqual((await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, owner)).status, 200);
			assert.strictEqual((await api('chat/rooms/join', { roomId: room.id }, member)).status, 204);
		}
		return room;
	}

	const mute = (room: { id: string }, value: boolean, reader: Account) => api('chat/rooms/mute', { roomId: room.id, mute: value }, reader);

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

	test('repeated mute requests leave no open interval, and the genuine unread survives compression', async () => {
		const [owner, early, bulk, window] = [await person(), await person(), await person(), await person()];
		const room = await roomOf(owner, early, bulk, window);
		const roomEntity = await db.getRepository(MiChatRoom).findOneByOrFail({ id: room.id });
		const [earlyEntity, bulkEntity, windowEntity] = [await userOf(early), await userOf(bulk), await userOf(window)];
		const key = excludedKey(owner, room);

		// 응답 유실 뒤 재전송이나 두 탭처럼 같은 뮤트 요청이 두 번 온다.
		const first = (await service.createMessageToRoom(earlyEntity, roomEntity, { text: 'first' })).id;
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		assert.deepStrictEqual(await intervals(owner, room), [`${first}|`]);

		// 한 번의 해제 뒤에는 열린 구간이 없어야 한다.
		assert.strictEqual((await mute(room, false, owner)).status, 204);
		assert.deepStrictEqual(openIntervals(await intervals(owner, room)), []);

		// 해제 뒤 받은 쪽지가 압축될 만큼 쌓인다. 압축 구간의 진짜 미읽음은 bulk 작성자의 쪽지다.
		for (let i = 0; i < 257; i++) await service.createMessageToRoom(bulkEntity, roomEntity, { text: `bulk ${i}` });
		for (let i = 0; i < CAP + 44 - 257; i++) await service.createMessageToRoom(windowEntity, roomEntity, { text: `window ${i}` });
		assert.ok(await redis.scard(`newRoomChatMessageExists:${owner.id}:${room.id}:messages`) <= CAP);
		assert.notStrictEqual(await redis.get(`newRoomChatMessageExists:${owner.id}:${room.id}:trimmed`), null);

		// 첫 쪽지를 철회하고 창 쪽지 작성자를 정지하면, 압축 구간의 진짜 미읽음만 남는다.
		assert.strictEqual((await api('chat/messages/delete', { messageId: first }, early)).status, 204);
		assert.strictEqual((await api('admin/suspend-user', { userId: window.id }, root)).status, 204);
		assert.strictEqual(await hasUnread(owner), true);

		assert.strictEqual((await api('chat/read-all', {}, owner)).status, 204);
		assert.strictEqual(await hasUnread(owner), false);
		assert.strictEqual(await redis.exists(key), 0);
	}, 240_000);

	test('a duplicate-mute cycle does not erase the genuine unread after compression', async () => {
		const [owner, early, bulk, window] = [await person(), await person(), await person(), await person()];
		const room = await roomOf(owner, early, bulk, window);
		const roomEntity = await db.getRepository(MiChatRoom).findOneByOrFail({ id: room.id });
		const [earlyEntity, bulkEntity, windowEntity] = [await userOf(early), await userOf(bulk), await userOf(window)];

		const first = (await service.createMessageToRoom(earlyEntity, roomEntity, { text: 'first' })).id;
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		assert.strictEqual((await mute(room, false, owner)).status, 204);

		for (let i = 0; i < 257; i++) await service.createMessageToRoom(bulkEntity, roomEntity, { text: `bulk ${i}` });
		for (let i = 0; i < CAP + 44 - 257; i++) await service.createMessageToRoom(windowEntity, roomEntity, { text: `window ${i}` });
		assert.notStrictEqual(await redis.get(`newRoomChatMessageExists:${owner.id}:${room.id}:trimmed`), null);

		assert.strictEqual((await api('chat/messages/delete', { messageId: first }, early)).status, 204);
		assert.strictEqual((await api('admin/suspend-user', { userId: window.id }, root)).status, 204);
		// 수정 전에는 중복 뮤트가 남긴 열린 구간이 압축 폴백의 상한을 첫 쪽지까지 내려 진짜 미읽음을 잃는다.
		assert.strictEqual(await hasUnread(owner), true);

		assert.strictEqual((await api('chat/read-all', {}, owner)).status, 204);
		assert.strictEqual(await hasUnread(owner), false);
	}, 240_000);

	test('a mute cycle with no messages in between stores no empty interval', async () => {
		const [owner, author] = [await person(), await person()];
		const room = await roomOf(owner, author);
		const roomEntity = await db.getRepository(MiChatRoom).findOneByOrFail({ id: room.id });
		const authorEntity = await userOf(author);

		const only = (await service.createMessageToRoom(authorEntity, roomEntity, { text: 'only' })).id;
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		assert.strictEqual((await mute(room, false, owner)).status, 204);
		assert.deepStrictEqual(await intervals(owner, room), []);

		// 같은 상태 요청이 반복되어도 구간은 늘지 않는다.
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		assert.deepStrictEqual(await intervals(owner, room), [`${only}|`]);
		assert.strictEqual((await mute(room, false, owner)).status, 204);
		assert.deepStrictEqual(await intervals(owner, room), []);
	}, 120_000);

	test('back-to-back mute cycles merge into one interval', async () => {
		const [owner, author] = [await person(), await person()];
		const room = await roomOf(owner, author);
		const roomEntity = await db.getRepository(MiChatRoom).findOneByOrFail({ id: room.id });
		const authorEntity = await userOf(author);

		const first = (await service.createMessageToRoom(authorEntity, roomEntity, { text: 'first' })).id;
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		await service.createMessageToRoom(authorEntity, roomEntity, { text: 'muted' });
		assert.strictEqual((await mute(room, false, owner)).status, 204);
		// 해제 직후 다시 뮤트: 앞 구간과 이어지는 구간이 생긴다.
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		const last = (await service.createMessageToRoom(authorEntity, roomEntity, { text: 'muted again' })).id;
		assert.strictEqual((await mute(room, false, owner)).status, 204);

		assert.deepStrictEqual(await intervals(owner, room), [`${first}|${last}`]);
	}, 120_000);

	test('overlapping intervals merge, and a leftover open interval closes on unmute', async () => {
		const [owner, author] = [await person(), await person()];
		const room = await roomOf(owner, author);
		const roomEntity = await db.getRepository(MiChatRoom).findOneByOrFail({ id: room.id });
		const authorEntity = await userOf(author);
		const key = excludedKey(owner, room);

		const ids: string[] = [];
		for (let i = 0; i < 5; i++) ids.push((await service.createMessageToRoom(authorEntity, roomEntity, { text: `m ${i}` })).id);

		// fixture: 이전 빌드가 남긴 겹치는 구간. 다음 토글이 실제 제품 경로에서 정리한다.
		await redis.rpush(key, `${ids[0]}|${ids[2]}`, `${ids[1]}|${ids[3]}`);
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		// 겹치는 구간은 합쳐지고, 뮤트 직전 쪽지(ids4)는 진짜 미읽음이라 새 열린 구간과 별개다.
		assert.deepStrictEqual(await intervals(owner, room), [`${ids[0]}|${ids[3]}`, `${ids[4]}|`]);
		const extra = (await service.createMessageToRoom(authorEntity, roomEntity, { text: 'extra' })).id;
		assert.strictEqual((await mute(room, false, owner)).status, 204);
		assert.deepStrictEqual(await intervals(owner, room), [`${ids[0]}|${ids[3]}`, `${ids[4]}|${extra}`]);

		// fixture: 토글 경합이 남긴 잔여 열린 구간(마지막이 아닌 위치). 해제가 모두 닫아야 한다.
		await redis.del(key);
		await redis.rpush(key, `${ids[0]}|`, `${ids[1]}|${ids[2]}`);
		assert.strictEqual((await mute(room, false, owner)).status, 204);
		assert.deepStrictEqual(await intervals(owner, room), [`${ids[0]}|${extra}`]);
	}, 120_000);

	test('intervals below the read boundary are pruned on the next toggle', async () => {
		const [owner, author] = [await person(), await person()];
		const room = await roomOf(owner, author);
		const roomEntity = await db.getRepository(MiChatRoom).findOneByOrFail({ id: room.id });
		const authorEntity = await userOf(author);
		const key = excludedKey(owner, room);
		const base = `newRoomChatMessageExists:${owner.id}:${room.id}`;

		const ids: string[] = [];
		for (let i = 0; i < 10; i++) ids.push((await service.createMessageToRoom(authorEntity, roomEntity, { text: `early ${i}` })).id);
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		const muted: string[] = [];
		for (let i = 0; i < 2; i++) muted.push((await service.createMessageToRoom(authorEntity, roomEntity, { text: `muted ${i}` })).id);
		assert.strictEqual((await mute(room, false, owner)).status, 204);
		assert.deepStrictEqual(await intervals(owner, room), [`${ids[9]}|${muted[1]}`]);

		// 압축이 생긴 뒤 부분 읽음: 읽음 경계가 구간 끝까지 올라간다. 표식은 유지된다.
		for (let i = 0; i < CAP + 150; i++) await service.createMessageToRoom(authorEntity, roomEntity, { text: `bulk ${i}` });
		await service.readRoomChatMessage(owner.id, room.id, { seenIds: [], upTo: muted[1] });
		assert.strictEqual(await redis.get(`${base}:readbound`), muted[1]);
		assert.notStrictEqual(await redis.get(`${base}:trimmed`), null);

		const latest = (await service.createMessageToRoom(authorEntity, roomEntity, { text: 'latest' })).id;
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		assert.deepStrictEqual(await intervals(owner, room), [`${latest}|`]);
		assert.strictEqual((await mute(room, false, owner)).status, 204);
		assert.deepStrictEqual(await intervals(owner, room), []);

		// fixture: 읽음 경계 아래에서 시작된 열린 구간. 시작을 하한으로 올린다.
		await redis.rpush(key, `${ids[0]}|`);
		assert.strictEqual((await mute(room, true, owner)).status, 204);
		assert.deepStrictEqual(await intervals(owner, room), [`${muted[1]}|`]);
		assert.strictEqual((await mute(room, false, owner)).status, 204);
		assert.deepStrictEqual(await intervals(owner, room), [`${muted[1]}|${latest}`]);
	}, 240_000);

	test('the excluded list stays within the fixed cap after many toggles', async () => {
		const [owner, author] = [await person(), await person()];
		const room = await roomOf(owner, author);
		const roomEntity = await db.getRepository(MiChatRoom).findOneByOrFail({ id: room.id });
		const authorEntity = await userOf(author);

		// 뮤트 중 쪽지와 해제 뒤 쪽지가 교대로 쌓이면 서로 떨어지는 구간이 매 사이클 생긴다.
		// 엔드포인트 제한(100회/시간)을 피하려 서비스 경로로 토글한다. 기록 경로는 동일하다.
		await service.createMessageToRoom(authorEntity, roomEntity, { text: 'gap 0' });
		for (let i = 1; i <= INTERVAL_CAP + 6; i++) {
			await service.muteRoom(owner.id, room.id, true);
			await service.createMessageToRoom(authorEntity, roomEntity, { text: `muted ${i}` });
			await service.muteRoom(owner.id, room.id, false);
			await service.createMessageToRoom(authorEntity, roomEntity, { text: `gap ${i}` });
		}

		const list = await intervals(owner, room);
		assert.ok(list.length <= INTERVAL_CAP, `interval list length ${list.length} exceeds ${INTERVAL_CAP}`);
		assert.deepStrictEqual(openIntervals(list), []);
		// 해제 뒤 받은 쪽지는 창에서 개별 판정되므로 미읽음을 유지한다.
		assert.strictEqual(await hasUnread(owner), true);
		assert.strictEqual((await api('chat/read-all', {}, owner)).status, 204);
	}, 240_000);

	test('an over-cap list collapses to one conservative covering interval', async () => {
		const [owner, author] = [await person(), await person()];
		const room = await roomOf(owner, author);
		const key = excludedKey(owner, room);

		// fixture: 상한을 크게 넘는 떨어지는 구간 목록. 다음 토글이 보수적 덮개 하나로 모은다.
		const seeded: string[] = [];
		for (let i = 0; i < 300; i++) {
			const start = `s${String(2 * i + 1).padStart(4, '0')}`;
			const end = `s${String(2 * i + 2).padStart(4, '0')}`;
			seeded.push(`${start}|${end}`);
		}
		await redis.rpush(key, ...seeded);
		assert.strictEqual((await mute(room, false, owner)).status, 204);

		assert.deepStrictEqual(await intervals(owner, room), ['s0001|s0600']);
	}, 120_000);

	test('concurrent toggles never leave an orphan open interval', async () => {
		const [owner, author] = [await person(), await person()];
		const room = await roomOf(owner, author);
		const roomEntity = await db.getRepository(MiChatRoom).findOneByOrFail({ id: room.id });
		const authorEntity = await userOf(author);
		await service.createMessageToRoom(authorEntity, roomEntity, { text: 'seed' });

		let violations = 0;
		const check = async () => {
			const list = await intervals(owner, room);
			const opens = openIntervals(list);
			// 열린 구간은 최대 하나, 항상 마지막이어야 한다. 마지막이 아닌 열린 구간은 닫히지 않고 남는다.
			if (opens.length > 1 || (opens.length === 1 && !list[list.length - 1].endsWith('|'))) violations++;
		};

		// 같은 상태 요청이 동시에 오면 열린 구간이 둘 생기면 안 된다.
		for (let i = 0; i < 5; i++) {
			await Promise.all([mute(room, true, owner), mute(room, true, owner)]);
			await check();
		}
		// 서로 다른 토글이 동시에 끼어도 읽기-쓰기 사이에 다른 토글이 끼지 못한다.
		for (let i = 0; i < 40; i++) {
			await Promise.all(i % 2 === 0 ? [mute(room, true, owner), mute(room, false, owner)] : [mute(room, false, owner), mute(room, true, owner)]);
			await check();
		}
		// HTTP 없이 서비스 경로에서도 같은 불변식을 확인한다.
		for (let i = 0; i < 200; i++) {
			await Promise.all(i % 2 === 0
				? [service.muteRoom(owner.id, room.id, true), service.muteRoom(owner.id, room.id, false)]
				: [service.muteRoom(owner.id, room.id, false), service.muteRoom(owner.id, room.id, true)]);
			await check();
		}
		assert.strictEqual(violations, 0, `orphan open intervals observed in ${violations} rounds`);

		assert.strictEqual((await mute(room, false, owner)).status, 204);
		assert.deepStrictEqual(openIntervals(await intervals(owner, room)), []);
	}, 240_000);
});