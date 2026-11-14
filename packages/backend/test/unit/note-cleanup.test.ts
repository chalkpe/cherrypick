/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test } from 'vitest';
import { cleanupKeywordLines, decideCleanup, matchesCleanupCondition, validateCleanupCondition } from '../../src/core/NoteCleanupCondition.js';

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
	test('빈 묶음과 알 수 없는 조건은 거부한다', () => {
		expect(() => validateCleanupCondition({ type: 'all', children: [] })).toThrow();
		expect(() => matchesCleanupCondition({ type: 'unknown' }, context)).toThrow();
	});
	test('남기기가 지우기 합집합보다 우선하고 무응답은 삭제를 막지 않는다', () => {
		expect(decideCleanup([{ id: 'a', action: 'delete', condition: word('고양이') }, { id: 'b', action: 'keep', condition: word('없음') }], [context])[0].decision).toBe('delete');
		expect(decideCleanup([{ id: 'a', action: 'delete', condition: word('고양이') }, { id: 'b', action: 'keep', condition: word('보호', ['cw']) }], [context])[0].reason).toBe('protected');
	});
	test('지우기 오류는 전체 규칙을 제외하고 다른 지우기는 동작한다', () => {
		const results = decideCleanup([{ id: 'a', action: 'delete', condition: { type: 'unknown' } }, { id: 'b', action: 'delete', condition: word('고양이') }], [context]);
		expect(results[0].deleteRuleIds).toEqual(['b']);
		expect(results[0].errors[0].ruleId).toBe('a');
	});
	test('남기기 오류는 다른 노트를 포함한 묶음 전체의 삭제를 막는다', () => {
		const results = decideCleanup([{ id: 'a', action: 'keep', condition: { type: 'unknown' } }, { id: 'b', action: 'delete', condition: word('고양이') }], [context, context]);
		expect(results.every(x => x.reason === 'blocked')).toBe(true);
	});
});

describe('줄 단위 키워드', () => {
	test('줄 바꿈으로 구분한 각 줄을 하나의 키워드로 OR 판정한다', () => {
		expect(cleanupKeywordLines('고양이\n강아지\n')).toEqual(['고양이', '강아지']);
		expect(matchesCleanupCondition(word('없음\n고양이'), context)).toBe(true);
		expect(matchesCleanupCondition(word('없음\n강아지'), context)).toBe(false);
	});
	test('빈 줄은 제외하고 줄 안의 공백과 공백만 있는 줄은 구절로 유지한다', () => {
		expect(cleanupKeywordLines('\n고양이\n\nHELLO\n')).toEqual(['고양이', 'HELLO']);
		expect(matchesCleanupCondition(word('고 양 이\n없음'), context)).toBe(false);
		expect(matchesCleanupCondition(word(' '), { ...context, text: '띄어쓰기 있음' })).toBe(true);
		expect(matchesCleanupCondition(word(' '), { ...context, text: '없음' })).toBe(false);
	});
	test('정규식도 줄마다 따로 검사해 하나라도 잘못되면 거부한다', () => {
		expect(matchesCleanupCondition({ type: 'keyword', mode: 'regex', value: '없음\nhello', flags: 'i', targets: ['text'] }, context)).toBe(true);
		expect(() => validateCleanupCondition({ type: 'keyword', mode: 'regex', value: 'hello\n(?=x)', flags: '', targets: ['text'] })).toThrow();
	});
	test('줄 수와 줄 길이의 상한을 적용한다', () => {
		expect(() => validateCleanupCondition(word(Array.from({ length: 32 }, (_, i) => `단어${i}`).join('\n')))).not.toThrow();
		expect(() => validateCleanupCondition(word(Array.from({ length: 33 }, (_, i) => `단어${i}`).join('\n')))).toThrow();
		expect(() => validateCleanupCondition(word('가'.repeat(128)))).not.toThrow();
		expect(() => validateCleanupCondition(word('가'.repeat(129)))).toThrow();
		expect(() => validateCleanupCondition(word(''))).toThrow();
		expect(() => validateCleanupCondition(word('\n\n'))).toThrow();
	});
});

test('중첩한 잘못된 입력의 정확한 조건 경로와 비활성 블록을 식별한다', () => {
	try { validateCleanupCondition({ type: 'all', children: [{ type: 'any', children: [{ type: 'age', operator: 'gte', seconds: -1 }] }] }); throw new Error('accepted'); } catch (error) { expect((error as { path: string }).path).toBe('condition.children.0.children.0'); }
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
	for (let i = 0; i < 9; i++) c = { type: 'all', children: [c] };
	expect(() => validateCleanupCondition(c)).toThrow();
	expect(() => validateCleanupCondition(word('x', []))).toThrow();
});

test('손상된 받은 횟수는 판정 오류로 남아 남기기는 묶음을 막고 지우기는 제외한다', () => {
	const broken = { ...context, renotes: -1 };
	expect(decideCleanup([{ id: 'keep', action: 'keep', condition: { type: 'count', field: 'renotes', operator: 'gte', value: 2 } }, { id: 'delete', action: 'delete', condition: word('고양이') }], [broken])[0].reason).toBe('blocked');
	const results = decideCleanup([{ id: 'count', action: 'delete', condition: { type: 'count', field: 'renotes', operator: 'gte', value: 2 } }, { id: 'word', action: 'delete', condition: word('고양이') }], [broken]);
	expect(results[0].deleteRuleIds).toEqual(['word']);
	expect(results[0].errors.map(e => e.ruleId)).toEqual(['count']);
});

test('해시태그 표지만 입력한 미완성 조건은 저장을 거부한다', () => {
	expect(() => validateCleanupCondition({ type: 'hashtag', value: '#' })).toThrow();
});

test('중복 접두 해시태그는 판정과 어긋나므로 저장 전에 거부하고 tag·#tag는 유지한다', () => {
	expect(() => validateCleanupCondition({ type: 'hashtag', value: '##tag' })).toThrow();
	expect(() => validateCleanupCondition({ type: 'hashtag', value: '###' })).toThrow();
	expect(() => validateCleanupCondition({ type: 'hashtag', value: 'tag' })).not.toThrow();
	expect(() => validateCleanupCondition({ type: 'hashtag', value: '#tag' })).not.toThrow();
	expect(matchesCleanupCondition({ type: 'hashtag', value: '#tag' }, { ...context, tags: ['tag'] })).toBe(true);
});

test('정규식 플래그는 단어 뮤트와 같은 RE2 생성자를 따른다', () => {
	for (const flags of ['', 'd', 'g', 'i', 'm', 's', 'u', 'y', 'dgimsuy', 'z', 'x', 'v', 'iz', 'ii']) {
		const condition = { type: 'keyword', mode: 'regex', value: 'hello', flags, targets: ['text'] };
		expect(() => validateCleanupCondition(condition)).not.toThrow();
		expect(matchesCleanupCondition(condition, { ...context, text: 'HELLO' })).toBe(flags.includes('i'));
	}
});

test('같은 패턴이라도 플래그가 다른 조건은 한 규칙 안에서 각자 플래그로 판정한다', () => {
	const sensitive = { type: 'keyword', mode: 'regex', value: '^abc$', flags: '', targets: ['text'] };
	const insensitive = { type: 'keyword', mode: 'regex', value: '^abc$', flags: 'i', targets: ['text'] };
	const upper = { ...context, text: 'ABC' };
	// 지우기 all: 대소문자 구분 조건이 거짓이면 보존해야 한다. 순서와 무관하게 같아야 한다.
	expect(matchesCleanupCondition({ type: 'all', children: [insensitive, sensitive] }, upper)).toBe(false);
	expect(matchesCleanupCondition({ type: 'all', children: [sensitive, insensitive] }, upper)).toBe(false);
	// 남기기 any: 대소문자 무시 조건이 참이면 보호해야 한다. 순서와 무관하게 같아야 한다.
	expect(matchesCleanupCondition({ type: 'any', children: [sensitive, insensitive] }, upper)).toBe(true);
	expect(matchesCleanupCondition({ type: 'any', children: [insensitive, sensitive] }, upper)).toBe(true);
	// 같은 패턴·같은 플래그의 재사용은 그대로 동작한다.
	expect(matchesCleanupCondition({ type: 'all', children: [insensitive, { ...insensitive }] }, upper)).toBe(true);
	expect(matchesCleanupCondition({ type: 'all', children: [sensitive, { ...sensitive }] }, upper)).toBe(false);
});
