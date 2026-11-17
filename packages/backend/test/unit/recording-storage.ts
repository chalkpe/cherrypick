/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { loadConfig } from '@/config.js';
import { RecordingStorageService, RecordingStorageFullError, RECORDING_DOWNLOAD_STORAGE_MAX_BYTES, type RecordingResult } from '@/core/RecordingStorageService.js';

// 본 Redis 클라이언트(제품 설정과 같은 keyPrefix)와 실제 임시 디렉터리로 보관 수명 주기를 확인한다.
let redis: Redis;
let tmpRoot: string;
let previousTmpdir: string | undefined;
const prefix = `test-recording-storage-${randomUUID()}:`;
const services: RecordingStorageService[] = [];
const extraClients: Redis[] = [];

function loggerService() {
	return { getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) } as any;
}

function makeService() {
	const service = new RecordingStorageService(
		redis,
		{ findOneBy: vi.fn(async () => null) } as any,
		{ deleteFile: vi.fn(async () => {}) } as any,
		loggerService(),
	);
	fs.mkdirSync(dirOf(service), { recursive: true });
	services.push(service);
	return service;
}

// 다른 keyPrefix를 쓰는 인스턴스(별도 클라이언트)를 만든다
async function makeServiceWithPrefix(otherPrefix: string) {
	const client = new Redis({ ...loadConfig().redis, keyPrefix: otherPrefix, lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 });
	await client.connect();
	extraClients.push(client);
	const service = new RecordingStorageService(
		client,
		{ findOneBy: vi.fn(async () => null) } as any,
		{ deleteFile: vi.fn(async () => {}) } as any,
		loggerService(),
	);
	fs.mkdirSync(dirOf(service), { recursive: true });
	services.push(service);
	return service;
}

function dirOf(service: RecordingStorageService): string {
	return (service as any).dir as string;
}

function writeSource(name: string, bytes: number): string {
	const file = path.join(tmpRoot, name);
	fs.writeFileSync(file, Buffer.alloc(bytes, 7));
	return file;
}

beforeAll(async () => {
	previousTmpdir = process.env.TMPDIR;
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-storage-test-'));
	process.env.TMPDIR = tmpRoot;
	const config = loadConfig();
	redis = new Redis({ ...config.redis, keyPrefix: prefix, lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 });
	await redis.connect();
});

afterEach(async () => {
	for (const service of services.splice(0)) service.onApplicationShutdown();
	if (redis?.status === 'ready') {
		const keys = await redis.keys(`${prefix}*`);
		if (keys.length > 0) await redis.del(...keys.map(name => name.slice(prefix.length)));
	}
	for (const client of extraClients.splice(0)) {
		if (client.status === 'ready') {
			const keyPrefix = client.options.keyPrefix ?? '';
			const keys = await client.keys('*');
			const mine = keys.filter(name => name.startsWith(keyPrefix));
			if (mine.length > 0) await client.del(...mine.map(name => name.slice(keyPrefix.length)));
		}
		client.disconnect();
	}
	// 인스턴스별 보관 폴더(이름에 인스턴스 식별자가 붙는다)를 모두 정리한다
	for (const entry of fs.readdirSync(tmpRoot)) {
		if (!entry.startsWith('cherrypick-recording-downloads')) continue;
		const dir = path.join(tmpRoot, entry);
		for (const file of fs.readdirSync(dir)) fs.rmSync(path.join(dir, file), { force: true });
	}
});

afterAll(() => {
	redis?.disconnect();
	if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('a kept file is found again under the real key prefix', async () => {
	const service = makeService();
	const src = writeSource('src.bin', 1024);
	const record = await service.store('u1', 'r1', src, 'recording.mp4');

	expect(fs.existsSync(record.path)).toBe(true);
	const found = await service.getDownload(record.id);
	expect(found).toMatchObject({ id: record.id, userId: 'u1', requestId: 'r1', size: 1024 });
});

test('the sweep keeps a live kept file and removes an expired one', async () => {
	const service = makeService();
	const live = await service.store('u1', 'r1', writeSource('live.bin', 2048), 'live.mp4');
	const expired = await service.store('u1', 'r2', writeSource('expired.bin', 2048), 'expired.mp4');
	await redis.pexpire(`chatVoice:recordingDownload:${expired.id}`, 1);
	await new Promise(resolve => setTimeout(resolve, 20));

	await (service as any).sweep();

	expect(fs.existsSync(live.path)).toBe(true);
	expect(fs.existsSync(expired.path)).toBe(false);
	expect(await service.getDownload(live.id)).not.toBeNull();
});

test('storage usage adds up the kept files under the real key prefix', async () => {
	const service = makeService();
	await service.store('u1', 'r1', writeSource('a.bin', 4096), 'a.mp4');
	await service.store('u2', 'r2', writeSource('b.bin', 8192), 'b.mp4');

	expect(await (service as any).storageUsage()).toBe(4096 + 8192);
});

test('storage full is decided against the real kept total', async () => {
	const service = makeService();
	// 기록만 남은 큰 보관이 총량을 거의 채운 상황
	await redis.set('chatVoice:recordingDownload:big', JSON.stringify({ id: 'big', userId: 'u1', requestId: 'r0', path: '/nonexistent', name: 'big.mp4', size: RECORDING_DOWNLOAD_STORAGE_MAX_BYTES - 1024 }), 'PX', 60_000);

	await expect(service.store('u1', 'r1', writeSource('over.bin', 2048), 'over.mp4'))
		.rejects.toBeInstanceOf(RecordingStorageFullError);
});

test('a new instance initializing does not remove a live kept file of another process', async () => {
	const owner = makeService();
	const record = await owner.store('u1', 'r1', writeSource('kept.bin', 2048), 'kept.mp4');

	const other = makeService();
	await other.onModuleInit();

	expect(fs.existsSync(record.path)).toBe(true);
	expect(await owner.getDownload(record.id)).not.toBeNull();
});

test('initialization still removes files that have no record', async () => {
	const service = makeService();
	await service.onModuleInit();
	const orphan = path.join(dirOf(service), 'orphan.bin');
	fs.writeFileSync(orphan, 'x');

	const restarted = makeService();
	await restarted.onModuleInit();

	expect(fs.existsSync(orphan)).toBe(false);
});

test('completing a download keeps the leftover-part cleanup record', async () => {
	const service = makeService();
	const record = await service.store('u1', 'r1', writeSource('final.bin', 2048), 'final.mp4');
	const result: RecordingResult = { download: { id: record.id, name: record.name, size: record.size, reason: 'tooLarge' }, remainingParts: ['p1', 'p2'] };
	await service.setResult('u1', 'r1', result);

	await service.removeDownload(record.id);

	expect(fs.existsSync(record.path)).toBe(false);
	expect(await service.getDownload(record.id)).toBeNull();
	const left = await service.getResult('u1', 'r1');
	expect(left).not.toBeNull();
	expect(left!.download).toBeUndefined();
	expect(left!.remainingParts).toEqual(['p1', 'p2']);
});

test('completing a download without leftover parts removes the result', async () => {
	const service = makeService();
	const record = await service.store('u1', 'r1', writeSource('final.bin', 2048), 'final.mp4');
	await service.setResult('u1', 'r1', { download: { id: record.id, name: record.name, size: record.size, reason: 'tooLarge' }, remainingParts: [] });

	await service.removeDownload(record.id);

	expect(await service.getResult('u1', 'r1')).toBeNull();
});

test('the sweep retries leftover parts after the download expired', async () => {
	const service = makeService();
	const record = await service.store('u1', 'r1', writeSource('final.bin', 2048), 'final.mp4');
	await service.setResult('u1', 'r1', { download: { id: record.id, name: record.name, size: record.size, reason: 'tooLarge' }, remainingParts: ['p1'] });
	const deleteFile = (service as any).driveService.deleteFile as ReturnType<typeof vi.fn>;
	const findOneBy = (service as any).driveFilesRepository.findOneBy as ReturnType<typeof vi.fn>;
	findOneBy.mockResolvedValue({ id: 'p1', userId: 'u1' });
	await redis.pexpire(`chatVoice:recordingDownload:${record.id}`, 1);
	await new Promise(resolve => setTimeout(resolve, 20));

	await (service as any).sweep();

	expect(deleteFile).toHaveBeenCalledTimes(1);
	const left = await service.getResult('u1', 'r1');
	expect(left?.remainingParts ?? []).toEqual([]);
});

test('the sweep removes a result whose download vanished with no parts left', async () => {
	const service = makeService();
	const record = await service.store('u1', 'r1', writeSource('final.bin', 2048), 'final.mp4');
	await service.setResult('u1', 'r1', { download: { id: record.id, name: record.name, size: record.size, reason: 'tooLarge' }, remainingParts: [] });
	await redis.pexpire(`chatVoice:recordingDownload:${record.id}`, 1);
	await new Promise(resolve => setTimeout(resolve, 20));

	await (service as any).sweep();

	expect(await service.getResult('u1', 'r1')).toBeNull();
});

test('a key prefix with glob characters still finds its own kept files', async () => {
	// 대괄호·별표·물음표·역슬래시가 든 prefix도 SCAN MATCH에서 리터럴로 검색되어야 한다
	const globPrefix = `test-recording-glob-[x]*?\\-${randomUUID()}:`;
	const service = await makeServiceWithPrefix(globPrefix);
	const record = await service.store('u1', 'r1', writeSource('glob.bin', 4096), 'glob.mp4');

	expect(await (service as any).storageUsage()).toBe(4096);

	await (service as any).sweep();

	expect(fs.existsSync(record.path)).toBe(true);
	expect(await service.getDownload(record.id)).not.toBeNull();
});

test('instances with different key prefixes do not remove each other\'s kept files in a shared temp directory', async () => {
	// 같은 호스트의 두 인스턴스가 같은 임시 폴더를 써도 보관 폴더가 인스턴스별로 나뉘어야 한다
	const owner = makeService();
	const record = await owner.store('u1', 'r1', writeSource('shared.bin', 2048), 'shared.mp4');

	const other = await makeServiceWithPrefix(`test-recording-storage-other-${randomUUID()}:`);
	await other.onModuleInit();
	await (other as any).sweep();

	expect(fs.existsSync(record.path)).toBe(true);
	expect(await owner.getDownload(record.id)).not.toBeNull();
});

test('a stored part is found again and shares the storage cap with kept files', async () => {
	const service = makeService();
	const kept = await service.store('u1', 'r1', writeSource('kept.bin', 4096), 'kept.mp4');
	const part = await service.storePart('u1', writeSource('part.bin', 2048), 'room 1-20261116-120000-002.webm', 'audio/webm');

	expect(fs.existsSync(part.path)).toBe(true);
	expect(await service.getPart(part.id)).toMatchObject({ id: part.id, userId: 'u1', size: 2048, type: 'audio/webm' });
	expect(await (service as any).storageUsage()).toBe(4096 + 2048);
	expect(fs.existsSync(kept.path)).toBe(true);
});

test('storage full is decided against kept files and parts together', async () => {
	const service = makeService();
	await redis.set('chatVoice:recordingPart:big', JSON.stringify({ id: 'big', userId: 'u1', path: '/nonexistent', name: 'big.webm', size: RECORDING_DOWNLOAD_STORAGE_MAX_BYTES - 1024, type: 'audio/webm' }), 'PX', 60_000);

	await expect(service.storePart('u1', writeSource('over.bin', 2048), 'over.webm', 'audio/webm'))
		.rejects.toBeInstanceOf(RecordingStorageFullError);
});

test('removing a part deletes the file and the record', async () => {
	const service = makeService();
	const part = await service.storePart('u1', writeSource('part.bin', 1024), 'part.webm', 'audio/webm');

	await service.removePart(part.id);

	expect(fs.existsSync(part.path)).toBe(false);
	expect(await service.getPart(part.id)).toBeNull();
});

test('the sweep keeps a live part and removes an expired one', async () => {
	const service = makeService();
	const live = await service.storePart('u1', writeSource('live.bin', 2048), 'live.webm', 'audio/webm');
	const expired = await service.storePart('u1', writeSource('expired.bin', 2048), 'expired.webm', 'audio/webm');
	await redis.pexpire(`chatVoice:recordingPart:${expired.id}`, 1);
	await new Promise(resolve => setTimeout(resolve, 20));

	await (service as any).sweep();

	expect(fs.existsSync(live.path)).toBe(true);
	expect(fs.existsSync(expired.path)).toBe(false);
	expect(await service.getPart(live.id)).not.toBeNull();
});

test('initialization removes part files that have no record', async () => {
	const service = makeService();
	await service.onModuleInit();
	const orphan = path.join(dirOf(service), 'orphan-part.bin');
	fs.writeFileSync(orphan, 'x');

	const restarted = makeService();
	await restarted.onModuleInit();

	expect(fs.existsSync(orphan)).toBe(false);
});
