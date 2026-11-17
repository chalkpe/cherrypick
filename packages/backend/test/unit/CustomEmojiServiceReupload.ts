/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';

describe('CustomEmojiService original file cleanup', () => {
	const url = 'https://local.example/files/original.png';

	function setup(files: { id: string, url: string, userId: string }[]) {
		const deleteFile = vi.fn();
		const driveFilesRepository = {
			findOneBy: async (where: { url: string, userId?: string }) => files.find(f => f.url === where.url && (where.userId === undefined || f.userId === where.userId)) ?? null,
			count: async () => 0,
		};
		const service = new CustomEmojiService(
			{} as any,
			{} as any,
			{} as any,
			driveFilesRepository as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{ uploadFromUrl: async () => ({ id: 'copy', url: 'https://local.example/files/copy.png', type: 'image/png' }), deleteFile } as any,
			{ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as any,
		);
		return { service, deleteFile };
	}

	test('deletes the original file owned by the requesting user', async () => {
		const { service, deleteFile } = setup([{ id: 'file1', url, userId: 'admin1' }]);

		await (service as any).reuploadFileAndCleanup({ originalUrl: url }, {}, { id: 'admin1' });

		expect(deleteFile).toHaveBeenCalledTimes(1);
	});

	test('keeps the original file owned by someone else', async () => {
		const { service, deleteFile } = setup([{ id: 'file1', url, userId: 'someone' }]);

		await (service as any).reuploadFileAndCleanup({ originalUrl: url }, {}, { id: 'admin1' });

		expect(deleteFile).not.toHaveBeenCalled();
	});

	test('keeps the original file when no requesting user is given', async () => {
		const { service, deleteFile } = setup([{ id: 'file1', url, userId: 'someone' }]);

		await (service as any).reuploadFileAndCleanup({ originalUrl: url }, {});

		expect(deleteFile).not.toHaveBeenCalled();
	});
});

describe('CustomEmojiService intermediate file cleanup', () => {
	const intermediate = { id: 'tmp1', url: 'https://local.example/files/intermediate.png', userId: null };

	function setup() {
		const deleteFile = vi.fn();
		const service = new CustomEmojiService(
			{} as any,
			{} as any,
			{ insertOne: async (v: any) => v } as any,
			{ findOneBy: async () => null, count: async () => 0 } as any,
			{} as any,
			{ gen: () => 'emoji1' } as any,
			{} as any,
			{} as any,
			{} as any,
			{ uploadFromUrl: async () => ({ id: 'copy', url: 'https://local.example/files/copy.png', type: 'image/png' }), deleteFile } as any,
			{ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as any,
		);
		const data = {
			originalUrl: intermediate.url,
			publicUrl: intermediate.url,
			fileType: 'image/png',
			name: 'sample',
			category: null,
			aliases: [],
			host: 'remote.example',
			license: null,
			isSensitive: false,
			localOnly: false,
			roleIdsThatCanBeUsedThisEmojiAsReaction: [],
		};
		return { service, deleteFile, data };
	}

	test('deletes the intermediate file passed by the caller after registering', async () => {
		const { service, deleteFile, data } = setup();

		const emoji = await service.add(data, undefined, intermediate as any);

		expect(emoji.originalUrl).toBe('https://local.example/files/copy.png');
		expect(deleteFile).toHaveBeenCalledTimes(1);
		expect(deleteFile).toHaveBeenCalledWith(intermediate);
	});

	test('does not delete any file when no intermediate file is passed', async () => {
		const { service, deleteFile, data } = setup();

		await service.add(data);

		expect(deleteFile).not.toHaveBeenCalled();
	});
});
