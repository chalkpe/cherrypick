/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { reactive, toRaw } from 'vue';
import { describe, expect, test } from 'vitest';
import type { NoteCleanupCondition as Condition } from 'cherrypick-js/entities.js';
import { cloneCondition, conditionAt, conditionId, convertAgeSeconds, createCondition, moveCondition, replaceCondition } from './note-cleanup-editor.js';

type Group = Extract<Condition, { type: 'all' | 'any' }>;
type Keyword = Extract<Condition, { type: 'keyword' }>;
const keyword = (value: string): Keyword => ({ type: 'keyword', mode: 'literal', value, flags: '', targets: ['text'] });

// 화면은 반응형 프록시로 조건을 읽으므로, 값 편집 뒤에도 같은 프록시 경로의 정체성이 유지되어야 한다.
describe('condition identity through reactive proxies', () => {
	test('value edits keep the identity of the leaf and every ancestor', () => {
		const root = reactive<Group>({ type: 'all', children: [{ type: 'any', children: [createCondition('keyword')] }, createCondition('age')] });
		const rootId = conditionId(root);
		const groupId = conditionId(root.children[0]);
		const leafId = conditionId(conditionAt(root, [0, 0]));
		const siblingId = conditionId(root.children[1]);
		const edited = replaceCondition(root, [0, 0], { ...(toRaw(conditionAt(root, [0, 0])) as Keyword), value: '고양이' });
		const view = reactive(edited);
		expect(conditionId(view)).toBe(rootId);
		expect(conditionId(conditionAt(view, [0]))).toBe(groupId);
		expect(conditionId(conditionAt(view, [0, 0]))).toBe(leafId);
		expect(conditionId(conditionAt(view, [1]))).toBe(siblingId);
		expect(conditionId(conditionAt(edited, [0, 0]))).toBe(leafId);
		expect((conditionAt(view, [0, 0]) as Keyword).value).toBe('고양이');
	});

	test('repeated edits through fresh proxies keep the same identity', () => {
		const root = reactive<Group>({ type: 'all', children: [keyword('')] });
		const leafId = conditionId(root.children[0]);
		let view: Condition = root;
		for (const value of ['첫째', '둘째', '셋째']) {
			const edited = replaceCondition(view, [0], { ...(toRaw(conditionAt(view, [0])) as Keyword), value });
			view = reactive(edited);
			expect(conditionId(conditionAt(view, [0]))).toBe(leafId);
		}
		expect((conditionAt(view, [0]) as Keyword).value).toBe('셋째');
	});

	test('top-level replacement keeps the root identity', () => {
		const root = reactive(createCondition('age'));
		const rootId = conditionId(root);
		const edited = replaceCondition(root, [], { type: 'age', operator: 'gt', seconds: 60 });
		expect(conditionId(reactive(edited))).toBe(rootId);
	});

	test('moving a condition across groups keeps its identity', () => {
		const root = reactive<Group>({ type: 'all', children: [{ type: 'any', children: [createCondition('hashtag')] }, { type: 'all', children: [createCondition('keyword')] }] });
		const movedId = conditionId(conditionAt(root, [0, 0]));
		const targetId = conditionId(root.children[1]);
		const moved = moveCondition(root, [0, 0], [1]);
		const view = reactive(moved);
		expect(conditionId(conditionAt(view, [1]))).toBe(targetId);
		expect(conditionId(conditionAt(view, [1, 1]))).toBe(movedId);
	});

	test('duplicates get a fresh identity and ids never reach the serialized form', () => {
		const node = reactive(keyword(''));
		const id = conditionId(node);
		const copy = cloneCondition(node);
		expect(conditionId(copy)).not.toBe(id);
		expect(JSON.stringify(node)).not.toContain('cleanup-condition');
		const replaced = replaceCondition(node, [], { ...toRaw(node), value: '복사' });
		expect(JSON.stringify(replaced)).not.toContain('cleanup-condition');
	});
});

describe('convertAgeSeconds', () => {
	test('keeps the displayed quantity when units divide evenly', () => {
		expect(convertAgeSeconds(30 * 86400, 86400, 3600)).toBe(30 * 3600);
		expect(convertAgeSeconds(30 * 3600, 3600, 86400)).toBe(30 * 86400);
		expect(convertAgeSeconds(90, 60, 3600)).toBe(5400);
		expect(convertAgeSeconds(0.5, 1, 60)).toBe(30);
		expect(convertAgeSeconds(420, 60, 86400)).toBe(7 * 86400);
	});
	test('handles zero, unchanged units and non-finite values', () => {
		expect(convertAgeSeconds(0, 86400, 1)).toBe(0);
		expect(convertAgeSeconds(123, 60, 60)).toBe(123);
		expect(convertAgeSeconds(NaN, 86400, 3600)).toBeNaN();
		expect(convertAgeSeconds(Infinity, 1, 60)).toBe(Infinity);
	});
	test('reduces the ratio before converting indivisible values', () => {
		expect(convertAgeSeconds(1, 86400, 3600)).toBeCloseTo(1 / 24, 12);
		expect(convertAgeSeconds(1, 3600, 86400)).toBe(24);
		expect(convertAgeSeconds(Number.MAX_SAFE_INTEGER, 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
	});
});
