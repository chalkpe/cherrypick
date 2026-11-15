/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import RecordingPartEndpoint from '@/server/api/endpoints/chat/rooms/voice/recording-part.js';
import { RecordingStorageFullError } from '@/core/RecordingStorageService.js';

const me = { id: 'me', host: null } as any;
const tmpDirs: string[] = [];

function fixture(overrides: { mime?: string; maxFileSizeMb?: number; serverMaxBytes?: number; storeError?: Error } = {}) {
	const fileInfoService = { detectType: vi.fn().mockResolvedValue({ mime: overrides.mime ?? 'audio/webm', ext: 'webm' }) };
	const roleService = { getUserPolicies: vi.fn().mockResolvedValue({ maxFileSizeMb: overrides.maxFileSizeMb ?? 100 }) };
	const recordingStorage = {
		storePart: overrides.storeError != null
			? vi.fn().mockRejectedValue(overrides.storeError)
			: vi.fn(async (userId: string, _src: string, name: string, type: string) => ({ id: 'part-1', userId, path: '/tmp/part-1', name, size: 8, type })),
	};
	const endpoint = new RecordingPartEndpoint(
		{ maxFileSize: overrides.serverMaxBytes ?? 100 * 1024 * 1024 } as any,
		fileInfoService as any,
		roleService as any,
		recordingStorage as any,
	);
	return { endpoint, fileInfoService, recordingStorage };
}

function partFile(bytes = 8): { name: string; path: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-part-test-'));
	tmpDirs.push(dir);
	const file = path.join(dir, 'room 1-20261116-120000.webm');
	fs.writeFileSync(file, Buffer.alloc(bytes, 3));
	return { name: 'room 1-20261116-120000.webm', path: file };
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('chat/rooms/voice/recording-part', () => {
	test('stores a recording part in the temporary recording storage', async () => {
		const f = fixture();
		const file = partFile();

		await expect(f.endpoint.exec({}, me, null, null, file)).resolves.toEqual({ id: 'part-1', size: 8 });

		expect(f.recordingStorage.storePart).toHaveBeenCalledWith('me', file.path, file.name, 'audio/webm');
	});

	test('accepts video recording parts', async () => {
		const f = fixture({ mime: 'video/webm' });

		await expect(f.endpoint.exec({}, me, null, null, partFile())).resolves.toEqual({ id: 'part-1', size: 8 });

		expect(f.recordingStorage.storePart).toHaveBeenCalledWith('me', expect.any(String), expect.any(String), 'video/webm');
	});

	test('rejects content that is not a recording', async () => {
		const f = fixture({ mime: 'image/png' });

		await expect(f.endpoint.exec({}, me, null, null, partFile())).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
		expect(f.recordingStorage.storePart).not.toHaveBeenCalled();
	});

	test('rejects a part larger than the role file size limit', async () => {
		const f = fixture({ maxFileSizeMb: 1 / 1024 });

		await expect(f.endpoint.exec({}, me, null, null, partFile(2048))).rejects.toMatchObject({ code: 'TOO_LARGE' });
		expect(f.recordingStorage.storePart).not.toHaveBeenCalled();
	});

	test('reports a full temporary recording storage', async () => {
		const f = fixture({ storeError: new RecordingStorageFullError() });

		await expect(f.endpoint.exec({}, me, null, null, partFile())).rejects.toMatchObject({ code: 'STORAGE_FULL' });
	});
});