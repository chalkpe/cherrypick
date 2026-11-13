/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../src/core/GlobalEventService.js', () => ({ GlobalEventService: class {} }));
vi.mock('../../src/core/SearchService.js', () => ({ SearchService: class {} }));
vi.mock('../../src/core/UtilityService.js', () => ({ UtilityService: class {} }));
import type { NoteDeleteLocalSnapshot } from '../../src/models/NoteDeleteReceipt.js';
import { receiptStore, receipt } from '../helpers/note-delete-receipts.js';

afterEach(() => vi.useRealTimers());

test('서비스 재생성 뒤 DB scan이 원본 없이 의무를 찾고 일부 성공은 반복하지 않는다', async () => {
	vi.useFakeTimers();
	const f = receiptStore([receipt()]);
	f.search.mockRejectedValueOnce(new Error('token=secret'));

	expect(await f.createRunner().scan()).toBe(1);
	expect(f.receipts[0].effects.noteStream).toBeDefined();
	expect(f.receipts[0].lastErrorCode).toBe('search_failed');
	expect(await f.createRunner().scan()).toBe(0);
	vi.advanceTimersByTime(5_000);
	expect(await f.createRunner().scan()).toBe(1);
	expect(f.events).toHaveBeenCalledTimes(1);
	expect(f.search).toHaveBeenCalledTimes(2);
	expect(f.receipts[0].completedAt).toBeNull();
	expect(JSON.stringify(f.receipts)).not.toContain('secret');
});

test('소유자 경계와 활성 claim을 지키며 만료 뒤 늦은 응답을 표식하지 않는다', async () => {
	vi.useFakeTimers();
	const f = receiptStore([receipt()]);
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	f.search.mockImplementationOnce(async () => { entered(); await gate; });

	await f.createRunner().runOne('note', 'other');
	expect(f.events).not.toHaveBeenCalled();
	const old = f.createRunner().runOne('note', 'author');
	await started;
	expect(await f.createRunner().scan()).toBe(0);
	vi.advanceTimersByTime(60_001);
	await f.createRunner().scan();
	const saved = structuredClone(f.receipts[0]);
	release();
	await old;

	expect(f.receipts[0]).toEqual(saved);
	expect(f.search).toHaveBeenCalledTimes(2);
	expect(saved.claimVersion).toBe(2);
});

test.each(['instanceStats', 'moderationLog'] as const)('%s 실제 DB 효과와 표식은 함께 롤백한다', async name => {
	vi.useFakeTimers();
	const row = receipt({ noteStream: false, search: false, [name]: true });
	row.snapshot.actor.host = 'remote.test';
	const f = receiptStore([row]);
	f.state.failEffectMark = name;

	await f.createRunner().scan();
	expect(f.state.decrements).toBe(0);
	expect(f.state.logs).toBe(0);
	expect(f.receipts[0].effects[name]).toBeUndefined();
	f.state.failEffectMark = null;
	vi.advanceTimersByTime(5_000);
	await f.createRunner().scan();

	expect(f.receipts[0].effects[name]).toBeDefined();
	expect(name === 'instanceStats' ? f.state.decrements : f.state.logs).toBe(1);
});

test('외부 성공 뒤 표식 실패 시 안정 deletedAt으로 재발행하며 검색 Promise를 기다린다', async () => {
	vi.useFakeTimers();
	const f = receiptStore([receipt()]);
	f.state.failEffectMark = 'noteStream';
	f.search.mockRejectedValueOnce(new Error('search unavailable'));
	await f.createRunner().scan();
	expect(f.receipts[0].effects.noteStream).toBeUndefined();
	f.state.failEffectMark = null;
	vi.advanceTimersByTime(5_000);
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	f.search.mockImplementationOnce(async () => { entered(); await gate; });
	const running = f.createRunner().scan();
	await started;
	expect(f.receipts[0].effects.search).toBeUndefined();
	release();
	await running;

	expect(f.events).toHaveBeenCalledTimes(2);
	for (const call of f.events.mock.calls) expect(call[2].deletedAt).toEqual(new Date('2026-01-01'));
	expect(f.receipts[0].effects.search).toBeDefined();
});

test('한 scan은 열 개로 제한하고 모든 적용 효과가 끝난 quiet 영수증만 완료한다', async () => {
	const rows = Array.from({ length: 12 }, (_, i) => ({ ...receipt({ noteStream: false, notesChart: false, perUserNotesChart: false, activityPub: false }), noteId: `note-${i}` }));
	const f = receiptStore(rows);

	expect(await f.createRunner().scan()).toBe(10);
	expect(f.search).toHaveBeenCalledTimes(10);
	expect(rows.filter(r => r.completedAt)).toHaveLength(10);
	expect(await f.createRunner().scan()).toBe(2);
});

test('scan은 열 개 영수증의 차트를 묶고 로컬 처리는 실행 직전 claim한다', async () => {
	const rows = Array.from({ length: 10 }, (_, i) => ({ ...receipt({ activityPub: false }), noteId: `batch-${i}` }));
	const f = receiptStore(rows);

	await f.createRunner().scan();

	expect(f.applyBatch).toHaveBeenCalledTimes(1);
	expect(f.applyBatch.mock.calls[0][0]).toHaveLength(10);
	expect(f.charts.notes.applyDeletionInTransaction).toHaveBeenCalledTimes(1);
	expect(rows.every(r => r.effects.charts && r.completedAt)).toBe(true);
});

test('차트 묶음 실패는 완료하지 않고 원본 없는 재시도에서 로컬 효과를 보존한다', async () => {
	vi.useFakeTimers();
	const f = receiptStore([receipt({ activityPub: false })]);
	f.charts.notes.applyDeletionInTransaction.mockRejectedValueOnce(new Error('count failed'));

	await f.createRunner().scan();

	expect(f.receipts[0].lastErrorCode).toBe('charts_failed');
	expect(f.receipts[0].completedAt).toBeNull();
	expect(f.receipts[0].effects.charts).toBeUndefined();
	vi.advanceTimersByTime(5_000);
	await f.createRunner().scan();
	const marked = structuredClone(f.receipts[0].effects);

	expect(f.receipts[0].completedAt).toBeInstanceOf(Date);
	expect(f.search).toHaveBeenCalledTimes(1);
	expect(f.events).toHaveBeenCalledTimes(1);
	f.receipts[0].completedAt = null;
	f.receipts[0].nextAttemptAt = new Date(0);
	await f.createRunner().runOne('note', 'author');
	expect(f.receipts[0].effects).toEqual(marked);
	expect(f.charts.notes.applyDeletionInTransaction).toHaveBeenCalledTimes(2);
});

test('지원하지 않는 차트 snapshot도 무관한 영수증의 로컬 의무를 막지 않는다', async () => {
	const poison = receipt();
	delete (poison.snapshot as any).charts;
	const healthy = { ...receipt(), noteId: 'healthy' };
	const f = receiptStore([poison, healthy]);

	await f.createRunner().scan();

	expect(f.search).toHaveBeenCalledTimes(2);
	expect(f.events).toHaveBeenCalledTimes(2);
	for (const row of f.receipts) {
		expect(row.effects.search).toBeDefined();
		expect(row.completedAt).toBeNull();
		expect(row.lastErrorCode).toBe(row.noteId === 'healthy' ? null : 'unsupported_charts');
	}
});

test('차트 대기 중 claim 만료 뒤 늦은 완료도 실제 차트 표식만 한 번 남긴다', async () => {
	vi.useFakeTimers();
	const f = receiptStore([receipt({ activityPub: false })]);
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	const apply = f.chartService.applyBatch.bind(f.chartService);
	f.applyBatch.mockImplementationOnce(async items => { entered(); await gate; await apply(items); });

	const late = f.createRunner().runOne('note', 'author');
	await started;
	vi.advanceTimersByTime(60_001);
	await f.createRunner().scan();
	const saved = structuredClone(f.receipts[0]);
	release();
	await late;

	expect(f.receipts[0]).toEqual(saved);
	expect(saved.completedAt).toBeInstanceOf(Date);
	expect(f.charts.notes.applyDeletionInTransaction).toHaveBeenCalledTimes(1);
});

test('다른 로컬 효과를 기다리다 claim이 만료돼도 먼저 적용한 차트와 정상 영수증을 보존한다', async () => {
	vi.useFakeTimers();
	const f = receiptStore([receipt(), { ...receipt(), noteId: 'second' }]);
	f.search.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { vi.advanceTimersByTime(60_001); });

	await f.createRunner().scan();

	expect(f.applyBatch).toHaveBeenCalledTimes(1);
	expect(f.receipts.every(row => row.effects.charts)).toBe(true);
	expect(f.receipts[0].effects.search).toBeDefined();
	expect(f.receipts[1].effects.search).toBeUndefined();
});

test.each(['events', 'search'] as const)('%s 무응답은 제한 시간 뒤 다른 영수증과 차트를 막지 않고 요청을 누적하지 않는다', async name => {
	vi.useFakeTimers();
	const f = receiptStore([receipt({ activityPub: false }), { ...receipt({ activityPub: false }), noteId: 'healthy' }]);
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	f[name].mockImplementationOnce(async () => { entered(); await gate; });
	const runner = f.createRunner();
	let done = false;
	const running = runner.scan().then(() => { done = true; });
	await started;
	await vi.advanceTimersByTimeAsync(10_001);
	try {
		expect(done).toBe(true);
		expect(f.receipts.every(row => row.effects.charts)).toBe(true);
		expect(f[name]).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_001);
		await runner.scan();
		expect(f[name]).toHaveBeenCalledTimes(1);
		const before = structuredClone(f.receipts);
		release();
		await running;
		await Promise.resolve();
		expect(f.receipts).toEqual(before);
	} finally {
		release();
		await running;
	}
});

test('삭제된 관리자는 감사 성공 대신 명시적 제외를 남기고 차트를 완료한다', async () => {
	const f = receiptStore([receipt({ moderationLog: true, activityPub: false })]);
	f.state.moderatorPresent = false;

	await f.createRunner().scan();

	expect(f.log).not.toHaveBeenCalled();
	expect(f.receipts[0].effects.moderationLog).toMatchObject({ outcome: 'excluded', reason: 'subject_deleted' });
	expect(f.receipts[0].effects.charts).toBeDefined();
	expect(f.receipts[0].completedAt).toBeInstanceOf(Date);
});

test.each(['snapshot', 'partial'] as const)('실제 차트 서비스는 %s 오류 한 행을 보존하고 정상 행을 적용한다', async kind => {
	const poison = receipt({ activityPub: false });
	if (kind === 'snapshot') delete (poison.snapshot as any).charts;
	else poison.effects.notesChart = { completedAt: new Date().toISOString() };
	const healthy = { ...receipt({ activityPub: false }), noteId: 'healthy' };
	const f = receiptStore([poison, healthy]);

	await expect(f.chartService.applyBatch([poison, healthy])).rejects.toMatchObject({ items: [{ noteId: poison.noteId, userId: poison.userId }] });

	expect(f.receipts[0].effects.charts).toBeUndefined();
	expect(f.receipts[1].effects.charts).toBeDefined();
	expect(f.charts.notes.applyDeletionInTransaction).toHaveBeenCalledTimes(1);
});

test('stream 장애여도 다른 종류의 로컬 의무는 독립적으로 완료한다', async () => {
	const f = receiptStore([receipt({ moderationLog: true, activityPub: false })]);
	f.events.mockRejectedValueOnce(new Error('publish failed'));

	await f.createRunner().scan();

	expect(f.receipts[0].effects.search).toBeDefined();
	expect(f.receipts[0].effects.moderationLog).toBeDefined();
	expect(f.receipts[0].effects.charts).toBeDefined();
	expect(f.receipts[0].lastErrorCode).toBe('noteStream_failed');
});

test('관리자 제외 판정과 표식도 같은 transaction에서 롤백하고 재시도한다', async () => {
	vi.useFakeTimers();
	const f = receiptStore([receipt({ moderationLog: true, activityPub: false })]);
	f.state.moderatorPresent = false;
	f.state.failEffectMark = 'moderationLog';

	await f.createRunner().scan();

	expect(f.receipts[0].effects.moderationLog).toBeUndefined();
	expect(f.receipts[0].effects.charts).toBeDefined();
	expect(f.receipts[0].completedAt).toBeNull();
	f.state.failEffectMark = null;
	vi.advanceTimersByTime(5_000);
	await f.createRunner().scan();
	expect(f.receipts[0].effects.moderationLog).toMatchObject({ outcome: 'excluded', reason: 'subject_deleted' });
	expect(f.log).not.toHaveBeenCalled();
});

test('차트 DB 장애에서는 열 개 fallback 호출을 만들지 않고 다음 scan으로 넘긴다', async () => {
	const rows = Array.from({ length: 10 }, (_, i) => ({ ...receipt(), noteId: `db-${i}` }));
	const f = receiptStore(rows);
	f.charts.notes.applyDeletionInTransaction.mockRejectedValue(new Error('database unavailable'));

	expect(await f.createRunner().scan()).toBe(1);

	expect(f.applyBatch).toHaveBeenCalledTimes(1);
	expect(f.query.mock.calls.filter(([sql]) => sql.trimStart().startsWith('UPDATE'))).toHaveLength(1);
	expect(f.receipts.every(row => !row.effects.charts)).toBe(true);
});

test('열 영수증의 총 외부 대기가 lease보다 길어도 실행 직전 claim과 선행 차트를 보존한다', async () => {
	vi.useFakeTimers();
	const rows = Array.from({ length: 10 }, (_, i) => ({ ...receipt({ activityPub: false }), noteId: `slow-${i}` }));
	const f = receiptStore(rows);
	const before = Date.now();
	f.events.mockImplementation(() => new Promise(resolve => { setTimeout(resolve, 4_000); }));
	f.search.mockImplementation(() => new Promise(resolve => { setTimeout(resolve, 4_000); }));
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	f.events.mockImplementationOnce(() => { entered(); return new Promise(resolve => { setTimeout(resolve, 4_000); }); });

	const running = f.createRunner().scan();
	await started;
	expect(f.receipts[0].effects.charts).toBeDefined();
	expect(f.receipts[1].claimToken).toBeNull();
	await vi.advanceTimersByTimeAsync(80_001);
	expect(await running).toBe(10);

	expect(Date.now() - before).toBeGreaterThan(60_000);
	expect(f.receipts.every(row => row.completedAt && row.claimVersion === 1)).toBe(true);
	expect(f.charts.notes.applyDeletionInTransaction).toHaveBeenCalledTimes(1);
});

test.each(['delivered', 'skipped', 'permanentFailed'] as const)('전달 %s 정산은 로컬 완료와 구분하며 다시 실행하지 않는다', async outcome => {
	vi.useFakeTimers();
	const row = receipt();
	const f = receiptStore([row]);
	await f.createRunner().scan();

	expect(row.completedAt).toBeNull();
	expect(row.effects.activityPub).toBeUndefined();
	f.deliveries[0].state = outcome;
	f.deliveries[0].settledAt = new Date();
	vi.advanceTimersByTime(300_000);
	await f.createRunner().scan();

	expect(row.effects.activityPub).toMatchObject({ outcome, summary: { unfinished: 0, [outcome]: 1 } });
	expect(row.completedAt).toBeInstanceOf(Date);
	expect(row.lastErrorCode).toBe(outcome === 'permanentFailed' ? 'delivery_permanent_failed' : null);
	vi.advanceTimersByTime(300_000);
	expect(await f.createRunner().scan()).toBe(0);
	expect(f.events).toHaveBeenCalledTimes(1);
});

test('stream 확정은 AP 미완료여도 수신자 복사본을 같은 경계에서 제거한다', async () => {
	const row = receipt();
	row.snapshot.stream = { visibleUserIds: ['private-recipient'], mentions: ['private-mention'], replyUserId: 'private-parent' };
	const f = receiptStore([row]);

	await f.createRunner().scan();

	expect(row.effects.noteStream).toBeDefined();
	expect(row.snapshot.stream).toBeNull();
	expect(row.completedAt).toBeNull();
	expect(f.events.mock.calls[0][0]).toMatchObject({ visibleUserIds: ['private-recipient'], mentions: ['private-mention'], replyUserId: 'private-parent' });
	const persisted = JSON.stringify(row);
	expect(persisted).not.toContain('private-recipient');
	expect(persisted).not.toContain('private-mention');
	expect(persisted).not.toContain('private-parent');
});

test('stream 표식 실패는 입력도 보존하고 재시도 확정 뒤 함께 제거한다', async () => {
	vi.useFakeTimers();
	const f = receiptStore([receipt()]);
	f.state.failEffectMark = 'noteStream';

	await f.createRunner().scan();

	expect(f.receipts[0].effects.noteStream).toBeUndefined();
	expect((f.receipts[0].snapshot as NoteDeleteLocalSnapshot).stream).not.toBeNull();
	f.state.failEffectMark = null;
	vi.advanceTimersByTime(5_000);
	await f.createRunner().scan();

	expect(f.receipts[0].effects.noteStream).toBeDefined();
	expect((f.receipts[0].snapshot as NoteDeleteLocalSnapshot).stream).toBeNull();
	expect(f.events).toHaveBeenCalledTimes(2);
});

test('전체 로컬 정산은 민감 복구 snapshot을 명시적인 최소 종료 형식으로 바꾼다', async () => {
	const f = receiptStore([receipt({ activityPub: false })]);

	await f.createRunner().scan();

	expect(f.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
	expect(f.receipts[0].completedAt).toBeInstanceOf(Date);
	expect(f.receipts[0].effects.activityPub).toMatchObject({ outcome: 'skipped', summary: { unfinished: 0, delivered: 0, skipped: 0, permanentFailed: 0 } });
});

test.each(['delivered', 'skipped', 'permanentFailed'] as const)('%s 정산은 요약·고정 오류·fencing만 보존하고 모든 전송 입력을 제거한다', async outcome => {
	const f = receiptStore([receipt()]);
	const row = f.deliveries[0];
	Object.assign(row, { state: outcome, attempts: 4, generation: 3, claimVersion: 7, settledAt: new Date(), lastErrorCode: outcome === 'permanentFailed' ? 'remote_permanent' : outcome === 'skipped' ? 'blocked' : null });
	const before = structuredClone(row);

	await f.createRunner().scan();

	expect(f.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
	expect(f.receipts[0].effects.activityPub).toMatchObject({ outcome, summary: { unfinished: 0, [outcome]: 1 } });
	expect(f.deliveries[0]).toEqual({ ...before, endpoint: null, isSharedInbox: null, payloadRef: null, relayId: null });
	expect(f.receipts[0].lastErrorCode).toBe(outcome === 'permanentFailed' ? 'delivery_permanent_failed' : null);
});

test('대상 없음은 skipped 요약으로 종료하고 불필요한 고정 문자열도 제거한다', async () => {
	const row = receipt();
	row.snapshot.delivery.directTargets = [];
	const f = receiptStore([row]);

	await f.createRunner().scan();

	expect(f.receipts[0].effects.activityPub).toMatchObject({ outcome: 'skipped', summary: { unfinished: 0, delivered: 0, skipped: 0, permanentFailed: 0 } });
	expect(f.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
});

test('한 의무라도 pending이면 이미 정산된 행과 고정 payload 입력을 함께 보존한다', async () => {
	const row = receipt();
	row.snapshot.delivery.directTargets.push({ targetKey: 'second', endpoint: 'https://other.test/private', isSharedInbox: false });
	const f = receiptStore([row]);
	f.deliveries[0].state = 'permanentFailed';
	const payload = structuredClone(row.snapshot.delivery);
	const inputs = structuredClone(f.deliveries);

	await f.createRunner().scan();

	expect(row.completedAt).toBeNull();
	expect(row.snapshot.delivery).toEqual(payload);
	expect(f.deliveries).toEqual(inputs);
});

test('외부 요약과 달리 실제 의무가 누락됐으면 성공으로 추정하지 않는다', async () => {
	const f = receiptStore([receipt()]);
	f.deliveries.splice(0);
	const summary = vi.spyOn(f.delivery, 'summarize').mockResolvedValue({ unfinished: 0, delivered: 1, skipped: 0, permanentFailed: 0 });

	await f.createRunner().scan();

	expect(f.receipts[0].completedAt).toBeNull();
	expect(f.receipts[0].snapshot.version).toBe(1);
	expect(f.receipts[0].effects.activityPub).toBeUndefined();
	expect(summary).not.toHaveBeenCalled();
});

test('종료 transaction 실패는 요약·전송 입력을 함께 롤백하고 재시도는 영구 실패를 보존한다', async () => {
	vi.useFakeTimers();
	const f = receiptStore([receipt()]);
	Object.assign(f.deliveries[0], { state: 'permanentFailed', settledAt: new Date(), lastErrorCode: 'remote_permanent', attempts: 2 });
	const before = structuredClone(f.deliveries);
	f.state.failDeliverySettlement = true;

	await expect(f.createRunner().scan()).rejects.toThrow('delivery settlement failed');

	expect(f.deliveries).toEqual(before);
	expect(f.receipts[0].snapshot.version).toBe(1);
	expect(f.receipts[0].effects.activityPub).toBeUndefined();
	const effects = structuredClone(f.receipts[0].effects);
	f.state.failDeliverySettlement = false;
	vi.advanceTimersByTime(60_001);
	await f.createRunner().scan();

	expect(f.receipts[0].effects).toMatchObject(effects);
	expect(f.receipts[0].effects.activityPub?.outcome).toBe('permanentFailed');
	expect(f.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
	expect(f.events).toHaveBeenCalledTimes(1);
	expect(f.deliveries[0].attempts).toBe(2);
	expect(f.deliveries[0].lastErrorCode).toBe('remote_permanent');
});

test('늦은 로컬 효과는 새 claim의 종료 snapshot과 요약을 복원하지 못한다', async () => {
	vi.useFakeTimers();
	const f = receiptStore([receipt({ activityPub: false })]);
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>(done => { entered = done; });
	const waiting = new Promise<void>(done => { release = done; });
	f.search.mockImplementationOnce(async () => { entered(); await waiting; });
	const old = f.createRunner().scan();
	await started;
	vi.advanceTimersByTime(60_001);
	await f.createRunner().scan();
	const saved = structuredClone(f.receipts[0]);

	release();
	await old;
	await f.chartService.applyBatch([{ noteId: 'note', userId: 'author' }]);
	await f.createRunner().runOne('note', 'author');

	expect(saved.snapshot).toEqual({ version: 2, state: 'settled' });
	expect(f.receipts[0]).toEqual(saved);
});

test('미지원 미완료 형식은 종료와 구별하여 입력을 보존하고 다음 정상 영수증을 처리한다', async () => {
	const poison = receipt();
	(poison.snapshot as any).version = 999;
	const healthy = { ...receipt({ activityPub: false }), noteId: 'healthy' };
	const before = structuredClone(poison.snapshot);
	const f = receiptStore([poison, healthy]);

	await f.createRunner().scan();

	expect(poison.snapshot).toEqual(before);
	expect(poison.completedAt).toBeNull();
	expect(poison.lastErrorCode).toBe('unsupported_snapshot');
	expect(healthy.snapshot).toEqual({ version: 2, state: 'settled' });
	expect(f.events).toHaveBeenCalledTimes(1);
});

test('미완료 전달 계획의 형식 오류는 종료 입력으로 바꾸지 않고 정상 영수증과 격리한다', async () => {
	const poison = receipt();
	const healthy = { ...receipt({ activityPub: false }), noteId: 'healthy' };
	const f = receiptStore([poison, healthy]);
	delete (poison.snapshot.delivery as any).directTargets;
	const before = structuredClone(poison.snapshot.delivery);

	await f.createRunner().scan();

	expect(poison.snapshot.delivery).toEqual(before);
	expect(poison.completedAt).toBeNull();
	expect(healthy.snapshot).toEqual({ version: 2, state: 'settled' });
});

test.each(['search', 'events', 'charts'] as const)('AP 종료 뒤 %s 실패는 소비한 전달 입력을 보관하지 않는다', async failure => {
	vi.useFakeTimers();
	const f = receiptStore([receipt()]);
	Object.assign(f.deliveries[0], { state: 'delivered', settledAt: new Date() });
	if (failure === 'charts') f.charts.notes.applyDeletionInTransaction.mockRejectedValueOnce(new Error('chart unavailable'));
	else f[failure].mockRejectedValueOnce(new Error('local unavailable'));

	await f.createRunner().scan();

	expect(f.receipts[0].completedAt).toBeNull();
	expect(f.receipts[0].snapshot).toMatchObject({ version: 3, state: 'delivery_settled', delivery: null });
	expect(f.receipts[0].effects.activityPub?.summary).toEqual({ unfinished: 0, delivered: 1, skipped: 0, permanentFailed: 0 });
	expect(f.deliveries[0].endpoint).toBeNull();
	expect(JSON.stringify(f.receipts[0])).not.toContain('private');
	vi.advanceTimersByTime(5_001);
	await f.createRunner().scan();

	expect(f.receipts[0].snapshot).toEqual({ version: 2, state: 'settled' });
	expect(f.receipts[0].completedAt).toBeInstanceOf(Date);
	expect(f.receipts[0].effects.activityPub?.summary?.delivered).toBe(1);
});

test('이전 activityPub 요약만으로 pending 의무를 종료하거나 입력을 제거하지 않는다', async () => {
	const row = receipt();
	row.effects.activityPub = { completedAt: new Date().toISOString(), outcome: 'delivered', summary: { unfinished: 0, delivered: 1, skipped: 0, permanentFailed: 0 } };
	const f = receiptStore([row]);

	await f.createRunner().scan();

	expect(f.receipts[0].completedAt).toBeNull();
	expect(f.receipts[0].snapshot.version).toBe(1);
	expect(f.deliveries[0].endpoint).toContain('private-inbox');
});

test('외부 로컬 효과 도중 AP가 끝나도 실패 정산의 최신 잠금에서 전달 입력을 제거한다', async () => {
	const f = receiptStore([receipt()]);
	f.search.mockImplementationOnce(async () => {
		Object.assign(f.deliveries[0], { state: 'permanentFailed', settledAt: new Date(), lastErrorCode: 'owner_removed' });
		throw new Error('search unavailable');
	});

	await f.createRunner().scan();

	expect(f.receipts[0].completedAt).toBeNull();
	expect(f.receipts[0].snapshot).toMatchObject({ version: 3, state: 'delivery_settled', delivery: null });
	expect(f.receipts[0].effects.activityPub?.outcome).toBe('permanentFailed');
	expect(f.deliveries[0].endpoint).toBeNull();
	expect(f.deliveries[0].lastErrorCode).toBe('owner_removed');
	expect(f.receipts[0].lastErrorCode).toBe('search_failed');
});

test('미지원 전달 이유는 terminal 행만으로 고정 입력을 제거하지 않는다', async () => {
	const f = receiptStore([receipt()]);
	Object.assign(f.deliveries[0], { state: 'delivered', settledAt: new Date() });
	if (f.receipts[0].snapshot.version === 1) Object.assign(f.receipts[0].snapshot.delivery, { reason: 'unsupported' });

	await f.createRunner().scan();

	expect(f.receipts[0].snapshot.version).toBe(1);
	expect(f.receipts[0].effects.activityPub).toBeUndefined();
	expect(f.deliveries[0].endpoint).toContain('private-inbox');
});

test.each(['owner', 'state'] as const)('의무의 %s가 canonical 계획과 맞지 않으면 입력을 보존한다', async mismatch => {
	const f = receiptStore([receipt()]);
	Object.assign(f.deliveries[0], { state: 'delivered', settledAt: new Date() });
	if (mismatch === 'owner') f.deliveries[0].ownerUserId = 'other';
	else Object.assign(f.deliveries[0], { state: 'unsupported' });
	const before = structuredClone(f.deliveries);

	await f.createRunner().scan();

	expect(f.receipts[0].completedAt).toBeNull();
	expect(f.receipts[0].snapshot.version).toBe(1);
	expect(f.receipts[0].effects.activityPub).toBeUndefined();
	expect(f.deliveries).toEqual(before);
});

test('여러 삭제 영수증을 한 차트 트랜잭션에 묶어 처리한다', async () => {
	const rows = [receipt(), receipt(), receipt()];
	for (const [index, row] of rows.entries()) {
		row.noteId = `note-${index}`;
		row.snapshot.note.id = row.noteId;
	}
	const f = receiptStore(rows);

	expect(await f.createRunner().scan()).toBe(3);

	expect(f.applyBatch).toHaveBeenCalledTimes(1);
	expect(f.applyBatch.mock.calls[0][0]).toHaveLength(3);
	expect(f.receipts.every(row => row.effects.charts != null)).toBe(true);
});
