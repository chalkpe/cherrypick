/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { PostScheduledNoteProcessorService } from '@/queue/processors/PostScheduledNoteProcessorService.js';

describe('PostScheduledNoteProcessorService', () => {
	test('passes the delivery targets of the draft to the created note', async () => {
		const deliveryTargets = { mode: 'exclude', hosts: ['blocked.example'] };
		const draft = {
			id: 'draft1',
			userId: 'user1',
			user: { id: 'user1', username: 'alice', host: null },
			scheduledAt: new Date(),
			isActuallyScheduled: true,
			fileIds: [],
			hasPoll: false,
			pollChoices: [],
			visibleUserIds: [],
			visibility: 'public',
			deliveryTargets,
		};
		const fetchAndCreate = vi.fn().mockResolvedValue({ id: 'note1' });
		const service = new PostScheduledNoteProcessorService(
			{ findOne: async () => draft, remove: vi.fn() } as any,
			{ fetchAndCreate } as any,
			{ createNotification: vi.fn() } as any,
			{ logger: { createSubLogger: () => ({}) } } as any,
		);

		await service.process({ data: { noteDraftId: 'draft1' } } as any);

		expect(fetchAndCreate).toHaveBeenCalledTimes(1);
		expect(fetchAndCreate.mock.calls[0][1]).toMatchObject({ deliveryTargets });
	});
});
