/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import RecordingFolderEndpoint from '@/server/api/endpoints/chat/rooms/voice/recording-folder.js';

const me = { id: 'me', host: null } as any;

function fixture(overrides: { remembered?: string | null; existingFolder?: { id: string; name: string } | null; lockFree?: boolean } = {}) {
	const remembered = overrides.remembered === undefined ? null : overrides.remembered;
	const existingFolder = overrides.existingFolder === undefined ? null : overrides.existingFolder;
	const driveFoldersRepository = {
		findOneBy: vi.fn().mockResolvedValue(existingFolder),
		insertOne: vi.fn(async (row: { id: string; name: string }) => ({ ...row })),
	};
	const redisClient = {
		set: vi.fn().mockResolvedValue(overrides.lockFree === false ? null : 'OK'),
		eval: vi.fn().mockResolvedValue(1),
	};
	const registryApiService = {
		getItem: vi.fn().mockResolvedValue(remembered != null ? { value: remembered } : null),
		set: vi.fn().mockResolvedValue(undefined),
	};
	const driveFolderEntityService = { pack: vi.fn(async (f: { id: string; name: string }) => ({ id: f.id, name: f.name })) };
	const idService = { gen: vi.fn(() => 'new-folder') };
	const globalEventService = { publishDriveStream: vi.fn() };
	const endpoint = new RecordingFolderEndpoint(
		driveFoldersRepository as any,
		redisClient as any,
		driveFolderEntityService as any,
		idService as any,
		globalEventService as any,
		registryApiService as any,
	);
	return { endpoint, driveFoldersRepository, registryApiService, redisClient };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('chat/rooms/voice/recording-folder', () => {
	test('creates the folder in the current language on first use and remembers it', async () => {
		const f = fixture();

		const res = await f.endpoint.exec({ name: 'Call recordings' }, me, null, null);

		expect(res).toEqual({ id: 'new-folder', name: 'Call recordings' });
		expect(f.driveFoldersRepository.insertOne).toHaveBeenCalledWith(expect.objectContaining({ name: 'Call recordings', userId: 'me', parentId: null }));
		expect(f.registryApiService.set).toHaveBeenCalledWith('me', null, ['voiceCall'], 'recordingFolderId', 'new-folder');
	});

	test('returns the remembered folder even when the language name changed', async () => {
		const f = fixture({ remembered: 'old-folder', existingFolder: { id: 'old-folder', name: '통화 녹화' } });

		const res = await f.endpoint.exec({ name: 'Call recordings' }, me, null, null);

		expect(res).toEqual({ id: 'old-folder', name: '통화 녹화' });
		expect(f.driveFoldersRepository.insertOne).not.toHaveBeenCalled();
	});

	test('returns the remembered folder even when it was renamed', async () => {
		const f = fixture({ remembered: 'old-folder', existingFolder: { id: 'old-folder', name: 'My recordings' } });

		const res = await f.endpoint.exec({ name: 'Call recordings' }, me, null, null);

		expect(res).toEqual({ id: 'old-folder', name: 'My recordings' });
		expect(f.driveFoldersRepository.insertOne).not.toHaveBeenCalled();
	});

	test('recreates and re-remembers when the remembered folder was deleted', async () => {
		const f = fixture({ remembered: 'gone-folder', existingFolder: null });

		const res = await f.endpoint.exec({ name: '通話録画' }, me, null, null);

		expect(res).toEqual({ id: 'new-folder', name: '通話録画' });
		expect(f.registryApiService.set).toHaveBeenCalledWith('me', null, ['voiceCall'], 'recordingFolderId', 'new-folder');
	});

	test('reports busy when the per-user lock cannot be acquired', async () => {
		const f = fixture({ lockFree: false });

		await expect(f.endpoint.exec({ name: 'Call recordings' }, me, null, null)).rejects.toMatchObject({ code: 'BUSY' });
		expect(f.driveFoldersRepository.insertOne).not.toHaveBeenCalled();
	});
});
