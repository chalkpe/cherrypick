/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { fork } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdirSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Bull from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { loadConfig, path as configPath } from '@/config.js';
import { MiChatRoom, MiUser, MiUserKeypair } from '@/models/_.js';
import { QUEUE, baseQueueOptions } from '@/queue/const.js';
import type { DbUserDeleteJobData, DeliverJobData } from '@/queue/types.js';
import { api, initTestDb, signup } from '../utils.js';
import type { ChatQueueProcessMessage } from '../misc/chat-queue-process-fixture.js';

const config = loadConfig();
let db: DataSource;
let redis: Redis;
let dbQueue: Bull.Queue<DbUserDeleteJobData>;
let deliverQueue: Bull.Queue<DeliverJobData>;

beforeAll(async () => {
	db = await initTestDb(true);
	redis = new Redis(config.redisForJobQueue);
	dbQueue = new Bull.Queue(QUEUE.DB, baseQueueOptions(config, QUEUE.DB));
	deliverQueue = new Bull.Queue(QUEUE.DELIVER, baseQueueOptions(config, QUEUE.DELIVER));
	await signup({ username: 'root' });
});

afterAll(async () => {
	await redis.config('SET', 'maxmemory', '0');
	await redis.quit();
	await dbQueue.close();
	await deliverQueue.close();
	await db.destroy();
});

test('account deletion retries a room Delete that could not be queued and preserves its signing key', async () => {
	const owner = await signup();
	const member = await signup();
	expect((await api('i/update', { chatScope: 'everyone' }, member)).status).toBe(200);
	const room = (await api('chat/rooms/create', { name: 'Owner leaving' }, owner)).body;
	expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, owner)).status).toBe(200);
	expect((await api('chat/rooms/join', { roomId: room.id }, member)).status).toBe(204);
	const inbox = `https://remote.test/users/${member.id}/inbox`;
	await db.getRepository(MiUser).update(member.id, { host: 'remote.test', uri: `https://remote.test/users/${member.id}`, inbox, sharedInbox: null });
	await deliverQueue.pause();
	const blocker = db.createQueryRunner();
	let child: ReturnType<typeof fork> | undefined;
	let exited: Promise<unknown[]> | undefined;
	try {
		expect((await api('i/delete-account', { password: 'test' }, owner)).status).toBe(204);
		const deletion = await vi.waitFor(async () => {
			const job = (await dbQueue.getJobs(['wait', 'delayed', 'prioritized'])).find(item => item.name === 'deleteAccount' && item.data.user.id === owner.id);
			expect(job).toBeDefined();
			return job!;
		}, { timeout: 10_000 });
		await blocker.connect();
		await blocker.startTransaction();
		await blocker.query('LOCK TABLE "chat_room" IN ACCESS EXCLUSIVE MODE');
		const evidenceRoot = process.env.CHAT_PROCESS_EVIDENCE_DIR ?? tmpdir();
		mkdirSync(evidenceRoot, { recursive: true });
		const evidenceDir = mkdtempSync(join(evidenceRoot, 'chat-delete-worker-'));
		const stdout = openSync(join(evidenceDir, 'stdout.log'), 'wx');
		const stderr = openSync(join(evidenceDir, 'stderr.log'), 'wx');
		child = fork(new URL('../../built-test/chat-queue-process-fixture.js', import.meta.url), [], {
			execArgv: ['--max-old-space-size=512'],
			stdio: ['ignore', stdout, stderr, 'ipc'],
			env: { ...process.env, NODE_ENV: 'production', CHERRYPICK_CONFIG_YML: configPath, CP_NO_DAEMONS: '1', CHAT_PROCESS_FIXTURE_DB: config.db.db },
		});
		closeSync(stdout);
		closeSync(stderr);
		exited = once(child, 'exit');
		const [message] = await Promise.race([
			once(child, 'message', { signal: AbortSignal.timeout(30_000) }),
			exited.then(([code, signal]) => { throw new Error(`worker exited before readiness: ${code}/${signal}, ${evidenceDir}`); }),
		]) as [ChatQueueProcessMessage];
		if (message.type === 'error') throw new Error(message.message);
		const blocked = await vi.waitFor(async () => {
			const rows = await db.query('SELECT "query" FROM "pg_stat_activity" WHERE "datname" = current_database() AND "wait_event_type" = $1 AND "query" LIKE $2', ['Lock', '%chat_room%']) as { query: string }[];
			expect(rows).toHaveLength(1);
			return rows[0].query;
		}, { timeout: 30_000, interval: 100 });
		const oomCount = async () => Number((await redis.info('errorstats')).match(/errorstat_OOM:count=(\d+)/)?.[1] ?? 0);
		const beforeOom = await oomCount();
		await redis.config('SET', 'maxmemory-policy', 'noeviction');
		await redis.config('SET', 'maxmemory', '1');
		await blocker.rollbackTransaction();
		await vi.waitFor(async () => expect(await oomCount()).toBeGreaterThan(beforeOom), { timeout: 10_000, interval: 50 });
		const afterOom = await oomCount();
		await redis.config('SET', 'maxmemory', '0');
		const finalState = await vi.waitFor(async () => {
			const state = await deletion.getState();
			expect(['completed', 'failed', 'delayed']).toContain(state);
			return state;
		}, { timeout: 15_000, interval: 100 });
		const present = {
			room: await db.getRepository(MiChatRoom).existsBy({ id: room.id }),
			account: await db.getRepository(MiUser).existsBy({ id: owner.id }),
			keypair: await db.getRepository(MiUserKeypair).existsBy({ userId: owner.id }),
		};
		const beforeRetry = (await deliverQueue.getJobs(['wait', 'active', 'delayed', 'prioritized', 'completed', 'failed']))
			.filter(job => job.data.user.id === owner.id && job.data.to === inbox && JSON.parse(job.data.content).type === 'Delete');
		console.log('CHAT_ACCOUNT_DELETE_QUEUE_FAILURE', JSON.stringify({ blocked, oomBefore: beforeOom, oomAfter: afterOom, jobState: finalState, present, deleteJobs: beforeRetry.length }));
		expect(present).toEqual({ room: true, account: true, keypair: true });
		const delivered = await vi.waitFor(async () => {
			const jobs = (await deliverQueue.getJobs(['wait', 'active', 'delayed', 'prioritized', 'completed', 'failed']))
				.filter(job => job.data.user.id === owner.id && job.data.to === inbox && JSON.parse(job.data.content).type === 'Delete');
			expect(jobs).toHaveLength(1);
			return jobs[0];
		}, { timeout: 90_000, interval: 250 });
		expect(await delivered.getState()).toBe('waiting');
		expect(await db.getRepository(MiUserKeypair).existsBy({ userId: owner.id })).toBe(true);
		const followUp = await vi.waitFor(async () => {
			const jobs = (await dbQueue.getJobs(['wait', 'delayed', 'prioritized'])).filter(job => job.name === 'deleteAccount' && job.data.user.id === owner.id && job.data.deliveries?.includes(delivered.id!));
			expect(jobs).toHaveLength(1);
			return jobs[0];
		}, { timeout: 10_000 });
		expect(followUp.data.deliveries).toContain(delivered.id);
	} finally {
		await redis.config('SET', 'maxmemory', '0');
		if (blocker.isTransactionActive) await blocker.rollbackTransaction();
		await blocker.release();
		if (child != null && child.exitCode == null && child.signalCode == null) {
			child.kill('SIGKILL');
			await exited;
		}
		await deliverQueue.resume();
	}
}, 180_000);
