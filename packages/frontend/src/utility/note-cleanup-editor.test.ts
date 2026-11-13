/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NoteCleanupCondition as Condition } from 'cherrypick-js/entities.js';
import { describe, expect, test } from 'vitest';
import { labelSelect } from '../pages/settings/note-cleanup/select-label.js';
import { createCondition, createHistory, replaceCondition, moveCondition, conditionAt, conditionId, incompletePaths, serverConditionPath, assertSize } from './note-cleanup-editor.js';

describe('note cleanup editing', () => {
	test('keeps slashes literal and defaults to text, CW and poll', () => {
		expect(createCondition('keyword')).toEqual({ type: 'keyword', mode: 'literal', value: '', flags: '', targets: ['text', 'cw', 'poll'] });
	});
	test('undo restores descendants after replacing their group and redo reapplies it', () => {
		const original = { type: 'all' as const, children: [{ type: 'hashtag' as const, value: '기록' }] };
		const history = createHistory<Condition>(original);
		history.push(replaceCondition(history.current, [], createCondition('age')));
		expect(history.current.type).toBe('age');
		expect(history.undo()).toEqual(original);
		expect(history.redo().type).toBe('age');
		history.undo();
		history.push(createCondition('keyword'));
		expect(history.canRedo).toBe(false);
	});
	test('moves a nested condition to another parent without changing values', () => {
		const root = { type: 'all' as const, children: [{ type: 'any' as const, children: [{ type: 'hashtag' as const, value: '/literal.*/' }] }, { type: 'all' as const, children: [{ type: 'flag' as const, field: 'selfReaction' as const, value: true }] }] };
		const moved = moveCondition(root, [0, 0], [1]);
		expect(conditionAt(moved, [1, 1])).toEqual({ type: 'hashtag', value: '/literal.*/' });
		expect(conditionAt(root, [0, 0]).type).toBe('hashtag');
		expect(() => moveCondition(root, [0], [0, 0])).toThrow();
	});
});

test('keeps UI identities through edits and undo without serializing them', () => {
	const node = createCondition('keyword');
	const originalId = conditionId(node);
	const history = createHistory(node);
	history.push(replaceCondition(history.current, [], { type: 'keyword', mode: 'literal', value: '문자 그대로', flags: '', targets: ['text', 'cw', 'poll'] }));
	expect(conditionId(history.current)).toBe(originalId);
	expect(conditionId(history.undo())).toBe(originalId);
	expect(conditionId(structuredClone(node))).not.toBe(originalId);
	expect(JSON.stringify(node)).not.toContain(originalId);
});

test('preserves fractional ages accepted by the server and rejects incomplete drafts', () => {
	expect(incompletePaths({ type: 'age', seconds: 0.5, operator: 'gt' })).toEqual([]);
	expect(incompletePaths({ type: 'clip', ids: null })).toEqual([]);
	expect(incompletePaths({ type: 'any', children: [] })).toEqual([[]]);
	expect(incompletePaths({ type: 'keyword', value: 'text', mode: 'literal', flags: '', targets: [] })).toEqual([[]]);
});
test('maps server child paths through inversion without losing the child index', () => {
	expect(serverConditionPath('condition.children.2.child.children.1.value')).toEqual([2, 0, 1]);
});
test('accepts the server depth boundary and refuses one extra nesting level', () => {
	let node = createCondition('keyword');
	for (let i = 0; i < 8; i++) node = { type: 'not', child: node };
	expect(() => assertSize(node)).not.toThrow();
	expect(() => assertSize({ type: 'not', child: node })).toThrow();
});

test('names the actual keyboard selection trigger instead of its surrounding div', () => {
	const root = window.document.createElement('div');
	root.innerHTML = '<div tabindex="0"><div tabindex="-1"></div></div>';
	labelSelect(root, '키워드 검색 방식');
	expect(root.querySelector('[tabindex="0"]')?.getAttribute('aria-label')).toBe('키워드 검색 방식');
	expect(root.querySelector('[tabindex="0"]')?.getAttribute('role')).toBe('button');
	expect(root.querySelector('[tabindex="0"]')?.getAttribute('aria-haspopup')).toBe('menu');
});

test('blocks oversized groups and empty normalized hashtags before saving', () => {
 expect(incompletePaths({ type: 'all', children: Array.from({ length: 33 }, () => ({ type: 'flag', field: 'pinned', value: true })) })).toEqual([[]]);
 expect(incompletePaths({ type: 'hashtag', value: '#  ' })).toEqual([[]]);
});
