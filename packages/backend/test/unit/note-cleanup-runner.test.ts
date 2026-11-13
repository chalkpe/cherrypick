/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { runCleanupBatch } from '../../src/core/NoteCleanupRunner.js';

test('보존 구간 뒤로 커서를 전진하고 삭제 예산 다음 노트를 건너뛰지 않는다', async () => {
	const deleted: string[] = [];
	const result = await runCleanupBatch([{ id: '1', decision: 'keep' }, { id: '2', decision: 'delete' }, { id: '3', decision: 'delete' }], 1, async id => { deleted.push(id); });
	expect(deleted).toEqual(['2']);
	expect(result).toEqual({ cursor: '2', deleted: 1, examined: 2 });
});

test('삭제 실패는 성공 개수나 다음 커서로 위장하지 않는다', async () => {
	await expect(runCleanupBatch([{ id: '1', decision: 'delete' }], 5, async () => { throw new Error('DB unavailable'); })).rejects.toThrow('DB unavailable');
});

test('기존 비활성 계정은 즐겨찾기 설정만 보존하며 신규 기본 보호를 추가하지 않는다', async () => {
	const { initialCleanupRules } = await import('../../src/core/NoteCleanupRunner.js');
	for (const favorite of [true, false]) {
		const rules = initialCleanupRules(true, null, favorite);
		expect(rules.some(r => r.condition.type === 'clip')).toBe(false);
		expect(rules.filter(r => r.action === 'delete').every(r => !r.enabled && !r.automatic)).toBe(true);
		expect(rules.find(r => r.legacy === 'favorite')?.enabled).toBe(favorite);
	}
	expect(initialCleanupRules(false, null, false).filter(r => r.enabled && r.action === 'keep')).toHaveLength(4);
});

test('이미 없는 노트는 삭제 성공 통계를 늘리지 않는다', async () => {
	const result = await runCleanupBatch([{ id: '1', decision: 'delete' }, { id: '2', decision: 'delete' }], 1, async id => id !== '1');
	expect(result).toEqual({ cursor: '2', deleted: 1, examined: 2 });
});

test('기간이 없는 기존 설정에는 임의 기간 규칙을 표시하지 않는다', async () => {
 const { initialCleanupRules } = await import('../../src/core/NoteCleanupRunner.js');
 for (const favorite of [true, false]) {
  const rules = initialCleanupRules(true, null, favorite);
  expect(rules.map(rule => rule.legacy)).toEqual(['favorite']);
  expect(rules[0].enabled).toBe(favorite);
 }
 expect(initialCleanupRules(true, 30, false).find(rule => rule.legacy === 'age')?.condition).toEqual({ type: 'age', operator: 'gt', seconds: 2592000 });
});

test('이관할 기간이 0·음수·null이면 이전 처리기처럼 지우기 규칙을 만들지 않고 즐겨찾기 설정만 옮긴다', async () => {
	const { initialCleanupRules } = await import('../../src/core/NoteCleanupRunner.js');
	for (const days of [0, -1, -3650, null]) {
		for (const favorite of [true, false]) {
			const rules = initialCleanupRules(true, days, favorite);
			expect(rules.filter(rule => rule.action === 'delete')).toEqual([]);
			expect(rules).toEqual([{ name: '내가 즐겨찾기한 내 글', defaultName: 'favorite', action: 'keep', enabled: favorite, automatic: false, legacy: 'favorite', condition: { type: 'flag', field: 'favorite', value: true } }]);
		}
	}
});

test('유효한 양수 기간과 즐겨찾기 설정은 새 기본 보호 없이 그대로 이관한다', async () => {
	const { initialCleanupRules } = await import('../../src/core/NoteCleanupRunner.js');
	for (const [days, favorite] of [[1, true], [30, false], [3650, true], [24856, false], [2147483647, true]] as const) {
		const rules = initialCleanupRules(true, days, favorite);
		expect(rules).toEqual([
			{ name: '기간이 지난 내 글', defaultName: 'age', action: 'delete', enabled: true, automatic: true, legacy: 'age', condition: { type: 'age', operator: 'gt', seconds: days * 86400 } },
			{ name: '내가 즐겨찾기한 내 글', defaultName: 'favorite', action: 'keep', enabled: favorite, automatic: false, legacy: 'favorite', condition: { type: 'flag', field: 'favorite', value: true } },
		]);
		expect(Number.isSafeInteger(rules[0].condition.type === 'age' ? rules[0].condition.seconds : NaN)).toBe(true);
	}
});

test('신규 계정 기본값은 고정·내 즐겨찾기·내 클립·자기 리액션 보호 4개이고 즐겨찾기 보호만 구 설정과 연결한다', async () => {
	const { initialCleanupRules } = await import('../../src/core/NoteCleanupRunner.js');
	// 신규 계정 기본값은 구 설정 값에 따라 달라지지 않는다.
	for (const [days, favorite] of [[null, true], [null, false], [30, false], [0, true]] as const) {
		expect(initialCleanupRules(false, days, favorite)).toEqual([
			{ name: '고정한 내 글', defaultName: 'pinned', action: 'keep', enabled: true, automatic: false, legacy: null, condition: { type: 'flag', field: 'pinned', value: true } },
			{ name: '내가 즐겨찾기한 내 글', defaultName: 'favorite', action: 'keep', enabled: true, automatic: false, legacy: 'favorite', condition: { type: 'flag', field: 'favorite', value: true } },
			{ name: '내 클립에 담은 내 글', defaultName: 'clip', action: 'keep', enabled: true, automatic: false, legacy: null, condition: { type: 'clip', ids: null } },
			{ name: '내가 리액션한 내 글', defaultName: 'selfReaction', action: 'keep', enabled: true, automatic: false, legacy: null, condition: { type: 'flag', field: 'selfReaction', value: true } },
		]);
	}
});

 test('제품 생성 이름은 신규·이관·구 API에서 문자열 대신 명시한 키로 구분한다', async () => {
 const { initialCleanupRules } = await import('../../src/core/NoteCleanupRunner.js');
 expect(initialCleanupRules(false, null, true).map(r => r.defaultName)).toEqual(['pinned', 'favorite', 'clip', 'selfReaction']);
 expect(initialCleanupRules(true, 30, true).map(r => r.defaultName)).toEqual(['age', 'favorite']);
 });

test('미배포 이관은 생성 시점에 기본 이름 출처를 기록한다', async () => {
 const { NoteCleanupRules1794504882218 } = await import('../../migration/1794504882218-NoteCleanupRules.js');
 const tables: any[] = []; const sql: string[] = [];
 await new NoteCleanupRules1794504882218().up({ createTable: async (table: any) => { tables.push(table); }, createIndex: async () => {}, createForeignKey: async () => {}, query: async (query: string) => { sql.push(query); } });
 expect(tables[0].columns.some((c: any) => c.name === 'defaultName' && c.isNullable)).toBe(true);
 expect(sql.filter(q => q.includes('INSERT INTO note_cleanup_rule')).every(q => q.includes('"defaultName"'))).toBe(true);
});
