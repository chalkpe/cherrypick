/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { AutoDeleteNotesProcessorService } from '@/queue/processors/AutoDeleteNotesProcessorService.js';
import { CleanupInputError } from '@/core/NoteCleanupService.js';

vi.mock('@/core/NoteCleanupService.js', () => ({
	NoteCleanupService: class {},
	CleanupInputError: class extends Error { constructor(public code: string) { super(code); } },
	NOTE_CLEANUP_LIMITS: { roundMs: 10000, windowMs: 300000 },
}));
vi.mock('@/core/QueueService.js', () => ({ QueueService: class {} }));

// 수동 요청의 대기 계약: 어떤 대기 경로도 자식 작업을 등록하지 않고 정상 종료해 마커를 다음 회차에 넘긴다.
function fixture(cleanup: Record<string, unknown>) {
	const added: unknown[][] = [];
	const queue = { deliverQueue: { getWaiting: async () => [] as { timestamp: number }[] }, inboxQueue: { getWaiting: async () => [] as { timestamp: number }[] }, systemQueue: { add: async (...args: unknown[]) => { added.push(args); } } };
	const processor = new AutoDeleteNotesProcessorService(cleanup as any, queue as any);
	const job = { data: { userId: 'alice', manual: true } };
	return { added, queue, processor, job };
}

test('연합 큐가 밀리면 수동 요청은 작업을 쌓지 않고 정상 종료해 다음 회차에 잇는다', async () => {
	const cleanup = { continueManual: vi.fn() };
	const f = fixture(cleanup);
	f.queue.deliverQueue.getWaiting = async () => [{ timestamp: 0 }];

	await expect(f.processor.process(f.job as any)).resolves.toMatchObject({ delayed: true });

	expect(f.added).toHaveLength(0);
	expect(cleanup.continueManual).not.toHaveBeenCalled();
});

test('일시적인 DB 연결 오류는 작업을 쌓지 않고 정상 종료해 마커 보존을 서비스에 맡긴다', async () => {
	const cleanup = { continueManual: async () => { throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }); } };
	const f = fixture(cleanup);

	await expect(f.processor.process(f.job as any)).resolves.toMatchObject({ delayed: true });

	expect(f.added).toHaveLength(0);
});

test('잠금 충돌은 실패가 아니라 다음 회차로 넘기는 대기다', async () => {
	const cleanup = { continueManual: async () => { throw new CleanupInputError('CLEANUP_BUSY'); } };
	const f = fixture(cleanup);

	await expect(f.processor.process(f.job as any)).resolves.toMatchObject({ delayed: true });

	expect(f.added).toHaveLength(0);
});

test('비재시도 오류는 작업을 쌓지 않고 종료 실패로 처리한다', async () => {
	const cleanup = { continueManual: async () => { throw new Error('account gone'); } };
	const f = fixture(cleanup);

	await expect(f.processor.process(f.job as any)).rejects.toBeInstanceOf(UnrecoverableError);

	expect(f.added).toHaveLength(0);
});

// 수동 전용 회차: 접수된 요청의 재시도가 5분 자동 회차에 묶이지 않도록 1분마다 마커를 이어 처리한다.
test('수동 전용 회차는 마커 계정을 이어 처리하고 자동 검사는 건드리지 않는다', async () => {
	const cleanup = {
		locked: async (_id: string, work: () => Promise<unknown>) => work(),
		manualUsers: async () => ['alice'],
		continueManual: vi.fn(async () => ({ deleted: 2, failed: 0, complete: true })),
		automaticUsers: vi.fn(async () => ['bob']),
		processUser: vi.fn(),
	};
	const f = fixture(cleanup);

	await expect(f.processor.processManualRound()).resolves.toEqual({ deletedCount: 2, skipped: false });

	expect(cleanup.continueManual).toHaveBeenCalledExactlyOnceWith('alice');
	expect(cleanup.automaticUsers).not.toHaveBeenCalled();
	expect(cleanup.processUser).not.toHaveBeenCalled();
	expect(f.added).toHaveLength(0);
});

test('수동 전용 회차도 연합 큐가 밀리면 작업을 쌓지 않고 건너뛴다', async () => {
	const cleanup = {
		locked: async (_id: string, work: () => Promise<unknown>) => work(),
		manualUsers: vi.fn(async () => ['alice']),
		continueManual: vi.fn(),
	};
	const f = fixture(cleanup);
	f.queue.deliverQueue.getWaiting = async () => [{ timestamp: 0 }];

	await expect(f.processor.processManualRound()).resolves.toEqual({ deletedCount: 0, skipped: true });

	expect(cleanup.manualUsers).not.toHaveBeenCalled();
	expect(cleanup.continueManual).not.toHaveBeenCalled();
	expect(f.added).toHaveLength(0);
});

test('수동 전용 회차는 scheduler 잠금 혼잡 시 건너뛴다', async () => {
	const cleanup = {
		locked: async () => { throw new CleanupInputError('CLEANUP_BUSY'); },
		manualUsers: vi.fn(),
	};
	const f = fixture(cleanup);

	await expect(f.processor.processManualRound()).resolves.toEqual({ deletedCount: 0, skipped: true });

	expect(cleanup.manualUsers).not.toHaveBeenCalled();
	expect(f.added).toHaveLength(0);
});

test('수동 전용 회차는 한 계정의 종료 실패가 다른 계정을 멈추지 않게 한다', async () => {
	const cleanup = {
		locked: async (_id: string, work: () => Promise<unknown>) => work(),
		manualUsers: async () => ['alice', 'bob'],
		continueManual: vi.fn(async (id: string) => {
			if (id === 'alice') throw new Error('account gone');
			return { deleted: 1, failed: 0, complete: true };
		}),
		deferUser: vi.fn(async () => {}),
	};
	const f = fixture(cleanup);

	await expect(f.processor.processManualRound()).resolves.toEqual({ deletedCount: 1, skipped: false });

	expect(cleanup.deferUser).toHaveBeenCalledExactlyOnceWith('alice');
	expect(cleanup.continueManual).toHaveBeenCalledWith('bob');
	expect(f.added).toHaveLength(0);
});
