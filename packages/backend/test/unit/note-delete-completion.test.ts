/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../src/core/UtilityService.js', () => ({ UtilityService: class {} }));
vi.mock('../../src/core/CacheService.js', () => ({ CacheService: class {} }));
vi.mock('../../src/core/QueryService.js', () => ({ QueryService: class {} }));
vi.mock('../../src/core/LoggerService.js', () => ({ LoggerService: class {} }));
vi.mock('../../src/models/_.js', () => ({ MiUser: class {} }));
import type { MiNoteDeleteReceipt } from '../../src/models/NoteDeleteReceipt.js';
import { receiptStore, receipt } from '../helpers/note-delete-receipts.js';
import { SearchService } from '../../src/core/SearchService.js';
import { GlobalEventService } from '../../src/core/GlobalEventService.js';

function gate<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

test('검색 기본 경로는 접수만 기다리고 복구 경로는 실제 작업 완료를 기다린다', async () => {
	const completion = gate<{ status: string }>();
	const waitForTask = vi.fn(() => completion.promise);
	const service: SearchService = Object.assign(Object.create(SearchService.prototype), {
		meilisearch: { tasks: { waitForTask } },
		meilisearchNoteIndex: { deleteDocument: vi.fn(async () => ({ taskUid: 7 })) },
	});
	const note = { id: 'note', visibility: 'public' } as const;
	let normalDone = false;
	const normal = service.unindexNote(note).then(() => { normalDone = true; });
	await Promise.resolve();
	await Promise.resolve();
	expect.soft(normalDone).toBe(true);
	expect.soft(waitForTask).not.toHaveBeenCalled();
	completion.resolve({ status: 'succeeded' });
	await normal;

	const recoveryGate = gate<{ status: string }>();
	const entered = gate<void>();
	waitForTask.mockImplementationOnce(() => { entered.resolve(); return recoveryGate.promise; });
	let recoveryDone = false;
	const recovery = service.unindexNote(note, true).then(() => { recoveryDone = true; });
	await entered.promise;
	expect.soft(recoveryDone).toBe(false);
	recoveryGate.resolve({ status: 'succeeded' });
	await recovery;
	expect(waitForTask).toHaveBeenLastCalledWith(7, { timeout: 30_000 });
});

test('기존 노트 이벤트는 void이고 복구 진입점만 Redis 완료 Promise를 반환한다', async () => {
	const completion = gate<number>();
	const publish = vi.fn(() => completion.promise);
	const service = new GlobalEventService({ host: 'local.test' } as any, { publish } as any);
	const note = { id: 'note' } as any;

	expect.soft(service.publishNoteStream(note, 'deleted', { deletedAt: new Date(0) })).toBeUndefined();
	let done = false;
	const recovery = service.publishNoteStreamForDeletion(note, new Date(0)).then(() => { done = true; });
	await Promise.resolve();
	expect(done).toBe(false);
	completion.resolve(1);
	await recovery;
	expect(publish).toHaveBeenCalledTimes(2);
	expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1]);
});

afterEach(() => vi.useRealTimers());

test.each(['publish', 'admission', 'completion'] as const)('실제 서비스 %s 무응답은 runner deadline과 제한된 미완료 슬롯으로 격리한다', async phase => {
	vi.useFakeTimers();
	const blocked = gate<any>();
	const entered = gate<void>();
	const publish = vi.fn(async () => 1);
	const deleteDocument = vi.fn(async () => ({ taskUid: 7 }));
	const waitForTask = vi.fn(async () => ({ status: 'succeeded' }));
	const target = phase === 'publish' ? publish : phase === 'admission' ? deleteDocument : waitForTask;
	target.mockImplementationOnce(() => { entered.resolve(); return blocked.promise; });
	const events = new GlobalEventService({ host: 'local.test' } as any, { publish } as any);
	const search: SearchService = Object.assign(Object.create(SearchService.prototype), {
		meilisearch: { tasks: { waitForTask } }, meilisearchNoteIndex: { deleteDocument },
	});
	const f = receiptStore([receipt({ activityPub: false }), { ...receipt({ activityPub: false }), noteId: 'healthy' }]);
	const runner = f.createRunner({ events, search });
	let done = false;
	const running = runner.scan().then(() => { done = true; });
	await entered.promise;
	await vi.advanceTimersByTimeAsync(5_001);
	try {
		expect(done).toBe(true);
		expect(target).toHaveBeenCalledTimes(1);
		expect(f.receipts.every(row => row.effects.charts)).toBe(true);
		await vi.advanceTimersByTimeAsync(60_001);
		await runner.scan();
		expect(target).toHaveBeenCalledTimes(1);
		const before = structuredClone(f.receipts);
		blocked.resolve(phase === 'publish' ? 1 : phase === 'admission' ? { taskUid: 7 } : { status: 'succeeded' });
		await running;
		await Promise.resolve();
		expect(f.receipts).toEqual(before);
		await vi.advanceTimersByTimeAsync(60_001);
		await runner.scan();
		expect(f.receipts.every(row => row.completedAt)).toBe(true);
	} finally {
		blocked.resolve(phase === 'publish' ? 1 : phase === 'admission' ? { taskUid: 7 } : { status: 'succeeded' });
		await running;
	}
});

test.each(['admission', 'completion'] as const)('매번 6초인 정상 검색 %s은 다음 claim에서 정산하고 새 작업을 반복하지 않는다', async phase => {
	vi.useFakeTimers();
	const delay = <T>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 6_000));
	const deleteDocument = vi.fn(() => phase === 'admission' ? delay({ taskUid: 7 }) : Promise.resolve({ taskUid: 7 }));
	const waitForTask = vi.fn(() => phase === 'completion' ? delay({ status: 'succeeded' }) : Promise.resolve({ status: 'succeeded' }));
	const search: SearchService = Object.assign(Object.create(SearchService.prototype), {
		meilisearch: { tasks: { waitForTask } }, meilisearchNoteIndex: { deleteDocument },
	});
	const f = receiptStore([receipt({ activityPub: false })]);
	const runner = f.createRunner({ search });
	for (let scan = 0; scan < 4; scan++) {
		const running = runner.scan();
		await vi.advanceTimersByTimeAsync(6_001);
		await running;
		if (scan === 0) {
			expect(f.receipts[0].effects.search).toBeUndefined();
			expect(f.receipts[0].effects.charts).toBeDefined();
			expect(f.receipts[0].snapshot.version).toBe(3);
		}
		await vi.advanceTimersByTimeAsync(3_600_001);
	}
	expect.soft(f.receipts[0].effects.search).toBeDefined();
	expect.soft(f.receipts[0].completedAt).toBeInstanceOf(Date);
	expect.soft(f.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
	expect(deleteDocument).toHaveBeenCalledTimes(1);
});

function slowSearch(status = 'succeeded') {
	const deleteDocument = vi.fn(async () => ({ taskUid: 7 }));
	const waitForTask = vi.fn(() => new Promise<{ status: string }>(resolve => setTimeout(() => resolve({ status }), 6_000)));
	const search: SearchService = Object.assign(Object.create(SearchService.prototype), {
		meilisearch: { tasks: { waitForTask } }, meilisearchNoteIndex: { deleteDocument },
	});
	return { search, deleteDocument };
}

async function runSlow(work: Promise<unknown>) {
	await vi.advanceTimersByTimeAsync(6_001);
	await work;
}

async function nextScan(runner: ReturnType<ReturnType<typeof receiptStore>['createRunner']>) {
	await vi.advanceTimersByTimeAsync(3_600_001);
	await runSlow(runner.scan());
}

test('늦은 검색 실패를 성공으로 바꾸지 않으며 다음 claim이 실제로 다시 확인한다', async () => {
	vi.useFakeTimers();
	const s = slowSearch('failed');
	const f = receiptStore([receipt({ activityPub: false, moderationLog: true })]);
	const runner = f.createRunner({ search: s.search });
	await runSlow(runner.scan());
	await nextScan(runner);

	expect(f.receipts[0].effects.search).toBeUndefined();
	expect(f.receipts[0].completedAt).toBeNull();
	expect(f.receipts[0].effects.charts).toBeDefined();
	expect(f.receipts[0].effects.moderationLog).toBeDefined();
	expect(f.state.logs).toBe(1);
	expect(f.receipts[0].snapshot).toMatchObject({ version: 3, delivery: null, auditNote: null });
	expect(s.deleteDocument).toHaveBeenCalledTimes(2);
});

test('검색 성공 뒤 표식 저장 실패는 새 작업 없이 새 권한으로 재확인한다', async () => {
	vi.useFakeTimers();
	const s = slowSearch();
	const f = receiptStore([receipt({ activityPub: false })]);
	const runner = f.createRunner({ search: s.search });
	await runSlow(runner.scan());
	f.state.failEffectMark = 'search';
	await nextScan(runner);
	expect(f.receipts[0].effects.search).toBeUndefined();
	f.state.failEffectMark = null;
	await nextScan(runner);

	expect(f.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
	expect(s.deleteDocument).toHaveBeenCalledTimes(1);
});

test.each(['token', 'version', 'expiry', 'owner'] as const)('과거 claim의 %s 변경 후 늦은 검색 성공은 DB를 쓰지 않는다', async fence => {
	vi.useFakeTimers();
	const s = slowSearch();
	const f = receiptStore([receipt({ activityPub: false })]);
	const runner = f.createRunner({ search: s.search });
	const running = runner.scan();
	await vi.advanceTimersByTimeAsync(1_000);
	const row = f.receipts[0];
	if (fence === 'token') row.claimToken = 'another-executor';
	if (fence === 'version') row.claimVersion++;
	if (fence === 'expiry') row.claimUntil = new Date(Date.now());
	if (fence === 'owner') row.userId = 'other-owner';
	await vi.advanceTimersByTimeAsync(4_001);
	await running;
	const before = structuredClone(f.receipts);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(f.receipts).toEqual(before);
	expect(row.effects.search).toBeUndefined();

	await nextScan(runner);
	if (fence === 'owner') {
		expect(row.effects.search).toBeUndefined();
		expect(s.deleteDocument).toHaveBeenCalledTimes(2);
		await nextScan(runner);
	}
	expect(row.effects.search).toBeDefined();
	expect(row.completedAt).toBeInstanceOf(Date);
	expect(s.deleteDocument).toHaveBeenCalledTimes(fence === 'owner' ? 2 : 1);
});

test('다른 영수증은 늦은 성공을 빌려 쓰지 않고 재시작은 DB의 미완료 의무를 재발견한다', async () => {
	vi.useFakeTimers();
	const s = slowSearch();
	const first = receipt({ activityPub: false });
	const second = receipt({ activityPub: false });
	second.noteId = 'other';
	if (second.snapshot.version === 1) second.snapshot.note.id = second.noteId;
	const f = receiptStore([first, second]);
	const runner = f.createRunner({ search: s.search });
	await runSlow(runner.runOne(first.noteId, first.userId));
	await runSlow(runner.runOne(second.noteId, second.userId));
	expect(second.effects.search).toBeUndefined();
	expect(s.deleteDocument).toHaveBeenCalledTimes(2);

	const restarted = f.createRunner({ search: s.search });
	await vi.advanceTimersByTimeAsync(3_600_001);
	await runSlow(restarted.runOne(first.noteId, first.userId));
	expect(first.effects.search).toBeUndefined();
	expect(s.deleteDocument).toHaveBeenCalledTimes(3);
	await nextScan(restarted);
	expect(first.snapshot).toEqual({ version: 2, state: 'settled' });
	await nextScan(restarted);
	expect(second.snapshot).toEqual({ version: 2, state: 'settled' });
	expect(s.deleteDocument).toHaveBeenCalledTimes(4);
});

test('인계 대기 10개는 밀어내지 않으며 다른 실행자의 완료를 확인하면 슬롯을 회수한다', async () => {
	vi.useFakeTimers();
	const s = slowSearch();
	const rows = Array.from({ length: 11 }, (_, index) => {
		const row = receipt({ activityPub: false });
		row.noteId = `note-${index}`;
		if (row.snapshot.version === 1) row.snapshot.note.id = row.noteId;
		return row;
	});
	const f = receiptStore(rows);
	const runner = f.createRunner({ search: s.search });
	for (const row of rows) await runSlow(runner.runOne(row.noteId, row.userId));
	expect(s.deleteDocument).toHaveBeenCalledTimes(10);
	expect(rows.every(row => !row.effects.search)).toBe(true);
	expect(rows.every(row => row.effects.charts && row.effects.noteStream)).toBe(true);

	await vi.advanceTimersByTimeAsync(3_600_001);
	const other = f.createRunner();
	await other.runOne(rows[0].noteId, rows[0].userId);
	await runSlow(runner.runOne(rows[10].noteId, rows[10].userId));
	expect(s.deleteDocument).toHaveBeenCalledTimes(11);
	await nextScan(runner);
	await nextScan(runner);
	expect(rows.every(row => row.completedAt && (row as MiNoteDeleteReceipt).snapshot.version === 2)).toBe(true);
	expect(s.deleteDocument).toHaveBeenCalledTimes(11);
});
