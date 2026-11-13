/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdirSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Bull from 'bullmq';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { DataSource, QueryRunner } from 'typeorm';
import { loadConfig, path as configPath } from '@/config.js';
import { MiChatRoom, MiFollowing, MiUser, MiUserKeypair } from '@/models/_.js';
import { QUEUE, baseQueueOptions } from '@/queue/const.js';
import type { DbUserDeleteJobData, DeliverJobData } from '@/queue/types.js';
import { api, initTestDb, signup } from '../utils.js';
import { chatProcessExitError } from '../misc/chat-process-stderr.js';
import type { ChatQueueProcessMessage } from '../misc/chat-queue-process-fixture.js';

const config = loadConfig();
let db: DataSource;
let dbQueue: Bull.Queue<DbUserDeleteJobData>;
let deliverQueue: Bull.Queue<DeliverJobData>;
let dbEvents: Bull.QueueEvents;

// e2e 서버는 작업 큐를 돌리지 않는다. 계정 삭제 작업은 아래 자식 프로세스만 처리한다.
beforeAll(async () => {
	db = await initTestDb(true);
	dbQueue = new Bull.Queue(QUEUE.DB, baseQueueOptions(config, QUEUE.DB));
	deliverQueue = new Bull.Queue(QUEUE.DELIVER, baseQueueOptions(config, QUEUE.DELIVER));
	dbEvents = new Bull.QueueEvents(QUEUE.DB, baseQueueOptions(config, QUEUE.DB));
	await dbEvents.waitUntilReady();
	await signup({ username: 'root' });
}, 1000 * 60 * 2);

afterAll(async () => {
	await dbEvents.close();
	await deliverQueue.close();
	await dbQueue.close();
	await db.destroy();
}, 30_000);

type Worker = { name: string; child: ChildProcess; exited: Promise<unknown[]>; ready: Promise<void> };

/** The job processors as production boots them, in a process of their own that borrows this test's database. */
function spawnWorker(name: string): Worker {
	const evidenceRoot = process.env.CHAT_PROCESS_EVIDENCE_DIR ?? tmpdir();
	mkdirSync(evidenceRoot, { recursive: true });
	const evidenceDir = mkdtempSync(join(evidenceRoot, `chat-queue-${name}-`));
	const stdout = openSync(join(evidenceDir, 'stdout.log'), 'wx');
	const stderr = openSync(join(evidenceDir, 'stderr.log'), 'wx');
	const child = fork(new URL('../../built-test/chat-queue-process-fixture.js', import.meta.url), [], {
		execArgv: ['--max-old-space-size=512'],
		stdio: ['ignore', stdout, stderr, 'ipc'],
		env: { ...process.env, NODE_ENV: 'production', CHERRYPICK_CONFIG_YML: configPath, CP_NO_DAEMONS: '1', CHAT_PROCESS_FIXTURE_DB: config.db.db },
	});
	closeSync(stdout);
	closeSync(stderr);
	console.log('CHAT_DELETION_RECOVERY', JSON.stringify({ event: 'spawn', name, pid: child.pid, evidenceDir }));
	const exited = once(child, 'exit');
	const ready = Promise.race([
		once(child, 'message', { signal: AbortSignal.timeout(30_000) }),
		exited.then(([code, signal]) => { throw chatProcessExitError(`${name} job worker`, code, signal, evidenceDir); }),
	]).then(([message]) => {
		if ((message as ChatQueueProcessMessage).type === 'error') throw new Error((message as { message: string }).message);
		console.log('CHAT_DELETION_RECOVERY', JSON.stringify({ event: 'ready', name, pid: child.pid }));
	});
	return { name, child, exited, ready };
}

async function stop(worker: Worker | undefined): Promise<void> {
	if (worker == null || worker.child.exitCode != null || worker.child.signalCode != null) return;
	worker.child.kill('SIGKILL');
	await worker.exited;
}

/** The deliveries of a Delete the account signs to the other server, with where each one is now. A job held by a paused queue reads 'waiting'. */
async function deletionsSignedBy(userId: string, to = 'https://remote.test/') {
	const jobs = await deliverQueue.getJobs(['wait', 'active', 'delayed', 'prioritized', 'completed', 'failed']);
	return await Promise.all(jobs
		.filter(job => job.data.user.id === userId && job.data.to.startsWith(to) && JSON.parse(job.data.content).type === 'Delete')
		.map(async job => ({ id: job.id, to: job.data.to, state: await job.getState() })));
}

test('an account deletion killed after its rooms went keeps the account until their deletions are delivered', async () => {
	const owner = await signup();
	const member = await signup();
	const friend = await signup();
	for (const account of [member, friend]) expect((await api('i/update', { chatScope: 'everyone' }, account)).status).toBe(200);
	const room = (await api('chat/rooms/create', { name: 'leaving with its owner' }, owner)).body;
	expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: member.id }, owner)).status).toBe(200);
	expect((await api('chat/rooms/join', { roomId: room.id }, member)).status).toBe(204);
	// fixture: 참가자를 다른 서버 계정으로 바꿔 방 삭제가 그 서버로 배송되게 한다.
	await db.getRepository(MiUser).update(member.id, {
		host: 'remote.test',
		uri: `https://remote.test/users/${member.id}`,
		inbox: `https://remote.test/users/${member.id}/inbox`,
		sharedInbox: null,
	});
	// 방 밖의 1:1 쪽지다. 방 삭제의 CASCADE는 이 행을 건드리지 않는다.
	expect((await api('chat/messages/create-to-user', { toUserId: friend.id, text: 'Before leaving' }, owner)).status).toBe(200);
	expect((await api('i/delete-account', { password: 'test' }, owner)).status).toBe(204);
	const deletion = await vi.waitFor(async () => {
		const found = (await dbQueue.getJobs(['wait', 'delayed', 'prioritized'])).find(job => job.name === 'deleteAccount' && job.data.user.id === owner.id);
		expect(found).toBeDefined();
		return found!;
	}, { timeout: 10_000 });
	expect(deletion.data.deliveries).toBeUndefined();

	const accountState = async () => ({
		account: await db.getRepository(MiUser).existsBy({ id: owner.id }),
		keypair: await db.getRepository(MiUserKeypair).existsBy({ userId: owner.id }),
	});
	expect(await accountState()).toEqual({ account: true, keypair: true });

	// 자식은 운영과 같이 deliver 처리기도 돌린다. 시험 전용 일회용 Redis의 deliver 큐를 BullMQ pause로 보류해,
	// 배송이 상대 서버의 응답이나 재시도 시각에 따라 끝나지 않고 대기에 남게 한다. finally에서 원래대로 돌린다.
	const deliverWasPaused = await deliverQueue.isPaused();
	expect(deliverWasPaused).toBe(false);
	await deliverQueue.pause();
	const stalled: string[] = [];
	const onStalled = ({ jobId }: { jobId: string }) => { stalled.push(jobId); };
	dbEvents.on('stalled', onStalled);
	const blocker: QueryRunner = db.createQueryRunner();
	let first: Worker | undefined;
	let second: Worker | undefined;
	try {
		await blocker.connect();
		await blocker.startTransaction();
		// 방을 지운 뒤 이 계정이 보낸 쪽지를 지우는 DELETE에서 첫 처리기를 멈춘다.
		expect(await blocker.query('SELECT "id" FROM "chat_message" WHERE "fromUserId" = $1 FOR UPDATE', [owner.id])).toHaveLength(1);
		first = spawnWorker('first');
		await first.ready;
		let waitingBackend: number | undefined;
		await vi.waitFor(async () => {
			const waiting = await db.query(`SELECT "pid" FROM "pg_stat_activity" WHERE "datname" = current_database() AND "wait_event_type" = 'Lock' AND "query" LIKE 'DELETE FROM "chat_message"%'`) as { pid: number }[];
			expect(waiting).toHaveLength(1);
			waitingBackend = waiting[0].pid;
		}, { timeout: 30_000, interval: 100 });
		expect(await db.getRepository(MiChatRoom).existsBy({ id: room.id })).toBe(false);
		const queued = await deletionsSignedBy(owner.id);
		expect(queued.length).toBeGreaterThan(0);
		expect(queued.every(delivery => delivery.state === 'waiting')).toBe(true);
		const running = (await dbQueue.getJob(deletion.id!))!;
		expect(await running.getState()).toBe('active');
		const beforeKill = await accountState();
		expect(beforeKill).toEqual({ account: true, keypair: true });
		console.log('CHAT_DELETION_RECOVERY', JSON.stringify({ event: 'blocked-after-rooms', pid: first.child.pid, waitingBackend, roomExists: false, queued, job: { id: running.id, state: 'active', attemptsStarted: running.attemptsStarted, stalledCounter: running.stalledCounter }, ...beforeKill }));

		expect(first.child.kill('SIGKILL')).toBe(true);
		const exit = await first.exited;
		console.log('CHAT_DELETION_RECOVERY', JSON.stringify({ event: 'exit', name: first.name, pid: first.child.pid, exit }));
		expect(exit).toEqual([null, 'SIGKILL']);
		// 죽은 프로세스의 DB 세션을 끝낸다. 서버가 늦게 알아차리는 사이 남은 DELETE가 잠금을 얻어 커밋하지 않게 한다.
		expect((await db.query('SELECT pg_terminate_backend($1) AS "terminated"', [waitingBackend]))[0].terminated).toBe(true);
		await vi.waitFor(async () => {
			expect(await db.query('SELECT 1 FROM "pg_stat_activity" WHERE "pid" = $1', [waitingBackend])).toHaveLength(0);
		}, { timeout: 10_000, interval: 100 });
		await blocker.rollbackTransaction();

		// BullMQ는 잠금이 끊긴 작업을 처음 데이터 그대로 다시 처리한다. 잠금 만료와 stalled 검사를 기다리는 상한이다.
		second = spawnWorker('second');
		await second.ready;
		const result = await (await dbQueue.getJob(deletion.id!))!.waitUntilFinished(dbEvents, 150_000);
		const retried = (await dbQueue.getJob(deletion.id!))!;
		const after = await deletionsSignedBy(owner.id);
		const afterRetry = await accountState();
		console.log('CHAT_DELETION_RECOVERY', JSON.stringify({ event: 'retried', pid: second.child.pid, result, job: { id: retried.id, state: await retried.getState(), attemptsStarted: retried.attemptsStarted, stalledCounter: retried.stalledCounter, stalledEvents: stalled.filter(id => id === deletion.id).length, data: retried.data }, deliveries: after, ...afterRetry }));

		// 같은 원래 작업이 BullMQ의 stalled 복구로 다시 처리됐다.
		expect(stalled).toContain(deletion.id);
		expect(retried.stalledCounter).toBeGreaterThanOrEqual(1);
		// 배송은 큐에 보류된 채 아직 끝나지 않았다.
		expect(after.map(delivery => delivery.id).sort()).toEqual(queued.map(delivery => delivery.id).sort());
		expect(after.every(delivery => delivery.state === 'waiting')).toBe(true);
		// 그 Delete들은 이 계정의 키로 서명한다. 배송이 끝나기 전에는 계정 행과 키가 남아야 한다.
		// 행이 남는 것만으로 서명 배송이 성공한다고 보지 않는다. 배송 자체는 이 시험에서 보내지 않는다.
		expect(afterRetry).toEqual({ account: true, keypair: true });
	} finally {
		dbEvents.off('stalled', onStalled);
		await stop(first);
		await stop(second);
		if (blocker.isTransactionActive) await blocker.rollbackTransaction();
		await blocker.release();
		// 처리기가 모두 내려간 뒤 deliver 큐를 원래 상태로 되돌린다. 남은 배송은 일회용 Redis에서 처리하는 곳이 없다.
		if (!deliverWasPaused) await deliverQueue.resume();
	}
}, 1000 * 60 * 4);

test('the deliveries of an account’s own Delete keep the account until they are done', async () => {
	const owner = await signup();
	const follower = await signup();
	expect((await api('following/create', { userId: owner.id }, follower)).status).toBe(200);
	// fixture: 팔로워를 다른 서버 계정으로 바꿔, 계정 삭제의 Delete가 그 서버의 공유 inbox로 배송되게 한다.
	const sharedInbox = 'https://account-delete.test/inbox';
	await db.getRepository(MiUser).update(follower.id, {
		host: 'account-delete.test',
		uri: `https://account-delete.test/users/${follower.id}`,
		inbox: `https://account-delete.test/users/${follower.id}/inbox`,
		sharedInbox,
	});
	await db.getRepository(MiFollowing).update({ followerId: follower.id, followeeId: owner.id }, {
		followerHost: 'account-delete.test',
		followerInbox: `https://account-delete.test/users/${follower.id}/inbox`,
		followerSharedInbox: sharedInbox,
	});

	// 자식의 deliver 처리기가 배송을 끝내지 않도록 시험 전용 deliver 큐를 보류한다. finally에서 원래대로 돌린다.
	const deliverWasPaused = await deliverQueue.isPaused();
	expect(deliverWasPaused).toBe(false);
	await deliverQueue.pause();
	let worker: Worker | undefined;
	try {
		expect((await api('i/delete-account', { password: 'test' }, owner)).status).toBe(204);
		const deletion = await vi.waitFor(async () => {
			const found = (await dbQueue.getJobs(['wait', 'delayed', 'prioritized'])).find(job => job.name === 'deleteAccount' && job.data.user.id === owner.id);
			expect(found).toBeDefined();
			return found!;
		}, { timeout: 10_000 });
		worker = spawnWorker('account-delete');
		await worker.ready;
		const queued = await vi.waitFor(async () => {
			const found = await deletionsSignedBy(owner.id, sharedInbox);
			expect(found).toHaveLength(1);
			return found;
		}, { timeout: 10_000 });
		expect(queued[0].state).toBe('waiting');
		console.log('CHAT_DELETION_RECOVERY', JSON.stringify({ event: 'account-delete-queued', job: { id: deletion.id, data: deletion.data }, queued }));

		const result = await deletion.waitUntilFinished(dbEvents, 60_000);
		const after = await deletionsSignedBy(owner.id, sharedInbox);
		const account = await db.getRepository(MiUser).existsBy({ id: owner.id });
		const keypair = await db.getRepository(MiUserKeypair).existsBy({ userId: owner.id });
		const followUps = (await dbQueue.getJobs(['wait', 'delayed', 'prioritized'])).filter(job => job.name === 'deleteAccount' && job.data.user.id === owner.id && job.data.deliveries != null);
		console.log('CHAT_DELETION_RECOVERY', JSON.stringify({ event: 'account-delete-processed', pid: worker.child.pid, result, deliveries: after, account, keypair, followUps: followUps.map(job => ({ id: job.id, data: job.data })) }));

		// 이 Delete는 아직 배송되지 않았다. 그동안 계정 행과 키가 남고, 배송을 기다리는 다음 작업이 있어야 한다.
		expect(after).toEqual(queued);
		expect({ account, keypair }).toEqual({ account: true, keypair: true });
		// 이 서버가 아는 다른 공유 inbox가 있으면 그 배송도 함께 기다린다.
		expect(followUps).toHaveLength(1);
		expect(followUps[0].data.deliveries).toContain(queued[0].id);
	} finally {
		await stop(worker);
		if (!deliverWasPaused) await deliverQueue.resume();
	}
}, 1000 * 60 * 2);
