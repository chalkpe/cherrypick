/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NoteCleanupCondition as Condition } from 'cherrypick-js/entities.js';

const ids = new WeakMap<object, string>();
let sequence = 0;
export function conditionId(node: Condition): string {
	let id = ids.get(node);
	if (!id) { id = `cleanup-condition-${++sequence}`; ids.set(node, id); }
	return id;
}

function cloneWithIds<T>(value: T): T {
	const clone = structuredClone(value);

	function transfer(source: unknown, target: unknown) {
		if (!source || !target || typeof source !== 'object' || typeof target !== 'object') return;
		const id = ids.get(source);
		if (id) ids.set(target, id);
		for (const key of Object.keys(source)) transfer((source as Record<string, unknown>)[key], (target as Record<string, unknown>)[key]);
	}

	transfer(value, clone);
	return clone;
}

function inheritId(source: Condition, target: Condition): Condition {
	ids.set(target, conditionId(source));
	return target;
}

export function createCondition(type: Condition['type']): Condition {
	switch (type) {
		case 'all': case 'any': return { type, children: [createCondition('keyword')] };
		case 'not': return { type, child: createCondition('keyword') };
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
	return node.type === 'all' || node.type === 'any' ? node.children : node.type === 'not' ? [node.child] : [];
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
	if (root.type === 'all' || root.type === 'any') {
		if (!root.children[index]) throw new Error('INVALID_PATH');
		return inheritId(root, { ...root, children: root.children.map((child, i) => i === index ? replaceCondition(child, rest, value) : child) });
	}
	if (root.type === 'not' && index === 0) return inheritId(root, { ...root, child: replaceCondition(root.child, rest, value) });
	throw new Error('INVALID_PATH');
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

export function incompletePaths(root: Condition, path: number[] = []): number[][] {
	let invalid = false;
	switch (root.type) {
		case 'all': case 'any': invalid = root.children.length === 0 || root.children.length > 32; break;
		case 'keyword': invalid = !root.value.length || root.value.length > 512 || root.targets.length === 0; break;
		case 'age': invalid = !Number.isFinite(root.seconds) || root.seconds < 0 || root.seconds > Number.MAX_SAFE_INTEGER; break;
		case 'count': invalid = !Number.isSafeInteger(root.value) || root.value < 0; break;
		case 'visibility': invalid = root.values.length === 0; break;
		case 'channel': case 'clip': invalid = root.ids !== null && (root.ids.length === 0 || root.ids.length > 32); break;
		case 'hashtag': invalid = !root.value.replace(/^#/, '').trim().length || root.value.length > 128; break;
	}
	return [...(invalid ? [path] : []), ...childrenOf(root).flatMap((child, i) => incompletePaths(child, [...path, i]))];
}

export function createHistory<T>(initial: T) {
	const entries = [cloneWithIds(initial)];
	let index = 0;
	let lastKey: string | undefined;
	let lastTime = 0;
	return {
		get current() { return cloneWithIds(entries[index]); },
		get canUndo() { return index > 0; },
		get canRedo() { return index < entries.length - 1; },
		push(value: T, key?: string) {
			if (JSON.stringify(value) === JSON.stringify(entries[index])) return;
			entries.splice(index + 1);
			if (key && lastKey === key && Date.now() - lastTime < 800 && index > 0) entries[index] = cloneWithIds(value);
			else { entries.push(cloneWithIds(value)); index++; }
			lastKey = key;
			lastTime = Date.now();
		},
		undo() { if (index > 0) index--; lastKey = undefined; return this.current; },
		redo() { if (index < entries.length - 1) index++; lastKey = undefined; return this.current; },
	};
}

export function serverConditionPath(path: string): number[] {
	const result: number[] = [];
	for (const part of path.split('.')) {
		if (part === 'child') result.push(0);
		else if (/^\d+$/.test(part)) result.push(Number(part));
	}
	return result;
}
