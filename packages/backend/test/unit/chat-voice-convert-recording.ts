/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import ConvertRecordingEndpoint, { meta } from '@/server/api/endpoints/chat/rooms/voice/convert-recording.js';
import { RecordingStorageFullError, type RecordingResult } from '@/core/RecordingStorageService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';

const childProcess = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
	...await importOriginal<typeof import('node:child_process')>(),
	execFile: childProcess.execFile,
	spawn: childProcess.spawn,
}));

const me = { id: 'me', host: null } as any;
const requestId = '11111111-1111-4111-8111-111111111111';
const tempDirs: string[] = [];

function fixture(overrides: { types?: string[]; names?: string[]; conversions?: number; addFileError?: Error; remembered?: RecordingResult | null; storeError?: Error; deleteFails?: string[]; serverMaxBytes?: number; roleMaxFileSizeMb?: number; objectStorage?: boolean; downloadFails?: boolean; downloadFailsAt?: number; remoteSize?: number; tempParts?: { id: string; userId?: string; type?: string; name?: string }[] } = {}) {
	const partDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-recording-parts-'));
	tempDirs.push(partDir);
	const types = overrides.types ?? ['audio/webm'];
	const files = types.map((type, i) => ({
		id: `original${i}`,
		userId: 'me',
		storedInternal: !overrides.objectStorage,
		accessKey: `access-key${i}`,
		url: `https://storage.example/part${i}.webm`,
		type,
		name: (overrides.names?.[i] ?? `room 1-20261115-090807${i > 0 ? `-${String(i + 1).padStart(3, '0')}` : ''}.webm`),
		size: overrides.remoteSize ?? 1024,
	}));
	const driveFilesRepository = { findBy: vi.fn().mockResolvedValue(files), findOneBy: vi.fn().mockResolvedValue(files[0]) };
	const redisClient = { eval: vi.fn().mockResolvedValue(1) };
	const driveService = {
		addFile: overrides.addFileError != null
			? vi.fn().mockRejectedValue(overrides.addFileError)
			: vi.fn().mockResolvedValue({ id: 'converted', folderId: 'folder1' }),
		deleteFile: vi.fn(async (file: { id: string }) => {
			if (overrides.deleteFails?.includes(file.id)) throw new Error('delete unavailable');
		}),
	};
	const internalStorageService = { resolvePath: vi.fn((key: string) => `/recordings/${key}.webm`) };
	const downloaded: string[] = [];
	const failed: string[] = [];
	const downloadService = {
		downloadUrl: vi.fn(async (_url: string, dst: string) => {
			if (overrides.downloadFails || overrides.downloadFailsAt === downloaded.length + failed.length) { failed.push(dst); throw new Error('download failed'); }
			fs.writeFileSync(dst, 'x');
			downloaded.push(dst);
			return { filename: 'part.webm' };
		}),
	};
	const driveFileEntityService = { pack: vi.fn(async (packed: { id: string }) => ({ id: packed.id })) };
	const roleService = { getUserPolicies: vi.fn().mockResolvedValue({ maxFileSizeMb: overrides.roleMaxFileSizeMb ?? 100, driveCapacityMb: 1000 }) };
	const apiLoggerService = { logger: { warn: vi.fn() } };
	const results = new Map<string, RecordingResult>();
	if (overrides.remembered != null) results.set(requestId, overrides.remembered);
	// 임시 보관 조각은 실제 파일이 있어야 변환 입력으로 인정된다
	const partPaths = new Map<string, string>();
	const recordingStorage = {
		getResult: vi.fn(async (_userId: string, id: string) => results.get(id) ?? null),
		setResult: vi.fn(async (_userId: string, id: string, value: RecordingResult) => { results.set(id, value); }),
		clearResult: vi.fn(async (_userId: string, id: string) => { results.delete(id); }),
		store: overrides.storeError != null
			? vi.fn().mockRejectedValue(overrides.storeError)
			: vi.fn(async (_userId: string, _requestId: string, _src: string, name: string) => ({ id: 'dl-1', userId: 'me', requestId, path: '/tmp/dl-1', name, size: 2048 })),
		getDownload: vi.fn().mockResolvedValue(null),
		getPart: vi.fn(async (id: string) => {
			const part = (overrides.tempParts ?? []).find(p => p.id === id);
			if (part == null) return null;
			const partPath = path.join(partDir, `${id}.webm`);
			fs.writeFileSync(partPath, 'x');
			partPaths.set(id, partPath);
			return { id: part.id, userId: part.userId ?? 'me', path: partPath, name: part.name ?? `room 1-20261115-090807-${part.id}.webm`, size: 1024, type: part.type ?? 'audio/webm' };
		}),
		removePart: vi.fn().mockResolvedValue(undefined),
		retryPartCleanup: vi.fn().mockResolvedValue(undefined),
		removeDownload: vi.fn().mockResolvedValue(undefined),
	};
	const endpoint = new ConvertRecordingEndpoint(
		{ maxFileSize: overrides.serverMaxBytes ?? 100 * 1024 * 1024 } as any,
		{ voiceCallMaxRecordingConversions: overrides.conversions ?? 2 } as any,
		driveFilesRepository as any,
		redisClient as any,
		driveService as any,
		internalStorageService as any,
		driveFileEntityService as any,
		recordingStorage as any,
		roleService as any,
		apiLoggerService as any,
		downloadService as any,
	);
	return { endpoint, downloadService, downloaded, driveService, driveFilesRepository, recordingStorage, results, files, partPaths, apiLoggerService };
}

function mockProbe(probe?: object) {
	childProcess.execFile.mockImplementation((_cmd: string, args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
		// ffprobe
		callback(null, JSON.stringify(probe ?? { format: { duration: '10' }, streams: [{ codec_type: 'audio' }, { codec_type: 'video', width: 1280, height: 720 }] }), '');
	});
}

function mockFfmpeg(writeBytes = 10, onSpawn?: (args: string[]) => void) {
	childProcess.spawn.mockImplementation((_cmd: string, args: string[]) => {
		onSpawn?.(args);
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

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('chat/rooms/voice/convert-recording', () => {
	test('converts a single audio recording to mp3 in the requested folder and deletes the original', async () => {
		const f = fixture();

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false, folderId: 'folder1' }, me, null, null)).resolves.toEqual({ file: { id: 'converted' }, download: null });

		const args = childProcess.spawn.mock.calls[0][1] as string[];
		expect(args).toContain('-vn');
		expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'room 1-20261115-090807.mp3', folderId: 'folder1', force: true }));
		expect(f.driveService.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'original0' }), false, me);
		expect(f.results.get(requestId)).toMatchObject({ fileId: 'converted', remainingParts: [] });
	});

	test('concatenates several parts in order into one file and deletes every part', async () => {
		const f = fixture({ types: ['audio/webm', 'audio/webm', 'audio/webm'] });

		await f.endpoint.exec({ fileIds: ['original0', 'original1', 'original2'], requestId, video: false, folderId: 'folder1' }, me, null, null);

		const args = childProcess.spawn.mock.calls[0][1] as string[];
		expect(args).toContain('concat');
		// only one final file is added
		expect(f.driveService.addFile).toHaveBeenCalledTimes(1);
		expect(f.driveService.deleteFile).toHaveBeenCalledTimes(3);
	});

	test('downloads parts stored in object storage, converts them into one file and removes the temporary files', async () => {
		const f = fixture({ types: ['audio/webm', 'audio/webm'], objectStorage: true });
		let listed: string[] = [];
		mockFfmpeg(10, args => {
			const listPath = args.find(a => a.endsWith('parts.txt'))!;
			listed = fs.readFileSync(listPath, 'utf8').split('\n').filter(l => l.startsWith('file ')).map(l => l.replace(/^file '/, '').replace(/'$/, ''));
		});
		const probed: string[] = [];
		childProcess.execFile.mockImplementation((_cmd: string, args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
			probed.push(args[args.length - 1]);
			callback(null, JSON.stringify({ format: { duration: '10' }, streams: [{ codec_type: 'audio' }] }), '');
		});

		await expect(f.endpoint.exec({ fileIds: ['original0', 'original1'], requestId, video: false }, me, null, null)).resolves.toEqual({ file: { id: 'converted' }, download: null });

		expect(f.downloadService.downloadUrl.mock.calls.map(c => c[0])).toEqual(['https://storage.example/part0.webm', 'https://storage.example/part1.webm']);
		expect(f.downloaded).toHaveLength(2);
		expect(probed).toEqual(f.downloaded);
		expect(listed).toEqual(f.downloaded);
		expect(f.driveService.addFile).toHaveBeenCalledTimes(1);
		expect(f.driveService.deleteFile).toHaveBeenCalledTimes(2);
		expect(f.downloaded.some(p => fs.existsSync(p))).toBe(false);
	});

	test('keeps the originals and removes downloaded files when a part of object storage cannot be downloaded', async () => {
		const f = fixture({ types: ['audio/webm', 'audio/webm'], objectStorage: true, downloadFailsAt: 1 });

		await expect(f.endpoint.exec({ fileIds: ['original0', 'original1'], requestId }, me, null, null)).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
		expect(f.downloaded).toHaveLength(1);
		expect(fs.existsSync(f.downloaded[0])).toBe(false);
		expect(fs.existsSync(path.dirname(f.downloaded[0]))).toBe(false);
		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(f.driveService.deleteFile).not.toHaveBeenCalled();
	});

	test('converts parts of object storage that are larger than the drive file limit', async () => {
		// 서버 한도 이하이면서 역할 한도보다 큰 조각
		const f = fixture({ objectStorage: true, remoteSize: 20 * 1024 * 1024, serverMaxBytes: 1024 * 1024 * 1024, roleMaxFileSizeMb: 10 });

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false }, me, null, null)).resolves.toEqual({ file: { id: 'converted' }, download: null });
		expect(f.downloadService.downloadUrl).toHaveBeenCalledTimes(1);
	});

	test('converts a part of object storage together with a temporarily kept part', async () => {
		const f = fixture({ types: ['audio/webm'], objectStorage: true, tempParts: [{ id: 'temp1' }] });

		await expect(f.endpoint.exec({ fileIds: ['original0', 'temp1'], requestId, video: false }, me, null, null)).resolves.toEqual({ file: { id: 'converted' }, download: null });
		expect(f.downloadService.downloadUrl).toHaveBeenCalledTimes(1);
		expect(childProcess.spawn.mock.calls[0][1] as string[]).toContain('concat');
		expect(f.driveService.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'original0' }), false, me);
		expect(f.recordingStorage.removePart).toHaveBeenCalledWith('temp1');
	});

	test('keeps the video of a video recording by default', async () => {
		const f = fixture({ types: ['video/webm'] });

		await f.endpoint.exec({ fileIds: ['original0'], requestId }, me, null, null);

		const args = childProcess.spawn.mock.calls[0][1] as string[];
		expect(args).toContain('libx264');
		expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'room 1-20261115-090807.mp4' }));
	});

	test('discards the black video lead-in when the caller asks for audio only', async () => {
		const f = fixture({ types: ['video/webm'] });

		await f.endpoint.exec({ fileIds: ['original0'], requestId, video: false }, me, null, null);

		const args = childProcess.spawn.mock.calls[0][1] as string[];
		expect(args).toContain('-vn');
	});

	test.each([
		['audio/mp4', 'room 1-20261115-090807.mp3'],
		['video/mp4', 'room 1-20261115-090807.mp4'],
	])('accepts %s recordings from browsers that cannot record webm', async (type, name) => {
		const f = fixture({ types: [type], names: ['room 1-20261115-090807.mp4'] });

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId }, me, null, null)).resolves.toEqual({ file: { id: 'converted' }, download: null });

		expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ name }));
	});

	test('reports a missing folder instead of a generic conversion failure', async () => {
		const f = fixture({ addFileError: new Error('folder-not-found') });

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, folderId: 'gone' }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_FOLDER' });
		expect(meta.errors).toHaveProperty('noSuchFolder');
	});

	test('rejects an over-long input before running ffmpeg and keeps the original', async () => {
		const f = fixture();
		mockProbe({ format: { duration: String(5 * 60 * 60) }, streams: [{ codec_type: 'audio' }] });

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId }, me, null, null)).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(f.driveService.deleteFile).not.toHaveBeenCalled();
	});

	test('rejects an over-large resolution before running ffmpeg', async () => {
		const f = fixture({ types: ['video/webm'] });
		mockProbe({ format: { duration: '10' }, streams: [{ codec_type: 'audio' }, { codec_type: 'video', width: 3840, height: 2160 }] });

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId }, me, null, null)).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});

	test('rejects duplicate part ids instead of probing the same file again and again', async () => {
		const f = fixture();

		await expect(f.endpoint.exec({ fileIds: ['original0', 'original0'], requestId }, me, null, null)).rejects.toMatchObject({ code: 'DUPLICATE_FILE' });
		expect(childProcess.execFile).not.toHaveBeenCalled();
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});

	test('probes many parts with a small bounded concurrency', async () => {
		const types = Array.from({ length: 20 }, () => 'audio/webm');
		const f = fixture({ types });
		let active = 0;
		let max = 0;
		childProcess.execFile.mockImplementation((_cmd: string, _args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
			active += 1;
			max = Math.max(max, active);
			setTimeout(() => {
				active -= 1;
				callback(null, JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'audio' }] }), '');
			}, 5);
		});

		await f.endpoint.exec({ fileIds: types.map((_, i) => `original${i}`), requestId, video: false }, me, null, null);

		expect(max).toBeLessThanOrEqual(4);
		expect(max).toBeGreaterThan(1);
	});

	test('waits for running probes before giving the slot back when one fails', async () => {
		const types = Array.from({ length: 8 }, () => 'audio/webm');
		const f = fixture({ types });
		let started = 0;
		let finished = 0;
		childProcess.execFile.mockImplementation((_cmd: string, _args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
			started += 1;
			const fail = started === 1;
			setTimeout(() => {
				finished += 1;
				callback(fail ? new Error('probe failed') : null, JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'audio' }] }), '');
			}, 10);
		});

		await expect(f.endpoint.exec({ fileIds: types.map((_, i) => `original${i}`), requestId, video: false }, me, null, null)).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
		// 실패 뒤에 남은 probe를 시작하지 않고, 실행 중이던 것은 끝까지 기다린다
		expect(started).toBeLessThanOrEqual(4);
		expect(finished).toBe(started);
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});

	test('returns the remembered final file for a repeated request without converting again', async () => {
		const f = fixture({ remembered: { fileId: 'converted', folderId: 'folder1', remainingParts: ['original0'] } });
		f.driveFilesRepository.findOneBy.mockResolvedValue({ id: 'converted', userId: 'me' });

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false }, me, null, null)).resolves.toEqual({ file: { id: 'converted' }, download: null });

		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(f.driveService.addFile).not.toHaveBeenCalled();
		expect(f.recordingStorage.retryPartCleanup).toHaveBeenCalledWith('me', requestId, expect.objectContaining({ remainingParts: ['original0'] }));
	});

	test('returns the kept download again while it is alive', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-recording-test-'));
		const kept = path.join(dir, 'kept.mp3');
		fs.writeFileSync(kept, 'x');
		const f = fixture({ addFileError: new IdentifiableError('f9e4e5f3-4df4-40b5-b400-f236945f7073', 'Max file size exceeded.'), remembered: { download: { id: 'dl-1', name: 'room.mp3', size: 1, reason: 'tooLarge' }, remainingParts: [] } });
		f.recordingStorage.getDownload.mockResolvedValue({ id: 'dl-1', userId: 'me', requestId, path: kept, name: 'room.mp3', size: 1 });

		try {
			await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false }, me, null, null))
				.resolves.toEqual({ file: null, download: { id: 'dl-1', name: 'room.mp3', size: 1, reason: 'tooLarge' } });
			expect(f.recordingStorage.removeDownload).not.toHaveBeenCalled();
			expect(f.recordingStorage.clearResult).not.toHaveBeenCalled();
			expect(childProcess.spawn).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('saves the kept download to the drive on retry once the limit or space is fixed', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-recording-test-'));
		const kept = path.join(dir, 'kept.mp3');
		fs.writeFileSync(kept, 'x');
		const f = fixture({ remembered: { download: { id: 'dl-1', name: 'room.mp3', size: 1, reason: 'noFreeSpace' }, remainingParts: [] } });
		f.recordingStorage.getDownload.mockResolvedValue({ id: 'dl-1', userId: 'me', requestId, path: kept, name: 'room.mp3', size: 1 });

		try {
			await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false, folderId: 'folder1' }, me, null, null))
				.resolves.toEqual({ file: { id: 'converted' }, download: null });
			expect(f.driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ path: kept, name: 'room.mp3', folderId: 'folder1' }));
			expect(f.recordingStorage.removeDownload).toHaveBeenCalledWith('dl-1');
			expect(f.results.get(requestId)).toMatchObject({ fileId: 'converted' });
			expect(childProcess.spawn).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a retry keeps the over-limit download without saving it to the drive', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-recording-test-'));
		const kept = path.join(dir, 'kept.mp3');
		fs.writeFileSync(kept, 'x');
		const f = fixture({ serverMaxBytes: 100, remembered: { download: { id: 'dl-1', name: 'room.mp3', size: 1024, reason: 'tooLarge' }, remainingParts: [] } });
		f.recordingStorage.getDownload.mockResolvedValue({ id: 'dl-1', userId: 'me', requestId, path: kept, name: 'room.mp3', size: 1024 });

		try {
			await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false }, me, null, null))
				.resolves.toEqual({ file: null, download: { id: 'dl-1', name: 'room.mp3', size: 1024, reason: 'tooLarge' } });
			expect(f.driveService.addFile).not.toHaveBeenCalled();
			expect(f.recordingStorage.removeDownload).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a retry maps a missing folder to NO_SUCH_FOLDER and keeps the download', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-recording-test-'));
		const kept = path.join(dir, 'kept.mp3');
		fs.writeFileSync(kept, 'x');
		const f = fixture({ addFileError: new Error('folder-not-found'), remembered: { download: { id: 'dl-1', name: 'room.mp3', size: 1, reason: 'tooLarge' }, remainingParts: [] } });
		f.recordingStorage.getDownload.mockResolvedValue({ id: 'dl-1', userId: 'me', requestId, path: kept, name: 'room.mp3', size: 1 });

		try {
			await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false, folderId: 'gone' }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_FOLDER' });
			expect(f.recordingStorage.removeDownload).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a retry logs an unexpected save error, reports CONVERSION_FAILED and keeps the download', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-recording-test-'));
		const kept = path.join(dir, 'kept.mp3');
		fs.writeFileSync(kept, 'x');
		const f = fixture({ addFileError: new Error('storage unavailable'), remembered: { download: { id: 'dl-1', name: 'room.mp3', size: 1, reason: 'tooLarge' }, remainingParts: [] } });
		f.recordingStorage.getDownload.mockResolvedValue({ id: 'dl-1', userId: 'me', requestId, path: kept, name: 'room.mp3', size: 1 });

		try {
			await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false }, me, null, null)).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
			expect(f.apiLoggerService.logger.warn).toHaveBeenCalledWith(expect.stringContaining('storage unavailable'));
			expect(f.recordingStorage.removeDownload).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a retry passes errors after the file was saved to the common error handling instead of CONVERSION_FAILED', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-recording-test-'));
		const kept = path.join(dir, 'kept.mp3');
		fs.writeFileSync(kept, 'x');
		const f = fixture({ remembered: { download: { id: 'dl-1', name: 'room.mp3', size: 1, reason: 'tooLarge' }, remainingParts: [] } });
		f.recordingStorage.getDownload.mockResolvedValue({ id: 'dl-1', userId: 'me', requestId, path: kept, name: 'room.mp3', size: 1 });
		f.recordingStorage.setResult.mockRejectedValueOnce(new Error('redis down'));

		try {
			await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false }, me, null, null)).rejects.toThrow('redis down');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a retry after the download expired keeps the leftover-part cleanup record', async () => {
		// 내려받기가 만료되고 원본 조각도 이미 사라진 경우: 재시도는 실패하더라도 남은 조각 정리 기록은 남아야 한다
		const f = fixture({ remembered: { download: { id: 'dl-1', name: 'room.mp3', size: 2048, reason: 'tooLarge' }, remainingParts: ['original1'] } });
		f.driveFilesRepository.findBy.mockResolvedValue([]);

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });

		expect(f.results.get(requestId)).toMatchObject({ remainingParts: ['original1'] });
		expect(f.recordingStorage.retryPartCleanup).toHaveBeenCalledWith('me', requestId, expect.objectContaining({ remainingParts: ['original1'] }));
	});

	test('keeps an over-limit final file for a one-time download instead of the drive', async () => {
		const f = fixture({ serverMaxBytes: 100 });
		mockFfmpeg(1024); // > 100 byte server cap

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false }, me, null, null))
			.resolves.toEqual({ file: null, download: { id: 'dl-1', name: 'room 1-20261115-090807.mp3', size: 2048, reason: 'tooLarge' } });

		expect(f.driveService.addFile).not.toHaveBeenCalled();
		expect(f.recordingStorage.store).toHaveBeenCalled();
		expect(f.driveService.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'original0' }), false, me);
		expect(f.results.get(requestId)).toMatchObject({ download: { id: 'dl-1', reason: 'tooLarge' }, remainingParts: [] });
	});

	test('offers the kept download when the drive has no free space for the final file', async () => {
		const f = fixture({ addFileError: new IdentifiableError('c6244ed2-a39a-4e1c-bf93-f0fbd7764fa6', 'No free space.') });

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false }, me, null, null))
			.resolves.toMatchObject({ file: null, download: { id: 'dl-1', reason: 'noFreeSpace' } });
	});

	test('keeps the originals when the temporary download storage is full', async () => {
		const f = fixture({ serverMaxBytes: 100, storeError: new RecordingStorageFullError() });
		mockFfmpeg(1024);

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId, video: false }, me, null, null)).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' });
		expect(f.driveService.deleteFile).not.toHaveBeenCalled();
	});

	test('records leftover parts when a deletion fails and still reports the saved file', async () => {
		const f = fixture({ types: ['audio/webm', 'audio/webm'], deleteFails: ['original1'] });

		await expect(f.endpoint.exec({ fileIds: ['original0', 'original1'], requestId, video: false }, me, null, null))
			.resolves.toEqual({ file: { id: 'converted' }, download: null });

		expect(f.results.get(requestId)).toMatchObject({ fileId: 'converted', remainingParts: ['original1'] });
	});

	test('leaves files that are not recordings alone', async () => {
		const f = fixture({ types: ['image/png'] });

		await expect(f.endpoint.exec({ fileIds: ['original0'], requestId }, me, null, null)).resolves.toBeNull();

		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(f.driveService.addFile).not.toHaveBeenCalled();
	});

	test('still produces one final file when the stored conversion limit is zero', async () => {
		const f = fixture({ types: ['audio/webm', 'audio/webm'], conversions: 0 });

		await expect(f.endpoint.exec({ fileIds: ['original0', 'original1'], requestId, video: false }, me, null, null))
			.resolves.toEqual({ file: { id: 'converted' }, download: null });

		expect(childProcess.spawn).toHaveBeenCalledTimes(1);
		expect(f.driveService.addFile).toHaveBeenCalledTimes(1);
		expect(f.driveService.deleteFile).toHaveBeenCalledTimes(2);
	});

	test('concatenates drive parts with parts kept in the recording storage, in order, and deletes both', async () => {
		const f = fixture({ types: ['audio/webm', 'audio/webm'], tempParts: [{ id: 'temp1' }] });
		// 두 번째 조각은 드라이브에 올라가지 못해 임시 보관에 있다
		f.driveFilesRepository.findBy.mockResolvedValue([f.files[0]]);
		const listWrites: string[] = [];
		mockFfmpeg(10, args => {
			const listPath = args[args.indexOf('-i') + 1];
			if (listPath.endsWith('parts.txt')) listWrites.push(fs.readFileSync(listPath, 'utf8'));
		});

		await expect(f.endpoint.exec({ fileIds: ['original0', 'temp1'], requestId, video: false }, me, null, null))
			.resolves.toEqual({ file: { id: 'converted' }, download: null });

		expect(listWrites).toHaveLength(1);
		expect(listWrites[0].indexOf('/recordings/access-key0.webm')).toBeGreaterThanOrEqual(0);
		expect(listWrites[0].indexOf(f.partPaths.get('temp1')!)).toBeGreaterThan(listWrites[0].indexOf('/recordings/access-key0.webm'));
		expect(f.driveService.addFile).toHaveBeenCalledTimes(1);
		expect(f.driveService.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'original0' }), false, me);
		expect(f.recordingStorage.removePart).toHaveBeenCalledWith('temp1');
		expect(f.results.get(requestId)).toMatchObject({ fileId: 'converted', remainingParts: [] });
	});

	test('keeps an over-limit final file from mixed sources for a one-time download and deletes both kinds of parts', async () => {
		const f = fixture({ types: ['audio/webm'], tempParts: [{ id: 'temp1' }], serverMaxBytes: 100 });
		f.driveFilesRepository.findBy.mockResolvedValue([f.files[0]]);
		mockFfmpeg(1024);

		await expect(f.endpoint.exec({ fileIds: ['original0', 'temp1'], requestId, video: false }, me, null, null))
			.resolves.toMatchObject({ file: null, download: { id: 'dl-1', reason: 'tooLarge' } });

		expect(f.driveService.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'original0' }), false, me);
		expect(f.recordingStorage.removePart).toHaveBeenCalledWith('temp1');
	});

	test('rejects a part id that is not in the recording storage', async () => {
		const f = fixture();
		f.driveFilesRepository.findBy.mockResolvedValue([]);

		await expect(f.endpoint.exec({ fileIds: ['gone'], requestId }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});

	test('rejects a recording-storage part owned by someone else', async () => {
		const f = fixture({ tempParts: [{ id: 'temp1', userId: 'other' }] });
		f.driveFilesRepository.findBy.mockResolvedValue([]);

		await expect(f.endpoint.exec({ fileIds: ['temp1'], requestId }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});
});
