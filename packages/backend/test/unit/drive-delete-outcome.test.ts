/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { DriveService } from '@/core/DriveService.js';
import { DriveDeletionService } from '@/core/DriveDeletionService.js';
import { QueueService } from '@/core/QueueService.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { DriveFilesRepository } from '@/models/_.js';

// 실제 삭제·큐 접수 메서드를 사용하고 DB/Redis 전송 경계만 대체한다.
function storageFixture() {
	const file = {
		id: 'file', userId: 'owner', userHost: null, size: 123,
		isLink: false, storedInternal: false, accessKey: 'original',
		thumbnailUrl: '/thumbnail', thumbnailAccessKey: 'thumbnail',
		webpublicUrl: '/webpublic', webpublicAccessKey: 'webpublic',
	} as MiDriveFile;
	const rows = new Map([[file.id, file]]);
	const chart = { update: vi.fn() };
	const perUserChart = { update: vi.fn() };
	const stream = { publishDriveStream: vi.fn() };
	const add = vi.fn(async (_name: string, _data: { key: string }) => ({}));
	const queue = Object.create(QueueService.prototype) as QueueService;
	Object.assign(queue, { objectStorageQueue: { add } });
	const repository = {
		findOneBy: async ({ id, userId }: { id: string; userId: string }) => rows.get(id)?.userId === userId ? rows.get(id) : null,
		delete: async (id: string) => ({ affected: rows.delete(id) ? 1 : 0 }),
	};
	const drive = Object.create(DriveService.prototype) as DriveService;
	Object.assign(drive, {
		queueService: queue, driveFilesRepository: repository,
		driveChart: chart, perUserDriveChart: perUserChart, globalEventService: stream,
	});
	let fields: Record<string, string> = {};
	const redis = {
		hgetall: async () => ({ ...fields }), expire: async () => 1,
		multi: () => {
			const actions: (() => void)[] = [];
			const pipeline = {
				del() { actions.push(() => { fields = {}; }); return pipeline; },
				hset(_key: string, values: Record<string, string>) { actions.push(() => Object.assign(fields, values)); return pipeline; },
				expire() { return pipeline; },
				async exec() { for (const action of actions) action(); return []; },
			};
			return pipeline;
		},
	};
	const runner = {
		connect: async () => {}, release: async () => {},
		manager: { getRepository: () => repository },
		query: async (sql: string) => sql.includes('pg_try_advisory_lock') ? [{ locked: true }]
			: sql.includes('AS files') ? [{ files: String(rows.size), folders: '0' }] : [],
	};
	const deletion = new DriveDeletionService({ createQueryRunner: () => runner } as never, redis as never, drive, stream as never);
	return { file, rows, chart, perUserChart, stream, add, drive, deletion, me: { id: 'owner' } as never };
}

test.each(['original', 'thumbnail', 'webpublic'])('preserves all storage keys after %s enqueue failure and accounts only once after reconfirmation', async failedKey => {
	const f = storageFixture();
	const accepted: string[] = [];
	let failing = true;
	f.add.mockImplementation(async (_name, { key }) => {
		if (failing && key === failedKey) throw new Error('Redis rejected enqueue');
		accepted.push(key);
		return {};
	});
	// 기본 경로가 거절을 방치하는 RED에서도 프로세스 종료 없이 결과를 관찰한다.
	const add = f.add.getMockImplementation()!;
	f.add.mockImplementation((...args) => {
		const result = add(...args);
		void result.catch(() => {});
		return result;
	});
	const plan = await f.deletion.prepare(f.me, { fileIds: ['file', 'file'] });

	const failed = await f.deletion.execute(f.me, plan.operationId);

	expect(failed).toMatchObject({ deletedCount: 0, missingCount: 0, failedCount: 1, remainingCount: 1 });
	expect(f.rows.get('file')).toMatchObject({ accessKey: 'original', thumbnailAccessKey: 'thumbnail', webpublicAccessKey: 'webpublic' });
	expect(f.chart.update).not.toHaveBeenCalled();
	expect(f.perUserChart.update).not.toHaveBeenCalled();
	expect(f.stream.publishDriveStream).not.toHaveBeenCalled();
	expect(await f.deletion.execute(f.me, plan.operationId)).toEqual(failed);
	expect(accepted).toEqual(['original', 'thumbnail', 'webpublic'].slice(0, ['original', 'thumbnail', 'webpublic'].indexOf(failedKey)));

	failing = false;
	const retry = await f.deletion.prepare(f.me, { fileIds: ['file'] });
	const recovered = await f.deletion.execute(f.me, retry.operationId);

	expect(recovered).toMatchObject({ deletedCount: 1, missingCount: 0, failedCount: 0, remainingCount: 0 });
	expect(new Set(accepted)).toEqual(new Set(['original', 'thumbnail', 'webpublic']));
	expect(f.rows.size).toBe(0);
	expect(f.chart.update).toHaveBeenCalledExactlyOnceWith(f.file, false);
	expect(f.perUserChart.update).toHaveBeenCalledExactlyOnceWith(f.file, false);
	expect(f.stream.publishDriveStream).toHaveBeenCalledExactlyOnceWith('owner', 'fileDeleted', 'file');
	expect(await f.deletion.execute(f.me, retry.operationId)).toEqual(recovered);
	expect(f.chart.update).toHaveBeenCalledTimes(1);
});

test('retries already removed objects after partial acceptance without counting the DB row twice', async () => {
	const f = storageFixture();
	const storage = new Set(['original', 'thumbnail', 'webpublic']);
	Object.assign(f.drive, {
		meta: { objectStorageBucket: 'unit' },
		s3Service: { delete: async (_meta: unknown, { Key }: { Key: string }) => {
			if (!storage.delete(Key)) throw Object.assign(new Error('Already removed'), { name: 'NoSuchKey' });
		} },
		deleteLogger: { warn: vi.fn() },
	});
	let failing = true;
	f.add.mockImplementation(async (_name, { key }) => {
		if (failing && key === 'thumbnail') throw new Error('Redis rejected enqueue');
		await f.drive.deleteObjectStorageFile(key);
		return {};
	});
	const plan = await f.deletion.prepare(f.me, { fileIds: ['file'] });

	expect(await f.deletion.execute(f.me, plan.operationId)).toMatchObject({ failedCount: 1, deletedCount: 0 });
	expect(storage).toEqual(new Set(['thumbnail', 'webpublic']));
	expect(f.rows.has('file')).toBe(true);

	failing = false;
	const retry = await f.deletion.prepare(f.me, { fileIds: ['file'] });
	expect(await f.deletion.execute(f.me, retry.operationId)).toMatchObject({ failedCount: 0, deletedCount: 1 });
	expect(storage.size).toBe(0);
	expect(f.rows.size).toBe(0);
	expect(f.chart.update).toHaveBeenCalledTimes(1);
	expect(f.perUserChart.update).toHaveBeenCalledTimes(1);
	expect(f.stream.publishDriveStream).toHaveBeenCalledTimes(1);
});

test('concurrent queue-backed deletion changes counters and events only for the removed row', async () => {
	const f = storageFixture();
	const outcomes = await Promise.all([
		f.drive.deleteFile(f.file, false, undefined, undefined, { awaitStorageQueue: true }),
		f.drive.deleteFile(f.file, false, undefined, undefined, { awaitStorageQueue: true }),
	]);

	expect(outcomes).toEqual([true, false]);
	expect(f.rows.size).toBe(0);
	expect(f.chart.update).toHaveBeenCalledTimes(1);
	expect(f.perUserChart.update).toHaveBeenCalledTimes(1);
	expect(f.stream.publishDriveStream).toHaveBeenCalledTimes(1);
});

test('confirmed deletion waits for queue acceptance while existing callers keep their default behavior', async () => {
	const f = storageFixture();
	let accept!: () => void;
	let entered!: () => void;
	const queued = new Promise<void>(resolve => { entered = resolve; });
	const acceptance = new Promise<void>(resolve => { accept = resolve; });
	f.add.mockImplementation(async () => { entered(); await acceptance; return {}; });
	const plan = await f.deletion.prepare(f.me, { fileIds: ['file'] });
	const execution = f.deletion.execute(f.me, plan.operationId);
	await queued;

	expect(f.rows.has('file')).toBe(true);
	expect(f.stream.publishDriveStream).not.toHaveBeenCalled();
	accept();
	expect(await execution).toMatchObject({ deletedCount: 1, failedCount: 0 });

	const existing = storageFixture();
	let finish!: () => void;
	const pending = new Promise<void>(resolve => { finish = resolve; });
	existing.add.mockImplementation(async () => { await pending; return {}; });
	try {
		expect(await existing.drive.deleteFile(existing.file)).toBe(true);
		expect(existing.rows.size).toBe(0);
	} finally { finish(); }
});

// 실제 삭제 메서드를 호출하고 DB 삭제 경계만 대체하여 통계/이벤트 중복을 검증한다.
test('concurrent deletion reports and publishes only the row actually removed', async () => {
	const rows = new Set(['file']);
	const chart = { update: vi.fn() };
	const stream = { publishDriveStream: vi.fn() };
	const service = Object.create(DriveService.prototype) as DriveService;
	Object.assign(service, {
		driveFilesRepository: { delete: async () => ({ affected: rows.delete('file') ? 1 : 0 }) },
		driveChart: chart,
		perUserDriveChart: { update: vi.fn() },
		globalEventService: stream,
	});
	const file = { id: 'file', isLink: true, storedInternal: false, userHost: null, userId: 'owner' } as MiDriveFile;

	const outcomes = await Promise.all([service.deleteFile(file), service.deleteFile(file)]);

	expect(rows.size).toBe(0);
	expect(outcomes).toEqual([true, false]);
	expect(chart.update).toHaveBeenCalledTimes(1);
	expect(stream.publishDriveStream).toHaveBeenCalledTimes(1);
});

test('removes the row on the provided SQL connection without acquiring a global pooled connection', async () => {
	const service = Object.create(DriveService.prototype) as DriveService;
	const stream = { publishDriveStream: vi.fn() };
	Object.assign(service, {
		driveFilesRepository: { delete: async () => { throw new Error('No spare SQL connection'); } },
		driveChart: { update: vi.fn() },
		perUserDriveChart: { update: vi.fn() },
		globalEventService: stream,
	});
	const file = { id: 'file', isLink: true, storedInternal: false, userHost: null, userId: 'owner' } as MiDriveFile;
	const scopedRepository = { delete: async () => ({ affected: 1 }) } as unknown as DriveFilesRepository;

	const removed = await service.deleteFile(file, false, undefined, scopedRepository);

	expect(removed).toBe(true);
	expect(stream.publishDriveStream).toHaveBeenCalledWith('owner', 'fileDeleted', 'file');
});
