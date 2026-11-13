/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { AutoDeleteNotesProcessorService } from '@/queue/processors/AutoDeleteNotesProcessorService.js';

vi.mock('@/core/NoteCleanupService.js', () => ({ NoteCleanupService: class {}, CleanupInputError: class extends Error {}, NOTE_CLEANUP_LIMITS: { roundMs: 10000, windowMs: 300000 } }));
vi.mock('@/core/QueueService.js', () => ({ QueueService: class {} }));

test('연합 큐가 밀리면 요청 ID를 보존한 지연 작업을 접수하고 정상 종료한다', async () => {
	const added: any[] = [];
	const queue = { deliverQueue: { getWaiting: async () => [{ timestamp: 0 }] }, inboxQueue: { getWaiting: async () => [] }, systemQueue: { add: async (...args: any[]) => { added.push(args); } } };
	const processor = new AutoDeleteNotesProcessorService({} as any, queue as any);
	const job: any = { data: { userId: 'alice', ruleIds: ['rule'], requestId: 'request', step: 0 }, updateData: async (data: any) => { job.data = data; } };

	await expect(processor.process(job)).resolves.toBeDefined();

	expect(added).toHaveLength(1);
	expect(added[0][1]).toMatchObject({ userId: 'alice', ruleIds: ['rule'], requestId: 'request', step: 1 });
	expect(added[0][2].delay).toBeGreaterThan(0);
});

test('이어 받기 접수 뒤 부모 작업이 재시작돼도 같은 작업 ID를 다시 사용한다', async () => {
	const added: any[] = [];
	const queue = { deliverQueue: { getWaiting: async () => [{ timestamp: 0 }] }, inboxQueue: { getWaiting: async () => [] }, systemQueue: { add: async (...args: any[]) => { added.push(args); } } };
	const processor = new AutoDeleteNotesProcessorService({} as any, queue as any);
	const job: any = { data: { userId: 'alice', ruleIds: ['rule'], requestId: 'request', step: 0 }, updateData: async (data: any) => { job.data = data; } };

	await processor.process(job);
	await processor.process(job);

	expect(added.map(args => args[2].jobId)).toEqual(['note-cleanup-request-1', 'note-cleanup-request-1']);
	expect(added[1][1]).toEqual(added[0][1]);
});

test('일시적인 DB 연결 오류는 같은 요청 ID로 다시 접수한다', async () => {
	const added: any[] = [];
	const cleanup = { processUser: async () => { throw new Error('Connection terminated unexpectedly'); } };
	const queue = { deliverQueue: { getWaiting: async () => [] }, inboxQueue: { getWaiting: async () => [] }, systemQueue: { add: async (...args: any[]) => { added.push(args); } } };
	const processor = new AutoDeleteNotesProcessorService(cleanup as any, queue as any);
	const job: any = { data: { userId: 'alice', ruleIds: ['rule'], requestId: 'request', step: 0 }, updateData: async (data: any) => { job.data = data; } };

	await expect(processor.process(job)).resolves.toMatchObject({ delayed: true });

	expect(added[0][1]).toMatchObject({ requestId: 'request', step: 1, retryFailures: 1 });
	expect(added[0][2].delay).toBeGreaterThan(0);
});
