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
	visibility: string; channelId: string | null; clipIds: string[]; tags: string[];
};
export type CleanupEvaluationRule = { id: string; action: 'keep' | 'delete'; condition: unknown; error?: string };
export type CleanupError = { ruleId: string; action: 'keep' | 'delete'; message: string };
const flags = ['pinned', 'favorite', 'selfReaction', 'selfRenote', 'reply', 'quote', 'poll', 'files', 'cw', 'localOnly'];
const targets = ['text', 'cw', 'poll', 'fileComment', 'fileName'];
const normalize = (s: string) => s.normalize('NFC').toLowerCase();

export class CleanupConditionError extends Error {
	constructor(public path: string) { super('Invalid cleanup condition'); }
}

// 키워드 입력은 줄마다 키워드 하나다. 빈 줄은 제외하고 줄 안의 공백은 구절의 일부로 유지한다.
export function cleanupKeywordLines(value: string): string[] {
	return value.split('\n').filter(line => line.length > 0);
}

export function validateCleanupCondition(input: unknown): asserts input is CleanupCondition {
	let nodes = 0;
	let currentPath = 'condition';

	function fail(): never { throw new CleanupConditionError(currentPath); }

	function strings(v: unknown): v is string[] { return Array.isArray(v) && v.length > 0 && v.length <= 32 && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 128); }

	const visit = (value: unknown, depth: number, path: string): void => {
		currentPath = path;
		if (++nodes > 128 || depth > 8 || !value || typeof value !== 'object' || Array.isArray(value)) fail();
		const c = value as Record<string, unknown>;
		const keys: Record<string, string[]> = { all: ['children'], any: ['children'], keyword: ['mode', 'value', 'flags', 'targets'], age: ['operator', 'seconds'], count: ['field', 'operator', 'value'], flag: ['field', 'value'], visibility: ['values'], channel: ['ids'], clip: ['ids'], hashtag: ['value'] };
		if (!keys[c.type as string] || Object.keys(c).some(k => k !== 'type' && !keys[c.type as string].includes(k))) fail();
		switch (c.type) {
			case 'all': case 'any':
				if (!Array.isArray(c.children) || c.children.length === 0 || c.children.length > 32) fail();
				(c.children as unknown[]).forEach((child, index) => visit(child, depth + 1, `${path}.children.${index}`));
				break;
			case 'keyword': {
				const keywordValue = c.value;
				const keywordTargets = c.targets;
				const keywordFlags = c.flags;
				if (typeof keywordValue !== 'string' || !strings(keywordTargets) || !keywordTargets.every(t => targets.includes(t)) || typeof keywordFlags !== 'string') fail();
				const lines = cleanupKeywordLines(keywordValue);
				if (!lines.length || lines.length > 32 || lines.some(line => line.length > 128)) fail();
				if (c.mode === 'regex') {
					for (const line of lines) { try { new RE2(line, keywordFlags); } catch { fail(); } }
				} else if (c.mode !== 'literal' || keywordFlags !== '') fail();
				break;
			}
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
	if (condition.type === 'channel' || (condition.type === 'clip' && condition.ids !== null)) return [{ type: condition.type, ids: condition.ids!, path }];
	return [];
}

function compare(a: number, op: CleanupOperator, b: number): boolean {
	return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
}

export function compileCleanupCondition(input: unknown): (context: CleanupContext) => boolean {
	validateCleanupCondition(input);
	const expressions = new Map<string, RE2>();
	const match = (c: CleanupCondition, context: CleanupContext): boolean => {
		switch (c.type) {
			case 'all': return c.children.map(child => match(child, context)).every(Boolean);
			case 'any': return c.children.map(child => match(child, context)).some(Boolean);
			case 'keyword': {
				const texts = c.targets.flatMap(t => context[t] ?? []);
				const lines = cleanupKeywordLines(c.value);
				if (c.mode === 'literal') return texts.some(t => lines.some(line => normalize(t).includes(normalize(line))));
				return texts.some(t => lines.some(line => {
					// 같은 패턴이라도 플래그가 다르면 다른 정규식이므로 캐시 키에 플래그를 포함한다.
					const key = `${line}\u0000${c.flags}`;
					let expression = expressions.get(key);
					if (!expression) { expression = new RE2(line.normalize('NFC'), c.flags); expressions.set(key, expression); }
					expression.lastIndex = 0;
					return expression.test(t.normalize('NFC'));
				}));
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
	return context => match(input, context);
}

// 조건이 판정에 쓰는 자료 출처. 필요한 조회만 골라 실행하는 데 쓴다.
// 노트 자체 필드만 쓰는 조건(flag poll·files·reply·quote·cw·localOnly, count renotes, keyword text·cw)은 외부 조회 출처가 없다.
export function cleanupDependencies(c: CleanupCondition): string[] {
	if (c.type === 'all' || c.type === 'any') return c.children.flatMap(cleanupDependencies);
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
