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
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { loadConfig, path as configPath } from '@/config.js';
import { MiChatRoom, MiUser, MiUserKeypair } from '@/models/_.js';
import { QUEUE, baseQueueOptions } from '@/queue/const.js';
import type { DbUserDeleteJobData, DeliverJobData } from '@/queue/types.js';
import { api, initTestDb, signup } from '../utils.js';
import type { ChatSendProcessMessage } from '../misc/chat-send-process-fixture.js';
import type { ChatQueueProcessMessage } from '../misc/chat-queue-process-fixture.js';

const config = loadConfig();
const replica = process.env.CHAT_E2E_REPLICA;

describe.skipIf(replica == null)('room Delete recipients with a read replica', () => {
	let db: DataSource;
	let standby: pg.Client;
	let deliverQueue: Bull.Queue<DeliverJobData>;
	let dbQueue: Bull.Queue<DbUserDeleteJobData>;

	beforeAll(async () => {
		db = await initTestDb(true);
		const [host, port] = replica!.split(':');
		standby = new pg.Client({ host, port: Number(port), user: config.db.user, password: config.db.pass, database: config.db.db });
		await standby.connect();
		deliverQueue = new Bull.Queue(QUEUE.DELIVER, baseQueueOptions(config, QUEUE.DELIVER));
		dbQueue = new Bull.Queue(QUEUE.DB, baseQueueOptions(config, QUEUE.DB));
		await signup({ username: 'root' });
	});

	afterAll(async () => {
		await standby.query('SELECT pg_wal_replay_resume()');
		await standby.end();
		await deliverQueue.close();
		await dbQueue.close();
		await db.destroy();
	});

	async function caughtUp() {
		const [{ lsn }] = await db.query('SELECT pg_current_wal_insert_lsn() AS "lsn"') as [{ lsn: string }];
		await vi.waitFor(async () => {
			const { rows: [{ replayed }] } = await standby.query('SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS "replayed"', [lsn]);
			expect(replayed).toBe(true);
		}, { timeout: 10_000 });
	}

	test('deletion reaches an invitee that the replica has not replayed', async () => {
		const owner = await signup();
		const invitee = await signup();
		expect((await api('i/update', { chatScope: 'everyone' }, invitee)).status).toBe(200);
		const room = (await api('chat/rooms/create', { name: 'Replica delay' }, owner)).body;
		const inbox = `https://remote.test/users/${invitee.id}/inbox`;
		await db.getRepository(MiUser).update(invitee.id, { host: 'remote.test', uri: `https://remote.test/users/${invitee.id}`, inbox, sharedInbox: null });
		await caughtUp();
		const evidenceRoot = process.env.CHAT_PROCESS_EVIDENCE_DIR ?? tmpdir();
		mkdirSync(evidenceRoot, { recursive: true });
		const evidenceDir = mkdtempSync(join(evidenceRoot, 'chat-delete-replica-'));
		const stdout = openSync(join(evidenceDir, 'stdout.log'), 'wx');
		const stderr = openSync(join(evidenceDir, 'stderr.log'), 'wx');
		const child = fork(new URL('../../built-test/chat-send-process-fixture.js', import.meta.url), [], {
			execArgv: ['--max-old-space-size=512'],
			stdio: ['ignore', stdout, stderr, 'ipc'],
			env: { ...process.env, NODE_ENV: 'production', CHERRYPICK_CONFIG_YML: configPath, CP_NO_DAEMONS: '1', CHAT_PROCESS_FIXTURE_DB: config.db.db, CHAT_PROCESS_FIXTURE_REPLICA: replica },
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
			await caughtUp();
			await standby.query('SELECT pg_wal_replay_pause()');
			await vi.waitFor(async () => {
				const { rows: [{ state }] } = await standby.query('SELECT pg_get_wal_replay_pause_state() AS "state"');
				expect(state).toBe('paused');
			}, { timeout: 5000 });
			expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: invitee.id }, owner)).status).toBe(200);
			const primary = (await db.query('SELECT 1 FROM "chat_room_invitation" WHERE "roomId" = $1 AND "userId" = $2', [room.id, invitee.id]) as unknown[]).length;
			const standbyRows = (await standby.query('SELECT 1 FROM "chat_room_invitation" WHERE "roomId" = $1 AND "userId" = $2', [room.id, invitee.id])).rowCount;
			const response = await fetch(`http://127.0.0.1:${message.port}/api/chat/rooms/delete`, {
				method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ i: owner.token, roomId: room.id }), signal: AbortSignal.timeout(15_000),
			});
			const jobs = (await deliverQueue.getJobs(['wait', 'active', 'delayed', 'prioritized', 'completed', 'failed']))
				.filter(job => job.data.user.id === owner.id && job.data.to === inbox && JSON.parse(job.data.content).type === 'Delete');
			console.log('CHAT_DELETE_REPLICA', JSON.stringify({ primary, standby: standbyRows, status: response.status, deleteJobs: jobs.length }));
			expect(primary).toBe(1);
			expect(standbyRows).toBe(0);
			expect(response.status).toBe(204);
			expect(jobs).toHaveLength(1);
		} finally {
			await standby.query('SELECT pg_wal_replay_resume()');
			if (child.exitCode == null && child.signalCode == null) {
				child.kill('SIGKILL');
				await exited;
			}
		}
	}, 120_000);

	test('account deletion reaches a room that the replica has not replayed', async () => {
		const owner = await signup();
		const member = await signup();
		expect((await api('i/update', { chatScope: 'everyone' }, member)).status).toBe(200);
		await caughtUp();
		const replicatedOwner = await standby.query('SELECT 1 FROM "user" WHERE "id" = $1', [owner.id]);
		expect(replicatedOwner.rowCount).toBe(1);
		await standby.query('SELECT pg_wal_replay_pause()');
		await vi.waitFor(async () => {
			const { rows: [{ state }] } = await standby.query('SELECT pg_get_wal_replay_pause_state() AS "state"');
			expect(state).toBe('paused');
		}, { timeout: 5000 });
		await deliverQueue.pause();
		let child: ReturnType<typeof fork> | undefined;
		let exited: Promise<unknown[]> | undefined;
		try {
			const room = (await api('chat/rooms/create', { name: 'Room created during replica delay' }, owner)).body;
			expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, owner)).status).toBe(200);
			expect((await api('chat/rooms/join', { roomId: room.id }, member)).status).toBe(204);
			const inbox = `https://remote.test/users/${member.id}/inbox`;
			await db.getRepository(MiUser).update(member.id, { host: 'remote.test', uri: `https://remote.test/users/${member.id}`, inbox, sharedInbox: null });
			const primary = (await db.query('SELECT 1 FROM "chat_room" WHERE "id" = $1', [room.id]) as unknown[]).length;
			const standbyRows = (await standby.query('SELECT 1 FROM "chat_room" WHERE "id" = $1', [room.id])).rowCount;
			expect((await api('i/delete-account', { password: 'test' }, owner)).status).toBe(204);
			const deletion = await vi.waitFor(async () => {
				const job = (await dbQueue.getJobs(['wait', 'delayed', 'prioritized'])).find(item => item.name === 'deleteAccount' && item.data.user.id === owner.id);
				expect(job).toBeDefined();
				return job!;
			}, { timeout: 10_000 });
			const evidenceRoot = process.env.CHAT_PROCESS_EVIDENCE_DIR ?? tmpdir();
			mkdirSync(evidenceRoot, { recursive: true });
			const evidenceDir = mkdtempSync(join(evidenceRoot, 'chat-delete-replica-worker-'));
			const stdout = openSync(join(evidenceDir, 'stdout.log'), 'wx');
			const stderr = openSync(join(evidenceDir, 'stderr.log'), 'wx');
			child = fork(new URL('../../built-test/chat-queue-process-fixture.js', import.meta.url), [], {
				execArgv: ['--max-old-space-size=512'], stdio: ['ignore', stdout, stderr, 'ipc'],
				env: { ...process.env, NODE_ENV: 'production', CHERRYPICK_CONFIG_YML: configPath, CP_NO_DAEMONS: '1', CHAT_PROCESS_FIXTURE_DB: config.db.db, CHAT_PROCESS_FIXTURE_REPLICA: replica },
			});
			closeSync(stdout);
			closeSync(stderr);
			exited = once(child, 'exit');
			const [message] = await Promise.race([
				once(child, 'message', { signal: AbortSignal.timeout(30_000) }),
				exited.then(([code, signal]) => { throw new Error(`worker exited before readiness: ${code}/${signal}, ${evidenceDir}`); }),
			]) as [ChatQueueProcessMessage];
			if (message.type === 'error') throw new Error(message.message);
			await vi.waitFor(async () => expect(await deletion.getState()).toBe('completed'), { timeout: 30_000, interval: 100 });
			const jobs = (await deliverQueue.getJobs(['wait', 'active', 'delayed', 'prioritized', 'completed', 'failed']))
				.filter(job => job.data.user.id === owner.id && job.data.to === inbox && JSON.parse(job.data.content).type === 'Delete');
			const present = {
				room: await db.getRepository(MiChatRoom).existsBy({ id: room.id }),
				account: await db.getRepository(MiUser).existsBy({ id: owner.id }),
				keypair: await db.getRepository(MiUserKeypair).existsBy({ userId: owner.id }),
			};
			console.log('CHAT_ACCOUNT_DELETE_REPLICA', JSON.stringify({ primary, standby: standbyRows, deleteJobs: jobs.length, present }));
			expect(primary).toBe(1);
			expect(standbyRows).toBe(0);
			expect(jobs).toHaveLength(1);
			expect(present).toEqual({ room: false, account: true, keypair: true });
		} finally {
			await standby.query('SELECT pg_wal_replay_resume()');
			if (child != null && child.exitCode == null && child.signalCode == null) {
				child.kill('SIGKILL');
				await exited;
			}
			await deliverQueue.resume();
		}
	}, 120_000);
});
