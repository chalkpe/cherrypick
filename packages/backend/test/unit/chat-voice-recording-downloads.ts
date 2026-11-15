/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import RecordingResultEndpoint from '@/server/api/endpoints/chat/rooms/voice/recording-result.js';
import RecordingDiscardEndpoint from '@/server/api/endpoints/chat/rooms/voice/recording-discard.js';
import type { RecordingResult } from '@/core/RecordingStorageService.js';

const existsSync = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async importOriginal => ({
	...await importOriginal<typeof import('node:fs')>(),
	existsSync,
}));

const me = { id: 'me', host: null } as any;
const requestId = '11111111-1111-4111-8111-111111111111';
const downloadId = '22222222-2222-4222-8222-222222222222';
// 임시 조각 id는 변환 요청의 fileIds 형식(misskey:id)을 따라 대시가 없다
const partId = '33333333333343338333333333333333';

function fixture(overrides: { result?: RecordingResult | null; download?: { id: string; userId: string; path: string; name: string; size: number } | null; fileExists?: boolean; part?: { id: string; userId: string } | null } = {}) {
	const driveFilesRepository = { findOneBy: vi.fn().mockResolvedValue({ id: 'final-file', userId: 'me' }) };
	const driveFileEntityService = { pack: vi.fn(async (f: { id: string }) => ({ id: f.id })) };
	const recordingStorage = {
		getResult: vi.fn().mockResolvedValue(overrides.result ?? null),
		getDownload: vi.fn().mockResolvedValue(overrides.download ?? null),
		removeDownload: vi.fn().mockResolvedValue(undefined),
		getPart: vi.fn().mockResolvedValue(overrides.part ?? null),
		removePart: vi.fn().mockResolvedValue(undefined),
	};
	const resultEndpoint = new RecordingResultEndpoint(driveFilesRepository as any, driveFileEntityService as any, recordingStorage as any);
	const discardEndpoint = new RecordingDiscardEndpoint(recordingStorage as any);
	return { resultEndpoint, discardEndpoint, recordingStorage, driveFilesRepository };
}

beforeEach(() => {
	vi.restoreAllMocks();
	existsSync.mockReset();
});

describe('chat/rooms/voice/recording-result', () => {
	test('returns null when nothing is remembered', async () => {
		const f = fixture();

		await expect(f.resultEndpoint.exec({ requestId }, me, null, null)).resolves.toBeNull();
	});

	test('returns the remembered drive file without converting again', async () => {
		const f = fixture({ result: { fileId: 'final-file', remainingParts: [] } });

		await expect(f.resultEndpoint.exec({ requestId }, me, null, null)).resolves.toEqual({ file: { id: 'final-file' }, download: null });
		expect(f.driveFilesRepository.findOneBy).toHaveBeenCalledWith({ id: 'final-file', userId: 'me' });
	});

	test('returns the kept download while its file is still there', async () => {
		existsSync.mockReturnValue(true);
		const f = fixture({
			result: { download: { id: downloadId, name: 'room.mp4', size: 10, reason: 'tooLarge' }, remainingParts: [] },
			download: { id: downloadId, userId: 'me', path: '/tmp/kept', name: 'room.mp4', size: 10 },
		});

		await expect(f.resultEndpoint.exec({ requestId }, me, null, null))
			.resolves.toEqual({ file: null, download: { id: downloadId, name: 'room.mp4', size: 10, reason: 'tooLarge' } });
	});

	test('does not return a kept download whose file is gone', async () => {
		existsSync.mockReturnValue(false);
		const f = fixture({
			result: { download: { id: downloadId, name: 'room.mp4', size: 10, reason: 'tooLarge' }, remainingParts: [] },
			download: { id: downloadId, userId: 'me', path: '/tmp/kept', name: 'room.mp4', size: 10 },
		});

		await expect(f.resultEndpoint.exec({ requestId }, me, null, null)).resolves.toBeNull();
	});
});

describe('chat/rooms/voice/recording-discard', () => {
	test('discards a kept download owned by the caller', async () => {
		const f = fixture({ download: { id: downloadId, userId: 'me', path: '/tmp/kept', name: 'room.mp4', size: 10 } });

		await f.discardEndpoint.exec({ id: downloadId }, me, null, null);

		expect(f.recordingStorage.removeDownload).toHaveBeenCalledWith(downloadId);
	});

	test('treats an already gone download as success', async () => {
		const f = fixture();

		await expect(f.discardEndpoint.exec({ id: downloadId }, me, null, null)).resolves.toBeUndefined();
		expect(f.recordingStorage.removeDownload).not.toHaveBeenCalled();
	});

	test('does not reveal or delete another user\'s kept download', async () => {
		const f = fixture({ download: { id: downloadId, userId: 'someone-else', path: '/tmp/kept', name: 'room.mp4', size: 10 } });

		await expect(f.discardEndpoint.exec({ id: downloadId }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_DOWNLOAD' });
		expect(f.recordingStorage.removeDownload).not.toHaveBeenCalled();
	});

	test('discards temporary recording parts owned by the caller', async () => {
		const f = fixture({ part: { id: partId, userId: 'me' } });

		await f.discardEndpoint.exec({ partIds: [partId] }, me, null, null);

		expect(f.recordingStorage.removePart).toHaveBeenCalledWith(partId);
	});

	test('treats an already gone part as success', async () => {
		const f = fixture();

		await expect(f.discardEndpoint.exec({ partIds: [partId] }, me, null, null)).resolves.toBeUndefined();
		expect(f.recordingStorage.removePart).not.toHaveBeenCalled();
	});

	test('does not delete another user\'s temporary part', async () => {
		const f = fixture({ part: { id: partId, userId: 'someone-else' } });

		await expect(f.discardEndpoint.exec({ partIds: [partId] }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_PART' });
		expect(f.recordingStorage.removePart).not.toHaveBeenCalled();
	});
});
