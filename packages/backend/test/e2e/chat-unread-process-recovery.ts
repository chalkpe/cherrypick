/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, verify } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Bull from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { DataSource, QueryRunner } from 'typeorm';
import { loadConfig, path as configPath } from '@/config.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
import { MiUser } from '@/models/User.js';
import { MiUserKeypair } from '@/models/UserKeypair.js';
import { QUEUE, baseQueueOptions } from '@/queue/const.js';
import type { DeliverJobData } from '@/queue/types.js';
import { api, connectStream, initTestDb, signup } from '../utils.js';
import type { UserToken } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';
import { chatUnreadReadGate } from '../misc/chat-unread-read-gate.js';
import { chatUnreadSettleFailureGate } from '../misc/chat-unread-settle-failure-gate.js';
import { chatProcessExitError } from '../misc/chat-process-stderr.js';
import type { ChatSendProcessMessage } from '../misc/chat-send-process-fixture.js';
import type { ChatQueueProcessMessage } from '../misc/chat-queue-process-fixture.js';

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

type Sender = { child: ChildProcess; exited: Promise<unknown[]>; port: number };

/** A separate HTTP server process that sends chat messages, borrowing this test's database. */
async function spawnSender(redisPort?: number): Promise<Sender> {
	const evidenceRoot = process.env.CHAT_PROCESS_EVIDENCE_DIR ?? tmpdir();
	mkdirSync(evidenceRoot, { recursive: true });
	const evidenceDir = mkdtempSync(join(evidenceRoot, 'chat-sender-'));
	const stdout = openSync(join(evidenceDir, 'stdout.log'), 'wx');
	const stderr = openSync(join(evidenceDir, 'stderr.log'), 'wx');
	const child = fork(new URL('../../built-test/chat-send-process-fixture.js', import.meta.url), [], {
		execArgv: ['--max-old-space-size=512'],
		stdio: ['ignore', stdout, stderr, 'ipc'],
		env: { ...process.env, NODE_ENV: 'production', CHERRYPICK_CONFIG_YML: configPath, CP_NO_DAEMONS: '1', CHAT_PROCESS_FIXTURE_DB: config.db.db, ...(redisPort == null ? {} : { CHAT_PROCESS_FIXTURE_REDIS_PORT: String(redisPort) }) },
	});
	closeSync(stdout);
	closeSync(stderr);
	console.log('CHAT_PROCESS_RECOVERY', JSON.stringify({ event: 'spawn', pid: child.pid, evidenceDir }));
	const exited = once(child, 'exit');
	try {
		const [message] = await Promise.race([
			once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
			exited.then(([code, signal]) => { throw chatProcessExitError('chat sender', code, signal, evidenceDir); }),
		]) as [ChatSendProcessMessage];
		if (message.type === 'error') throw new Error(message.message);
		console.log('CHAT_PROCESS_RECOVERY', JSON.stringify({ event: 'ready', pid: child.pid, port: message.port }));
		return { child, exited, port: message.port };
	} catch (error) {
		await killSender({ child, exited });
		throw error;
	}
}

async function killSender({ child, exited }: Pick<Sender, 'child' | 'exited'>): Promise<void> {
	if (child.exitCode != null || child.signalCode != null) return;
	child.kill('SIGKILL');
	await exited;
}

/** Sends through the sender process. The request ends with a network error when that process is killed. */
function sendThrough(sender: Sender, from: UserToken, toUserId: string, text: string) {
	return fetch(`http://127.0.0.1:${sender.port}/api/chat/messages/create-to-user`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ i: from.token, toUserId, text }),
		signal: AbortSignal.timeout(15_000),
	}).then(response => ({ kind: 'response', status: response.status }), (error: Error) => ({ kind: 'network-error', name: error.name }));
}

async function pendingOf(key: string): Promise<string> {
	return await vi.waitFor(async () => {
		const pending = await redis.smembers(`${key}:pending`);
		expect(pending).toHaveLength(1);
		return pending[0];
	}, { timeout: 5000 });
}

async function readyPair() {
	const sender = await signup();
	const reader = await signup();
	expect((await api('i/update', { chatScope: 'everyone' }, reader)).status).toBe(200);
	// 처음 전송의 승인 INSERT는 완료해 둔다. 아래 잠금은 쪽지 INSERT 경계만 검사한다.
	expect((await api('chat/messages/create-to-user', { toUserId: reader.id, text: 'Before the crossing' }, sender)).status).toBe(200);
	expect((await api('chat/messages/user-timeline', { userId: sender.id }, reader)).status).toBe(200);
	expect((await api('i', {}, reader)).body.hasUnreadChatMessages).toBe(false);
	return { sender, reader, key: `newUserChatMessageExists:${reader.id}:${sender.id}` };
}

/** Locks the recipient's row so that the message INSERT of a send waits on its foreign key check. */
async function lockRecipientRow(readerId: string): Promise<QueryRunner> {
	const blocker = db.createQueryRunner();
	await blocker.connect();
	await blocker.startTransaction();
	await blocker.query('SELECT "id" FROM "user" WHERE "id" = $1 FOR UPDATE', [readerId]);
	return blocker;
}

async function release(blocker: QueryRunner | undefined): Promise<void> {
	if (blocker?.isTransactionActive) await blocker.rollbackTransaction();
	await blocker?.release();
}

test('one stream read clears a received message after settle fails without reading an unfinished send', async () => {
	const { sender, reader, key } = await readyPair();
	const gate = await chatUnreadSettleFailureGate(config.redis.host, config.redis.port);
	let resolveMessage: (id: string) => void = () => {};
	const received = new Promise<string>(resolve => { resolveMessage = resolve; });
	let worker: Sender | undefined;
	let stream: Awaited<ReturnType<typeof connectStream>> | undefined;
	let blocker: QueryRunner | undefined;
	let sending: Promise<{ status: number }> | undefined;
	try {
		worker = await spawnSender(gate.port);
		stream = await connectStream(reader, 'chatUser', message => {
			if (message.type === 'message' && message.body.text === 'Received despite settle failure') resolveMessage(message.body.id);
		}, { otherId: sender.id });
		gate.arm(reader.id);
		const response = await fetch(`http://127.0.0.1:${worker.port}/api/chat/messages/create-to-user`, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ i: sender.token, toUserId: reader.id, text: 'Received despite settle failure' }),
			signal: AbortSignal.timeout(15_000),
		});
		expect(response.status).toBe(200);
		const sent = await response.json() as { id: string };
		const streamId = await Promise.race([received, new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error('stream message timed out')), 5000).unref();
		})]);
		expect(streamId).toBe(sent.id);
		expect(gate.failures).toBe(1);
		expect(await db.getRepository(MiChatMessage).existsBy({ id: streamId })).toBe(true);
		expect(await redis.sismember(`${key}:pending`, streamId)).toBe(1);

		blocker = await lockRecipientRow(reader.id);
		sending = api('chat/messages/create-to-user', { toUserId: reader.id, text: 'Still saving' }, sender);
		const otherId = await vi.waitFor(async () => {
			const ids = await redis.smembers(`${key}:pending`);
			const other = ids.find(id => id !== streamId);
			expect(other).toBeDefined();
			return other!;
		}, { timeout: 5000 });
		expect(await db.getRepository(MiChatMessage).existsBy({ id: otherId })).toBe(false);

		stream.send(JSON.stringify({ type: 'ch', body: { id: 'a', type: 'read', body: { id: streamId } } }));
		await vi.waitFor(async () => expect(await redis.sismember(`${key}:pending`, streamId)).toBe(0), { timeout: 5000 });
		const state = {
			receivedMarked: await redis.sismember(`${key}:messages`, streamId),
			unfinishedMarked: await redis.sismember(`${key}:messages`, otherId),
			unfinishedPending: await redis.sismember(`${key}:pending`, otherId),
		};
		console.log('CHAT_STREAM_SETTLE_FAILURE', JSON.stringify({ streamId, otherId, ...state }));
		expect(state).toEqual({ receivedMarked: 0, unfinishedMarked: 1, unfinishedPending: 1 });
		expect((await api('i', {}, reader)).body.hasUnreadChatMessages).toBe(false);
		await release(blocker);
		blocker = undefined;
		expect((await sending).status).toBe(200);
		expect((await api('i', {}, reader)).body.hasUnreadChatMessages).toBe(true);
	} finally {
		stream?.close();
		await release(blocker);
		await sending?.catch(() => undefined);
		if (worker != null) await killSender(worker);
		await gate.close();
	}
}, 60_000);

test.each(['leave', 'kick'] as const)('unread after room %s excludes a room whose cleanup failed', async action => {
	const owner = await signup();
	const reader = await signup();
	const rooms = await Promise.all(['Departed', 'Still joined'].map(async name => {
		const created = await api('chat/rooms/create', { name }, owner);
		expect(created.status).toBe(200);
		expect((await api('chat/rooms/invitations/create', { roomId: created.body.id, userId: reader.id }, owner)).status).toBe(200);
		expect((await api('chat/rooms/join', { roomId: created.body.id }, reader)).status).toBe(204);
		expect((await api('chat/messages/create-to-room', { toRoomId: created.body.id, text: name }, owner)).status).toBe(200);
		return created.body;
	}));
	const [departed, remaining] = rooms;
	const remote = await signup();
	expect((await api('chat/rooms/invitations/create', { roomId: departed.id, userId: remote.id }, owner)).status).toBe(200);
	expect((await api('chat/rooms/join', { roomId: departed.id }, remote)).status).toBe(204);
	const inbox = `https://remote.test/users/${remote.id}/inbox`;
	await db.getRepository(MiUser).update(remote.id, { host: 'remote.test', uri: `https://remote.test/users/${remote.id}`, inbox, sharedInbox: null });
	const deliveries = new Bull.Queue<DeliverJobData>(QUEUE.DELIVER, baseQueueOptions(config, QUEUE.DELIVER));
	let gate: Awaited<ReturnType<typeof chatUnreadSettleFailureGate>> | undefined;
	let worker: Sender | undefined;
	try {
		gate = await chatUnreadSettleFailureGate(config.redis.host, config.redis.port);
		worker = await spawnSender(gate.port);
		gate.arm(reader.id, 'clear');
		const actor = action === 'leave' ? reader : owner;
		const response = await fetch(`http://127.0.0.1:${worker.port}/api/chat/rooms/${action}`, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ i: actor.token, roomId: departed.id, ...(action === 'kick' ? { userId: reader.id } : {}) }),
			signal: AbortSignal.timeout(15_000),
		});
		expect(response.status).toBe(204);
		expect(gate.failures).toBe(1);
		await vi.waitFor(async () => {
			const jobs = (await deliveries.getJobs(['wait', 'active', 'delayed', 'prioritized', 'completed', 'failed']))
				.filter(job => job.data.user.id === actor.id && job.data.to === inbox && JSON.parse(job.data.content).type === 'Remove');
			expect(jobs).toHaveLength(1);
		}, { timeout: 5000 });
		const history = await api('chat/history', { room: true }, reader);
		expect(history.body.map(message => message.toRoomId)).toEqual([remaining.id]);
		expect(history.body[0].isRead).toBe(false);
		expect((await api('chat/messages/room-timeline', { roomId: departed.id }, reader)).status).toBe(400);
		expect((await api('i', {}, reader)).body.hasUnreadChatMessages).toBe(true);
		expect((await api('chat/messages/room-timeline', { roomId: remaining.id }, reader)).status).toBe(200);
		const hasUnread = (await api('i', {}, reader)).body.hasUnreadChatMessages;
		console.log('CHAT_ROOM_REMOVAL_UNREAD', JSON.stringify({ action, hasUnread, history: history.body.map(message => message.toRoomId) }));
		expect(hasUnread).toBe(false);
	} finally {
		if (worker != null) await killSender(worker);
		await gate?.close();
		await deliveries.close();
	}
}, 60_000);

test.skipIf(process.env.CHAT_DELIVERY_CERT == null || process.env.CHAT_DELIVERY_KEY == null)('a leave with failed unread cleanup still delivers a signed Remove', async () => {
	const owner = await signup();
	const reader = await signup();
	const remote = await signup();
	const room = (await api('chat/rooms/create', { name: 'Federated leave' }, owner)).body;
	for (const participant of [reader, remote]) {
		expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: participant.id }, owner)).status).toBe(200);
		expect((await api('chat/rooms/join', { roomId: room.id }, participant)).status).toBe(204);
	}
	expect((await api('chat/messages/create-to-room', { toRoomId: room.id, text: 'Unread before leaving' }, owner)).status).toBe(200);

	type Received = { body: string; signature: string; date: string; host: string; digest: string; target: string };
	let receive!: (value: Received) => void;
	const received = new Promise<Received>(resolve => { receive = resolve; });
	const inbox = createServer({ key: readFileSync(process.env.CHAT_DELIVERY_KEY!), cert: readFileSync(process.env.CHAT_DELIVERY_CERT!) }, (request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', chunk => chunks.push(Buffer.from(chunk)));
		request.on('end', () => {
			response.writeHead(202).end();
			receive({ body: Buffer.concat(chunks).toString(), signature: String(request.headers.signature), date: String(request.headers.date), host: String(request.headers.host), digest: String(request.headers.digest), target: request.url ?? '' });
		});
	});
	inbox.listen(0, '0.0.0.0');
	await once(inbox, 'listening');
	const address = inbox.address();
	if (address == null || typeof address === 'string') throw new Error('test inbox did not bind a TCP port');
	const remoteHost = `remote.test:${address.port}`;
	const remoteInbox = `https://${remoteHost}/inbox`;
	await db.getRepository(MiUser).update(remote.id, { host: remoteHost, uri: `https://${remoteHost}/users/${remote.id}`, inbox: remoteInbox, sharedInbox: null });
	const deliveries = new Bull.Queue<DeliverJobData>(QUEUE.DELIVER, baseQueueOptions(config, QUEUE.DELIVER));
	let gate: Awaited<ReturnType<typeof chatUnreadSettleFailureGate>> | undefined;
	let sender: Sender | undefined;
	let worker: ChildProcess | undefined;
	let workerExit: Promise<unknown[]> | undefined;
	try {
		gate = await chatUnreadSettleFailureGate(config.redis.host, config.redis.port);
		sender = await spawnSender(gate.port);
		gate.arm(reader.id, 'clear');
		const response = await fetch(`http://127.0.0.1:${sender.port}/api/chat/rooms/leave`, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ i: reader.token, roomId: room.id }),
			signal: AbortSignal.timeout(15_000),
		});
		expect(response.status).toBe(204);
		expect(gate.failures).toBe(1);

		const evidenceRoot = process.env.CHAT_PROCESS_EVIDENCE_DIR ?? tmpdir();
		mkdirSync(evidenceRoot, { recursive: true });
		const evidenceDir = mkdtempSync(join(evidenceRoot, 'chat-leave-delivery-'));
		const stdout = openSync(join(evidenceDir, 'stdout.log'), 'wx');
		const stderr = openSync(join(evidenceDir, 'stderr.log'), 'wx');
		worker = fork(new URL('../../built-test/chat-queue-process-fixture.js', import.meta.url), [], {
			execArgv: ['--max-old-space-size=512'], stdio: ['ignore', stdout, stderr, 'ipc'],
			env: { ...process.env, NODE_ENV: 'production', CHERRYPICK_CONFIG_YML: configPath, CP_NO_DAEMONS: '1', CHAT_PROCESS_FIXTURE_DB: config.db.db },
		});
		closeSync(stdout);
		closeSync(stderr);
		workerExit = once(worker, 'exit');
		const [ready] = await Promise.race([
			once(worker, 'message', { signal: AbortSignal.timeout(30_000) }),
			workerExit.then(([code, signal]) => { throw chatProcessExitError('chat queue', code, signal, evidenceDir); }),
		]) as [ChatQueueProcessMessage];
		if (ready.type === 'error') throw new Error(ready.message);
		const delivered = await Promise.race([received, new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error('signed Remove delivery timed out')), 30_000).unref();
		})]);
		const activity = JSON.parse(delivered.body) as { type: string; object: string };
		expect(activity.type).toBe('Remove');
		expect(activity.object).toContain(reader.id);
		expect(delivered.digest).toBe(`SHA-256=${createHash('sha256').update(delivered.body).digest('base64')}`);
		const signature = delivered.signature.match(/signature="([^"]+)"/)?.[1];
		expect(signature).toBeDefined();
		const key = await db.getRepository(MiUserKeypair).findOneByOrFail({ userId: reader.id });
		const signed = `(request-target): post ${delivered.target}\ndate: ${delivered.date}\nhost: ${delivered.host}\ndigest: ${delivered.digest}`;
		expect(verify('RSA-SHA256', Buffer.from(signed), key.publicKey, Buffer.from(signature!, 'base64'))).toBe(true);
		await vi.waitFor(async () => {
			const jobs = (await deliveries.getJobs(['completed'])).filter(job => job.data.to === remoteInbox && job.data.user.id === reader.id && JSON.parse(job.data.content).type === 'Remove');
			expect(jobs).toHaveLength(1);
		}, { timeout: 10_000 });
		console.log('CHAT_LEAVE_SIGNED_DELIVERY', JSON.stringify({ status: response.status, digestValid: true, signatureValid: true, completed: true }));
	} finally {
		if (worker != null && worker.exitCode == null && worker.signalCode == null) {
			worker.kill('SIGKILL');
			await workerExit;
		}
		if (sender != null) await killSender(sender);
		await gate?.close();
		await deliveries.close();
		inbox.close();
		await once(inbox, 'close');
	}
}, 90_000);

test('an HTTP sender killed before its INSERT leaves no unread mark or duplicate on retry', async () => {
	const { sender, reader, key } = await readyPair();
	const text = 'Across the bridge';
	const worker = await spawnSender();
	let blocker: QueryRunner | undefined;
	let pendingId: string | undefined;
	try {
		// 수신자 FK를 잠가 실제 API 전송의 INSERT만 막는다. 인증하는 발신자의 행은 잠그지 않는다.
		blocker = await lockRecipientRow(reader.id);

		const sending = sendThrough(worker, sender, reader.id, text);
		pendingId = await pendingOf(key);
		expect(await db.getRepository(MiChatMessage).existsBy({ id: pendingId })).toBe(false);
		console.log('CHAT_PROCESS_RECOVERY', JSON.stringify({ event: 'blocked-insert', pid: worker.child.pid, pendingId, rowExists: false }));

		expect(worker.child.kill('SIGKILL')).toBe(true);
		const exit = await worker.exited;
		console.log('CHAT_PROCESS_RECOVERY', JSON.stringify({ event: 'exit', pid: worker.child.pid, exit }));
		expect(exit).toEqual([null, 'SIGKILL']);
		const result = await sending;
		expect(result.kind).toBe('network-error');
		if ('name' in result) expect(result.name).not.toBe('TimeoutError');
	} finally {
		await killSender(worker);
		await release(blocker);
	}

	// 프로세스 종료 뒤 연결 정리가 끝나야 잠금을 얻는다. 실제 제품 읽기를 반복해 회복을 확인한다.
	await vi.waitFor(async () => {
		expect((await api('chat/read-all', {}, reader)).status).toBe(204);
		expect(await redis.exists(`${key}:pending`)).toBe(0);
	}, { timeout: 10_000 });
	expect((await api('i', {}, reader)).body.hasUnreadChatMessages).toBe(false);
	expect((await api('chat/messages/user-timeline', { userId: reader.id }, sender)).body.filter(message => message.text === text)).toHaveLength(0);

	expect((await api('chat/messages/create-to-user', { toUserId: reader.id, text }, sender)).status).toBe(200);
	expect((await api('chat/messages/user-timeline', { userId: reader.id }, sender)).body.filter(message => message.text === text)).toHaveLength(1);
	expect((await api('i', {}, reader)).body.hasUnreadChatMessages).toBe(true);
	expect((await api('chat/messages/user-timeline', { userId: sender.id }, reader)).body.filter(message => message.text === text)).toHaveLength(1);
	expect((await api('i', {}, reader)).body.hasUnreadChatMessages).toBe(false);
	console.log('CHAT_PROCESS_RECOVERY', JSON.stringify({ event: 'recovered', pid: worker.child.pid, pendingId, timelineBeforeRetry: 0, timelineAfterRetry: 1 }));
});

test('a message stored by an HTTP sender killed before it settled is read by one read-all', async () => {
	const { sender, reader, key } = await readyPair();
	const text = 'Stored, then the lights went out';
	const worker = await spawnSender();
	let rowLock: QueryRunner | undefined;
	let tableLock: QueryRunner | undefined;
	let tableLocking: Promise<unknown> | undefined;
	let pendingId: string | undefined;
	try {
		rowLock = await lockRecipientRow(reader.id);
		const sending = sendThrough(worker, sender, reader.id, text);
		pendingId = await pendingOf(key);

		// 저장 직후 발신 화면용 계정 조회에서 멈추도록 "user" 테이블 전체 잠금을 대기열에 넣는다.
		// 전송의 FK 검사가 이미 테이블 공유 잠금을 쥐고 있으므로, 이 잠금은 그 트랜잭션이 커밋된 뒤에 잡힌다.
		tableLock = db.createQueryRunner();
		await tableLock.connect();
		const [{ pid: tableLockPid }] = await tableLock.query('SELECT pg_backend_pid() AS "pid"') as [{ pid: number }];
		await tableLock.startTransaction();
		tableLocking = tableLock.query('LOCK TABLE "user" IN ACCESS EXCLUSIVE MODE');
		await vi.waitFor(async () => {
			const waiting = await db.query(`SELECT 1 FROM "pg_locks" WHERE "pid" = $1 AND "mode" = 'AccessExclusiveLock' AND NOT "granted"`, [tableLockPid]) as unknown[];
			expect(waiting).toHaveLength(1);
		}, { timeout: 5000 });

		let sent: unknown;
		void sending.then(result => { sent = result; });
		await rowLock.rollbackTransaction();
		await tableLocking;
		let observed: unknown;
		const stalled = await vi.waitFor(async () => {
			const stored = (await db.query('SELECT 1 FROM "chat_message" WHERE "id" = $1', [pendingId]) as unknown[]).length;
			const waiting = await db.query(`SELECT "l"."pid", "a"."query" FROM "pg_locks" "l" JOIN "pg_stat_activity" "a" ON "a"."pid" = "l"."pid" WHERE "l"."relation" = '"user"'::regclass AND NOT "l"."granted" AND "l"."pid" <> $1`, [tableLockPid]) as { pid: number; query: string }[];
			observed = { stored, waiting, sent, activity: await db.query(`SELECT "pid", "state", "wait_event_type", "wait_event", left("query", 100) AS "query" FROM "pg_stat_activity" WHERE "datname" = current_database() AND "state" <> 'idle' AND "pid" <> pg_backend_pid()`) };
			expect(stored).toBe(1);
			expect(waiting).toHaveLength(1);
			return waiting[0];
		}, { timeout: 5000 }).finally(() => console.log('CHAT_PROCESS_RECOVERY', JSON.stringify({ event: 'wait-observed', observed })));
		expect(await redis.smembers(`${key}:pending`)).toEqual([pendingId]);
		console.log('CHAT_PROCESS_RECOVERY', JSON.stringify({ event: 'stored-before-settle', pid: worker.child.pid, pendingId, rowExists: true, backend: stalled.pid }));

		expect(worker.child.kill('SIGKILL')).toBe(true);
		const exit = await worker.exited;
		console.log('CHAT_PROCESS_RECOVERY', JSON.stringify({ event: 'exit', pid: worker.child.pid, exit }));
		expect(exit).toEqual([null, 'SIGKILL']);
		expect((await sending).kind).toBe('network-error');
		await db.query('SELECT pg_terminate_backend($1)', [stalled.pid]);
	} finally {
		await killSender(worker);
		await release(rowLock);
		await tableLocking?.catch(() => {});
		await release(tableLock);
	}

	// 수신자는 저장된 쪽지를 미읽음으로 본다. 전체 읽음 한 번으로 그 쪽지까지 읽은 것이 되어야 한다.
	const history = (await api('chat/history', { room: false }, reader)).body;
	expect(history.find(message => message.id === pendingId)?.isRead).toBe(false);
	expect((await api('chat/read-all', {}, reader)).status).toBe(204);

	const state = {
		hasUnread: (await api('i', {}, reader)).body.hasUnreadChatMessages,
		marked: await redis.sismember(`${key}:messages`, pendingId!),
		pending: await redis.smembers(`${key}:pending`),
	};
	console.log('CHAT_PROCESS_RECOVERY', JSON.stringify({ event: 'after-one-read-all', pendingId, ...state }));
	expect(state).toEqual({ hasUnread: false, marked: 0, pending: [] });
});

test('a message committed after the timeline query remains unread even when its ID is older', async () => {
	const { sender, reader, key } = await readyPair();
	const gate = await chatUnreadReadGate(config.redis.host, config.redis.port);
	const blocker = db.createQueryRunner();
	let worker: Sender | undefined;
	let locked = false;
	let lowSend: Promise<{ status: number; body: { id: string } }> | undefined;
	try {
		await blocker.connect();
		await blocker.query('SELECT pg_advisory_lock(17040123)');
		locked = true;
		await db.query(`CREATE FUNCTION chat_unread_delay_insert() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.text = 'Delayed older message' THEN PERFORM pg_advisory_xact_lock(17040123); END IF;
				RETURN NEW;
			END $$`);
		await db.query('CREATE TRIGGER chat_unread_delay_insert BEFORE INSERT ON "chat_message" FOR EACH ROW EXECUTE FUNCTION chat_unread_delay_insert()');
		worker = await spawnSender(gate.port);

		lowSend = api('chat/messages/create-to-user', { toUserId: reader.id, text: 'Delayed older message' }, sender);
		const lowId = await pendingOf(key);
		await vi.waitFor(async () => {
			const waiting = await db.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = 17040123`) as unknown[];
			expect(waiting).toHaveLength(1);
		}, { timeout: 5000 });
		const high = await api('chat/messages/create-to-user', { toUserId: reader.id, text: 'Visible newer message' }, sender);
		expect(high.status).toBe(200);
		expect(high.body.id > lowId).toBe(true);

		gate.arm(reader.id);
		const timeline = fetch(`http://127.0.0.1:${worker.port}/api/chat/messages/user-timeline`, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ i: reader.token, userId: sender.id, limit: 1 }),
			signal: AbortSignal.timeout(15_000),
		});
		await vi.waitFor(() => expect(gate.held).toBe(true), { timeout: 5000 });
		await blocker.query('SELECT pg_advisory_unlock(17040123)');
		locked = false;
		const low = await lowSend;
		expect(low.status).toBe(200);
		expect(low.body.id).toBe(lowId);
		expect(await redis.sismember(`${key}:pending`, lowId)).toBe(0);

		gate.release();
		const response = await timeline;
		expect(response.status).toBe(200);
		const page = await response.json() as { id: string }[];
		const state = { ids: page.map(message => message.id), lowMarked: await redis.sismember(`${key}:messages`, lowId), hasUnread: (await api('i', {}, reader)).body.hasUnreadChatMessages };
		console.log('CHAT_LATE_COMMIT_READ', JSON.stringify({ lowId, highId: high.body.id, ...state }));
		expect(state).toEqual({ ids: [high.body.id], lowMarked: 1, hasUnread: true });
	} finally {
		gate.release();
		if (locked) await blocker.query('SELECT pg_advisory_unlock(17040123)');
		await lowSend?.catch(() => undefined);
		if (worker != null) await killSender(worker);
		await gate.close();
		await db.query('DROP TRIGGER IF EXISTS chat_unread_delay_insert ON "chat_message"');
		await db.query('DROP FUNCTION IF EXISTS chat_unread_delay_insert()');
		await blocker.release();
	}
}, 60_000);
