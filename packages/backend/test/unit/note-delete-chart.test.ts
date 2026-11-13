/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../src/misc/distributed-lock.js', () => ({ acquireChartInsertLock: async () => () => {} }));
vi.mock('../../src/core/UtilityService.js', () => ({ UtilityService: class {} }));
import { NoteDeleteChartService } from '../../src/core/NoteDeleteChartService.js';
import { MiNoteDeleteReceipt } from '../../src/models/NoteDeleteReceipt.js';
import NotesChart from '../../src/core/chart/charts/notes.js';
import PerUserNotesChart from '../../src/core/chart/charts/per-user-notes.js';
import InstanceChart from '../../src/core/chart/charts/instance.js';
import Chart from '../../src/core/chart/core.js';
import { TickChartsProcessorService } from '../../src/queue/processors/TickChartsProcessorService.js';

const note = { userId: 'alice', userHost: null, replyId: null, renoteId: null, fileIds: [] };

// SQL 실행이나 연결 간 경쟁을 검증하지 않는 저장소 모형이다.
function fixture() {
	const rows = new Map<string, any[]>();
	const events: string[] = [];
	const expressions: string[] = [];
	const lockKeys: string[] = [];
	const state = { count: 10, fail: '', counts: 0, failCommit: false, afterWrite: undefined as (() => void) | undefined };
	const receipts: any[] = [];
	let nextId = 1;
	const repository = (target: any): any => {
		if (target === MiNoteDeleteReceipt) return {
			findOneOrFail: async ({ where, lock }: any) => {
				expect(lock.mode).toBe('pessimistic_write');
				events.push('receipt:' + where.noteId);
				const receipt = receipts.find(r => r.noteId === where.noteId && r.userId === where.userId);
				if (!receipt) throw new Error('receipt missing');
				return receipt;
			},
			update: async (where: any, data: any) => {
				events.push('marker');
				if (state.fail === 'marker') throw new Error('marker failed');
				Object.assign(receipts.find(r => r.noteId === where.noteId), data);
			},
		};
		const key = target.options?.name ?? target.name ?? target;
		if (!rows.has(key)) rows.set(key, []);
		const all = rows.get(key)!;
		const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
		const repo: any = {
			target,
			extend: () => repo,
			findOneBy: async (where: any) => all.find(row => matches(row, where)),
			findOneByOrFail: async (where: any) => { const row = all.find(row => matches(row, where)); if (!row) throw new Error('missing row'); return row; },
			findOne: async ({ where }: any) => all.filter(row => matches(row, where)).sort((a, b) => b.date - a.date)[0],
			insert: async (row: any) => {
				if (target.options?.columns?.group && row.group == null) throw new Error('group NOT NULL');
				const id = nextId++;
				const defaults = Object.fromEntries(Object.keys(target.options?.columns ?? {}).filter(k => k.startsWith('unique_temp___')).map(k => [k, []]));
				all.push({ id, ...defaults, ...row });
				return { identifiers: [{ id }] };
			},
			insertOne: async (row: any) => { const id = nextId++; const defaults = Object.fromEntries(Object.keys(target.options?.columns ?? {}).filter(k => k.startsWith('unique_temp___')).map(k => [k, []])); const saved = { id, ...defaults, ...row }; all.push(saved); return saved; },
			countBy: async () => { events.push('count'); state.counts++; return state.count; },
			createQueryBuilder: () => {
				let values: any;
				let rowId: number;
				const builder: any = {
					select: () => builder, addSelect: () => builder,
					getRawOne: async () => { events.push('count'); state.counts++; return { local: String(state.count), remote: '0' }; },
					update: () => builder,
					set: (v: any) => { values = v; return builder; },
					where: (_: string, v: any) => { rowId = v.id; return builder; },
					execute: async () => {
						events.push(key);
						if (state.fail && key.toLowerCase().includes(state.fail)) throw new Error('write failed');
						const row = all.find(r => r.id === rowId)!;
						for (const [column, value] of Object.entries(values)) {
							if (typeof value === 'function') {
								const sql = value();
								expressions.push(sql);
								if (sql.startsWith('array_cat')) {
									row[column] = row[column].concat([...sql.matchAll(/'([^']*)'/g)].map(match => match[1]));
									continue;
								}
								const delta = sql.match(/(?:bigint)? ([+-]) (\d+)/)!;
								row[column] += Number(delta[2]) * (delta[1] === '+' ? 1 : -1);
							} else row[column] = value;
						}
						state.afterWrite?.();
					},
				};
				return builder;
			},
		};
		return repo;
	};
	const manager: any = { getRepository: repository, query: async (_sql: string, params: string[]) => { events.push('lock'); lockKeys.push(params[0]); } };
	const db: any = {
		getRepository: repository,
		transaction: async (work: any) => {
			const before = structuredClone([...rows]);
			const beforeReceipts = structuredClone(receipts);
			try { const result = await work(manager); if (state.failCommit) throw new Error('commit failed'); return result; } catch (error) {
				receipts.splice(0, receipts.length, ...beforeReceipts);
				for (const [key, value] of rows) value.splice(0, value.length, ...(before.find(([k]) => k === key)?.[1] ?? []));
				throw error;
			}
		},
	};
	const logger: any = { logger: { info: vi.fn() } };
	const chart = new NotesChart(db, {} as any, repository('note'), logger);
	const perUser = new PerUserNotesChart(db, {} as any, repository('note'), logger);
	const instance = new InstanceChart(db, {} as any, repository('user'), repository('note'), repository('drive'), repository('following'), { toPuny: (s: string) => s } as any, logger);
	const stage = new NoteDeleteChartService(db, chart, perUser, instance);
	const addReceipt = (id: string, targets = { version: 1, notes: true, perUser: 'alice', instance: null }, quiet = false) => {
		const receipt = { noteId: id, userId: 'alice', quiet, deletedAt: new Date('2020-01-01Z'), effects: {}, snapshot: { version: 1, charts: targets, actor: { host: null }, note } };
		receipts.push(receipt);
		return { noteId: id, userId: 'alice' };
	};
	return { db, manager, chart, perUser, instance, rows, state, events, logger, stage, receipts, addReceipt, expressions, lockKeys };
}

afterEach(() => vi.useRealTimers());

test('삭제 후 resync 9와 늦은 삭제 적용이 total을 8로 만들지 않는다', async () => {
	const f = fixture();
	f.state.count = 9;
	await f.chart.resync();
	await f.db.transaction(async (manager: any) => {
		await f.chart.lockDeletionGroup(manager, null);
		await f.chart.applyDeletionInTransaction(manager, [note] as any, null, new Date());
	});

	for (const rows of f.rows.values()) for (const row of rows) {
		expect(row.___local_total).toBe(9);
		expect(row.___local_dec).toBe(1);
	}
	expect(f.events[0]).toBe('lock');
});

test('생성 +1 buffer 뒤 삭제 count 10을 쓴 후 save도 10이다', async () => {
	const f = fixture();
	await f.chart.update(note as any, true);
	await f.db.transaction((manager: any) => f.chart.applyDeletionInTransaction(manager, [note] as any, null, new Date()));
	await f.chart.save();

	for (const rows of f.rows.values()) for (const row of rows) {
		expect(row.___local_total).toBe(10);
		expect(row.___local_inc).toBe(1);
		expect(row.___local_dec).toBe(1);
	}
});

test('day 쓰기 실패 시 hour도 롤백하고 재시도한다', async () => {
	const f = fixture();
	f.state.fail = 'day';

	await expect(f.db.transaction((manager: any) => f.chart.applyDeletionInTransaction(manager, [note] as any, null, new Date()))).rejects.toThrow('write failed');
	for (const rows of f.rows.values()) expect(rows).toHaveLength(0);
	f.state.fail = '';
	await f.db.transaction((manager: any) => f.chart.applyDeletionInTransaction(manager, [note] as any, null, new Date()));
	for (const rows of f.rows.values()) for (const row of rows) expect(row.___local_dec).toBe(1);
});

test('단일 UTC bucket과 history 없는 row를 count로 초기화한다', async () => {
	const f = fixture();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-13T23:59:59.999Z'));
	f.state.afterWrite = () => vi.setSystemTime(new Date('2026-11-14T00:00:01Z'));
	await f.db.transaction((manager: any) => f.perUser.applyDeletionInTransaction(manager, [note] as any, 'alice', new Date()));

	const saved = [...f.rows.values()].flat();
	expect(saved.map(row => row.date).sort()).toEqual([Date.parse('2026-11-13T00:00:00Z') / 1000, Date.parse('2026-11-13T23:00:00Z') / 1000]);
	for (const row of saved) { expect(row.___total).toBe(10); expect(row.___dec).toBe(1); }
	expect(f.state.counts).toBe(1);
});

test('instance는 notes total만 대입하고 다른 buffer total은 가산한다', async () => {
	const f = fixture();
	await f.instance.newUser('remote.test');
	await f.instance.updateNote('remote.test', { ...note, userHost: 'remote.test' } as any, true);
	await f.instance.save();

	for (const rows of f.rows.values()) for (const row of rows) {
		expect(row.___notes_total).toBe(10);
		expect(row.___users_total).toBe(1);
		expect(row.___notes_inc).toBe(1);
	}
});

test('선택하지 않은 차트는 기존 buffered total을 유지한다', async () => {
	const f = fixture();
	class BufferedChart extends Chart<{ total: { accumulate: true } }> {
		protected async tickMajor() { return {}; }
		protected async tickMinor() { return {}; }
		public add() { this.commit({ total: 1 }); }
	}
	const chart = new BufferedChart(f.db, async () => () => {}, f.logger.logger, 'buffered', { total: { accumulate: true } });
	chart.add();
	await chart.save();

	for (const rows of f.rows.values()) for (const row of rows) expect(row.___total).toBe(1);
	expect(f.events).not.toContain('lock');
});

test('같은 영수증 중복과 재시도는 한 번만 반영하고 다른 영수증은 각각 반영한다', async () => {
	const f = fixture();
	const first = f.addReceipt('one');
	const second = f.addReceipt('two');
	await f.stage.applyBatch([second, first, first]);
	const countCalls = f.state.counts;
	await f.stage.applyBatch([first, second]);

	expect(f.state.counts).toBe(countCalls);
	expect(countCalls).toBe(2);
	expect(f.lockKeys.slice(0, 2)).toEqual([...f.lockKeys.slice(0, 2)].sort());
	for (const rows of f.rows.values()) for (const row of rows) {
		const dec = row.___local_dec ?? row.___dec;
		expect(dec).toBe(2);
	}
	for (const receipt of f.receipts) {
		expect(receipt.effects.charts.outcome).toBe('applied');
		expect(receipt.effects.notesChart.bucketAt).toBe(receipt.effects.perUserNotesChart.bucketAt);
		expect(receipt.deletedAt).toEqual(new Date('2020-01-01Z'));
	}
	expect(f.events.slice(0, 4)).toEqual(['receipt:one', 'receipt:two', 'lock', 'lock']);
});

test.each(['chartxnotes', 'day', 'marker'])('%s 실패 시 차트와 처리 표식을 모두 롤백한다', async (failure) => {
	const f = fixture();
	const item = f.addReceipt('one');
	f.state.fail = failure;

	await expect(f.stage.applyBatch([item])).rejects.toThrow();
	for (const rows of f.rows.values()) expect(rows).toHaveLength(0);
	expect(f.receipts[0].effects).toEqual({});
	f.state.fail = '';
	await f.stage.applyBatch([item]);
	for (const rows of f.rows.values()) for (const row of rows) expect(row.___local_dec ?? row.___dec).toBe(1);
});

test('commit 실패도 표식과 차트를 롤백한다', async () => {
	const f = fixture();
	const item = f.addReceipt('one');
	f.state.failCommit = true;

	await expect(f.stage.applyBatch([item])).rejects.toThrow('commit failed');
	expect(f.receipts[0].effects).toEqual({});
	for (const rows of f.rows.values()) expect(rows).toHaveLength(0);
});

test('quiet와 설정 제외를 기록하고 재시도는 현재 설정을 읽지 않는다', async () => {
	const f = fixture();
	const quiet = f.addReceipt('quiet', { version: 1, notes: false, perUser: null as any, instance: null }, true);
	const disabled = f.addReceipt('disabled', { version: 1, notes: true, perUser: null as any, instance: null });
	await f.stage.applyBatch([quiet, disabled]);

	expect(f.receipts[0].effects.notesChart).toMatchObject({ outcome: 'excluded', reason: 'quiet' });
	expect(f.receipts[1].effects.perUserNotesChart).toMatchObject({ outcome: 'excluded', reason: 'settings' });
	expect(f.state.counts).toBe(1);
	await f.stage.applyBatch([quiet, disabled]);
	expect(f.state.counts).toBe(1);
});

test('없는 영수증과 다른 소유자 및 큰 batch를 완료로 처리하지 않는다', async () => {
	const f = fixture();
	f.addReceipt('one');

	await expect(f.stage.applyBatch([{ noteId: 'missing', userId: 'alice' }])).rejects.toThrow('receipt missing');
	await expect(f.stage.applyBatch([{ noteId: 'one', userId: 'mallory' }])).rejects.toThrow('receipt missing');
	await expect(f.stage.applyBatch(Array.from({ length: 33 }, () => ({ noteId: 'one', userId: 'alice' })))).rejects.toThrow('32');
	expect(f.receipts[0].effects).toEqual({});
});

test('count는 잠금 완료 뒤에 실행되어 대기 전 값을 재사용하지 않는다', async () => {
	const f = fixture();
	f.manager.query = async () => { f.events.push('lock'); f.state.count = 9; };
	await f.chart.resync();

	expect(f.events.indexOf('count')).toBeGreaterThan(f.events.indexOf('lock'));
	for (const rows of f.rows.values()) for (const row of rows) expect(row.___local_total).toBe(9);
});

test('새 UTC day는 이전 누적값을 복사하고 diff는 새로 시작한다', async () => {
	const f = fixture();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-13T23:59:59Z'));
	await f.instance.newUser('remote.test');
	await f.instance.save();
	vi.setSystemTime(new Date('2026-11-14T00:00:01Z'));
	f.state.count = 9;
	await f.instance.applyDeletionInTransaction(f.manager, [{ ...note, userHost: 'remote.test', replyId: 'reply', renoteId: 'renote', fileIds: ['file'] }], 'remote.test', new Date());

	const next = [...f.rows.values()].flat().filter(row => row.date === Date.parse('2026-11-14Z') / 1000);
	expect(next).toHaveLength(2);
	for (const row of next) {
		expect(row.___users_total).toBe(1);
		expect(row.___users_inc).toBe(0);
		expect(row.___notes_total).toBe(9);
		expect(row.___notes_diffs_reply).toBe(-1);
		expect(row.___notes_diffs_renote).toBe(-1);
		expect(row.___notes_diffs_withFile).toBe(-1);
	}
});

test('선택 밖 unique와 intersection의 누적 저장 의미를 보존한다', async () => {
	const f = fixture();
	const schema = { total: { accumulate: true }, a: { uniqueIncrement: true }, b: { uniqueIncrement: true }, both: { intersection: ['a', 'b'] } } as const;
	class UniqueChart extends Chart<typeof schema> {
		protected async tickMajor() { return {}; }
		protected async tickMinor() { return {}; }
		public add(a: string[], b: string[]) { this.commit({ total: 1, a, b }); }
	}
	const chart = new UniqueChart(f.db, async () => () => {}, f.logger.logger, 'unique', schema);
	chart.add(['alice'], ['bob']);
	await chart.save();
	chart.add(['alice', 'bob'], ['alice']);
	await chart.save();

	for (const rows of f.rows.values()) for (const row of rows) {
		expect(row.___total).toBe(2);
		expect(row.___a).toBe(2);
		expect(row.___b).toBe(2);
		expect(row.___both).toBe(2);
	}
	expect(f.events).not.toContain('lock');
});

test('선택한 total은 잔류 delta도 무시하고 기존 정수 clamp를 쓴다', async () => {
	const f = fixture();
	f.state.count = 2147483648;
	Reflect.get(f.chart, 'commit').call(f.chart, { 'local.total': 1, 'local.inc': 1 });
	await f.chart.save();

	for (const rows of f.rows.values()) for (const row of rows) expect(row.___local_total).toBe(2147483647);
	await f.perUser.applyDeletionInTransaction(f.manager, [note], 'alice', new Date());
	expect(f.expressions).toContain('LEAST("___dec"::bigint + 1, 32767)');
	expect(f.expressions).toContain('GREATEST("___diffs_normal"::bigint - 1, -32768)');
});

test.each(['ChartXnotes', 'ChartDayXnotes'])('%s만 존재해도 나머지 row를 같은 count로 생성한다', async (existing) => {
	const f = fixture();
	await f.chart.resync();
	for (const [key, rows] of f.rows) if (key !== existing) rows.splice(0);
	f.state.count = 9;
	await f.chart.applyDeletionInTransaction(f.manager, [note], null, new Date());

	const saved = [...f.rows.values()].flat();
	expect(saved).toHaveLength(2);
	for (const row of saved) {
		expect(row.___local_total).toBe(9);
		expect(row.___local_dec).toBe(1);
	}
});

test('이전 부분 차트 표식이나 대상 snapshot 누락은 성공으로 추정하지 않는다', async () => {
	const f = fixture();
	const item = f.addReceipt('one');
	f.receipts[0].effects.notesChart = { completedAt: '2020-01-01Z' };
	await expect(f.stage.applyBatch([item])).rejects.toThrow('Unsupported');
	f.receipts[0].effects = {};
	delete f.receipts[0].snapshot.charts;
	await expect(f.stage.applyBatch([item])).rejects.toThrow('Unsupported');

	expect(f.state.counts).toBe(0);
});

test('선택 경로는 주입된 전역 저장소 대신 manager에 재결합한 저장소만 사용한다', async () => {
	const f = fixture();
	const fail = () => { throw new Error('pool repository used'); };
	for (const chart of [f.chart, f.perUser, f.instance]) {
		Reflect.get(chart, 'notesRepository').countBy = fail;
		Reflect.get(chart, 'repositoryForHour').findOneBy = fail;
		Reflect.get(chart, 'repositoryForDay').findOneBy = fail;
	}
	for (const key of ['usersRepository', 'followingsRepository', 'driveFilesRepository']) Reflect.get(f.instance, key).countBy = fail;

	await f.chart.resync();
	await f.perUser.resync('alice');
	await f.instance.resync('remote.test');
	await f.instance.newUser('remote.test');
	await f.instance.save();

	expect(f.state.counts).toBe(8);
});

// 정기 처리기와 선택 차트의 실제 tick을 실행하고 DB 경계만 모형으로 대체한다.
test.each(['both', 'hour', 'day', 'neither', 'nextUtcDay'])('정기 tick은 group 없는 차트를 건드리지 않고 뒤 차트까지 진행한다: %s', async (existing) => {
	const f = fixture();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-13T23:59:59.999Z'));
	for (const group of ['one.test', 'two.test']) {
		await f.instance.resync(group);
		await f.perUser.resync(group);
	}
	for (const [key, rows] of f.rows) {
		const span = key.startsWith('ChartDay') ? 'day' : 'hour';
		if (existing === 'neither' || (existing !== 'both' && existing !== 'nextUtcDay' && existing !== span)) rows.splice(0);
	}
	for (const [key, rows] of f.rows) if (key.startsWith('ChartDay')) rows.reverse();
	if (existing === 'nextUtcDay') vi.setSystemTime(new Date('2026-11-14T00:00:00.001Z'));
	const groupedRows = () => [...f.rows].filter(([key]) => key.includes('instance') || key.includes('perUserNotes'));
	const before = structuredClone(groupedRows());
	f.state.count = 99;
	const countBefore = f.state.counts;
	const progressed: string[] = [];
	class LaterChart extends Chart<{ total: { accumulate: true } }> {
		protected async tickMajor() { return {}; }
		protected async tickMinor() { progressed.push('later'); return {}; }
	}
	const other = (): any => new LaterChart(f.db, async () => () => {}, f.logger.logger, 'later', { total: { accumulate: true } });
	const logger: any = { logger: { createSubLogger: () => ({ info() {}, succ() {} }) } };
	const processor = new TickChartsProcessorService(other(), f.chart, other(), other(), f.instance, f.perUser, other(), other(), other(), other(), other(), other(), logger);

	await processor.process();

	expect(groupedRows()).toEqual(before);
	expect(f.state.counts - countBefore).toBe(1);
	expect(progressed).toHaveLength(9);
	const notes = [...f.rows].filter(([key]) => key === 'ChartXnotes' || key === 'ChartDayXnotes').flatMap(([, rows]) => rows);
	expect(notes).toHaveLength(2);
	for (const row of notes) expect(row.___local_total).toBe(99);
});

test.each([null, '', '   '])('선택 grouped 차트는 잘못된 group %s의 major/save/삭제를 DB 접근 전에 거절한다', async (group) => {
	const f = fixture();
	for (const chart of [f.instance, f.perUser]) {
		await expect(chart.resync(group)).rejects.toThrow('requires a non-empty group');
		await expect(chart.tick(true, group)).rejects.toThrow('requires a non-empty group');
		await expect(chart.applyDeletionInTransaction(f.manager, [note], group as any, new Date())).rejects.toThrow('requires a non-empty group');
		Reflect.get(chart, 'commit').call(chart, {}, group);
		await expect(chart.save()).rejects.toThrow('requires a non-empty group');
	}
	expect(f.events).toEqual([]);
	for (const rows of f.rows.values()) expect(rows).toHaveLength(0);
});

test('유효한 두 group의 save/resync/삭제는 다른 group의 total을 보존한다', async () => {
	const f = fixture();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-11-14T00:00:00.001Z'));
	for (const group of ['one.test', 'two.test']) {
		f.state.count = group === 'one.test' ? 11 : 22;
		await f.instance.resync(group);
		await f.perUser.resync(group);
	}
	f.state.count = 10;
	await f.instance.newUser('one.test');
	f.perUser.update({ id: 'one.test' }, note as any, true);
	await f.instance.save();
	await f.perUser.save();
	await f.instance.applyDeletionInTransaction(f.manager, [note], 'one.test', new Date());
	await f.perUser.applyDeletionInTransaction(f.manager, [note], 'one.test', new Date());

	for (const rows of f.rows.values()) for (const row of rows) {
		expect(row.___total ?? row.___notes_total).toBe(row.group === 'one.test' ? 10 : 22);
		expect(row.___dec ?? row.___notes_dec).toBe(row.group === 'one.test' ? 1 : 0);
		expect(row.date).toBe(Date.parse('2026-11-14T00:00:00Z') / 1000);
	}
});

test('선택 밖 grouped 차트의 인자 없는 minor와 major 계약을 보존한다', async () => {
	const f = fixture();
	const calls: (string | null)[] = [];
	class BufferedGroupedChart extends Chart<{ total: { accumulate: true } }> {
		protected async tickMajor(group: string | null) { calls.push(group); return {}; }
		protected async tickMinor(group: string | null) { calls.push(group); return {}; }
	}
	const chart = new BufferedGroupedChart(f.db, async () => () => {}, f.logger.logger, 'bufferedGrouped', { total: { accumulate: true } }, true);

	await chart.tick(false);
	await chart.resync();

	expect(calls).toEqual([null, null]);
	expect(f.events).toEqual([]);
});

test.each(['snapshot', 'partial'] as const)('차트 진입점은 %s poison을 보존하고 정상 hour/day 증감을 확정한다', async kind => {
	const f = fixture();
	const poison = f.addReceipt('poison');
	const healthy = f.addReceipt('healthy');
	if (kind === 'snapshot') delete f.receipts[0].snapshot.charts;
	else f.receipts[0].effects.notesChart = { completedAt: '2020-01-01Z' };
	const before = structuredClone(f.receipts[0]);
	f.state.count = 9;

	await expect(f.stage.applyBatch([poison, healthy])).rejects.toMatchObject({ items: [poison] });

	expect(f.receipts[0]).toEqual(before);
	expect(f.receipts[1].effects.charts).toBeDefined();
	for (const rows of f.rows.values()) for (const row of rows) {
		expect(row.___local_total ?? row.___total).toBe(9);
		expect(row.___local_dec ?? row.___dec).toBe(1);
	}
	expect(f.state.counts).toBe(2);
});

test.each([
	[false, false, false], [true, false, false], [false, true, false], [true, true, true], [false, false, true],
])('최소 분류로 원본과 같은 normal/reply/renote/withFile 차트를 기록한다: %s %s %s', async (hasReply, hasRenote, hasFile) => {
	const f = fixture();
	const classification = { userHost: 'remote.test', hasReply, hasRenote, hasFile };
	const bucketAt = new Date();
	await f.instance.applyDeletionInTransaction(f.manager, [classification], 'remote.test', bucketAt);
	await f.chart.applyDeletionInTransaction(f.manager, [classification], null, bucketAt);
	await f.perUser.applyDeletionInTransaction(f.manager, [classification], 'alice', bucketAt);

	for (const rows of f.rows.values()) for (const row of rows) {
		expect(row.___notes_diffs_normal ?? row.___remote_diffs_normal ?? row.___diffs_normal).toBe(!hasReply && !hasRenote ? -1 : 0);
		expect(row.___notes_diffs_reply ?? row.___remote_diffs_reply ?? row.___diffs_reply).toBe(hasReply ? -1 : 0);
		expect(row.___notes_diffs_renote ?? row.___remote_diffs_renote ?? row.___diffs_renote).toBe(hasRenote ? -1 : 0);
		expect(row.___notes_diffs_withFile ?? row.___remote_diffs_withFile ?? row.___diffs_withFile).toBe(hasFile ? -1 : 0);
	}
});
