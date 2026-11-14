/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import RE2 from 're2';

import type { entities } from 'cherrypick-js';

export type CleanupOperator = entities.NoteCleanupOperator;
export type CleanupTarget = entities.NoteCleanupTarget;
export type CleanupFlag = entities.NoteCleanupFlag;
export type CleanupCondition = entities.NoteCleanupCondition;
export type CleanupContext = {
	text: string | null; cw: string | null; poll: string[]; fileComment: string[]; fileName: string[];
	age: number; reactions: number; renotes: number; flags: Partial<Record<CleanupFlag, boolean>>;
	visibility: string; channelId: string | null; clipIds: string[]; tags: string[]; errors?: Record<string, string>;
};
export type CleanupEvaluationRule = { id: string; action: 'keep' | 'delete'; condition: unknown; error?: string };
export type CleanupError = { ruleId: string; action: 'keep' | 'delete'; message: string };
const flags = ['pinned', 'favorite', 'selfReaction', 'selfRenote', 'reply', 'quote', 'poll', 'files', 'cw', 'localOnly'];
const targets = ['text', 'cw', 'poll', 'fileComment', 'fileName'];
const normalize = (s: string) => s.normalize('NFC').toLowerCase();

export class CleanupConditionError extends Error {
	constructor(public path: string) { super('Invalid cleanup condition'); }
}

export function validateCleanupCondition(input: unknown): asserts input is CleanupCondition {
	let nodes = 0;
	let currentPath = 'condition';
	const fail = (): never => { throw new CleanupConditionError(currentPath); };
	const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 32 && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 128);
	const visit = (value: unknown, depth: number, path: string): void => {
		currentPath = path;
		if (++nodes > 128 || depth > 8 || !value || typeof value !== 'object' || Array.isArray(value)) fail();
		const c = value as Record<string, unknown>;
		const keys: Record<string, string[]> = { all: ['children'], any: ['children'], not: ['child'], keyword: ['mode', 'value', 'flags', 'targets'], age: ['operator', 'seconds'], count: ['field', 'operator', 'value'], flag: ['field', 'value'], visibility: ['values'], channel: ['ids'], clip: ['ids'], hashtag: ['value'] };
		if (!keys[c.type as string] || Object.keys(c).some(k => k !== 'type' && !keys[c.type as string].includes(k))) fail();
		switch (c.type) {
			case 'all': case 'any':
				if (!Array.isArray(c.children) || c.children.length === 0 || c.children.length > 32) fail();
				(c.children as unknown[]).forEach((child, index) => visit(child, depth + 1, `${path}.children.${index}`));
				break;
			case 'not': visit(c.child, depth + 1, `${path}.child`); break;
			case 'keyword':
				if (typeof c.value !== 'string' || !c.value.length || c.value.length > 512 || !strings(c.targets) || !c.targets.every(t => targets.includes(t)) || typeof c.flags !== 'string') fail();
				if (c.mode === 'regex') { try { new RE2(c.value as string, c.flags as string); } catch { fail(); } } else if (c.mode !== 'literal' || c.flags !== '') fail();
				break;
			case 'age': case 'count': {
				const n = c.type === 'age' ? c.seconds : c.value;
				if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER || !['gt', 'gte', 'lt', 'lte'].includes(c.operator as string)) fail();
				if (c.type === 'count' && (!Number.isInteger(n) || !['reactions', 'renotes'].includes(c.field as string))) fail();
				break;
			}
			case 'flag': if (!flags.includes(c.field as string) || typeof c.value !== 'boolean') fail(); break;
			case 'visibility': if (!strings(c.values) || !c.values.every(v => ['public', 'home', 'followers', 'specified'].includes(v))) fail(); break;
			case 'channel': if (!strings(c.ids)) fail(); break;
			case 'clip': if (c.ids !== null && !strings(c.ids)) fail(); break;
			// 판정은 접두 #을 하나만 벗기므로 중복 접두는 저장 전에 거부한다.
			case 'hashtag': if (typeof c.value !== 'string' || !c.value.replace(/^#/, '').trim().length || c.value.replace(/^#/, '').startsWith('#') || c.value.length > 128) fail(); break;
			default: fail();
		}
	};
	visit(input, 0, 'condition');
}

export function cleanupReferences(condition: CleanupCondition, path = 'condition'): { type: 'clip' | 'channel'; ids: string[]; path: string }[] {
	if (condition.type === 'all' || condition.type === 'any') return condition.children.flatMap((child, index) => cleanupReferences(child, `${path}.children.${index}`));
	if (condition.type === 'not') return cleanupReferences(condition.child, `${path}.child`);
	if (condition.type === 'channel' || (condition.type === 'clip' && condition.ids !== null)) return [{ type: condition.type, ids: condition.ids!, path }];
	return [];
}

function compare(a: number, op: CleanupOperator, b: number): boolean {
	return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
}

export function compileCleanupCondition(input: unknown): (context: CleanupContext) => boolean {
	validateCleanupCondition(input);
	const expressions = new Map<CleanupCondition, RE2>();
	const match = (c: CleanupCondition, context: CleanupContext): boolean => {
		switch (c.type) {
			case 'all': return c.children.map(child => match(child, context)).every(Boolean);
			case 'any': return c.children.map(child => match(child, context)).some(Boolean);
			case 'not': return !match(c.child, context);
			case 'keyword': {
				const texts = c.targets.flatMap(t => context[t] ?? []);
				if (c.mode === 'literal') return texts.some(t => normalize(t).includes(normalize(c.value)));
				let expression = expressions.get(c);
				if (!expression) { expression = new RE2(c.value.normalize('NFC'), c.flags); expressions.set(c, expression); }
				return texts.some(t => { expression.lastIndex = 0; return expression.test(t.normalize('NFC')); });
			}
			case 'age': return compare(context.age, c.operator, c.seconds);
			case 'count':
				if (!Number.isSafeInteger(context[c.field]) || context[c.field] < 0) throw new Error('Invalid cleanup count');
				return compare(context[c.field], c.operator, c.value);
			case 'flag': return Boolean(context.flags[c.field]) === c.value;
			case 'visibility': return c.values.includes(context.visibility);
			case 'channel': return context.channelId !== null && c.ids.includes(context.channelId);
			case 'clip': return c.ids === null ? context.clipIds.length > 0 : context.clipIds.some(id => c.ids!.includes(id));
			case 'hashtag': return context.tags.some(t => normalize(t) === normalize(c.value.replace(/^#/, '')));
		}
	};
	const dependencies = cleanupDependencies(input);
	return context => {
		for (const source of dependencies) if (context.errors?.[source]) throw new Error(context.errors[source]);
		return match(input, context);
	};
}

// 조건이 판정에 쓰는 자료 출처. 보호 실패 기록은 실패한 출처에 의존하는 규칙에만 남긴다.
// 노트 자체 필드만 쓰는 조건(flag poll·files·reply·quote·cw·localOnly, count renotes, keyword text·cw)은 외부 조회 출처가 없다.
export function cleanupDependencies(c: CleanupCondition): string[] {
	if (c.type === 'all' || c.type === 'any') return c.children.flatMap(cleanupDependencies);
	if (c.type === 'not') return cleanupDependencies(c.child);
	if (c.type === 'count') return c.field === 'reactions' ? [c.field] : [];
	if (c.type === 'flag') return ['pinned', 'favorite', 'selfReaction', 'selfRenote'].includes(c.field) ? [c.field] : [];
	if (c.type === 'clip') return ['clip'];
	if (c.type === 'keyword') return c.targets.flatMap(t => t === 'fileComment' || t === 'fileName' ? ['files'] : t === 'poll' ? ['poll'] : []);
	return [];
}

export function matchesCleanupCondition(input: unknown, context: CleanupContext): boolean {
	return compileCleanupCondition(input)(context);
}

export function decideCleanup(rules: CleanupEvaluationRule[], contexts: CleanupContext[]) {
	const errors: CleanupError[] = [];
	const evaluated = rules.flatMap(rule => {
		try {
			if (rule.error) throw new Error(rule.error);
			const match = compileCleanupCondition(rule.condition);
			return [{ rule, matches: contexts.map(match) }];
		} catch (error) {
			errors.push({ ruleId: rule.id, action: rule.action, message: error instanceof Error ? error.message : 'Evaluation failed' });
			return [];
		}
	});
	const blocked = errors.some(e => e.action === 'keep');
	return contexts.map((_, index) => {
		const keepRuleIds = evaluated.filter(e => e.rule.action === 'keep' && e.matches[index]).map(e => e.rule.id);
		const deleteRuleIds = evaluated.filter(e => e.rule.action === 'delete' && e.matches[index]).map(e => e.rule.id);
		const reason: 'blocked' | 'protected' | 'matched' | 'unmatched' = blocked ? 'blocked' : keepRuleIds.length ? 'protected' : deleteRuleIds.length ? 'matched' : 'unmatched';
		return { keepRuleIds, deleteRuleIds, decision: reason === 'matched' ? 'delete' as const : 'keep' as const, reason, errors };
	});
}
