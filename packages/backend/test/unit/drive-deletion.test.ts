/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { Client } from 'pg';
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner.js';
import { PostgresStream } from '../fixtures/postgres-stream.js';
vi.mock('@/core/DriveService.js', () => ({ DriveService: class {} }));
vi.mock('@/core/GlobalEventService.js', () => ({ GlobalEventService: class {} }));

import { DriveDeletionService } from '@/core/DriveDeletionService.js';

// DB/Redis 경계의 실패 주입용 단위 시험이다. 실제 SQL과 권한 검증은 drive E2E에서 한다.
function fixture() {
	const hashes = new Map<string, Record<string, string>>();
	const files = new Map<string, { id: string; userId: string }>();
	const folders: { id: string; parentId: string | null }[] = [];
	const redis = {
		del: vi.fn(async (key: string) => hashes.delete(key)),
		expire: vi.fn(async () => 1),
		hset: vi.fn(async (key: string, fields: Record<string, string>) => {
			hashes.set(key, { ...hashes.get(key), ...fields });
			return 1;
		}),
		hgetall: vi.fn(async (key: string) => ({ ...hashes.get(key) })),
	};
	let redisReplyError: Error | null = null;
	const redisWithMulti = {
		...redis,
		multi: () => {
			const actions: (() => Promise<unknown>)[] = [];
			const pipeline = {
				del(key: string) { actions.push(() => redis.del(key)); return pipeline; },
				hset(key: string, fields: Record<string, string>) { actions.push(() => redis.hset(key, fields)); return pipeline; },
				expire(_key: string, _seconds: number) { actions.push(() => redis.expire()); return pipeline; },
				async exec() {
					if (redisReplyError) return [[redisReplyError, null]];
					for (const action of actions) await action();
					return [];
				},
			};
			return pipeline;
		},
	};

	let locked = false;
	const counts = vi.fn(async () => [{ files: '0', folders: '0' }]);
	const repo = {
		findOneBy: vi.fn(async ({ id, userId }: { id: string; userId: string }) => {
			const f = files.get(id);
			return f?.userId === userId ? f : null;
		}),
	};
	const manager = {
		query: vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>(async sql => sql.includes('drive_file') ? [...files.values()].map(f => ({ id: f.id })) : folders),
		getRepository: () => repo,
	};
	const runner = {
		manager,
		connect: vi.fn(async () => {}), release: vi.fn(async () => {}),
		startTransaction: vi.fn(async () => {}), commitTransaction: vi.fn(async () => {}), rollbackTransaction: vi.fn(async () => {}),
		query: vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>(async (sql, params) => {
			if (sql.includes('pg_try_advisory_lock')) return [{ locked: !locked && (locked = true) }];
			if (sql.includes('pg_advisory_unlock')) { locked = false; return []; }
			if (sql.includes('AS files')) return counts();
			return manager.query(sql, params);
		}),
	};
	const db = {
		createQueryRunner: () => runner,
		transaction: vi.fn(async (...args: unknown[]) => (args.at(-1) as (m: typeof manager) => unknown)(manager)),
		query: vi.fn(async () => counts()),
	};

	let active = 0;
	let maxActive = 0;
	const drive = {
		deleteFile: vi.fn(async (file: { id: string }) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await Promise.resolve();
			files.delete(file.id);
			active--;
			return true;
		}),
	};
	const events = { publishDriveStream: vi.fn() };
	const service = new DriveDeletionService(db as never, redisWithMulti as never, drive as never, events as never);
	const me = { id: 'owner' } as never;
	return { service, me, files, folders, drive, db, manager, repo, redis, runner, events, counts, setRedisReplyError: (error: Error | null) => { redisReplyError = error; }, maxActive: () => maxActive };
}

describe('Drive deletion snapshots (unit boundaries)', () => {
	test('evicts the PostgreSQL session when unlocking fails instead of returning a held lock to the pool', async () => {
		const f = fixture();
		const releases: (Error | undefined)[] = [];
		const error = Object.assign(new Error('canceling statement due to user request'), { code: '57014' });
		const runner = Object.create(PostgresQueryRunner.prototype) as PostgresQueryRunner;
		Object.assign(runner, {
			isReleased: false,
			driver: { connectedQueryRunners: [runner] },
			connect: async () => {},
			releaseCallback: (reason?: Error) => releases.push(reason),
			query: async (sql: string) => {
				if (sql.includes('pg_advisory_unlock')) throw error;
				return [{ locked: true }];
			},
		});
		f.db.createQueryRunner = () => runner as unknown as typeof f.runner;

		await expect(f.service.prepare(f.me, { fileIds: ['file'] })).rejects.toBe(error);

		expect(releases).toHaveLength(1);
		expect(releases[0]).toBeInstanceOf(Error);
		expect(runner.isReleased).toBe(true);
		expect(runner.driver.connectedQueryRunners).toHaveLength(0);
	});

	test('deletes confirmed IDs including used files without asking the unused cleaner', async () => {
		const f = fixture();
		f.files.set('used', { id: 'used', userId: 'owner' });
		const plan = await f.service.prepare(f.me, { fileIds: ['used', 'used', 'missing', 'foreign'] });
		f.files.set('foreign', { id: 'foreign', userId: 'other' });

		const result = await f.service.execute(f.me, plan.operationId);

		expect(plan.totalCount).toBe(3);
		expect(result).toMatchObject({ deletedCount: 1, missingCount: 2, failedCount: 0, done: true });
		expect(f.files.has('used')).toBe(false);
		expect(f.files.has('foreign')).toBe(true);
	});

	test('bounds a request to 100 files and at most four concurrent deletions', async () => {
		const f = fixture();
		const ids = Array.from({ length: 205 }, (_, i) => `file${i}`);
		for (const id of ids) f.files.set(id, { id, userId: 'owner' });
		const plan = await f.service.prepare(f.me, { fileIds: ids });

		const first = await f.service.execute(f.me, plan.operationId);
		expect(first).toMatchObject({ deletedCount: 100, done: false });
		expect(f.maxActive()).toBeLessThanOrEqual(4);
		await f.service.execute(f.me, plan.operationId);
		const last = await f.service.execute(f.me, plan.operationId);

		expect(last).toMatchObject({ deletedCount: 205, remainingCount: 0, done: true });
		expect(f.files.size).toBe(0);
	});

	test('persists partial failure and returns identical totals on repeated execution', async () => {
		const f = fixture();
		f.files.set('good', { id: 'good', userId: 'owner' });
		f.files.set('bad', { id: 'bad', userId: 'owner' });
		f.drive.deleteFile.mockImplementation(async file => {
			if (file.id === 'bad') throw new Error('storage failure');
			return f.files.delete(file.id);
		});
		f.counts.mockResolvedValue([{ files: '1', folders: '0' }]);
		const plan = await f.service.prepare(f.me, { fileIds: ['good', 'bad'] });

		const first = await f.service.execute(f.me, plan.operationId);
		const repeated = await f.service.execute(f.me, plan.operationId);

		expect(first).toMatchObject({ deletedCount: 1, failedCount: 1, remainingCount: 1, done: true });
		expect(repeated).toEqual(first);
		expect(f.files.has('bad')).toBe(true);
		expect(f.drive.deleteFile).toHaveBeenCalledTimes(2);
	});

	test('rejects stale operations and another owner', async () => {
		const f = fixture();
		const first = await f.service.prepare(f.me, { fileIds: ['one'] });
		await f.service.prepare(f.me, { fileIds: ['two'] });

		await expect(f.service.execute(f.me, first.operationId)).rejects.toMatchObject({ code: 'PLAN_EXPIRED' });
		await expect(f.service.execute({ id: 'other' } as never, first.operationId)).rejects.toMatchObject({ code: 'PLAN_EXPIRED' });
		expect(f.drive.deleteFile).not.toHaveBeenCalled();
	});

	test('rejects overlapping requests without waiting in an unbounded queue', async () => {
		const f = fixture();
		f.runner.query.mockResolvedValueOnce([{ locked: false }]);

		await expect(f.service.prepare(f.me, { fileIds: ['one'] })).rejects.toMatchObject({ code: 'DELETE_BUSY' });
		expect(f.redis.hset).not.toHaveBeenCalled();
	});

	test('freezes recursive file IDs so additions after confirmation survive', async () => {
		const f = fixture();
		f.folders.push({ id: 'root', parentId: null }, { id: 'child', parentId: 'root' });
		f.files.set('before', { id: 'before', userId: 'owner' });
		const plan = await f.service.prepare(f.me, { folderId: 'root' });
		f.files.set('after', { id: 'after', userId: 'owner' });
		// 새 자식 때문에 두 폴더 모두 남는다.
		f.manager.query.mockImplementation(async (sql: string) => sql.includes('EXISTS') ? [{ present: true }] : [{ id: 'root', parentId: null }]);
		f.counts.mockResolvedValue([{ files: '1', folders: '2' }]);

		const result = await f.service.execute(f.me, plan.operationId);

		expect(result).toMatchObject({ totalCount: 1, deletedCount: 1, remainingCount: 1, folderDeleted: false });
		expect(f.files.has('after')).toBe(true);
	});

	test('rejects oversized selections before saving a destructive operation', async () => {
		const f = fixture();

		await expect(f.service.prepare(f.me, { fileIds: Array.from({ length: 10001 }, (_, i) => `f${i}`) })).rejects.toMatchObject({ code: 'TOO_MANY_ITEMS' });
		expect(f.redis.hset).not.toHaveBeenCalled();
	});
	test('keeps its user lock until every worker settles after a Redis write failure', async () => {
		const f = fixture();
		for (const id of ['one', 'two']) f.files.set(id, { id, userId: 'owner' });
		const plan = await f.service.prepare(f.me, { fileIds: ['one', 'two'] });
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		f.drive.deleteFile.mockImplementation(async file => {
			if (file.id === 'two') await gate;
			return f.files.delete(file.id);
		});
		f.redis.hset.mockRejectedValueOnce(new Error('Redis disconnected'));
		let settled = false;
		const execution = f.service.execute(f.me, plan.operationId).catch(() => { settled = true; });
		await vi.waitFor(() => expect(f.drive.deleteFile).toHaveBeenCalledTimes(2));
		await Promise.resolve();
		const releasedEarly = settled;
		release();
		await execution;

		expect(releasedEarly).toBe(false);
	});

	test('deletes a zero-file folder and publishes its event after the transaction', async () => {
		const f = fixture();
		f.folders.push({ id: 'root', parentId: null });
		const plan = await f.service.prepare(f.me, { folderId: 'root' });
		f.manager.query.mockImplementation(async (sql: string) => {
			if (sql.includes('FOR UPDATE')) return [{ id: 'root', parentId: null }];
			if (sql.includes('EXISTS')) return [{ present: false }];
			return [];
		});

		const result = await f.service.execute(f.me, plan.operationId);

		expect(plan.totalCount).toBe(0);
		expect(result).toMatchObject({ deletedCount: 0, folderDeleted: true, done: true });
		expect(result.deletedFolderIds).toEqual(['root']);
		expect(f.events.publishDriveStream).toHaveBeenCalledWith('owner', 'folderDeleted', 'root');
	});

	test('treats an externally removed folder as gone and exposes it for preference cleanup', async () => {
		const f = fixture();
		f.folders.push({ id: 'root', parentId: null });
		const plan = await f.service.prepare(f.me, { folderId: 'root' });
		f.manager.query.mockResolvedValue([]);

		const result = await f.service.execute(f.me, plan.operationId);

		expect(result.folderDeleted).toBe(true);
		expect(result.missingFolderIds).toEqual(['root']);
	});

	test('fails a request when Redis EXEC returns a command error instead of rejecting', async () => {
		const f = fixture();
		f.files.set('one', { id: 'one', userId: 'owner' });
		const plan = await f.service.prepare(f.me, { fileIds: ['one'] });
		f.setRedisReplyError(new Error('OOM command not allowed'));

		await expect(f.service.execute(f.me, plan.operationId)).rejects.toThrow('OOM');
	});

	test('reads persisted outcomes after a lost response without deleting another batch', async () => {
		const f = fixture();
		const ids = Array.from({ length: 105 }, (_, i) => `file${i}`);
		for (const id of ids) f.files.set(id, { id, userId: 'owner' });
		const plan = await f.service.prepare(f.me, { fileIds: ids });
		const first = await f.service.execute(f.me, plan.operationId);

		const read = f.redis.hgetall.getMockImplementation()!;
		f.redis.hgetall.mockImplementation(async key => Object.fromEntries(Object.entries(await read(key)).reverse()));
		const observed = await f.service.status(f.me, plan.operationId);

		expect(observed).toEqual(first);
		expect(f.files.size).toBe(5);
		await expect(f.service.status({ id: 'other' } as never, plan.operationId)).rejects.toMatchObject({ code: 'PLAN_EXPIRED' });
	});

	test('finishes with one available SQL connection instead of waiting for a second pooled connection', async () => {
		const f = fixture();
		f.folders.push({ id: 'root', parentId: null });
		f.db.transaction.mockRejectedValue(new Error('connection pool exhausted'));
		f.db.query.mockRejectedValue(new Error('connection pool exhausted'));

		const plan = await f.service.prepare(f.me, { folderId: 'root' });
		f.manager.query.mockImplementation(async (sql: string) => {
			if (sql.includes('FOR UPDATE')) return [{ id: 'root', parentId: null }];
			if (sql.includes('EXISTS')) return [{ present: false }];
			return [];
		});
		const result = await f.service.execute(f.me, plan.operationId);

		expect(result.folderDeleted).toBe(true);
		expect(result.done).toBe(true);
	});

	test('does not overlap queries on the real pg client through the repository boundary', async () => {
		const f = fixture();
		const client = new Client({ user: 'unit', database: 'unit', password: 'unit', ssl: false, stream: () => new PostgresStream() });
		const warnings = vi.spyOn(process, 'emitWarning');
		await client.connect();
		try {
			for (const id of ['one', 'two', 'three', 'four']) f.files.set(id, { id, userId: 'owner' });
			const read = f.repo.findOneBy.getMockImplementation()!;
			f.repo.findOneBy.mockImplementation(async params => {
				await client.query('SELECT 1');
				return read(params);
			});
			f.drive.deleteFile.mockImplementation(async file => {
				await client.query('SELECT 1');
				return f.files.delete(file.id);
			});
			const plan = await f.service.prepare(f.me, { fileIds: [...f.files.keys()] });

			const result = await f.service.execute(f.me, plan.operationId);

			expect(result.deletedCount).toBe(4);
			expect(f.files.size).toBe(0);
			const overlapping = warnings.mock.calls.filter(([warning]) => String(warning).includes('Calling client.query()'));
			expect(overlapping).toEqual([]);
		} finally {
			await client.end();
			warnings.mockRestore();
		}
	});

	test('returns canonical file IDs when Redis returns the same outcomes in a different field order', async () => {
		const f = fixture();
		for (const id of ['fileZ', 'fileA', 'fileM']) f.files.set(id, { id, userId: 'owner' });
		const plan = await f.service.prepare(f.me, { fileIds: ['fileZ', 'missingZ', 'fileA', 'missingA', 'fileM'] });
		const first = await f.service.execute(f.me, plan.operationId);
		const read = f.redis.hgetall.getMockImplementation()!;
		f.redis.hgetall.mockImplementation(async key => Object.fromEntries(Object.entries(await read(key)).reverse()));

		const observed = await f.service.status(f.me, plan.operationId);
		const repeated = await f.service.execute(f.me, plan.operationId);

		expect(observed).toEqual(first);
		expect(repeated).toEqual(first);
		expect(first.deletedIds).toEqual(['fileA', 'fileM', 'fileZ']);
		expect(first.missingIds).toEqual(['missingA', 'missingZ']);
	});

	test('returns canonical folder IDs independently of deletion order or Redis field order', async () => {
		const f = fixture();
		f.folders.push({ id: 'root', parentId: null });
		for (const id of ['deletedZ', 'missingZ', 'deletedA', 'missingA']) f.folders.push({ id, parentId: 'root' });
		const plan = await f.service.prepare(f.me, { folderId: 'root' });
		f.manager.query.mockImplementation(async (sql, params) => {
			if (sql.includes('FOR UPDATE')) {
				const id = String(params?.[0]);
				return id.startsWith('missing') ? [] : f.folders.filter(folder => folder.id === id);
			}
			if (sql.includes('EXISTS')) return [{ present: false }];
			return [];
		});
		const first = await f.service.execute(f.me, plan.operationId);
		const read = f.redis.hgetall.getMockImplementation()!;
		f.redis.hgetall.mockImplementation(async key => Object.fromEntries(Object.entries(await read(key)).reverse()));

		const observed = await f.service.status(f.me, plan.operationId);

		expect(observed).toEqual(first);
		expect(first.deletedFolderIds).toEqual(['deletedA', 'deletedZ', 'root']);
		expect(first.missingFolderIds).toEqual(['missingA', 'missingZ']);
	});
});
