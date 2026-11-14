/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { toRaw } from 'vue';
import type { NoteCleanupCondition as Condition } from 'cherrypick-js/entities.js';

const ids = new WeakMap<object, string>();
let sequence = 0;
export function conditionId(node: Condition): string {
	// 화면은 반응형 프록시로 조건을 읽으므로 원본 객체를 기준으로 정체성을 기억한다.
	const raw = toRaw(node);
	let id = ids.get(raw);
	if (!id) { id = `cleanup-condition-${++sequence}`; ids.set(raw, id); }
	return id;
}

// 반응형 프록시는 structuredClone으로 복제할 수 없으므로 원본 객체로 풀어 재귀 복제한다.
function rawClone<T>(value: T, keepIds: boolean): T {
	function clone(source: unknown): unknown {
		const raw = toRaw(source);
		if (!raw || typeof raw !== 'object') return raw;
		if (Array.isArray(raw)) return raw.map(item => clone(item));
		const target: Record<string, unknown> = {};
		if (keepIds) {
			const id = ids.get(raw);
			if (id) ids.set(target, id);
		}
		for (const key of Object.keys(raw)) target[key] = clone((raw as Record<string, unknown>)[key]);
		return target;
	}

	return clone(value) as T;
}

function cloneWithIds<T>(value: T): T {
	return rawClone(value, true);
}

export function cloneCondition(node: Condition): Condition {
	return rawClone(node, false);
}

function inheritId(source: Condition, target: Condition): Condition {
	ids.set(toRaw(target), conditionId(source));
	return target;
}

export function createCondition(type: Condition['type']): Condition {
	switch (type) {
		case 'all': case 'any': return { type, children: [createCondition('keyword')] };
		case 'keyword': return { type, mode: 'literal', value: '', flags: '', targets: ['text', 'cw', 'poll'] };
		case 'age': return { type, operator: 'gte', seconds: 30 * 86400 };
		case 'count': return { type, field: 'reactions', operator: 'gte', value: 0 };
		case 'flag': return { type, field: 'pinned', value: true };
		case 'visibility': return { type, values: ['public'] };
		case 'clip': return { type, ids: null };
		case 'channel': return { type, ids: [] };
		case 'hashtag': return { type, value: '' };
	}
}

export function childrenOf(node: Condition): Condition[] {
	return node.type === 'all' || node.type === 'any' ? node.children : [];
}

export function conditionAt(root: Condition, path: number[]): Condition {
	let node = root;
	for (const index of path) {
		const child = childrenOf(node)[index];
		if (!child) throw new Error('INVALID_PATH');
		node = child;
	}
	return node;
}

export function replaceCondition(root: Condition, path: number[], value: Condition): Condition {
	if (path.length === 0) return inheritId(root, cloneWithIds(value));
	const [index, ...rest] = path;
	if (root.type !== 'all' && root.type !== 'any') throw new Error('INVALID_PATH');
	if (!root.children[index]) throw new Error('INVALID_PATH');
	return inheritId(root, { ...root, children: root.children.map((child, i) => i === index ? replaceCondition(child, rest, value) : child) });
}

export function removeCondition(root: Condition, path: number[]): Condition {
	if (!path.length) throw new Error('ROOT_REQUIRED');
	const parentPath = path.slice(0, -1);
	const parent = conditionAt(root, parentPath);
	if (parent.type !== 'all' && parent.type !== 'any') throw new Error('GROUP_REQUIRED');
	return replaceCondition(root, parentPath, { ...parent, children: parent.children.filter((_, index) => index !== path.at(-1)) });
}

export function moveCondition(root: Condition, from: number[], to: number[]): Condition {
	if (!from.length || from.every((v, i) => to[i] === v)) throw new Error('INVALID_MOVE');
	const node = conditionAt(root, from);
	const parent = conditionAt(root, to);
	if (parent.type !== 'all' && parent.type !== 'any') throw new Error('GROUP_REQUIRED');
	// 먼저 대상에 붙여도 원본 경로가 바뀌지 않으므로 같은 트리 안의 이동을 안전하게 처리한다.
	const appended = replaceCondition(root, to, { ...parent, children: [...parent.children, node] });
	const result = removeCondition(appended, from);
	assertSize(result);
	return result;
}

export function groupPaths(root: Condition, path: number[] = []): number[][] {
	return [
		...(root.type === 'all' || root.type === 'any' ? [path] : []),
		...childrenOf(root).flatMap((child, i) => groupPaths(child, [...path, i])),
	];
}

export function assertSize(root: Condition): void {
	let count = 0;

	function visit(node: Condition, depth: number) {
		if (++count > 128 || depth > 8) throw new Error('CONDITION_LIMIT');
		childrenOf(node).forEach(child => visit(child, depth + 1));
	}

	visit(root, 0);
}

// 키워드 입력은 줄마다 하나씩이며 빈 줄은 제외한다. 서버 검증과 같은 기준이다.
export function keywordLines(value: string): string[] {
	return value.split('\n').filter(line => line.length > 0);
}

// 단위 변경 뒤에도 표시 수량이 유지되도록 초 값을 새 단위로 변환한다. 나누어떨어지지 않으면 비율을 약분해 계산한다.
export function convertAgeSeconds(seconds: number, from: number, to: number): number {
	if (from === to || !Number.isFinite(seconds)) return seconds;
	let a = from;
	let b = to;
	while (b !== 0) [a, b] = [b, a % b];
	const div = from / a;
	const mul = to / a;
	return seconds % div === 0 ? (seconds / div) * mul : (seconds * mul) / div;
}

export function incompletePaths(root: Condition, path: number[] = []): number[][] {
	let invalid = false;
	switch (root.type) {
		case 'all': case 'any': invalid = root.children.length === 0 || root.children.length > 32; break;
		case 'keyword': {
			const lines = keywordLines(root.value);
			invalid = !lines.length || lines.length > 32 || lines.some(line => line.length > 128) || root.targets.length === 0 || root.targets.length > 32;
			break;
		}
		case 'age': invalid = !Number.isFinite(root.seconds) || root.seconds < 0 || root.seconds > Number.MAX_SAFE_INTEGER; break;
		case 'count': invalid = !Number.isSafeInteger(root.value) || root.value < 0 || root.value > Number.MAX_SAFE_INTEGER; break;
		case 'visibility': invalid = root.values.length === 0 || root.values.length > 32; break;
		case 'channel': case 'clip': invalid = root.ids !== null && (root.ids.length === 0 || root.ids.length > 32); break;
		case 'hashtag': invalid = !root.value.replace(/^#/, '').trim().length || root.value.replace(/^#/, '').startsWith('#') || root.value.length > 128; break;
	}
	return [...(invalid ? [path] : []), ...childrenOf(root).flatMap((child, i) => incompletePaths(child, [...path, i]))];
}

export function serverConditionPath(path: string): number[] {
	const result: number[] = [];
	for (const part of path.split('.')) {
		if (/^\d+$/.test(part)) result.push(Number(part));
	}
	return result;
}
