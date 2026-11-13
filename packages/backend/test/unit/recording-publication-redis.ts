/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo, Socket } from 'node:net';
import type { RedisOptions } from 'ioredis';
import type { Config } from '@/config.js';
import { loadConfig } from '@/config.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ACK_RECORDING_PUBLICATION_SCRIPT, PREPARE_RECORDING_PUBLICATION_SCRIPT, PUBLISH_RECORDING_EVENT_SCRIPT } from '@/core/recording-event.js';

const prefix = `test-recording-publication-${randomUUID()}:`;
const channel = prefix + 'channel';
// maxmemory·ACL 변경과 응답 유실 시험은 시험 전용으로 지정한 Redis에서만 실행하고, 지정이 없으면 건너뛴다.
// 값은 쉼표로 구분한 `host:port` 목록이다. 설정의 redis와 redisForPubsub가 모두 목록에 있고 서로 다른 서버여야 한다.
const dedicatedRedis = process.env.CHERRYPICK_TEST_DEDICATED_REDIS?.split(',').map(endpoint => endpoint.trim()).filter(endpoint => endpoint !== '') ?? [];
const isolated = dedicatedRedis.length > 0;
const children = new Set<ChildProcess>();
const aclUsers = new Set<string>();
const faultClients = new Set<Redis>();
let mainOptions: RedisOptions;
let pubsubOptions: RedisOptions;
let main: Redis;
let pubsub: Redis;
let subscriber: Redis;
let initialMemory: [string, string] | undefined;
let delivered: unknown[];

beforeAll(async () => {
	const config = loadConfig();
	mainOptions = { ...config.redis, keyPrefix: prefix + 'main:', connectTimeout: 3000, maxRetriesPerRequest: 1 };
	pubsubOptions = { ...config.redisForPubsub, keyPrefix: prefix + 'pubsub:', connectTimeout: 3000, maxRetriesPerRequest: 1 };
	main = new Redis(mainOptions);
	pubsub = new Redis(pubsubOptions);
	subscriber = new Redis({ ...pubsubOptions, keyPrefix: undefined });
	await Promise.all([once(main, 'ready'), once(pubsub, 'ready'), once(subscriber, 'ready')]);
	if (isolated) {
		const endpoint = (options: RedisOptions) => `${options.host ?? 'localhost'}:${options.port ?? 6379}`;
		expect(dedicatedRedis).toContain(endpoint(mainOptions));
		expect(dedicatedRedis).toContain(endpoint(pubsubOptions));
		const runId = async (redis: Redis) => (await redis.info('server')).match(/^run_id:(.+)$/m)?.[1];
		expect(await runId(main)).not.toBe(await runId(pubsub));
		initialMemory = [(await main.config('GET', 'maxmemory') as string[])[1], (await pubsub.config('GET', 'maxmemory') as string[])[1]];
	}
});

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode == null && child.signalCode == null) {
		const exited = once(child, 'exit');
		child.kill('SIGKILL');
		await exited;
	}
	children.delete(child);
}

function nextMessage(child: ChildProcess): Promise<{ type: string; result?: number }> {
	return new Promise((resolve, reject) => {
		const cleanup = () => { child.off('message', message); child.off('exit', exited); child.off('error', failed); };
		const message = (value: unknown) => { cleanup(); resolve(value as { type: string; result?: number }); };
		const exited = (code: number | null, signal: string | null) => { cleanup(); reject(new Error(`Publication fixture exited before IPC: ${code}/${signal}`)); };
		const failed = (error: Error) => { cleanup(); reject(error); };
		child.once('message', message);
		child.once('exit', exited);
		child.once('error', failed);
	});
}

async function worker(): Promise<ChildProcess> {
	const child = fork(fileURLToPath(new URL('../misc/recording-publication-process.ts', import.meta.url)), { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
	children.add(child);
	expect(await nextMessage(child)).toEqual({ type: 'ready' });
	return child;
}

async function send(child: ChildProcess, command: object, expected: string): Promise<number | undefined> {
	const response = nextMessage(child);
	child.send(command);
	const result = await response;
	expect(result.type).toBe(expected);
	return result.result;
}

async function listen(): Promise<void> {
	delivered = [];
	subscriber.on('message', (_channel, payload) => { if (payload !== 'barrier') delivered.push(JSON.parse(payload)); });
	await subscriber.subscribe(channel);
}

async function flushPublications(): Promise<void> {
	const barrier = new Promise<void>(resolve => {
		const received = (_channel: string, payload: string) => {
			if (payload !== 'barrier') return;
			subscriber.off('message', received);
			resolve();
		};
		subscriber.on('message', received);
	});
	await pubsub.eval('return redis.call("PUBLISH", ARGV[1], "barrier")', 0, channel);
	await barrier;
}

function message(recording = true) {
	return { channel: 'mainStream:m1', message: { type: 'chatRoomRecording', body: { id: '12345678-1234-4123-8123-123456789abc', recording } } };
}

async function prepare(recording = true, id = 'event', capacity = 4096, deadline = Date.now() + 3_600_000) {
	return main.eval(PREPARE_RECORDING_PUBLICATION_SCRIPT, 3, 'seen', 'flags', 'pending', id, recording ? 1 : 2, Date.now(), deadline, capacity);
}

async function publish(recording = true, id = 'event', capacity = 4096, deadline = Date.now() + 3_600_000, client = pubsub) {
	return client.eval(PUBLISH_RECORDING_EVENT_SCRIPT, 1, 'published', id, recording ? 1 : 2, Date.now(), deadline, capacity, JSON.stringify([JSON.stringify(message(recording))]), channel);
}

async function acknowledge(recording = true, id = 'event') {
	return main.eval(ACK_RECORDING_PUBLICATION_SCRIPT, 2, 'flags', 'pending', id, recording ? 1 : 2);
}

async function recover(recording = true): Promise<void> {
	const claim = await prepare(recording);
	if (claim === 0) return;
	expect(claim === 1 || claim === 2).toBe(true);
	expect(await publish(recording)).toBeGreaterThanOrEqual(0);
	await acknowledge(recording);
}

afterEach(async () => {
	if (initialMemory) {
		await main.config('SET', 'maxmemory', initialMemory[0]);
		await pubsub.config('SET', 'maxmemory', initialMemory[1]);
	}
	for (const child of children) await stop(child);
	for (const client of faultClients) client.disconnect();
	faultClients.clear();
	for (const user of aclUsers) await pubsub.acl('DELUSER', user);
	aclUsers.clear();
	await subscriber.unsubscribe();
	subscriber.removeAllListeners('message');
	await main.del('seen', 'flags', 'pending');
	await pubsub.del('published', 'chatVoice:recordingPublished:r1');
});

afterAll(() => { main?.disconnect(); pubsub?.disconnect(); subscriber?.disconnect(); });

test.each(['before prepare', 'before publication', 'before acknowledgement'] as const)('a killed process %s leaves exactly one actual Redis publication after retry', async point => {
	await listen();
	const body = message();
	const command = { type: 'run', main: mainOptions, pubsub: pubsubOptions, channel, message: JSON.stringify(body), now: Date.now() };
	const original = await worker();
	if (point !== 'before prepare') {
		expect(await send(original, command, 'prepared')).toBe(1);
		if (point === 'before acknowledgement') expect(await send(original, { type: 'publish' }, 'published')).toBe(1);
	}

	await stop(original);
	const retry = await worker();
	expect(await send(retry, command, 'prepared')).toBe(point === 'before prepare' ? 1 : 2);
	expect(await send(retry, { type: 'publish' }, 'published')).toBe(point === 'before acknowledgement' ? 0 : 1);
	await send(retry, { type: 'acknowledge' }, 'completed');
	await stop(retry);
	await recover();
	await flushPublications();

	expect(delivered).toEqual([body]);
	expect(await main.hget('pending', 'event')).toBeNull();
	expect(await main.hget('flags', 'event')).toBe('1');
});

test('the recording publisher uses the PubSub connection and the existing main envelope', async () => {
	await listen();
	const publisher = new GlobalEventService({ host: channel } as Config, pubsub);
	const value = { roomId: 'r1', id: '12345678-1234-4123-8123-123456789abc', identity: 'https://remote.test/users/recorder', recording: true, updatedAt: Date.now(), deliveryWindowMs: 744_689_000, user: { id: 'recorder', username: 'recorder' } } as any;
	const receipt = { id: 'event', deadline: Date.now() + 3_600_000 };

	await publisher.publishRecordingMainStream(['m1', 'm2'], value, receipt);
	await publisher.publishRecordingMainStream(['m1', 'm2'], value, receipt);
	await flushPublications();

	expect(delivered).toEqual(['m1', 'm2'].map(userId => ({ channel: `mainStream:${userId}`, message: { type: 'chatRoomRecording', body: value } })));
	expect(await main.exists('chatVoice:recordingPublished:r1')).toBe(0);
	expect(await pubsub.exists('chatVoice:recordingPublished:r1')).toBe(1);
});

test('both transitions remain independent after reverse delivery and retry', async () => {
	await listen();
	await recover(false);
	await recover(true);
	await recover(false);
	await recover(true);
	await flushPublications();

	expect(delivered).toEqual([message(false), message(true)]);
	expect(await main.hget('flags', 'event')).toBe('3');
	expect(await main.hget('pending', 'event')).toBeNull();
});

test('a previous seen bit remains completed without replaying or recreating it', async () => {
	await listen();
	await main.zadd('seen', Date.now() + 3_600_000, 'event');
	await main.hset('flags', 'event', '1');

	await recover();
	await flushPublications();

	expect(delivered).toEqual([]);
	expect(await main.hget('flags', 'event')).toBe('1');
	expect(await main.hget('pending', 'event')).toBeNull();
	expect(await pubsub.exists('published')).toBe(0);
});

test('a full preparation budget still permits the same ID stop and both pending transitions', async () => {
	await listen();
	const deadline = Date.now() + 3_600_000;
	const seed = main.pipeline();
	for (let index = 0; index < 4095; index++) {
		seed.zadd('seen', deadline, `fixture-${index}`);
		seed.hset('flags', `fixture-${index}`, '1');
	}
	await seed.exec();

	expect(await prepare(true, 'event', 4096, deadline)).toBe(1);
	expect(await prepare(true, 'second')).toBe(-1);
	expect(await prepare(false, 'event', 4096, Date.now() + 60_000)).toBe(1);

	await publish(false);
	await acknowledge(false);
	await publish(true);
	await acknowledge(true);
	await flushPublications();

	expect(delivered).toEqual([message(false), message(true)]);
	expect(await main.zcard('seen')).toBe(4096);
	expect(await main.hget('flags', 'event')).toBe('3');
	expect(await main.hget('pending', 'event')).toBeNull();
	expect(await main.pttl('seen')).toBeGreaterThan(3_000_000);
	expect(await main.pttl('flags')).toBeGreaterThan(3_000_000);
});

test('preparation repairs pending retained by a real Lua error before its seen write', async () => {
	await listen();
	// 실제 Lua 오류가 앞선 쓰기를 되돌리지 않는 장애 상태를 준비한다. 제품의 복구 경로를 이어서 실행한다.
	const partial = "redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1]); redis.call('HSET', KEYS[2], ARGV[1], '1'); return redis.call('INCR', KEYS[2])";
	await expect(main.eval(partial, 2, 'seen', 'pending', 'event', Date.now() + 3_600_000)).rejects.toThrow('WRONGTYPE');
	expect(await main.hget('pending', 'event')).toBe('1');
	expect(await main.hget('flags', 'event')).toBeNull();

	expect(await prepare()).toBe(2);
	await recover();
	await flushPublications();

	expect(delivered).toEqual([message()]);
	expect(await main.hget('flags', 'event')).toBe('1');
	expect(await main.hget('pending', 'event')).toBeNull();
});

test('a full ID budget preserves its matching stop and the longer lifetime', async () => {
	await listen();
	const now = Date.now();
	const ledger = Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`fixture-${index}`, { flags: 1, deadline: now + 3_600_000 }]));
	await pubsub.set('published', JSON.stringify(ledger), 'PX', 3_600_000);

	expect(await publish(true, 'new-id')).toBe(-1);
	expect(await publish(false, 'fixture-0', 4096, now + 60_000)).toBe(1);
	await flushPublications();

	expect(delivered).toEqual([message(false)]);
	expect(Object.keys(JSON.parse((await pubsub.get('published'))!))).toHaveLength(4096);
	expect(await pubsub.pttl('published')).toBeGreaterThan(3_000_000);
});

test('wrong-type publication state preserves pending until the state is repaired', async () => {
	await listen();
	expect(await prepare()).toBe(1);
	await pubsub.hset('published', 'invalid', 'state');

	await expect(publish()).rejects.toThrow('WRONGTYPE');
	expect(await main.hget('pending', 'event')).toBe('1');
	await pubsub.del('published');
	await recover();
	await flushPublications();

	expect(delivered).toEqual([message()]);
});

test.skipIf(!isolated)('a lost Redis publication reply is retried without another subscriber message', async () => {
	await listen();
	expect(await prepare()).toBe(1);
	const sockets = new Set<Socket>();
	let dropReplies = false;
	const proxy = createServer(downstream => {
		const upstream = connect({ host: String(pubsubOptions.host), port: pubsubOptions.port ?? 6379 });
		sockets.add(downstream);
		sockets.add(upstream);
		downstream.pipe(upstream);
		upstream.on('data', chunk => { if (!dropReplies) downstream.write(chunk); });
		upstream.on('error', () => downstream.destroy());
		downstream.on('error', () => upstream.destroy());
		downstream.on('close', () => { sockets.delete(downstream); upstream.destroy(); });
		upstream.on('close', () => { sockets.delete(upstream); downstream.destroy(); });
	});
	proxy.listen(0, '127.0.0.1');
	await once(proxy, 'listening');
	const client = new Redis({ ...pubsubOptions, host: '127.0.0.1', port: (proxy.address() as AddressInfo).port, enableReadyCheck: false, retryStrategy: () => null });
	faultClients.add(client);
	try {
		await client.ping();
		dropReplies = true;
		const observed = once(subscriber, 'message', { signal: AbortSignal.timeout(5000) });
		// 실제 Redis가 발행한 뒤, 그 EVAL 응답만 클라이언트에 도달하지 않도록 한다.
		const result = publish(true, 'event', 4096, Date.now() + 3_600_000, client).then(() => null, error => error);
		await observed;
		client.disconnect();

		expect(await result).toBeInstanceOf(Error);
		expect(await main.hget('pending', 'event')).toBe('1');
		await recover();
		await recover();
		await flushPublications();

		expect(delivered).toEqual([message()]);
		expect(await main.hget('pending', 'event')).toBeNull();
	} finally {
		client.disconnect();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
	}
});

test.skipIf(!isolated).each(['publish', 'set'])('%s permission failure cannot leave a completed publication bit', async denied => {
	await listen();
	expect(await prepare()).toBe(1);
	const username = `test-recording-publication-${randomUUID()}`;
	const password = randomUUID();
	await pubsub.acl('SETUSER', username, 'on', `>${password}`, `~${pubsubOptions.keyPrefix}*`, `&${channel}`, '+@all', `-${denied}`);
	aclUsers.add(username);
	const restricted = new Redis({ ...pubsubOptions, username, password });
	faultClients.add(restricted);

	await expect(publish(true, 'event', 4096, Date.now() + 3_600_000, restricted)).rejects.toThrow('NOPERM');
	expect(await pubsub.exists('published')).toBe(0);
	expect(await main.hget('pending', 'event')).toBe('1');
	await pubsub.acl('SETUSER', username, `+${denied}`);
	expect(await publish(true, 'event', 4096, Date.now() + 3_600_000, restricted)).toBe(1);
	await acknowledge();
	await recover();
	await flushPublications();

	expect(delivered).toEqual([message()]);
});

test.skipIf(!isolated).each(['prepare', 'publication', 'acknowledgement'] as const)('OOM during %s preserves retry without losing or repeating the publication', async point => {
	await listen();
	if (point !== 'prepare') expect(await prepare()).toBe(1);
	if (point === 'acknowledgement') expect(await publish()).toBe(1);
	const target = point === 'publication' ? pubsub : main;
	await target.config('SET', 'maxmemory', '1');

	await expect(point === 'prepare' ? prepare() : point === 'publication' ? publish() : acknowledge()).rejects.toThrow('OOM');
	expect(await main.hget('pending', 'event')).toBe(point === 'prepare' ? null : '1');
	if (point === 'publication') expect(await pubsub.exists('published')).toBe(0);
	await target.config('SET', 'maxmemory', point === 'publication' ? initialMemory![1] : initialMemory![0]);
	await recover();
	await recover();
	await flushPublications();

	expect(delivered).toEqual([message()]);
});
