/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import RecordingFolderEndpoint from '@/server/api/endpoints/chat/rooms/voice/recording-folder.js';
import { MiDriveFolder } from '@/models/DriveFolder.js';
import { MiRegistryItem } from '@/models/RegistryItem.js';

const me = { id: 'me', host: null } as any;

// 폴더와 기억값을 한 트랜잭션에서 커밋하는지 확인하기 위해, 트랜잭션이 실패하면 쓰기를 버리는 가짜 DB를 쓴다.
function fixture(overrides: { remembered?: string | null; existingFolder?: { id: string; name: string } | null; lockFree?: boolean; registryWriteFails?: boolean } = {}) {
	const remembered = overrides.remembered === undefined ? null : overrides.remembered;
	const existingFolder = overrides.existingFolder === undefined ? null : overrides.existingFolder;
	const committed = { folders: [] as { id: string; name: string; userId: string }[], registry: [] as { id: string; value: string }[] };
	const pending = { folders: [] as { id: string; name: string; userId: string }[], registry: [] as { id: string; value: string }[] };
	const registryItem = remembered != null ? { id: 'registry-item', value: remembered } : null;

	const folderRepo = {
		findOneBy: vi.fn(async ({ id }: { id: string }) => existingFolder?.id === id ? existingFolder : null),
		insert: vi.fn(async (row: { id: string; name: string; userId: string }) => { pending.folders.push(row); }),
	};
	const registryRepo = {
		createQueryBuilder: vi.fn(() => {
			const query = {
				where: () => query,
				andWhere: () => query,
				getOne: async () => registryItem,
			};
			return query;
		}),
		update: vi.fn(async (id: string, patch: { value: string }) => {
			if (overrides.registryWriteFails) throw new Error('registry unavailable');
			pending.registry.push({ id, value: patch.value });
		}),
		insert: vi.fn(async (row: { id: string; value: string }) => {
			if (overrides.registryWriteFails) throw new Error('registry unavailable');
			pending.registry.push(row);
		}),
	};
	const manager = {
		query: vi.fn().mockResolvedValue([{ locked: overrides.lockFree === false ? false : true }]),
		getRepository: vi.fn((entity: unknown) => entity === MiDriveFolder ? folderRepo : registryRepo),
	};
	const db = {
		transaction: vi.fn(async (cb: (m: typeof manager) => Promise<void>) => {
			pending.folders = [];
			pending.registry = [];
			await cb(manager);
			committed.folders.push(...pending.folders);
			committed.registry.push(...pending.registry);
		}),
	};
	const driveFolderEntityService = { pack: vi.fn(async (f: { id: string; name: string }) => ({ id: f.id, name: f.name })) };
	const idService = { gen: vi.fn(() => 'new-folder') };
	const globalEventService = { publishDriveStream: vi.fn() };
	const endpoint = new RecordingFolderEndpoint(
		db as any,
		driveFolderEntityService as any,
		idService as any,
		globalEventService as any,
	);
	return { endpoint, folderRepo, registryRepo, manager, db, committed, globalEventService };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('chat/rooms/voice/recording-folder', () => {
	test('creates the folder in the current language on first use and remembers it in the same transaction', async () => {
		const f = fixture();

		const res = await f.endpoint.exec({ name: 'Call recordings' }, me, null, null);

		expect(res).toEqual({ id: 'new-folder', name: 'Call recordings' });
		expect(f.db.transaction).toHaveBeenCalledTimes(1);
		expect(f.manager.query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_xact_lock'), [expect.stringContaining('me')]);
		expect(f.committed.folders).toEqual([expect.objectContaining({ name: 'Call recordings', userId: 'me' })]);
		expect(f.committed.registry).toEqual([expect.objectContaining({ value: 'new-folder' })]);
		expect(f.globalEventService.publishDriveStream).toHaveBeenCalledWith('me', 'folderCreated', expect.objectContaining({ id: 'new-folder' }));
	});

	test('returns the remembered folder even when the language name changed', async () => {
		const f = fixture({ remembered: 'old-folder', existingFolder: { id: 'old-folder', name: '통화 녹화' } });

		const res = await f.endpoint.exec({ name: 'Call recordings' }, me, null, null);

		expect(res).toEqual({ id: 'old-folder', name: '통화 녹화' });
		expect(f.folderRepo.insert).not.toHaveBeenCalled();
		expect(f.globalEventService.publishDriveStream).not.toHaveBeenCalled();
	});

	test('returns the remembered folder even when it was renamed', async () => {
		const f = fixture({ remembered: 'old-folder', existingFolder: { id: 'old-folder', name: 'My recordings' } });

		const res = await f.endpoint.exec({ name: 'Call recordings' }, me, null, null);

		expect(res).toEqual({ id: 'old-folder', name: 'My recordings' });
		expect(f.folderRepo.insert).not.toHaveBeenCalled();
	});

	test('recreates and re-remembers when the remembered folder was deleted', async () => {
		const f = fixture({ remembered: 'gone-folder', existingFolder: null });

		const res = await f.endpoint.exec({ name: '通話録画' }, me, null, null);

		expect(res).toEqual({ id: 'new-folder', name: '通話録画' });
		expect(f.registryRepo.update).toHaveBeenCalledWith('registry-item', expect.objectContaining({ value: 'new-folder' }));
		expect(f.committed.registry).toEqual([expect.objectContaining({ value: 'new-folder' })]);
	});

	test('leaves no orphan folder when remembering fails', async () => {
		const f = fixture({ registryWriteFails: true });

		await expect(f.endpoint.exec({ name: 'Call recordings' }, me, null, null)).rejects.toThrow('registry unavailable');
		// 폴더 insert와 기억값 쓰기는 한 트랜잭션이라 함께 롤백된다
		expect(f.folderRepo.insert).toHaveBeenCalled();
		expect(f.committed.folders).toEqual([]);
		expect(f.committed.registry).toEqual([]);
		expect(f.globalEventService.publishDriveStream).not.toHaveBeenCalled();
	});

	test('reports busy when the per-user lock cannot be acquired', async () => {
		vi.useFakeTimers();
		try {
			const f = fixture({ lockFree: false });

			const pending = f.endpoint.exec({ name: 'Call recordings' }, me, null, null);
			const assertion = expect(pending).rejects.toMatchObject({ code: 'BUSY' });
			await vi.advanceTimersByTimeAsync(6000);
			await assertion;

			expect(f.folderRepo.insert).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
