/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { Blob } from 'node-fetch';
import type { entities } from 'cherrypick-js';
import { IdService } from '@/core/IdService.js';
import { MiNote } from '@/models/Note.js';
import { api, channel, clip, initTestDb, post, relativeFetch, signup, startJobQueue, uploadFile } from '../utils.js';
import type { UserToken } from '../utils.js';
import type { INestApplicationContext } from '@nestjs/common';

type Condition = entities.NoteCleanupCondition;
type Rule = { id: string; condition: Condition; action: 'keep' | 'delete' };
type Item = { noteId: string; decision: 'keep' | 'delete'; reason: string; keepRuleIds: string[]; deleteRuleIds: string[] };
type Response = { rule: Rule; rules: Rule[]; items: Item[]; errors: unknown[]; complete: boolean; queued: boolean; error: { code: string; info: { code: string } } };
let queue: INestApplicationContext;
const accounts: Awaited<ReturnType<typeof signup>>[] = [];

async function account() {
	const user = await signup();
	accounts.push(user);
	return user;
}

const literal = (value: string, targets: entities.NoteCleanupTarget[] = ['text', 'cw', 'poll']): Condition => ({ type: 'keyword', mode: 'literal', value, flags: '', targets });
const flag = (field: entities.NoteCleanupFlag, value = true): Condition => ({ type: 'flag', field, value });
const allVisibility: Condition = { type: 'visibility', values: ['public', 'home', 'followers', 'specified'] };
const signal = '완료신호전용문자열';

// 생성·관계 변경·정리는 제품 HTTP API를 사용한다.
async function cleanup(path: string, params: Record<string, unknown>, user: UserToken) {
	const res = await relativeFetch(`api/i/note-cleanup/${path}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, i: user.token }),
	});
	return { status: res.status, body: (res.status === 204 ? null : await res.json()) as Response };
}

async function owner() {
	const user = await account();
	const listed = await cleanup('list', {}, user);
	expect(listed.status).toBe(200);
	// 기본 보호를 API로 제거하여 각 조건만 독립적으로 판정한다.
	for (const rule of listed.body.rules) expect((await cleanup('delete', { ruleId: rule.id }, user)).status).toBe(204);
	return user;
}

async function rule(user: UserToken, condition: Condition, action: 'keep' | 'delete' = 'delete') {
	const created = await cleanup('create', { name: '조건 시험', action, condition, automatic: false }, user);
	expect(created.status).toBe(200);
	const listed = await cleanup('list', {}, user);
	expect(listed.status).toBe(200);
	expect(listed.body.rules.find(r => r.id === created.body.rule.id)?.condition).toEqual(condition);
	return created.body.rule;
}

async function preview(user: UserToken, ids: string[]) {
	const res = await cleanup('preview', { ruleIds: ids }, user);
	expect(res.status).toBe(200);
	expect(res.body.errors).toEqual([]);
	expect(res.body.complete).toBe(true);
	return res.body.items;
}

async function exists(user: UserToken, id: string, present: boolean) {
	const res = await api('notes/show', { noteId: id }, user);
	expect(res.status).toBe(present ? 200 : 400);
	if (!present) expect((res.body as unknown as { error: { code: string } }).error.code).toBe('NO_SUCH_NOTE');
}

// 양성 삭제 신호와 모든 삭제 대상을 기다린 뒤 보존 대상을 확인한다.
async function execute(user: UserToken, ids: string[], deleted: string[], retained: string[]) {
	const sentinel = await post(user, { text: signal });
	const completion = await rule(user, literal(signal));
	const selected = [...ids, completion.id];
	const requested = await cleanup('request', { ruleIds: selected }, user);
	expect(requested.status).toBe(200);
	expect(requested.body.queued).toBe(true);
	for (const id of [...deleted, sentinel.id]) {
		await expect.poll(async () => (await api('notes/show', { noteId: id }, user)).status, { timeout: 180000, interval: 250 }).toBe(400);
		await exists(user, id, false);
	}
	for (const id of retained) await exists(user, id, true);
}

async function check(user: UserToken, condition: Condition, matched: string[], unmatched: string[], action: 'keep' | 'delete' = 'delete') {
	const tested = await rule(user, condition, action);
	const deletion = action === 'keep' ? await rule(user, allVisibility) : tested;
	const items = await preview(user, [deletion.id]);
	for (const id of matched) {
		const item = items.find(i => i.noteId === id);
		expect(item?.[action === 'keep' ? 'keepRuleIds' : 'deleteRuleIds']).toContain(tested.id);
		expect(item?.decision).toBe(action === 'keep' ? 'keep' : 'delete');
	}
	for (const id of unmatched) {
		const item = items.find(i => i.noteId === id);
		expect(item?.[action === 'keep' ? 'keepRuleIds' : 'deleteRuleIds']).not.toContain(tested.id);
		expect(item?.decision).toBe(action === 'keep' ? 'delete' : 'keep');
	}

	await execute(user, [deletion.id], action === 'keep' ? unmatched : matched, action === 'keep' ? matched : unmatched);
}

beforeAll(async () => { queue = await startJobQueue(); }, 120000);
afterEach(async () => {
	// 계정 삭제 요청은 시험 데이터 정리이며 완료 검증을 대체하지 않는다.
	for (const user of accounts.splice(0)) expect((await api('i/delete-account', { password: 'test' }, user)).status).toBe(204);
}, 240000);
afterAll(async () => { await queue?.close(); });

test('중첩 저장과 재조회, 공통 보호, 개별 요청과 미해당 보존', async () => {
	const user = await owner();
	const a = await post(user, { text: '대상 하나' });
	const b = await post(user, { text: '대상 둘 보존' });
	const c = await post(user, { text: '다른 규칙 전용' });
	const d = await post(user, { text: '미해당' });
	const e = await post(user, { text: '보존만' });
	const condition: Condition = { type: 'all', children: [literal('대상'), { type: 'any', children: [literal('하나'), literal('둘')] }, { type: 'not', child: literal('제외') }] };
	const selected = await rule(user, literal('편집 전'));
	const updated = await cleanup('update', { ruleId: selected.id, name: '중첩 편집', action: 'delete', condition }, user);
	expect(updated.status).toBe(200);
	expect((await cleanup('list', {}, user)).body.rules.find(r => r.id === selected.id)?.condition).toEqual(condition);
	const omitted = await rule(user, literal('다른 규칙'));
	const overlapping = await rule(user, literal('대상'));
	const keep = await rule(user, literal('보존'), 'keep');
	const items = await preview(user, [selected.id]);
	expect(items.find(i => i.noteId === a.id)).toMatchObject({ decision: 'delete', deleteRuleIds: [selected.id], keepRuleIds: [] });
	expect(items.find(i => i.noteId === b.id)).toMatchObject({ decision: 'keep', reason: 'protected', deleteRuleIds: [selected.id], keepRuleIds: [keep.id] });
	for (const id of [c.id, d.id]) expect(items.find(i => i.noteId === id)).toMatchObject({ reason: 'unmatched', deleteRuleIds: [] });
	expect(items.find(i => i.noteId === e.id)).toMatchObject({ reason: 'protected', deleteRuleIds: [], keepRuleIds: [keep.id] });
	expect(items.flatMap(i => i.deleteRuleIds)).not.toContain(omitted.id);
	expect(items.flatMap(i => i.deleteRuleIds)).not.toContain(overlapping.id);

	await execute(user, [selected.id], [a.id], [b.id, c.id, d.id, e.id]);
}, 240000);

const strings: { name: string; condition: Condition; yes: string; no: string }[] = [
	{ name: '조사 부분 일치', condition: literal('사과'), yes: '사과를 먹었다', no: '배를 먹었다' },
	{ name: 'NFC', condition: literal('한글'), yes: '한글'.normalize('NFD'), no: '다른 글' },
	{ name: '대소문자', condition: literal('AbC'), yes: '앞 abc 뒤', no: 'abd' },
	{ name: '공백 유지', condition: literal('두  칸'), yes: '두  칸', no: '두 칸' },
	{ name: '줄바꿈 유지', condition: literal('첫\n줄'), yes: '첫\n줄', no: '첫 줄' },
	{ name: 'NFKC 확장 없음', condition: literal('ABC'), yes: 'ABC', no: 'ＡＢＣ' },
	{ name: '유사어 확장 없음', condition: literal('자동차'), yes: '자동차', no: '차량' },
	{ name: '발음 확장 없음', condition: literal('같이'), yes: '같이', no: '가치' },
	{ name: '초성 확장 없음', condition: literal('ㅎㄱ'), yes: 'ㅎㄱ', no: '한글' },
	{ name: '슬래시와 메타문자', condition: literal('/a.b/'), yes: '/a.b/', no: 'axb' },
	{ name: '명시적 RE2', condition: { type: 'keyword', mode: 'regex', value: '^a.b$', flags: '', targets: ['text'] }, yes: 'axb', no: 'AXB' },
	{ name: 'RE2 i 플래그', condition: { type: 'keyword', mode: 'regex', value: '^abc$', flags: 'i', targets: ['text'] }, yes: 'ABC', no: 'abcd' },
];

test.each(strings)('$name 저장·조회·미리 보기·삭제', async ({ condition, yes, no }) => {
	const user = await owner();
	const positive = await post(user, { text: yes });
	const negative = await post(user, { text: no });

	expect((await api('notes/show', { noteId: positive.id }, user)).body.text).toBe(yes);
	await check(user, condition, [positive.id], [negative.id]);
	expect((await api('notes/show', { noteId: negative.id }, user)).body.text).toBe(no);
}, 240000);

test.each(['[', '(a)\\1', '(?=a)', 'a'])('잘못된 RE2 또는 플래그 저장 차단: %s', async value => {
	const user = await owner();
	const condition = { type: 'keyword', mode: 'regex', value, flags: value === 'a' ? 'z' : '', targets: ['text'] };
	const res = await cleanup('create', { name: '거절', action: 'delete', condition }, user);
	expect(res.status).toBe(400);
	expect(res.body.error.code).toBe('INVALID_CLEANUP');
	expect((await cleanup('list', {}, user)).body.rules).toEqual([]);
}, 240000);

test('빈 묶음·불완전·과대·과심도 조건을 저장하지 않는다', async () => {
	const user = await owner();
	let deep: Condition = literal('끝');
	for (let i = 0; i < 10; i++) deep = { type: 'not', child: deep };
	for (const condition of [{ type: 'all', children: [] }, { type: 'keyword' }, { type: 'any', children: Array.from({ length: 33 }, () => literal('큰 묶음')) }, deep]) {
		expect((await cleanup('create', { name: '거절', action: 'delete', condition }, user)).status).toBe(400);
	}
	expect((await cleanup('list', {}, user)).body.rules).toEqual([]);
}, 240000);

test.each(['text', 'cw', 'poll'] as const)('기본 검색 범위 %s와 제외 범위를 구분한다', async target => {
	const user = await owner();
	const positive = await post(user, target === 'poll' ? { text: '설문', poll: { choices: ['검색문자', '다른 선택지'] } } : target === 'cw' ? { text: '본문', cw: '검색문자' } : { text: '검색문자' });
	const negative = await post(user, { text: '미해당' });
	const excluded = await rule(user, literal('검색문자', target === 'text' ? ['cw'] : ['text']));
	expect((await preview(user, [excluded.id])).find(i => i.noteId === positive.id)?.decision).toBe('keep');

	await check(user, literal('검색문자'), [positive.id], [negative.id]);
}, 240000);

test.each(['fileComment', 'fileName'] as const)('공유 첨부의 %s 선택·제외 및 수정 반영', async target => {
	const user = await owner();
	const uploaded = await uploadFile(user, { name: '처음.txt', blob: new Blob(['합성 시험 자료'], { type: 'text/plain' }) });
	expect(uploaded.status).toBe(200);
	const fileId = uploaded.body!.id;
	const a = await post(user, { text: '첨부 하나', fileIds: [fileId] });
	const b = await post(user, { text: '첨부 둘', fileIds: [fileId] });
	const c = await post(user, { text: '첨부 없음' });
	const selected = await rule(user, literal('변경표식', [target]));
	expect((await preview(user, [selected.id])).filter(i => i.decision === 'delete')).toEqual([]);
	expect((await api('drive/files/update', { fileId, ...(target === 'fileName' ? { name: '변경표식.txt' } : { comment: '변경표식' }) }, user)).status).toBe(200);
	const excluded = await rule(user, literal('변경표식'));
	expect((await preview(user, [excluded.id])).filter(i => i.decision === 'delete')).toEqual([]);
	const items = await preview(user, [selected.id]);
	for (const id of [a.id, b.id]) expect(items.find(i => i.noteId === id)?.decision).toBe('delete');

	await execute(user, [selected.id], [a.id, b.id], [c.id]);
	expect((await api('drive/files/delete', { fileId }, user)).status).toBe(204);
}, 240000);

test.each(['pinned', 'favorite', 'selfReaction', 'selfRenote'] as const)('자기 표시 %s와 타인 표시를 구분한다', async field => {
	const user = await owner();
	const other = await account();
	const own = await post(user, { text: '내 표시' });
	const foreignMark = await post(user, { text: '타인 표시' });
	const plain = await post(user, { text: '표시 없음' });
	if (field === 'pinned') {
		expect((await api('i/pin', { noteId: own.id }, user)).status).toBe(204);
	} else if (field === 'favorite') {
		expect((await api('notes/favorites/create', { noteId: own.id }, user)).status).toBe(204);
		expect((await api('notes/favorites/create', { noteId: foreignMark.id }, other)).status).toBe(204);
	} else if (field === 'selfReaction') {
		expect((await api('notes/reactions/create', { noteId: own.id, reaction: '👍' }, user)).status).toBe(204);
		expect((await api('notes/reactions/create', { noteId: foreignMark.id, reaction: '👍' }, other)).status).toBe(204);
	} else {
		expect((await post(user, { renoteId: own.id })).renoteId).toBe(own.id);
		expect((await post(other, { renoteId: foreignMark.id })).renoteId).toBe(foreignMark.id);
	}

	await check(user, flag(field), [own.id], [foreignMark.id, plain.id], 'keep');
}, 240000);

test.each([null, 'public', 'private'] as const)('내 클립 전체/지정 %s와 동명 타인 클립 구분', async selection => {
	const user = await owner();
	const other = await account();
	const pub = await clip(user, { name: '같은 이름', isPublic: true });
	const priv = await clip(user, { name: '같은 이름', isPublic: false });
	const theirs = await clip(other, { name: '같은 이름', isPublic: true });
	const notes = await Promise.all(['공개 클립', '비공개 클립', '타인 클립', '클립 없음'].map(text => post(user, { text })));
	for (const [index, resource, actor] of [[0, pub, user], [1, priv, user], [2, theirs, other]] as const) {
		expect((await api('clips/add-note', { clipId: resource.id, noteId: notes[index].id }, actor)).status).toBe(204);
	}
	const matches = selection === null ? [0, 1] : selection === 'public' ? [0] : [1];

	await check(user, { type: 'clip', ids: selection === null ? null : [selection === 'public' ? pub.id : priv.id] }, matches.map(i => notes[i].id), notes.filter((_, i) => !matches.includes(i)).map(n => n.id));
	for (const [resource, actor] of [[pub, user], [priv, user], [theirs, other]] as const) expect((await api('clips/delete', { clipId: resource.id }, actor)).status).toBe(204);
}, 240000);

test('다른 사용자의 비공개 클립을 지정할 수 없다', async () => {
	const user = await owner();
	const other = await account();
	const resource = await clip(other, { isPublic: false });
	const res = await cleanup('create', { name: '권한', action: 'delete', condition: { type: 'clip', ids: [resource.id] } }, user);
	expect(res.status).toBe(400);
	expect((await cleanup('list', {}, user)).body.rules).toEqual([]);
	expect((await api('clips/delete', { clipId: resource.id }, other)).status).toBe(204);
}, 240000);

test.each(['poll', 'files', 'cw', 'reply', 'quote', 'localOnly'] as const)('%s 유무 양쪽을 판정한다', async field => {
	const user = await owner();
	const parent = await post(user, { text: '원본' });
	let fileId: string | undefined;
	if (field === 'files') {
		const uploaded = await uploadFile(user, { name: '합성.txt', blob: new Blob(['합성 자료'], { type: 'text/plain' }) });
		expect(uploaded.status).toBe(200);
		fileId = uploaded.body!.id;
	}
	const positive = await post(user, {
		text: '조건 있음',
		...(field === 'poll' ? { poll: { choices: ['선택 하나', '선택 둘'] } } : {}),
		...(field === 'files' ? { fileIds: [fileId!] } : {}),
		...(field === 'cw' ? { cw: '경고' } : {}),
		...(field === 'reply' ? { replyId: parent.id } : {}),
		...(field === 'quote' ? { renoteId: parent.id } : {}),
		...(field === 'localOnly' ? { localOnly: true } : {}),
	});
	const negative = await post(user, { text: '조건 없음' });
	const inverse = await rule(user, flag(field, false));
	const inverted = await preview(user, [inverse.id]);
	expect(inverted.find(i => i.noteId === positive.id)?.decision).toBe('keep');
	expect(inverted.find(i => i.noteId === negative.id)?.decision).toBe('delete');

	await check(user, flag(field), [positive.id], [negative.id, parent.id]);
	if (fileId) expect((await api('drive/files/delete', { fileId }, user)).status).toBe(204);
}, 240000);

test.each(['public', 'home', 'followers', 'specified'] as const)('공개 범위 %s를 다른 범위와 구분한다', async visibility => {
	const user = await owner();
	const other = await account();
	const notes = [];
	for (const value of ['public', 'home', 'followers', 'specified'] as const) notes.push(await post(user, { text: value, visibility: value, ...(value === 'specified' ? { visibleUserIds: [other.id] } : {}) }));

	await check(user, { type: 'visibility', values: [visibility] }, notes.filter(n => n.visibility === visibility).map(n => n.id), notes.filter(n => n.visibility !== visibility).map(n => n.id));
}, 240000);

test('지정 채널과 다른 채널·채널 없는 글을 구분한다', async () => {
	const user = await owner();
	const first = await channel(user, { name: '첫 채널' });
	const second = await channel(user, { name: '둘째 채널' });
	const yes = await post(user, { text: '채널 하나', channelId: first.id });
	const no = await post(user, { text: '채널 둘', channelId: second.id });
	const plain = await post(user, { text: '채널 없음' });

	await check(user, { type: 'channel', ids: [first.id] }, [yes.id], [no.id, plain.id]);
}, 240000);

test('태그 조건은 CW 유무와 독립적이다', async () => {
	const user = await owner();
	const tagged = await post(user, { text: '본문 #정리태그' });
	const cw = await post(user, { text: '본문', cw: '정리태그' });
	const plain = await post(user, { text: '정리태그' });

	await check(user, { type: 'hashtag', value: '#정리태그' }, [tagged.id], [cw.id, plain.id]);
}, 240000);

test.each(['reactions', 'renotes'] as const)('받은 %s 수의 이상·초과·이하·미만 경계', async field => {
	const user = await owner();
	const other = await account();
	const zero = await post(user, { text: '반응 없음' });
	const one = await post(user, { text: '반응 하나' });
	const two = await post(user, { text: '반응 둘' });
	const another = await account();
	if (field === 'reactions') {
		for (const actor of [other, another]) expect((await api('notes/reactions/create', { noteId: two.id, reaction: '👍' }, actor)).status).toBe(204);
	} else {
		for (const actor of [other, another]) expect((await post(actor, { renoteId: two.id })).renoteId).toBe(two.id);
	}
	if (field === 'reactions') expect((await api('notes/reactions/create', { noteId: one.id, reaction: '👍' }, other)).status).toBe(204);
	else expect((await post(other, { renoteId: one.id })).renoteId).toBe(one.id);
	// 반응 버퍼의 사용 여부는 실행 환경에서 기록한다. 플러시나 설정 변경으로 우회하지 않는다.
	await expect.poll(async () => {
		const shown = await api('notes/show', { noteId: one.id }, user);
		return field === 'reactions' ? Object.values(shown.body.reactions).reduce((sum, n) => sum + n, 0) : shown.body.renoteCount;
	}, { timeout: 30000, interval: 100 }).toBe(1);
	for (const [operator, expected] of [['gte', [one.id, two.id]], ['gt', [two.id]], ['lte', [zero.id, one.id]], ['lt', [zero.id]]] as const) {
		const tested = await rule(user, { type: 'count', field, operator, value: 1 });
		const items = await preview(user, [tested.id]);
		expect(items.filter(i => i.decision === 'delete').map(i => i.noteId).sort()).toEqual([...expected].sort());
	}

	await check(user, { type: 'count', field, operator: 'gte', value: 1 }, [one.id, two.id], [zero.id]);
}, 240000);

test.each([600, 3600, 86400] as const)('작성 시각 기준 %s초 전후와 네 비교 연산', async seconds => {
	const user = await owner();
	const template = await post(user, { text: '과거 작성 fixture' });
	const db = await initTestDb(true);
	let oldId: string;
	let youngId: string;
	try {
		// 과거 작성 시각을 넣는 API가 없어 기존 initTestDb 패턴으로만 준비한다.
		// 제품의 생성·수정 동작을 검증한 것으로 보고하지 않는다.
		const notes = db.getRepository(MiNote);
		const source = await notes.findOneByOrFail({ id: template.id });
		const ids = queue.get(IdService);
		oldId = ids.gen(Date.now() - (seconds + 300) * 1000);
		youngId = ids.gen(Date.now() - (seconds - 300) * 1000);
		await notes.insert([{ ...source, id: oldId }, { ...source, id: youngId }]);
	} finally {
		await db.destroy();
	}
	const edited = await api('notes/update', { noteId: oldId, text: '방금 수정한 과거 글' }, user);
	expect(edited.status).toBe(200);
	for (const operator of ['gt', 'gte', 'lt', 'lte'] as const) {
		const tested = await rule(user, { type: 'age', operator, seconds });
		const items = await preview(user, [tested.id]);
		expect(items.find(i => i.noteId === oldId)?.decision).toBe(operator === 'gt' || operator === 'gte' ? 'delete' : 'keep');
		expect(items.find(i => i.noteId === youngId)?.decision).toBe(operator === 'lt' || operator === 'lte' ? 'delete' : 'keep');
	}

	await check(user, { type: 'age', operator: 'gte', seconds }, [oldId], [youngId, template.id]);
}, 240000);

test('클립에서 빼는 API 변경이 이후 판정에 반영된다', async () => {
	const user = await owner();
	const resource = await clip(user, { isPublic: false });
	const note = await post(user, { text: '클립 관계 변경' });
	expect((await api('clips/add-note', { clipId: resource.id, noteId: note.id }, user)).status).toBe(204);
	const tested = await rule(user, { type: 'clip', ids: null });
	expect((await preview(user, [tested.id])).find(i => i.noteId === note.id)?.decision).toBe('delete');
	expect((await api('clips/remove-note', { clipId: resource.id, noteId: note.id }, user)).status).toBe(204);
	expect((await preview(user, [tested.id])).find(i => i.noteId === note.id)?.decision).toBe('keep');

	await execute(user, [tested.id], [], [note.id]);
	expect((await api('clips/delete', { clipId: resource.id }, user)).status).toBe(204);
}, 240000);
