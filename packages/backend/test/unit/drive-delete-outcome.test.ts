/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { DriveService } from '@/core/DriveService.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { DriveFilesRepository } from '@/models/_.js';

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
