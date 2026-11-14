/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import ConvertRecordingEndpoint, { meta } from '@/server/api/endpoints/chat/rooms/voice/convert-recording.js';

const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
	...await importOriginal<typeof import('node:child_process')>(),
	execFile: childProcess.execFile,
}));

const me = { id: 'me', host: null } as any;

function fixture(overrides: { type?: string; name?: string; conversions?: number; addFileError?: Error } = {}) {
	const file = {
		id: 'original',
		userId: 'me',
		storedInternal: true,
		accessKey: 'access-key',
		type: overrides.type ?? 'audio/webm',
		name: overrides.name ?? 'room 1-20261115-090807.webm',
		size: 1024,
	};
	const driveFilesRepository = { findOneBy: vi.fn().mockResolvedValue(file) };
	const redisClient = { eval: vi.fn().mockResolvedValue(1) };
	const driveService = {
		addFile: overrides.addFileError != null
			? vi.fn().mockRejectedValue(overrides.addFileError)
			: vi.fn().mockResolvedValue({ id: 'converted' }),
	};
	const internalStorageService = { resolvePath: vi.fn(() => '/recordings/access-key.webm') };
	const driveFileEntityService = { pack: vi.fn(async (packed: { id: string }) => ({ id: packed.id })) };
	const roleService = { getUserPolicies: vi.fn().mockResolvedValue({ maxFileSizeMb: 100, driveCapacityMb: 1000 }) };
	const apiLoggerService = { logger: { warn: vi.fn() } };
	const endpoint = new ConvertRecordingEndpoint(
		{ maxFileSize: 100 * 1024 * 1024 } as any,
		{ voiceCallMaxRecordingConversions: overrides.conversions ?? 2 } as any,
		driveFilesRepository as any,
		redisClient as any,
		driveService as any,
		internalStorageService as any,
		driveFileEntityService as any,
		roleService as any,
		apiLoggerService as any,
	);
	return { endpoint, driveService, driveFilesRepository };
}

beforeEach(() => {
	childProcess.execFile.mockReset().mockImplementation((_cmd: string, args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
		fs.writeFileSync(args[args.length - 1], 'converted');
		callback(null, '', '');
	});
});

describe('chat/rooms/voice/convert-recording', () => {
	test('converts an audio recording to mp3 in the requested folder', async () => {
		const f = fixture();

		await expect(f.endpoint.exec({ fileId: 'original', video: false, folderId: 'folder1' }, me, null, null)).resolves.toEqual({ id: 'converted' });

		const args = childProcess.execFile.mock.calls[0][1] as string[];
		expect(args).toContain('-vn');
		expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({
			name: 'room 1-20261115-090807.mp3',
			folderId: 'folder1',
			force: true,
		}));
	});

	test('keeps the video of a video recording by default', async () => {
		const f = fixture({ type: 'video/webm' });

		await f.endpoint.exec({ fileId: 'original' }, me, null, null);

		const args = childProcess.execFile.mock.calls[0][1] as string[];
		expect(args).toContain('libx264');
		expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'room 1-20261115-090807.mp4' }));
	});

	test('discards the black video lead-in when the caller asks for audio only', async () => {
		const f = fixture({ type: 'video/webm' });

		await f.endpoint.exec({ fileId: 'original', video: false }, me, null, null);

		const args = childProcess.execFile.mock.calls[0][1] as string[];
		expect(args).toContain('-vn');
		expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'room 1-20261115-090807.mp3' }));
	});

	test('converts an audio recording to mp4 when the caller asks for video', async () => {
		const f = fixture({ type: 'audio/webm' });

		await f.endpoint.exec({ fileId: 'original', video: true }, me, null, null);

		const args = childProcess.execFile.mock.calls[0][1] as string[];
		expect(args).toContain('libx264');
		expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'room 1-20261115-090807.mp4' }));
	});

	test.each([
		['audio/mp4', 'room 1-20261115-090807.mp3'],
		['video/mp4', 'room 1-20261115-090807.mp4'],
	])('accepts %s recordings from browsers that cannot record webm', async (type, name) => {
		const f = fixture({ type, name: 'room 1-20261115-090807.mp4' });

		await expect(f.endpoint.exec({ fileId: 'original' }, me, null, null)).resolves.toEqual({ id: 'converted' });

		expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ name }));
	});

	test('reports a missing folder instead of a generic conversion failure', async () => {
		const f = fixture({ addFileError: new Error('folder-not-found') });

		await expect(f.endpoint.exec({ fileId: 'original', folderId: 'gone' }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_FOLDER' });
		expect(meta.errors).toHaveProperty('noSuchFolder');
	});

	test('leaves files that are not recordings alone', async () => {
		const f = fixture({ type: 'image/png' });

		await expect(f.endpoint.exec({ fileId: 'original' }, me, null, null)).resolves.toBeNull();

		expect(childProcess.execFile).not.toHaveBeenCalled();
		expect(f.driveService.addFile).not.toHaveBeenCalled();
	});

	test('keeps the original when conversion is turned off', async () => {
		const f = fixture({ conversions: 0 });

		await expect(f.endpoint.exec({ fileId: 'original' }, me, null, null)).resolves.toBeNull();

		expect(childProcess.execFile).not.toHaveBeenCalled();
		expect(f.driveService.addFile).not.toHaveBeenCalled();
	});
});
