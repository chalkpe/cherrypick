/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test } from 'vitest';
import { decideCleanup, matchesCleanupCondition, validateCleanupCondition } from '../../src/core/NoteCleanupCondition.js';

const context = { text: '고양이는 HELLO', cw: '보호', poll: ['선택'], fileComment: ['설명'], fileName: ['사진.png'], age: 60, reactions: 3, renotes: 2, flags: { pinned: false }, visibility: 'public', channelId: null, clipIds: [], tags: ['고양이'] };
const word = (value: string, targets = ['text']) => ({ type: 'keyword', mode: 'literal', value, flags: '', targets });

describe('노트 정리 판정', () => {
	test('한국어 조사와 NFC 및 영문 대소문자를 부분 일치한다', () => {
		expect(matchesCleanupCondition(word('고양이'), context)).toBe(true);
		expect(matchesCleanupCondition(word('hello'), context)).toBe(true);
		expect(matchesCleanupCondition(word('고양이'.normalize('NFD')), context)).toBe(true);
	});
	test('공백과 정규식 기호를 일반 검색에서 그대로 보존한다', () => {
		expect(matchesCleanupCondition(word('고 양 이'), context)).toBe(false);
		expect(matchesCleanupCondition(word('/.*/'), context)).toBe(false);
	});
	test('CW와 설문 및 선택한 첨부 정보를 검색한다', () => {
		for (const [value, target] of [['보호', 'cw'], ['선택', 'poll'], ['설명', 'fileComment'], ['사진', 'fileName']]) expect(matchesCleanupCondition(word(value, [target]), context)).toBe(true);
	});
	test.each([
		['gt', false, false, true],
		['gte', false, true, true],
		['lt', true, false, false],
		['lte', true, true, false],
	] as const)('기간 %s는 60초의 바로 양편과 동등점을 구분한다', (operator, before, equal, after) => {
		for (const [age, expected] of [[59.999, before], [60, equal], [60.001, after]] as const) {
			expect(matchesCleanupCondition({ type: 'age', operator, seconds: 60 }, { ...context, age })).toBe(expected);
		}
	});
	test('빈 묶음과 알 수 없는 조건 및 반전된 오류는 거부한다', () => {
		expect(() => validateCleanupCondition({ type: 'all', children: [] })).toThrow();
		expect(() => matchesCleanupCondition({ type: 'not', child: { type: 'unknown' } }, context)).toThrow();
	});
	test('남기기가 지우기 합집합보다 우선하고 무응답은 삭제를 막지 않는다', () => {
		expect(decideCleanup([{ id: 'a', action: 'delete', condition: word('고양이') }, { id: 'b', action: 'keep', condition: word('없음') }], [context])[0].decision).toBe('delete');
		expect(decideCleanup([{ id: 'a', action: 'delete', condition: word('고양이') }, { id: 'b', action: 'keep', condition: word('보호', ['cw']) }], [context])[0].reason).toBe('protected');
	});
	test('지우기 오류는 전체 규칙을 제외하고 다른 지우기는 동작한다', () => {
		const results = decideCleanup([{ id: 'a', action: 'delete', condition: { type: 'not', child: { type: 'unknown' } } }, { id: 'b', action: 'delete', condition: word('고양이') }], [context]);
		expect(results[0].deleteRuleIds).toEqual(['b']);
		expect(results[0].errors[0].ruleId).toBe('a');
	});
	test('남기기 오류는 다른 노트를 포함한 묶음 전체의 삭제를 막는다', () => {
		const results = decideCleanup([{ id: 'a', action: 'keep', condition: { type: 'not', child: { type: 'unknown' } } }, { id: 'b', action: 'delete', condition: word('고양이') }], [context, context]);
		expect(results.every(x => x.reason === 'blocked')).toBe(true);
	});
});

test('중첩한 잘못된 입력의 정확한 조건 경로와 비활성 블록을 식별한다', () => {
	try { validateCleanupCondition({ type: 'all', children: [{ type: 'not', child: { type: 'age', operator: 'gte', seconds: -1 } }] }); throw new Error('accepted'); } catch (error) { expect((error as { path: string }).path).toBe('condition.children.0.child'); }
	expect(() => validateCleanupCondition({ type: 'age', operator: 'gte', seconds: 1, enabled: false })).toThrow();
});

test('정규식은 명시 모드와 지정 플래그만 따르고 잘못된 RE2를 거부한다', () => {
	expect(matchesCleanupCondition({ type: 'keyword', mode: 'regex', value: 'hello', flags: '', targets: ['text'] }, context)).toBe(false);
	expect(matchesCleanupCondition({ type: 'keyword', mode: 'regex', value: 'hello', flags: 'i', targets: ['text'] }, context)).toBe(true);
	expect(() => validateCleanupCondition({ type: 'keyword', mode: 'regex', value: '(?=x)', flags: '', targets: ['text'] })).toThrow();
});

test('공개 범위·채널·클립·해시태그와 모든 명시적 플래그를 판정한다', () => {
	const c = { ...context, channelId: 'channel', clipIds: ['own'], flags: { pinned: true, favorite: true, selfReaction: true, selfRenote: true, reply: true, quote: true, poll: true, files: true, cw: true, localOnly: true } };
	for (const field of Object.keys(c.flags)) expect(matchesCleanupCondition({ type: 'flag', field, value: true }, c)).toBe(true);
	for (const condition of [{ type: 'visibility', values: ['public'] }, { type: 'channel', ids: ['channel'] }, { type: 'clip', ids: null }, { type: 'clip', ids: ['own'] }, { type: 'hashtag', value: '#고양이' }, { type: 'count', field: 'reactions', operator: 'gte', value: 3 }, { type: 'count', field: 'renotes', operator: 'lt', value: 3 }]) expect(matchesCleanupCondition(condition, c)).toBe(true);
	expect(matchesCleanupCondition({ type: 'clip', ids: null }, context)).toBe(false);
});

test('과도한 중첩과 미완성 검색 범위를 저장하지 않는다', () => {
	let c: unknown = { type: 'flag', field: 'pinned', value: true };
	for (let i = 0; i < 9; i++) c = { type: 'not', child: c };
	expect(() => validateCleanupCondition(c)).toThrow();
	expect(() => validateCleanupCondition(word('x', []))).toThrow();
});

test('특정 자료 조회 실패는 그 자료를 쓰는 지우기 규칙 전체만 제외한다', () => {
	const results = decideCleanup([{ id: 'count', action: 'delete', condition: { type: 'not', child: { type: 'count', field: 'reactions', operator: 'gte', value: 2 } } }, { id: 'word', action: 'delete', condition: word('고양이') }], [{ ...context, errors: { reactions: 'TEMPORARY_FAILURE' } }]);
	expect(results[0].deleteRuleIds).toEqual(['word']);
	expect(results[0].errors.map(e => e.ruleId)).toEqual(['count']);
});

test('해시태그 표지만 입력한 미완성 조건은 NOT 안에서도 저장을 거부한다', () => {
	expect(() => validateCleanupCondition({ type: 'not', child: { type: 'hashtag', value: '#' } })).toThrow();
});

test('손상된 받은 횟수는 불일치나 NOT의 참으로 바꾸지 않는다', () => {
	const results = decideCleanup([{ id: 'keep', action: 'keep', condition: { type: 'not', child: { type: 'count', field: 'renotes', operator: 'gte', value: 2 } } }, { id: 'delete', action: 'delete', condition: word('고양이') }], [{ ...context, renotes: -1 }]);
	expect(results[0].reason).toBe('blocked');
});

test('지원하지 않는 플래그를 저장하거나 잘못 저장된 규칙으로 판정하지 않는다', () => {
	const keyword = { type: 'keyword', mode: 'regex', value: 'HELLO', flags: 'z', targets: ['text'] };
	expect(() => validateCleanupCondition(keyword)).toThrow();
	for (const action of ['delete', 'keep'] as const) {
		const [result] = decideCleanup([{ id: 'invalid', action, condition: { type: 'not', child: keyword } }, { id: 'valid', action: 'delete', condition: word('고양이') }], [context]);
		expect(result.errors.map(error => error.ruleId)).toEqual(['invalid']);
		expect(result.reason).toBe(action === 'keep' ? 'blocked' : 'matched');
	}
});

test('RE2의 지원 플래그만 각 한 번 허용한다', () => {
	for (const flags of ['', 'd', 'g', 'i', 'm', 's', 'u', 'y', 'dgimsuy']) {
		expect(() => validateCleanupCondition({ type: 'keyword', mode: 'regex', value: 'x', flags, targets: ['text'] })).not.toThrow();
	}
	for (const flags of ['z', 'v', 'ii']) {
		expect(() => validateCleanupCondition({ type: 'keyword', mode: 'regex', value: 'x', flags, targets: ['text'] })).toThrow();
	}
});
