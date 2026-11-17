/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import CopyEndpoint from '@/server/api/endpoints/admin/emoji/copy.js';
import StealEndpoint from '@/server/api/endpoints/admin/emoji/steal.js';
import { ImportCustomEmojisProcessorService } from '@/queue/processors/ImportCustomEmojisProcessorService.js';

const sourceEmoji = {
	id: 'e1', name: 'sample', host: 'remote.example', originalUrl: 'https://remote.example/e.png',
	category: null, aliases: [], license: null, isSensitive: false, localOnly: false,
	roleIdsThatCanBeUsedThisEmojiAsReaction: [],
};
const driveFile = { id: 'tmp1', url: 'https://local.example/files/tmp.png', type: 'image/png', webpublicUrl: null, webpublicType: null };

describe('callers pass the intermediate drive file to CustomEmojiService.add', () => {
	test('admin/emoji/copy', async () => {
		const add = vi.fn(async () => ({}));
		const endpoint = new (CopyEndpoint as any)(
			{ findOneBy: async () => sourceEmoji },
			{ packDetailed: async () => ({}) },
			{ checkDuplicate: async () => false, add },
			{ uploadFromUrl: async () => driveFile },
		);
		await endpoint.exec({ emojiId: 'e1' }, { id: 'admin1' }, undefined, undefined, undefined, undefined);
		expect(add).toHaveBeenCalledTimes(1);
		expect((add.mock.calls[0] as any)[2]).toBe(driveFile);
	});

	test('admin/emoji/steal', async () => {
		const add = vi.fn(async () => ({}));
		const endpoint = new (StealEndpoint as any)(
			{ findOneBy: async (w: any) => w.host === null || (w.host && w.host._type === 'isNull') ? null : sourceEmoji },
			{ packDetailed: async () => ({}) },
			{ checkDuplicate: async () => false, add },
			{ uploadFromUrl: async () => driveFile },
		);
		await endpoint.exec({ name: 'sample', host: 'remote.example' }, { id: 'admin1' }, undefined, undefined, undefined, undefined);
		expect(add).toHaveBeenCalledTimes(1);
		expect((add.mock.calls[0] as any)[2]).toBe(driveFile);
	});

	test('bulk import', async () => {
		const add = vi.fn(async () => ({}));
		const service = new ImportCustomEmojisProcessorService(
			{} as any,
			{ delete: async () => undefined } as any,
			{ add } as any,
			{ addFile: async () => driveFile } as any,
			{} as any,
			{ logger: { createSubLogger: () => ({ error: vi.fn(), info: vi.fn(), succ: vi.fn(), warn: vi.fn() }) } } as any,
		);
		await (service as any).importEmoji({
			fileName: 'sample.png', downloaded: true,
			emoji: { name: 'sample', category: null, aliases: [], license: null, isSensitive: false, localOnly: false },
		}, '/tmp/sample.png');
		expect(add).toHaveBeenCalledTimes(1);
		expect((add.mock.calls[0] as any)[2]).toBe(driveFile);
	});
});
