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
import { RecordingStorageService, RecordingStorageFullError, RECORDING_DOWNLOAD_STORAGE_MAX_BYTES, RECORDING_DOWNLOAD_USER_MAX_ENTRIES, type RecordingResult } from '@/core/RecordingStorageService.js';

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

// 기록 없는 파일 정리는 최근 5분 안에 바뀐 파일을 남기므로, 지워지는 경우를 확인하는 시험은 파일을 오래된 것으로 만든다
function makeOld(file: string) {
	const old = new Date(Date.now() - 6 * 60 * 1000);
	fs.utimesSync(file, old, old);
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
	makeOld(expired.path);

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
	makeOld(orphan);

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
	makeOld(expired.path);

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
	makeOld(orphan);

	const restarted = makeService();
	await restarted.onModuleInit();

	expect(fs.existsSync(orphan)).toBe(false);
});

function seedPart(id: string, userId: string, size: number, ttlMs = 60_000) {
	return redis.set(`chatVoice:recordingPart:${id}`, JSON.stringify({ id, userId, path: '/nonexistent', name: `${id}.webm`, size, type: 'audio/webm' }), 'PX', ttlMs);
}

const SLOT = 1024;

test('concurrent uploads never push the kept total over the cap', async () => {
	const service = makeService();
	await seedPart('big', 'u9', RECORDING_DOWNLOAD_STORAGE_MAX_BYTES - 3 * SLOT);

	const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => service.storePart(`u${i}`, writeSource(`c${i}.bin`, SLOT), `c${i}.webm`, 'audio/webm')));

	expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
	for (const result of results) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(RecordingStorageFullError);
	expect(await (service as any).storageUsage()).toBeLessThanOrEqual(RECORDING_DOWNLOAD_STORAGE_MAX_BYTES);
	expect(await (service as any).storageUsage()).toBe(RECORDING_DOWNLOAD_STORAGE_MAX_BYTES);
});

function writeSparseSource(name: string, bytes: number): string {
	const file = path.join(tmpRoot, name);
	fs.writeFileSync(file, '');
	fs.truncateSync(file, bytes);
	return file;
}

test('a final file larger than half of the cap is kept while the total has room', async () => {
	const service = makeService();
	const size = RECORDING_DOWNLOAD_STORAGE_MAX_BYTES / 2 + 4096;

	const record = await service.store('u1', 'r1', writeSparseSource('big.bin', size), 'big.mp4');

	expect(record.size).toBe(size);
	expect(await (service as any).storageUsage()).toBe(size);
});

test('parts and the final file of one recording are counted against the total only', async () => {
	const service = makeService();
	const third = Math.floor(RECORDING_DOWNLOAD_STORAGE_MAX_BYTES / 3);
	await seedPart('p1', 'u1', third);
	await seedPart('p2', 'u1', third);

	// 조각 두 개(약 2/3)가 남은 채로 최종 파일(약 1/3)이 들어간다
	const record = await service.store('u1', 'r1', writeSparseSource('final.bin', third), 'final.mp4');

	expect(record.size).toBe(third);
	expect(await (service as any).storageUsage()).toBe(3 * third);
	await expect(service.store('u1', 'r2', writeSparseSource('more.bin', third), 'more.mp4')).rejects.toBeInstanceOf(RecordingStorageFullError);
});

test('one user can keep up to the entry cap and others are not affected', async () => {
	const service = makeService();
	const pipeline = redis.pipeline();
	for (let i = 0; i < RECORDING_DOWNLOAD_USER_MAX_ENTRIES; i++) {
		pipeline.set(`chatVoice:recordingPart:many${i}`, JSON.stringify({ id: `many${i}`, userId: 'u1', path: '/nonexistent', name: `many${i}.webm`, size: 1, type: 'audio/webm' }), 'PX', 60_000);
	}
	await pipeline.exec();

	await expect(service.storePart('u1', writeSource('a.bin', 16), 'a.webm', 'audio/webm')).rejects.toBeInstanceOf(RecordingStorageFullError);
	await expect(service.store('u1', 'r1', writeSource('b.bin', 16), 'b.mp4')).rejects.toBeInstanceOf(RecordingStorageFullError);
	const other = await service.storePart('u2', writeSource('c.bin', 16), 'c.webm', 'audio/webm');
	expect(other.userId).toBe('u2');

	await service.removePart('many0');
	const again = await service.storePart('u1', writeSource('d.bin', 16), 'd.webm', 'audio/webm');
	expect(again.userId).toBe('u1');
}, 60_000);

async function evalStats(): Promise<{ calls: number; usec: number }> {
	const info = await redis.info('commandstats');
	const match = /cmdstat_eval:calls=(\d+),usec=(\d+)/.exec(info);
	return { calls: Number(match?.[1] ?? 0), usec: Number(match?.[2] ?? 0) };
}

test('reserving does not walk every kept entry', async () => {
	const service = makeService();
	const pipeline = redis.pipeline();
	for (let i = 0; i < 6000; i++) {
		pipeline.set(`chatVoice:recordingPart:bulk${i}`, JSON.stringify({ id: `bulk${i}`, userId: `bulk-user-${i % 60}`, path: '/nonexistent', name: `bulk${i}.webm`, size: 1, type: 'audio/webm' }), 'PX', 600_000);
	}
	await pipeline.exec();
	await service.storePart('u1', writeSource('warm.bin', 16), 'warm.webm', 'audio/webm');

	const before = await evalStats();
	for (let i = 0; i < 20; i++) await service.storePart('u1', writeSource(`w${i}.bin`, 16), `w${i}.webm`, 'audio/webm');
	const after = await evalStats();

	const perCallUsec = (after.usec - before.usec) / Math.max(1, after.calls - before.calls);
	expect(perCallUsec).toBeLessThan(1000);
}, 60_000);

test('a refused upload leaves no reservation behind', async () => {
	const service = makeService();
	await seedPart('big', 'u9', RECORDING_DOWNLOAD_STORAGE_MAX_BYTES - SLOT);

	for (let i = 0; i < 5; i++) await expect(service.storePart('u1', writeSource(`o${i}.bin`, 2 * SLOT), `o${i}.webm`, 'audio/webm')).rejects.toBeInstanceOf(RecordingStorageFullError);

	expect(await (service as any).storageUsage()).toBe(RECORDING_DOWNLOAD_STORAGE_MAX_BYTES - SLOT);
	await service.storePart('u1', writeSource('fits.bin', SLOT), 'fits.webm', 'audio/webm');
});

test('a failed copy gives the reservation back', async () => {
	const service = makeService();
	await expect(service.storePart('u1', path.join(tmpRoot, 'missing.bin'), 'missing.webm', 'audio/webm')).rejects.toThrow();
	const copy = vi.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(new Error('disk failure'));
	await expect(service.storePart('u1', writeSource('f.bin', SLOT), 'f.webm', 'audio/webm')).rejects.toThrow('disk failure');
	copy.mockRestore();

	expect(await (service as any).storageUsage()).toBe(0);
});

test('large parts are copied without blocking the event loop', async () => {
	const service = makeService();
	const copy = vi.spyOn(fs.promises, 'copyFile');
	const src = writeSource('async.bin', 4096);
	const part = await service.storePart('u1', src, 'async.webm', 'audio/webm');

	expect(copy).toHaveBeenCalledWith(src, part.path);
	copy.mockRestore();
	expect(fs.readFileSync(part.path).equals(fs.readFileSync(src))).toBe(true);
});

test('removing kept files and parts frees their share for new uploads', async () => {
	const service = makeService();
	await seedPart('big', 'u9', RECORDING_DOWNLOAD_STORAGE_MAX_BYTES - 2 * SLOT);
	const kept = await service.store('u1', 'r1', writeSource('k.bin', SLOT), 'k.mp4');
	const part = await service.storePart('u2', writeSource('p.bin', SLOT), 'p.webm', 'audio/webm');
	await expect(service.storePart('u3', writeSource('x.bin', SLOT), 'x.webm', 'audio/webm')).rejects.toBeInstanceOf(RecordingStorageFullError);

	await service.removeDownload(kept.id);
	await service.removePart(part.id);

	expect(await (service as any).storageUsage()).toBe(RECORDING_DOWNLOAD_STORAGE_MAX_BYTES - 2 * SLOT);
	await service.storePart('u3', writeSource('y.bin', 2 * SLOT), 'y.webm', 'audio/webm');
});

test('expired keeps stop counting toward the cap', async () => {
	const service = makeService();
	await seedPart('old', 'u9', RECORDING_DOWNLOAD_STORAGE_MAX_BYTES - SLOT, 60_000);
	await seedPart('keep', 'u8', SLOT, 3_600_000);
	await expect(service.storePart('u1', writeSource('n.bin', SLOT), 'n.webm', 'audio/webm')).rejects.toBeInstanceOf(RecordingStorageFullError);
	const realNow = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 120_000);

	try {
		await (service as any).sweep();
		await service.storePart('u1', writeSource('m.bin', SLOT), 'm.webm', 'audio/webm');
		expect(await (service as any).storageUsage()).toBe(2 * SLOT);
	} finally {
		clock.mockRestore();
	}
});

test('kept files that were stored before are still counted', async () => {
	const service = makeService();
	await seedPart('before', 'u1', RECORDING_DOWNLOAD_STORAGE_MAX_BYTES - SLOT);

	await service.storePart('u1', writeSource('a.bin', SLOT), 'a.webm', 'audio/webm');

	await expect(service.storePart('u1', writeSource('b.bin', SLOT), 'b.webm', 'audio/webm')).rejects.toBeInstanceOf(RecordingStorageFullError);
	expect(await (service as any).storageUsage()).toBe(RECORDING_DOWNLOAD_STORAGE_MAX_BYTES);
});

function bareService() {
	const service = new RecordingStorageService(
		redis,
		{ findOneBy: vi.fn(async () => null) } as any,
		{ deleteFile: vi.fn(async () => {}) } as any,
		loggerService(),
	);
	services.push(service);
	return service;
}

test('a newly created keeping folder is private to its owner', async () => {
	const service = bareService();
	fs.rmSync(dirOf(service), { recursive: true, force: true });

	await service.onModuleInit();

	expect(fs.statSync(dirOf(service)).mode & 0o777).toBe(0o700);
});

test('an existing keeping folder of the same user gets owner-only permissions and stays usable', async () => {
	const service = bareService();
	fs.rmSync(dirOf(service), { recursive: true, force: true });
	fs.mkdirSync(dirOf(service), { mode: 0o755 });
	fs.chmodSync(dirOf(service), 0o755);
	const leftover = path.join(dirOf(service), 'leftover');
	fs.writeFileSync(leftover, 'kept');

	await service.onModuleInit();

	expect(fs.statSync(dirOf(service)).mode & 0o777).toBe(0o700);
	const record = await service.store('u1', 'r1', writeSource('after.bin', 1024), 'after.mp4');
	expect(fs.existsSync(record.path)).toBe(true);
	expect(await service.getDownload(record.id)).not.toBeNull();
});

test('a keeping folder that is a symbolic link is not used', async () => {
	const service = bareService();
	fs.rmSync(dirOf(service), { recursive: true, force: true });
	const elsewhere = fs.mkdtempSync(path.join(tmpRoot, 'elsewhere-'));
	fs.symlinkSync(elsewhere, dirOf(service));

	await service.onModuleInit();

	await expect(service.store('u1', 'r1', writeSource('s.bin', 1024), 's.mp4')).rejects.toBeInstanceOf(RecordingStorageFullError);
	await expect(service.storePart('u1', writeSource('t.bin', 1024), 't.webm', 'audio/webm')).rejects.toBeInstanceOf(RecordingStorageFullError);
	expect(fs.readdirSync(elsewhere)).toEqual([]);
	fs.rmSync(dirOf(service), { force: true });
});

test('a keeping folder owned by someone else is not used', async () => {
	const service = bareService();
	fs.rmSync(dirOf(service), { recursive: true, force: true });
	fs.mkdirSync(dirOf(service), { mode: 0o755 });
	fs.chmodSync(dirOf(service), 0o755);
	vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);

	await service.onModuleInit();
	vi.restoreAllMocks();

	expect(fs.statSync(dirOf(service)).mode & 0o777).toBe(0o755);
	await expect(service.store('u1', 'r1', writeSource('o.bin', 1024), 'o.mp4')).rejects.toBeInstanceOf(RecordingStorageFullError);
});

test('the periodic cleanup runs without a usable keeping folder', async () => {
	const driveFilesRepository = { findOneBy: vi.fn(async () => ({ id: 'left1' })) };
	const driveService = { deleteFile: vi.fn(async () => {}) };
	const service = new RecordingStorageService(redis, driveFilesRepository as any, driveService as any, loggerService());
	services.push(service);
	fs.rmSync(dirOf(service), { recursive: true, force: true });
	const elsewhere = fs.mkdtempSync(path.join(tmpRoot, 'elsewhere-'));
	fs.symlinkSync(elsewhere, dirOf(service));
	await service.setResult('u1', 'r1', { remainingParts: ['left1'] });

	await service.onModuleInit();

	expect(driveService.deleteFile).toHaveBeenCalledTimes(1);
	expect((await service.getResult('u1', 'r1'))?.remainingParts).toEqual([]);
	expect((service as any).sweepTimer).not.toBeNull();
	await expect(service.store('u1', 'r1', writeSource('s.bin', 1024), 's.mp4')).rejects.toBeInstanceOf(RecordingStorageFullError);
	fs.rmSync(dirOf(service), { force: true });
});

test('the sweep keeps a file without a record that was modified within the last 5 minutes', async () => {
	const service = makeService();
	const fresh = path.join(dirOf(service), 'fresh-orphan.bin');
	fs.writeFileSync(fresh, 'x');

	await (service as any).sweep();

	expect(fs.existsSync(fresh)).toBe(true);
});

test('the sweep removes a file without a record that was last modified more than 5 minutes ago', async () => {
	const service = makeService();
	const stale = path.join(dirOf(service), 'stale-orphan.bin');
	fs.writeFileSync(stale, 'x');
	makeOld(stale);

	await (service as any).sweep();

	expect(fs.existsSync(stale)).toBe(false);
});

test('a part being copied survives a sweep that runs before its record is written', async () => {
	const service = makeService();
	const realCopy = fs.promises.copyFile;
	const copy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (src, dest, mode) => {
		await realCopy(src, dest, mode);
		await (service as any).sweep();
	});

	try {
		const part = await service.storePart('u1', writeSource('copying.bin', 2048), 'copying.webm', 'audio/webm');
		expect(fs.existsSync(part.path)).toBe(true);
		expect(await service.getPart(part.id)).not.toBeNull();
	} finally {
		copy.mockRestore();
	}
});
