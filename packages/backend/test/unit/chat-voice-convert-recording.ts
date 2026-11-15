/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import ConvertRecordingEndpoint, { meta } from '@/server/api/endpoints/chat/rooms/voice/convert-recording.js';

const childProcess = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
	...await importOriginal<typeof import('node:child_process')>(),
	execFile: childProcess.execFile,
	spawn: childProcess.spawn,
}));

const me = { id: 'me', host: null } as any;

function fixture(overrides: { types?: string[]; names?: string[]; conversions?: number; addFileError?: Error; probe?: object } = {}) {
	const types = overrides.types ?? ['audio/webm'];
	const files = types.map((type, i) => ({
		id: `original${i}`,
		userId: 'me',
		storedInternal: true,
		accessKey: `access-key${i}`,
		type,
		name: (overrides.names?.[i] ?? `room 1-20261115-090807${i > 0 ? `-${String(i + 1).padStart(3, '0')}` : ''}.webm`),
		size: 1024,
	}));
	const driveFilesRepository = { findBy: vi.fn().mockResolvedValue(files), findOneBy: vi.fn().mockResolvedValue(files[0]) };
	const redisClient = { eval: vi.fn().mockResolvedValue(1) };
	const driveService = {
		addFile: overrides.addFileError != null
			? vi.fn().mockRejectedValue(overrides.addFileError)
			: vi.fn().mockResolvedValue({ id: 'converted', folderId: 'folder1' }),
		deleteFile: vi.fn().mockResolvedValue(undefined),
	};
	const internalStorageService = { resolvePath: vi.fn((key: string) => `/recordings/${key}.webm`) };
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
	return { endpoint, driveService, driveFilesRepository, files };
}

function mockProbe(probe?: object) {
	childProcess.execFile.mockImplementation((_cmd: string, args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
		// ffprobe
		callback(null, JSON.stringify(probe ?? { format: { duration: '10' }, streams: [{ codec_type: 'audio' }, { codec_type: 'video', width: 1280, height: 720 }] }), '');
	});
}

function mockFfmpeg(writeBytes = 10) {
	childProcess.spawn.mockImplementation((_cmd: string, args: string[]) => {
		const dst = args[args.length - 1];
		const child = new EventEmitter() as any;
		child.stderr = new EventEmitter();
		child.kill = vi.fn();
		queueMicrotask(() => {
			fs.writeFileSync(dst, 'x'.repeat(writeBytes));
			child.emit('close', 0);
		});
		return child;
	});
}

beforeEach(() => {
	childProcess.execFile.mockReset();
	childProcess.spawn.mockReset();
	mockProbe();
	mockFfmpeg();
});

describe('chat/rooms/voice/convert-recording', () => {
	test('converts a single audio recording to mp3 in the requested folder and deletes the original', async () => {
		const f = fixture();

		await expect(f.endpoint.exec({ fileIds: ['original0'], video: false, folderId: 'folder1' }, me, null, null)).resolves.toEqual({ id: 'converted' });

		const args = childProcess.spawn.mock.calls[0][1] as string[];
		expect(args).toContain('-vn');
		expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'room 1-20261115-090807.mp3', folderId: 'folder1', force: true }));
		expect(f.driveService.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'original0' }), false, me);
	});

	test('concatenates several parts in order into one file and deletes every part', async () => {
		const f = fixture({ types: ['audio/webm', 'audio/webm', 'audio/webm'] });

		await f.endpoint.exec({ fileIds: ['original0', 'original1', 'original2'], video: false, folderId: 'folder1' }, me, null, null);

		const args = childProcess.spawn.mock.calls[0][1] as string[];
		expect(args).toContain('concat');
		// only one final file is added
		expect(f.driveService.addFile).toHaveBeenCalledTimes(1);
		expect(f.driveService.deleteFile).toHaveBeenCalledTimes(3);
	});

	test('keeps the video of a video recording by default', async () => {
		const f = fixture({ types: ['video/webm'] });

		await f.endpoint.exec({ fileIds: ['original0'] }, me, null, null);

		const args = childProcess.spawn.mock.calls[0][1] as string[];
		expect(args).toContain('libx264');
		expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'room 1-20261115-090807.mp4' }));
	});

	test('discards the black video lead-in when the caller asks for audio only', async () => {
		const f = fixture({ types: ['video/webm'] });

		await f.endpoint.exec({ fileIds: ['original0'], video: false }, me, null, null);

		const args = childProcess.spawn.mock.calls[0][1] as string[];
		expect(args).toContain('-vn');
	});

	test.each([
		['audio/mp4', 'room 1-20261115-090807.mp3'],
		['video/mp4', 'room 1-20261115-090807.mp4'],
	])('accepts %s recordings from browsers that cannot record webm', async (type, name) => {
		const f = fixture({ types: [type], names: ['room 1-20261115-090807.mp4'] });

		await expect(f.endpoint.exec({ fileIds: ['original0'] }, me, null, null)).resolves.toEqual({ id: 'converted' });

		expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ name }));
	});

	test('reports a missing folder instead of a generic conversion failure', async () => {
		const f = fixture({ addFileError: new Error('folder-not-found') });

		await expect(f.endpoint.exec({ fileIds: ['original0'], folderId: 'gone' }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_FOLDER' });
		expect(meta.errors).toHaveProperty('noSuchFolder');
	});

	test('rejects an over-long input before running ffmpeg and keeps the original', async () => {
		const f = fixture();
		mockProbe({ format: { duration: String(5 * 60 * 60) }, streams: [{ codec_type: 'audio' }] });

		await expect(f.endpoint.exec({ fileIds: ['original0'] }, me, null, null)).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(f.driveService.deleteFile).not.toHaveBeenCalled();
	});

	test('rejects an over-large resolution before running ffmpeg', async () => {
		const f = fixture({ types: ['video/webm'] });
		mockProbe({ format: { duration: '10' }, streams: [{ codec_type: 'audio' }, { codec_type: 'video', width: 3840, height: 2160 }] });

		await expect(f.endpoint.exec({ fileIds: ['original0'] }, me, null, null)).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});

	test('stops and reports when the output grows past the limit while running', async () => {
		const f = fixture();
		// role cap 100MB but server cap small; write a big output so the watchdog trips
		const endpoint = new ConvertRecordingEndpoint(
			{ maxFileSize: 100 } as any,
			{ voiceCallMaxRecordingConversions: 2 } as any,
			f.driveFilesRepository as any,
			{ eval: vi.fn().mockResolvedValue(1) } as any,
			f.driveService as any,
			{ resolvePath: vi.fn(() => '/recordings/a.webm') } as any,
			{ pack: vi.fn(async (p: { id: string }) => ({ id: p.id })) } as any,
			{ getUserPolicies: vi.fn().mockResolvedValue({ maxFileSizeMb: 100, driveCapacityMb: 1000 }) } as any,
			{ logger: { warn: vi.fn() } } as any,
		);
		mockFfmpeg(1024); // > 100 byte server cap

		await expect(endpoint.exec({ fileIds: ['original0'] }, me, null, null)).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' });
		expect(f.driveService.addFile).not.toHaveBeenCalled();
		expect(f.driveService.deleteFile).not.toHaveBeenCalled();
	});

	test('leaves files that are not recordings alone', async () => {
		const f = fixture({ types: ['image/png'] });

		await expect(f.endpoint.exec({ fileIds: ['original0'] }, me, null, null)).resolves.toBeNull();

		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(f.driveService.addFile).not.toHaveBeenCalled();
	});

	test('keeps the originals when conversion is turned off', async () => {
		const f = fixture({ conversions: 0 });

		await expect(f.endpoint.exec({ fileIds: ['original0'] }, me, null, null)).resolves.toBeNull();

		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(f.driveService.addFile).not.toHaveBeenCalled();
		expect(f.driveService.deleteFile).not.toHaveBeenCalled();
	});
});
