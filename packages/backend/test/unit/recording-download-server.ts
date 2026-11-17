/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { loadConfig } from '@/config.js';
import { RecordingStorageService } from '@/core/RecordingStorageService.js';
import { RecordingDownloadServerService } from '@/server/RecordingDownloadServerService.js';
import type { AuthenticateService } from '@/server/api/AuthenticateService.js';
import type { RateLimiterService } from '@/server/api/RateLimiterService.js';

// 실제 보관 서비스와 실제 Fastify 라우터로 전용 내려받기 경로의 인증·전달·한 번 삭제를 확인한다.
let redis: Redis;
let tmpRoot: string;
let previousTmpdir: string | undefined;
const prefix = `test-recording-download-${randomUUID()}:`;
const servers: FastifyInstance[] = [];
let baseUrl: string;
let authenticate: ReturnType<typeof vi.fn>;
let storage: RecordingStorageService;
let storageDir: string;

const owner = { id: 'u1', isSuspended: false } as any;
const stranger = { id: 'u2', isSuspended: false } as any;
const tokens: Record<string, [any, any, any]> = {
	'native-owner': [owner, null, null],
	'native-stranger': [stranger, null, null],
	'app-read': [owner, { permission: ['read:drive'] }, null],
	'app-write-only': [owner, { permission: ['write:drive'] }, null],
	'flash-read': [owner, null, { permissions: ['read:drive'] }],
	'flash-write-only': [owner, null, { permissions: ['write:drive'] }],
	'suspended-owner': [{ id: 'u1', isSuspended: true }, null, null],
};

function makeStorage() {
	return storage;
}

async function keptFile(storage: RecordingStorageService, bytes = 4096) {
	const src = path.join(tmpRoot, `src-${randomUUID()}.bin`);
	fs.writeFileSync(src, Buffer.alloc(bytes, 3));
	return await storage.store('u1', randomUUID(), src, 'recording.mp4');
}

function get(urlPath: string, init: RequestInit = {}) {
	return fetch(baseUrl + urlPath, init);
}

async function waitUntil(cond: () => Promise<boolean>, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cond()) return;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error('condition not met in time');
}

beforeAll(async () => {
	previousTmpdir = process.env.TMPDIR;
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-download-test-'));
	process.env.TMPDIR = tmpRoot;
	const config = loadConfig();
	redis = new Redis({ ...config.redis, keyPrefix: prefix, lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 });
	await redis.connect();

	authenticate = vi.fn(async (token: string | null | undefined) => {
		if (token != null && token in tokens) return tokens[token];
		return [null, null, null];
	});
	storage = new RecordingStorageService(
		redis,
		{ findOneBy: vi.fn(async () => null) } as any,
		{ deleteFile: vi.fn(async () => {}) } as any,
		{ getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) } as any,
	);
	storageDir = (storage as any).dir as string;
	fs.mkdirSync(storageDir, { recursive: true });
	const downloadServer = new RecordingDownloadServerService(
		storage,
		{ authenticate } as unknown as AuthenticateService,
		{ limit: vi.fn(async () => null) } as unknown as RateLimiterService,
	);
	const fastify = Fastify({ logger: false });
	fastify.register(downloadServer.createServer);
	await fastify.listen({ port: 0, host: '127.0.0.1' });
	servers.push(fastify);
	const address = fastify.server.address();
	if (address == null || typeof address === 'string') throw new Error('no port');
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
	if (redis?.status === 'ready') {
		const keys = await redis.keys(`${prefix}*`);
		if (keys.length > 0) await redis.del(...keys.map(name => name.slice(prefix.length)));
	}
	for (const entry of fs.existsSync(storageDir) ? fs.readdirSync(storageDir) : []) fs.rmSync(path.join(storageDir, entry), { force: true });
});

afterAll(async () => {
	storage?.onApplicationShutdown();
	for (const server of servers.splice(0)) await server.close();
	redis?.disconnect();
	if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('the owner receives the kept file once and it is removed after the body was sent', async () => {
	const storage = makeStorage();
	const record = await keptFile(storage);

	const res = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer native-owner' } });
	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('application/octet-stream');
	const body = Buffer.from(await res.arrayBuffer());
	expect(body.length).toBe(record.size);

	await waitUntil(async () => (await storage.getDownload(record.id)) == null);
	expect(fs.existsSync(record.path)).toBe(false);
	const again = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer native-owner' } });
	expect(again.status).toBe(404);
});

test('a HEAD request does not consume the kept download', async () => {
	const storage = makeStorage();
	const record = await keptFile(storage);

	const head = await get(`/recording-download/${record.id}`, { method: 'HEAD', headers: { Authorization: 'Bearer native-owner' } });
	expect([404, 405]).toContain(head.status);
	await new Promise(resolve => setTimeout(resolve, 300));

	const res = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer native-owner' } });
	expect(res.status).toBe(200);
	expect(Buffer.from(await res.arrayBuffer()).length).toBe(record.size);
});

test('an app token without read:drive cannot read the kept file', async () => {
	const storage = makeStorage();
	const record = await keptFile(storage);

	const res = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer app-write-only' } });
	expect(res.status).toBe(403);
	expect(fs.existsSync(record.path)).toBe(true);
	expect(await storage.getDownload(record.id)).not.toBeNull();
});

test('a flash token without read:drive cannot read the kept file', async () => {
	const storage = makeStorage();
	const record = await keptFile(storage);

	const res = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer flash-write-only' } });
	expect(res.status).toBe(403);
	expect(fs.existsSync(record.path)).toBe(true);
});

test('an app token with read:drive receives the kept file', async () => {
	const storage = makeStorage();
	const record = await keptFile(storage);

	const res = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer app-read' } });
	expect(res.status).toBe(200);
	expect(Buffer.from(await res.arrayBuffer()).length).toBe(record.size);
});

test('a flash token with read:drive receives the kept file', async () => {
	const storage = makeStorage();
	const record = await keptFile(storage);

	const res = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer flash-read' } });
	expect(res.status).toBe(200);
	expect(Buffer.from(await res.arrayBuffer()).length).toBe(record.size);
});

test('a suspended account cannot read the kept file', async () => {
	const storage = makeStorage();
	const record = await keptFile(storage);

	const res = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer suspended-owner' } });
	expect(res.status).toBe(403);
	expect(fs.existsSync(record.path)).toBe(true);
});

test('the token is only accepted from the Authorization header', async () => {
	const storage = makeStorage();
	const record = await keptFile(storage);

	const res = await get(`/recording-download/${record.id}?i=native-owner`);
	expect(res.status).toBe(401);
	expect(fs.existsSync(record.path)).toBe(true);
});

test('another user does not find the kept file', async () => {
	const storage = makeStorage();
	const record = await keptFile(storage);

	const res = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer native-stranger' } });
	expect(res.status).toBe(404);
	expect(fs.existsSync(record.path)).toBe(true);
});

test('an interrupted transfer leaves the kept file for a retry', async () => {
	const storage = makeStorage();
	const record = await keptFile(storage, 8 * 1024 * 1024);

	// 본문을 받다가 연결을 끊는다
	await new Promise<void>((resolve, reject) => {
		const req = http.get(`${baseUrl}/recording-download/${record.id}`, { headers: { Authorization: 'Bearer native-owner' } }, res => {
			res.once('data', () => {
				req.destroy();
				resolve();
			});
			res.on('error', () => {});
		});
		req.on('error', () => {});
		setTimeout(() => reject(new Error('no data')), 10_000).unref();
	});
	await new Promise(resolve => setTimeout(resolve, 300));

	expect(fs.existsSync(record.path)).toBe(true);
	expect(await storage.getDownload(record.id)).not.toBeNull();
	const res = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer native-owner' } });
	expect(res.status).toBe(200);
	expect(Buffer.from(await res.arrayBuffer()).length).toBe(record.size);
});

test('a file read error does not consume the kept download and a later retry succeeds', async () => {
	const storage = makeStorage();
	const record = await keptFile(storage);

	// 파일 자리에 디렉터리를 두어 읽기 스트림이 첫 본문 전에 오류(EISDIR)를 내게 한다
	fs.rmSync(record.path);
	fs.mkdirSync(record.path);

	const res = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer native-owner' } });
	expect(res.status).toBe(500);
	expect(Buffer.from(await res.arrayBuffer()).length).toBe(0);
	await new Promise(resolve => setTimeout(resolve, 300));

	// 오류 응답 뒤에도 기록과 파일이 남아 있어야 한다
	expect(await storage.getDownload(record.id)).not.toBeNull();
	expect(fs.existsSync(record.path)).toBe(true);

	// 오류가 회복되면 같은 ID로 다시 받을 수 있어야 한다
	fs.rmSync(record.path, { recursive: true });
	fs.writeFileSync(record.path, Buffer.alloc(record.size, 3));
	const retry = await get(`/recording-download/${record.id}`, { headers: { Authorization: 'Bearer native-owner' } });
	expect(retry.status).toBe(200);
	expect(Buffer.from(await retry.arrayBuffer()).length).toBe(record.size);

	await waitUntil(async () => (await storage.getDownload(record.id)) == null);
	expect(fs.existsSync(record.path)).toBe(false);
});
