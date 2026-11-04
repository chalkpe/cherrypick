/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';

function createService() {
	return new ChatEntityService(
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{ pack: vi.fn().mockResolvedValue({ id: 'u1' }) } as never,
		{ pack: vi.fn().mockResolvedValue({ id: 'f1' }) } as never,
		{ populateEmojis: vi.fn().mockResolvedValue([]) } as never,
		{ parse: vi.fn().mockReturnValue({ date: new Date('2026-11-02T00:00:00.000Z') }) } as never,
	);
}

describe('chat message lifecycle packing', () => {
	test('packs editedAt/deletedAt and clears deleted content', async () => {
		const service = createService();
		const message = await service.packMessageDetailed({
			id: 'm1',
			text: 'secret',
			editedAt: new Date('2026-11-02T00:00:00Z'),
			deletedAt: new Date('2026-11-02T00:01:00Z'),
			reactions: ['u1/👍'],
			fileIds: ['f1'],
			fromUserId: 'u1',
			fromUser: { id: 'u1', host: null },
			toUserId: null,
			toRoomId: null,
			emojis: [],
		} as never, { id: 'u2' });

		expect(message.editedAt).toBe('2026-11-02T00:00:00.000Z');
		expect(message.deletedAt).toBe('2026-11-02T00:01:00.000Z');
		expect(message.text).toBeNull();
		expect(message.file).toBeNull();
		expect(message.files).toEqual([]);
		expect(message.reactions).toEqual([]);
	});
});
