/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { loadConfig } from '@/config.js';
import { CoreModule } from '@/core/CoreModule.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { IdService } from '@/core/IdService.js';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { MiChatMessage, MiUser } from '@/models/_.js';
import { createPostgresDataSource } from '@/postgres.js';
import { api, initTestDb, signup } from '../utils.js';
import { chatUnreadMarkGate } from '../misc/chat-unread-mark-gate.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';

const config = loadConfig();
let db: DataSource;
let redis: Redis;

beforeAll(async () => {
	db = await initTestDb(true);
	redis = new Redis(config.redis);
	await signup({ username: 'root' });
});

afterAll(async () => {
	await waitForChatNotificationTurn();
	await redis.quit();
	await db.destroy();
}, 30_000);

/** An inbox worker with its own PostgreSQL and Redis connections. */
async function inboxWorker(redisPort?: number): Promise<TestingModule> {
	const dataSource = createPostgresDataSource({ ...config, db: { ...config.db, disableCache: true } });
	dataSource.setOptions({ synchronize: false, dropSchema: false, cache: false });
	await dataSource.initialize();
	const workerRedis = new Redis(redisPort == null ? config.redis : { ...config.redis, host: '127.0.0.1', port: redisPort });
	try {
		const app = await Test.createTestingModule({ imports: [GlobalModule, CoreModule] })
			.overrideProvider(DI.db).useValue(dataSource)
			.overrideProvider(DI.redis).useValue(workerRedis)
			.compile();
		await app.init();
		return app;
	} catch (error) {
		await workerRedis.quit();
		await dataSource.destroy();
		throw error;
	}
}

// 예전 talk 쪽지와 채팅 답장은 일반 Note 주소로 온다
test.each([
	['a chat message URI', 'chat/messages'],
	['an ordinary Note URI', 'notes'],
])('a delayed Create cannot store a message after its Delete has taken the expired URI lock (%s)', async (_, path) => {
	const reader = await signup();
	expect((await api('i/update', { chatScope: 'everyone' }, reader)).status).toBe(200);
	const gate = await chatUnreadMarkGate(config.redis.host, config.redis.port);
	let first: TestingModule | undefined;
	let second: TestingModule | undefined;
	let creating: Promise<string> | undefined;
	try {
		first = await inboxWorker(gate.port);
		second = await inboxWorker();
		const id = first.get(IdService).gen();
		const actorUri = `https://remote.test/users/${id}`;
		const uri = `https://remote.test/${path}/${id}`;
		await db.getRepository(MiUser).insert({ id, username: `actor${id}`, usernameLower: `actor${id}`, host: 'remote.test', uri: actorUri, inbox: 'https://remote.test/inbox' });
		const actor = await db.getRepository(MiUser).findOneByOrFail({ id });
		const inboxA = first.get(ApInboxService) as unknown as { createChatMessage: (...args: unknown[]) => Promise<string> };
		const inboxB = second.get(ApInboxService) as unknown as { delete: (...args: unknown[]) => Promise<string> };
		const object = { id: uri, type: 'Note', attributedTo: actorUri, to: [`${config.url}/users/${reader.id}`], content: 'Delayed remote message', _misskey_talk: true };
		gate.arm(reader.id);
		creating = inboxA.createChatMessage({}, actor, object, { type: 'Create', actor: actorUri });
		let createError: unknown;
		void creating.catch(error => { createError = error; });
		await vi.waitFor(() => {
			if (createError != null) throw createError;
			expect(gate.held).toBe(true);
		}, { timeout: 10_000 });
		const markKey = `newUserChatMessageExists:${reader.id}:${actor.id}`;
		expect(await redis.scard(`${markKey}:messages`)).toBe(1);
		const lockKey = `lock:ap-object:${uri}`;
		expect(await redis.pttl(lockKey)).toBeGreaterThan(0);
		await vi.waitFor(async () => expect(await redis.exists(lockKey)).toBe(0), { timeout: 35_000, interval: 100 });

		let deletionResult: string | undefined;
		let deletionError: unknown;
		const deleting = inboxB.delete(actor, { type: 'Delete', actor: actorUri, object: { id: uri, type: 'Tombstone', formerType: 'Note' } });
		void deleting.then(result => { deletionResult = result; }, error => { deletionError = error; });
		await vi.waitFor(async () => {
			if (deletionError != null) throw deletionError;
			const waiting = await db.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted") as unknown[];
			expect(deletionResult != null || waiting.length > 0).toBe(true);
		}, { timeout: 5000 });
		gate.release();
		const deletion = await deleting;
		const result = await creating;
		const stored = await db.getRepository(MiChatMessage).findOneBy({ uri });
		console.log('CHAT_AP_EXPIRED_LOCK', JSON.stringify({ deletion, result, stored: stored != null, deleted: stored?.deletedAt != null }));
		expect(['ok: chat message tombstone stored', 'ok: chat message deleted']).toContain(deletion);
		expect(stored == null || stored.deletedAt != null).toBe(true);
		expect(stored?.text ?? null).toBeNull();
		expect((await api('i', {}, reader)).body.hasUnreadChatMessages).toBe(false);
	} finally {
		gate.release();
		await creating?.catch(() => undefined);
		await waitForChatNotificationTurn();
		await first?.close();
		await second?.close();
		await gate.close();
	}
}, 120_000);
