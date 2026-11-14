/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NoteCleanupCondition as Condition } from 'cherrypick-js/entities.js';
import { describe, expect, test } from 'vitest';
import { labelSelect } from '../pages/settings/note-cleanup/select-label.js';
import { assertSize, conditionAt, conditionId, createCondition, groupPaths, incompletePaths, keywordLines, moveCondition, removeCondition, replaceCondition, serverConditionPath } from './note-cleanup-editor.js';

describe('note cleanup editing', () => {
	test('keeps slashes literal and defaults to text, CW and poll', () => {
		expect(createCondition('keyword')).toEqual({ type: 'keyword', mode: 'literal', value: '', flags: '', targets: ['text', 'cw', 'poll'] });
	});
	test('groups start with one keyword child and leaves have no children', () => {
		expect(createCondition('all')).toEqual({ type: 'all', children: [createCondition('keyword')] });
		expect(createCondition('any').type).toBe('any');
		expect(createCondition('flag')).toEqual({ type: 'flag', field: 'pinned', value: true });
	});
	test('moves a nested condition to another parent without changing values', () => {
		const root = { type: 'all' as const, children: [{ type: 'any' as const, children: [{ type: 'hashtag' as const, value: '/literal.*/' }] }, { type: 'all' as const, children: [{ type: 'flag' as const, field: 'selfReaction' as const, value: true }] }] };
		const moved = moveCondition(root, [0, 0], [1]);
		expect(conditionAt(moved, [1, 1])).toEqual({ type: 'hashtag', value: '/literal.*/' });
		expect(conditionAt(root, [0, 0]).type).toBe('hashtag');
		expect(() => moveCondition(root, [0], [0, 0])).toThrow();
	});
	test('removal keeps the remaining siblings in order', () => {
		const root = { type: 'any' as const, children: [{ type: 'hashtag' as const, value: 'a' }, { type: 'hashtag' as const, value: 'b' }, { type: 'hashtag' as const, value: 'c' }] };
		const removed = removeCondition(root, [1]);
		expect(removed.type === 'any' && removed.children.map(child => (child as { value: string }).value)).toEqual(['a', 'c']);
		expect(() => removeCondition(root, [])).toThrow();
	});
	test('lists every group path including the root', () => {
		const root = { type: 'all' as const, children: [{ type: 'any' as const, children: [{ type: 'hashtag' as const, value: '태그' }] }, { type: 'flag' as const, field: 'pinned' as const, value: true }] };
		expect(groupPaths(root)).toEqual([[], [0]]);
	});
});

test('keeps UI identities through edits without serializing them', () => {
	const node = createCondition('keyword');
	const originalId = conditionId(node);
	const replaced = replaceCondition(node, [], { type: 'keyword', mode: 'literal', value: '문자 그대로', flags: '', targets: ['text', 'cw', 'poll'] });
	expect(conditionId(replaced)).toBe(originalId);
	expect(conditionId(structuredClone(node))).not.toBe(originalId);
	expect(JSON.stringify(node)).not.toContain(originalId);
});

test('preserves fractional ages accepted by the server and rejects incomplete drafts', () => {
	expect(incompletePaths({ type: 'age', seconds: 0.5, operator: 'gt' })).toEqual([]);
	expect(incompletePaths({ type: 'clip', ids: null })).toEqual([]);
	expect(incompletePaths({ type: 'any', children: [] })).toEqual([[]]);
	expect(incompletePaths({ type: 'keyword', value: 'text', mode: 'literal', flags: '', targets: [] })).toEqual([[]]);
});

test('keyword drafts follow the per-line limits and ignore blank lines', () => {
	expect(keywordLines('고양이\n\n강아지\n')).toEqual(['고양이', '강아지']);
	const keyword = (value: string) => ({ type: 'keyword' as const, mode: 'literal' as const, value, flags: '', targets: ['text' as const] });
	expect(incompletePaths(keyword('한 줄\n두 줄'))).toEqual([]);
	expect(incompletePaths(keyword('\n\n'))).toEqual([[]]);
	expect(incompletePaths(keyword(Array.from({ length: 32 }, (_, i) => `줄${i}`).join('\n')))).toEqual([]);
	expect(incompletePaths(keyword(Array.from({ length: 33 }, (_, i) => `줄${i}`).join('\n')))).toEqual([[]]);
	expect(incompletePaths(keyword('a'.repeat(128)))).toEqual([]);
	expect(incompletePaths(keyword('a'.repeat(129)))).toEqual([[]]);
	expect(incompletePaths(keyword(`ok\n${'a'.repeat(129)}`))).toEqual([[]]);
});

test('maps server paths to child indexes only', () => {
	expect(serverConditionPath('condition.children.2.children.1.value')).toEqual([2, 1]);
	expect(serverConditionPath('condition')).toEqual([]);
	expect(serverConditionPath('ruleIds')).toEqual([]);
});

test('accepts the server depth boundary and refuses one extra nesting level', () => {
	let node: Condition = createCondition('keyword');
	for (let i = 0; i < 8; i++) node = { type: 'all', children: [node] };
	expect(() => assertSize(node)).not.toThrow();
	expect(() => assertSize({ type: 'all', children: [node] })).toThrow();
});

test('names the actual keyboard selection trigger instead of its surrounding div', () => {
	const root = window.document.createElement('div');
	root.innerHTML = '<div tabindex="0"><div tabindex="-1"></div></div>';
	labelSelect(root, '키워드 검색 범위');
	expect(root.querySelector('[tabindex="0"]')?.getAttribute('aria-label')).toBe('키워드 검색 범위');
	expect(root.querySelector('[tabindex="0"]')?.getAttribute('role')).toBe('button');
	expect(root.querySelector('[tabindex="0"]')?.getAttribute('aria-haspopup')).toBe('menu');
});

test('blocks oversized groups and empty normalized hashtags before saving', () => {
	expect(incompletePaths({ type: 'all', children: Array.from({ length: 33 }, () => ({ type: 'flag', field: 'pinned', value: true })) })).toEqual([[]]);
	expect(incompletePaths({ type: 'hashtag', value: '#  ' })).toEqual([[]]);
	expect(incompletePaths({ type: 'hashtag', value: '##tag' })).toEqual([[]]);
	expect(incompletePaths({ type: 'hashtag', value: '#tag' })).toEqual([]);
});
