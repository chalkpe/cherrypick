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
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { DataSource } from 'typeorm';
import { loadConfig, path as configPath } from '@/config.js';
import { MiChatRoom, MiChatRoomInvitation, MiChatRoomMembership, MiUser } from '@/models/_.js';
import { QUEUE, baseQueueOptions } from '@/queue/const.js';
import type { DeliverJobData } from '@/queue/types.js';
import { api, initTestDb, signup } from '../utils.js';
import type { ChatSendProcessMessage } from '../misc/chat-send-process-fixture.js';

const config = loadConfig();
let db: DataSource;
let queueRedis: Redis;
let deliverQueue: Bull.Queue<DeliverJobData>;

beforeAll(async () => {
	db = await initTestDb(true);
	queueRedis = new Redis(config.redisForJobQueue);
	deliverQueue = new Bull.Queue(QUEUE.DELIVER, baseQueueOptions(config, QUEUE.DELIVER));
	await signup({ username: 'root' });
});

afterAll(async () => {
	await queueRedis.config('SET', 'maxmemory', '0');
	await queueRedis.quit();
	await deliverQueue.close();
	await db.destroy();
});

test('a room remains available for retry when its Delete cannot be queued', async () => {
	const owner = await signup();
	const member = await signup();
	const invitee = await signup();
	for (const user of [member, invitee]) expect((await api('i/update', { chatScope: 'everyone' }, user)).status).toBe(200);
	const room = (await api('chat/rooms/create', { name: 'Queue failure' }, owner)).body;
	expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, owner)).status).toBe(200);
	expect((await api('chat/rooms/join', { roomId: room.id }, member)).status).toBe(204);
	expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: invitee.id }, owner)).status).toBe(200);
	const inboxes = [member, invitee].map(user => `https://remote.test/users/${user.id}/inbox`);
	for (const [index, user] of [member, invitee].entries()) {
		await db.getRepository(MiUser).update(user.id, { host: 'remote.test', uri: `https://remote.test/users/${user.id}`, inbox: inboxes[index], sharedInbox: null });
	}

	const evidenceRoot = process.env.CHAT_PROCESS_EVIDENCE_DIR ?? tmpdir();
	mkdirSync(evidenceRoot, { recursive: true });
	const evidenceDir = mkdtempSync(join(evidenceRoot, 'chat-delete-sender-'));
	const stdout = openSync(join(evidenceDir, 'stdout.log'), 'wx');
	const stderr = openSync(join(evidenceDir, 'stderr.log'), 'wx');
	const child = fork(new URL('../../built-test/chat-send-process-fixture.js', import.meta.url), [], {
		execArgv: ['--max-old-space-size=512'],
		stdio: ['ignore', stdout, stderr, 'ipc'],
		env: { ...process.env, NODE_ENV: 'production', CHERRYPICK_CONFIG_YML: configPath, CP_NO_DAEMONS: '1', CHAT_PROCESS_FIXTURE_DB: config.db.db },
	});
	closeSync(stdout);
	closeSync(stderr);
	const exited = once(child, 'exit');
	try {
		const [message] = await Promise.race([
			once(child, 'message', { signal: AbortSignal.timeout(30_000) }),
			exited.then(([code, signal]) => { throw new Error(`sender exited before readiness: ${code}/${signal}, ${evidenceDir}`); }),
		]) as [ChatSendProcessMessage];
		if (message.type === 'error') throw new Error(message.message);
		const oomCount = async () => Number((await queueRedis.info('errorstats')).match(/errorstat_OOM:count=(\d+)/)?.[1] ?? 0);
		const beforeOom = await oomCount();
		await queueRedis.config('SET', 'maxmemory-policy', 'noeviction');
		await queueRedis.config('SET', 'maxmemory', '1');
		const response = await fetch(`http://127.0.0.1:${message.port}/api/chat/rooms/delete`, {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ i: owner.token, roomId: room.id }), signal: AbortSignal.timeout(15_000),
		});
		const afterOom = await oomCount();
		await queueRedis.config('SET', 'maxmemory', '0');
		const state = {
			room: await db.getRepository(MiChatRoom).existsBy({ id: room.id }),
			member: await db.getRepository(MiChatRoomMembership).existsBy({ roomId: room.id, userId: member.id }),
			invitee: await db.getRepository(MiChatRoomInvitation).existsBy({ roomId: room.id, userId: invitee.id }),
		};
		const jobs = (await deliverQueue.getJobs(['wait', 'active', 'delayed', 'prioritized', 'completed', 'failed']))
			.filter(job => job.data.user.id === owner.id && inboxes.includes(job.data.to) && JSON.parse(job.data.content).type === 'Delete');
		const retry = await api('chat/rooms/delete', { roomId: room.id }, owner);
		console.log('CHAT_DELETE_QUEUE_FAILURE', JSON.stringify({ status: response.status, oomBefore: beforeOom, oomAfter: afterOom, state, deleteJobs: jobs.length, retryStatus: retry.status, retryBody: retry.status === 204 ? undefined : retry.body }));
		expect(afterOom).toBeGreaterThan(beforeOom);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(state).toEqual({ room: true, member: true, invitee: true });
		expect(jobs).toHaveLength(0);
		expect(retry.status).toBe(204);
		const retried = (await deliverQueue.getJobs(['wait', 'active', 'delayed', 'prioritized', 'completed', 'failed']))
			.filter(job => job.data.user.id === owner.id && inboxes.includes(job.data.to) && JSON.parse(job.data.content).type === 'Delete');
		expect(retried.map(job => job.data.to).sort()).toEqual(inboxes.sort());
	} finally {
		await queueRedis.config('SET', 'maxmemory', '0');
		if (child.exitCode == null && child.signalCode == null) {
			child.kill('SIGKILL');
			await exited;
		}
	}
}, 120_000);
