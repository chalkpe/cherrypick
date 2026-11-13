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
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { loadConfig, path as configPath } from '@/config.js';
import { api, connectStream, initTestDb, signup } from '../utils.js';
import { waitForChatNotificationTurn } from '../misc/chat-notification-drain.js';
import { chatProcessExitError } from '../misc/chat-process-stderr.js';
import type { ChatSendProcessMessage } from '../misc/chat-send-process-fixture.js';

const config = loadConfig();
// 시험 DB를 스트리밍 복제하는 읽기 복제본의 "host:port". 복제본을 준비한 환경에서만 실행한다.
const replica = process.env.CHAT_E2E_REPLICA;

describe.skipIf(replica == null)('chat unread marks with a read replica', () => {
	let db: DataSource;
	let redis: Redis;
	let standby: pg.Client;

	beforeAll(async () => {
		db = await initTestDb(true);
		redis = new Redis(config.redis);
		const [host, port] = replica!.split(':');
		standby = new pg.Client({ host, port: Number(port), user: config.db.user, password: config.db.pass, database: config.db.db });
		await standby.connect();
		await signup({ username: 'root' });
	});

	afterAll(async () => {
		await waitForChatNotificationTurn();
		await standby.end();
		await redis.quit();
		await db.destroy();
	}, 30_000);

	/** Waits until the replica has replayed everything the primary has written so far. */
	async function caughtUp(): Promise<void> {
		const [{ lsn }] = await db.query('SELECT pg_current_wal_lsn() AS "lsn"') as [{ lsn: string }];
		await vi.waitFor(async () => {
			const { rows: [{ replayed }] } = await standby.query('SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS "replayed"', [lsn]);
			expect(replayed).toBe(true);
		}, { timeout: 10_000 });
	}

	async function setReplay(paused: boolean): Promise<void> {
		await standby.query(paused ? 'SELECT pg_wal_replay_pause()' : 'SELECT pg_wal_replay_resume()');
		await vi.waitFor(async () => {
			const { rows: [{ state }] } = await standby.query('SELECT pg_get_wal_replay_pause_state() AS "state"');
			expect(state).toBe(paused ? 'paused' : 'not paused');
		}, { timeout: 5000 });
	}

	test('a message the replica has not replayed yet stays unread', async () => {
		const sender = await signup();
		const reader = await signup();
		expect((await api('i/update', { chatScope: 'everyone' }, reader)).status).toBe(200);
		expect((await api('chat/messages/create-to-user', { toUserId: reader.id, text: 'Before the delay' }, sender)).status).toBe(200);
		expect((await api('chat/messages/user-timeline', { userId: sender.id }, reader)).status).toBe(200);
		expect((await api('i', {}, reader)).body.hasUnreadChatMessages).toBe(false);
		const key = `newUserChatMessageExists:${reader.id}:${sender.id}`;

		const evidenceRoot = process.env.CHAT_PROCESS_EVIDENCE_DIR ?? tmpdir();
		mkdirSync(evidenceRoot, { recursive: true });
		const evidenceDir = mkdtempSync(join(evidenceRoot, 'chat-replica-sender-'));
		const stdout = openSync(join(evidenceDir, 'stdout.log'), 'wx');
		const stderr = openSync(join(evidenceDir, 'stderr.log'), 'wx');
		// 운영처럼 읽기는 복제본, 쓰기와 트랜잭션은 주 DB로 가는 전송 서버다.
		const child = fork(new URL('../../built-test/chat-send-process-fixture.js', import.meta.url), [], {
			execArgv: ['--max-old-space-size=512'],
			stdio: ['ignore', stdout, stderr, 'ipc'],
			env: { ...process.env, NODE_ENV: 'production', CHERRYPICK_CONFIG_YML: configPath, CP_NO_DAEMONS: '1', CHAT_PROCESS_FIXTURE_DB: config.db.db, CHAT_PROCESS_FIXTURE_REPLICA: replica },
		});
		closeSync(stdout);
		closeSync(stderr);
		const exited = once(child, 'exit');
		let lagging: Record<string, unknown> | undefined;
		try {
			const [message] = await Promise.race([
				once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
				exited.then(([code, signal]) => { throw chatProcessExitError('chat sender', code, signal, evidenceDir); }),
			]) as [ChatSendProcessMessage];
			if (message.type === 'error') throw new Error(message.message);

			// 복제본이 지금까지를 모두 반영한 뒤 재생을 멈춘다. 그 뒤 주 DB에 저장한 쪽지는 복제본에 없다.
			await caughtUp();
			await setReplay(true);
			const response = await fetch(`http://127.0.0.1:${message.port}/api/chat/messages/create-to-user`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ i: sender.token, toUserId: reader.id, text: 'Sent while the replica waits' }),
				signal: AbortSignal.timeout(15_000),
			});
			expect(response.status).toBe(200);
			const sent = await response.json() as { id: string };
			lagging = {
				onReplica: (await standby.query('SELECT 1 FROM "chat_message" WHERE "id" = $1', [sent.id])).rowCount,
				onPrimary: (await db.query('SELECT 1 FROM "chat_message" WHERE "id" = $1', [sent.id]) as unknown[]).length,
				conversation: await redis.sismember(`newChatMessagesExists:${reader.id}`, `user:${sender.id}`),
				message: await redis.sismember(`${key}:messages`, sent.id),
			};
			console.log('CHAT_REPLICA_UNREAD', JSON.stringify({ event: 'sent-while-lagging', id: sent.id, ...lagging }));
		} finally {
			await setReplay(false);
			if (child.exitCode == null && child.signalCode == null) {
				child.kill('SIGKILL');
				await exited;
			}
		}
		await caughtUp();

		const after = { hasUnread: (await api('i', {}, reader)).body.hasUnreadChatMessages };
		console.log('CHAT_REPLICA_UNREAD', JSON.stringify({ event: 'after-replay', ...after }));
		expect(lagging).toEqual({ onReplica: 0, onPrimary: 1, conversation: 1, message: 1 });
		expect(after).toEqual({ hasUnread: true });
	});

	test('a local room member who joined while the replica lags receives an unread mark', async () => {
		const owner = await signup();
		const reader = await signup();
		const room = (await api('chat/rooms/create', { name: 'Replica room' }, owner)).body;
		const evidenceRoot = process.env.CHAT_PROCESS_EVIDENCE_DIR ?? tmpdir();
		mkdirSync(evidenceRoot, { recursive: true });
		const evidenceDir = mkdtempSync(join(evidenceRoot, 'chat-replica-room-'));
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
		let observation: Record<string, unknown> | undefined;
		try {
			const [message] = await Promise.race([
				once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
				exited.then(([code, signal]) => { throw chatProcessExitError('chat sender', code, signal, evidenceDir); }),
			]) as [ChatSendProcessMessage];
			if (message.type === 'error') throw new Error(message.message);
			await caughtUp();
			await setReplay(true);
			expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: reader.id }, owner)).status).toBe(200);
			expect((await api('chat/rooms/join', { roomId: room.id }, reader)).status).toBe(204);
			const response = await fetch(`http://127.0.0.1:${message.port}/api/chat/messages/create-to-room`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ i: owner.token, toRoomId: room.id, text: 'After joining' }),
				signal: AbortSignal.timeout(15_000),
			});
			expect(response.status).toBe(200);
			const sent = await response.json() as { id: string };
			observation = {
				primaryMembers: (await db.query('SELECT 1 FROM "chat_room_membership" WHERE "roomId" = $1 AND "userId" = $2', [room.id, reader.id]) as unknown[]).length,
				replicaMembers: (await standby.query('SELECT 1 FROM "chat_room_membership" WHERE "roomId" = $1 AND "userId" = $2', [room.id, reader.id])).rowCount,
				conversation: await redis.sismember(`newChatMessagesExists:${reader.id}`, `room:${room.id}`),
				message: await redis.sismember(`newRoomChatMessageExists:${reader.id}:${room.id}:messages`, sent.id),
			};
			console.log('CHAT_REPLICA_ROOM_UNREAD', JSON.stringify(observation));
		} finally {
			await setReplay(false);
			if (child.exitCode == null && child.signalCode == null) {
				child.kill('SIGKILL');
				await exited;
			}
		}
		await caughtUp();
		expect(observation).toEqual({ primaryMembers: 1, replicaMembers: 0, conversation: 1, message: 1 });
		expect((await api('i', {}, reader)).body.hasUnreadChatMessages).toBe(true);
	});

	test('an owner unmuted on the primary receives a message while the replica still says muted', async () => {
		const owner = await signup();
		const sender = await signup();
		const courier = await signup();
		expect((await api('i/update', { chatScope: 'everyone' }, owner)).status).toBe(200);
		const room = (await api('chat/rooms/create', { name: 'Owner unmute with replica delay' }, owner)).body;
		expect((await api('chat/rooms/invitations/create', { roomId: room.id, userId: sender.id }, owner)).status).toBe(200);
		expect((await api('chat/rooms/join', { roomId: room.id }, sender)).status).toBe(204);
		expect((await api('chat/rooms/mute', { roomId: room.id, mute: true }, owner)).status).toBe(204);

		const evidenceRoot = process.env.CHAT_PROCESS_EVIDENCE_DIR ?? tmpdir();
		mkdirSync(evidenceRoot, { recursive: true });
		const evidenceDir = mkdtempSync(join(evidenceRoot, 'chat-replica-unmute-'));
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
		let onPrimary: boolean | undefined;
		let onReplica: boolean | undefined;
		let marked: number | undefined;
		let noticed = false;
		const notices: string[] = [];
		let resolveSentinel: () => void = () => {};
		const sentinel = new Promise<void>(resolve => { resolveSentinel = resolve; });
		let stream: Awaited<ReturnType<typeof connectStream>> | undefined;
		try {
			stream = await connectStream(owner, 'main', message => {
				if (message.type !== 'newChatMessage') return;
				notices.push(message.body.text);
				if (message.body.text === 'Notice barrier') resolveSentinel();
			});
			const [ready] = await Promise.race([
				once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
				exited.then(([code, signal]) => { throw chatProcessExitError('chat sender', code, signal, evidenceDir); }),
			]) as [ChatSendProcessMessage];
			if (ready.type === 'error') throw new Error(ready.message);
			await caughtUp();
			await setReplay(true);
			expect((await api('chat/rooms/mute', { roomId: room.id, mute: false }, owner)).status).toBe(204);
			[{ isMutedByOwner: onPrimary }] = await db.query('SELECT "isMutedByOwner" FROM "chat_room" WHERE "id" = $1', [room.id]) as [{ isMutedByOwner: boolean }];
			({ rows: [{ isMutedByOwner: onReplica }] } = await standby.query('SELECT "isMutedByOwner" FROM "chat_room" WHERE "id" = $1', [room.id]));
			const response = await fetch(`http://127.0.0.1:${ready.port}/api/chat/messages/create-to-room`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ i: sender.token, toRoomId: room.id, text: 'After owner unmute' }),
				signal: AbortSignal.timeout(15_000),
			});
			expect(response.status).toBe(200);
			const message = await response.json() as { id: string };
			marked = await redis.sismember(`newRoomChatMessageExists:${owner.id}:${room.id}:messages`, message.id);
			expect((await api('chat/messages/create-to-user', { toUserId: owner.id, text: 'Notice barrier' }, courier)).status).toBe(200);
			await Promise.race([sentinel, new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('notice barrier timed out')), 15_000).unref();
			})]);
			noticed = notices.includes('After owner unmute');
		} finally {
			stream?.close();
			await setReplay(false);
			if (child.exitCode == null && child.signalCode == null) {
				child.kill('SIGKILL');
				await exited;
			}
		}
		await caughtUp();
		expect((await api('chat/messages/user-timeline', { userId: courier.id }, owner)).status).toBe(200);
		const hasUnread = (await api('i', {}, owner)).body.hasUnreadChatMessages;
		console.log('CHAT_REPLICA_OWNER_UNMUTE', JSON.stringify({ onPrimary, onReplica, marked, noticed, hasUnread }));
		expect({ onPrimary, onReplica, marked, noticed, hasUnread }).toEqual({ onPrimary: false, onReplica: true, marked: 1, noticed: true, hasUnread: true });
	}, 60_000);
});
