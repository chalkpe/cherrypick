/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { QueueService } from '@/core/QueueService.js';

vi.mock('@/core/activitypub/ApRequestService.js', () => ({ ApRequestCreator: class {} }));

// 수동 요청 이어 처리 회차와 자동 정리 회차의 주기를 함께 고정한다.
test('수동 요청 이어 처리는 1분 회차, 자동 정리는 5분 회차를 유지한다', () => {
	const upserts: [string, { pattern: string }][] = [];
	const systemQueue = {
		upsertJobScheduler: (name: string, opts: { pattern: string }) => { upserts.push([name, opts]); },
		getJobSchedulers: async () => [],
	};
	new (QueueService as any)({}, systemQueue, ...Array(10).fill({}));

	expect(upserts.find(([name]) => name === 'autoDeleteNotesManual')?.[1].pattern).toBe('* * * * *');
	expect(upserts.find(([name]) => name === 'autoDeleteNotes')?.[1].pattern).toBe('*/5 * * * *');
});
