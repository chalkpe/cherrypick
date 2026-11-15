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
import { ApiError } from '@/server/api/error.js';

const me = { id: 'me', host: null, isSuspended: false, isDeleted: false } as any;
const tmpDirs: string[] = [];

function fixture(overrides: {
	mime?: string; maxFileSizeMb?: number; serverMaxBytes?: number; storeError?: Error;
	room?: Record<string, unknown> | null; member?: boolean; chatWriteDenied?: boolean;
} = {}) {
	const fileInfoService = { detectType: vi.fn().mockResolvedValue({ mime: overrides.mime ?? 'audio/webm', ext: 'webm' }) };
	const roleService = { getUserPolicies: vi.fn().mockResolvedValue({ maxFileSizeMb: overrides.maxFileSizeMb ?? 100 }) };
	const recordingStorage = {
		storePart: overrides.storeError != null
			? vi.fn().mockRejectedValue(overrides.storeError)
			: vi.fn(async (userId: string, _src: string, name: string, type: string) => ({ id: 'part-1', userId, path: '/tmp/part-1', name, size: 8, type })),
	};
	const chatService = {
		checkChatAvailability: overrides.chatWriteDenied === true
			? vi.fn().mockRejectedValue(new ApiError({ message: 'Your role does not allow this chat action.', code: 'ROLE_PERMISSION_DENIED', kind: 'permission', id: '4768787a-dc92-45ad-ac96-6491d4a0d0a8' }))
			: vi.fn().mockResolvedValue(undefined),
		findRoomById: vi.fn().mockResolvedValue(overrides.room === undefined
			? { id: 'room1', ownerId: 'me', isArchived: false, allowRecording: true }
			: overrides.room),
	};
	const chatRoomMembershipsRepository = { exists: vi.fn().mockResolvedValue(overrides.member ?? false) };
	const endpoint = new RecordingPartEndpoint(
		{ maxFileSize: overrides.serverMaxBytes ?? 100 * 1024 * 1024 } as any,
		chatService as any,
		chatRoomMembershipsRepository as any,
		fileInfoService as any,
		roleService as any,
		recordingStorage as any,
	);
	return { endpoint, fileInfoService, recordingStorage, chatService, chatRoomMembershipsRepository };
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

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, file)).resolves.toEqual({ id: 'part-1', size: 8 });

		expect(f.recordingStorage.storePart).toHaveBeenCalledWith('me', file.path, file.name, 'audio/webm');
	});

	test('accepts video recording parts', async () => {
		const f = fixture({ mime: 'video/webm' });

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, partFile())).resolves.toEqual({ id: 'part-1', size: 8 });

		expect(f.recordingStorage.storePart).toHaveBeenCalledWith('me', expect.any(String), expect.any(String), 'video/webm');
	});

	test('accepts a part from a room member after the call session ended', async () => {
		const f = fixture({ room: { id: 'room1', ownerId: 'owner', isArchived: false, allowRecording: true }, member: true });

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, partFile())).resolves.toEqual({ id: 'part-1', size: 8 });

		expect(f.chatService.checkChatAvailability).toHaveBeenCalledWith('me', 'write');
		expect(f.recordingStorage.storePart).toHaveBeenCalled();
	});

	test('rejects a user who is not a member of the room', async () => {
		const f = fixture({ room: { id: 'room1', ownerId: 'owner', isArchived: false, allowRecording: true }, member: false });

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, partFile())).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		expect(f.recordingStorage.storePart).not.toHaveBeenCalled();
	});

	test('accepts a part from a room that does not allow recording', async () => {
		const f = fixture({ room: { id: 'room1', ownerId: 'me', isArchived: false, allowRecording: false } });

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, partFile())).resolves.toEqual({ id: 'part-1', size: 8 });
		expect(f.recordingStorage.storePart).toHaveBeenCalled();
	});

	test('accepts a part from an archived room', async () => {
		const f = fixture({ room: { id: 'room1', ownerId: 'me', isArchived: true, allowRecording: true } });

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, partFile())).resolves.toEqual({ id: 'part-1', size: 8 });
		expect(f.recordingStorage.storePart).toHaveBeenCalled();
	});

	test('accepts a part after the owner withdraws recording permission', async () => {
		const f = fixture({ room: { id: 'room1', ownerId: 'owner', isArchived: false, allowRecording: false }, member: true });

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, partFile())).resolves.toEqual({ id: 'part-1', size: 8 });
		expect(f.recordingStorage.storePart).toHaveBeenCalled();
	});

	test('rejects a room that does not exist', async () => {
		const f = fixture({ room: null });

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, partFile())).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		expect(f.recordingStorage.storePart).not.toHaveBeenCalled();
	});

	test('rejects a suspended user', async () => {
		const f = fixture();

		await expect(f.endpoint.exec({ roomId: 'room1' }, { ...me, isSuspended: true }, null, null, partFile())).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		expect(f.recordingStorage.storePart).not.toHaveBeenCalled();
	});

	test('rejects a user whose role cannot write chat', async () => {
		const f = fixture({ chatWriteDenied: true });

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, partFile())).rejects.toMatchObject({ code: 'ROLE_PERMISSION_DENIED' });
		expect(f.recordingStorage.storePart).not.toHaveBeenCalled();
	});

	test('rejects content that is not a recording', async () => {
		const f = fixture({ mime: 'image/png' });

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, partFile())).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
		expect(f.recordingStorage.storePart).not.toHaveBeenCalled();
	});

	test('rejects a part larger than the role file size limit', async () => {
		const f = fixture({ maxFileSizeMb: 1 / 1024 });

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, partFile(2048))).rejects.toMatchObject({ code: 'TOO_LARGE' });
		expect(f.recordingStorage.storePart).not.toHaveBeenCalled();
	});

	test('reports a full temporary recording storage', async () => {
		const f = fixture({ storeError: new RecordingStorageFullError() });

		await expect(f.endpoint.exec({ roomId: 'room1' }, me, null, null, partFile())).rejects.toMatchObject({ code: 'STORAGE_FULL' });
	});
});
