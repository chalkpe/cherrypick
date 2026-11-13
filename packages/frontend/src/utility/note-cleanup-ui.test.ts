/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, h } from 'vue';

vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token' } }));
// 요약 시험에서 언어별 어순을 확인하도록 호출 시점의 locale을 바꿀 수 있게 한다.
const activeLocale = vi.hoisted(() => ({ current: 'en-US' as 'en-US' | 'ko-KR' | 'ja-JP' }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locales = Object.fromEntries(['en-US', 'ko-KR', 'ja-JP'].map(language => [language, load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as Locale]));
	const instances = { 'en-US': new I18n(locales['en-US'], false), 'ko-KR': new I18n(locales['ko-KR'], false), 'ja-JP': new I18n(locales['ja-JP'], false) };
	return { i18n: { get ts() { return instances[activeLocale.current].ts; }, get tsx() { return instances[activeLocale.current].tsx; } } };
});
const popupMenu = vi.hoisted(() => vi.fn((_items: { text: string; action: () => void | Promise<void> }[]) => {}));
const alert = vi.hoisted(() => vi.fn(async (_options: { type: string; title: string; text?: string }) => {}));
const confirm = vi.hoisted(() => vi.fn(async (_options: { title: string }) => ({ canceled: true })));
vi.mock('@/os.js', () => ({ alert, confirm, popupMenu }));
vi.mock('@/components/MkInput.vue', () => ({ default: defineComponent({
	props: ['modelValue'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('label', [slots.label?.(), h('input', { value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) })]),
}) }));
vi.mock('@/components/MkSelect.vue', () => ({ default: defineComponent({ props: ['modelValue', 'items'], setup: () => () => h('div') }) }));
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
	props: ['disabled'], emits: ['click'],
	setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: (event: MouseEvent) => emit('click', event) }, slots.default?.()),
}) }));
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
vi.mock('@/pages/settings/note-cleanup/Preview.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
vi.mock('@/pages/settings/note-cleanup/ConditionEditor.vue', () => ({ default: defineComponent({
	props: ['condition'], emits: ['change', 'move'],
	setup: (props, { emit }) => () => h('div', [
		h('button', { onClick: () => emit('change', [], { type: 'keyword', mode: 'literal', value: '/고양이.*/\n문자 그대로', flags: '', targets: ['text', 'cw', 'poll'] }) }, 'Enter condition'),
		// 실제 ConditionEditor처럼 두 번째 최상위 자식의 이동 메뉴를 연다.
		h('button', { onClick: (event: MouseEvent) => emit('move', [1], event) }, 'Move second condition'),
		h('pre', { 'data-testid': 'condition' }, JSON.stringify(props.condition)),
	]),
}) }));
import type { CleanupRule } from '@/utility/note-cleanup-api.js';
import type { NoteCleanupCondition as Condition } from 'cherrypick-js/entities.js';
import RuleEditor from '@/pages/settings/note-cleanup/RuleEditor.vue';
import { summary } from '@/pages/settings/note-cleanup/labels.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); popupMenu.mockReset(); confirm.mockClear(); alert.mockClear(); activeLocale.current = 'en-US'; });

test('saving an incomplete editor sends no request; a complete draft reaches the real API transport', async () => {
	const requests: { url: string; body: unknown }[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		requests.push({ url, body: JSON.parse(init.body as string) });
		return new Response(JSON.stringify({ rule: { id: 'saved-rule' } }));
	});
	const onSaved = vi.fn();
	const view = render(RuleEditor, { props: { onSaved } });
	await fireEvent.update(view.getByLabelText('Rule name'), '기록');
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	expect(requests).toHaveLength(0);
	await fireEvent.click(view.getByRole('button', { name: 'Enter condition' }));
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(requests).toHaveLength(1));
	expect(requests[0]).toEqual({ url: 'https://cleanup.invalid/api/i/note-cleanup/create', body: { name: '기록', action: 'delete', condition: { type: 'keyword', mode: 'literal', value: '/고양이.*/\n문자 그대로', flags: '', targets: ['text', 'cw', 'poll'] }, i: 'dummy-test-token' } });
	await waitFor(() => expect(onSaved).toHaveBeenCalledWith('saved-rule'));
});

test('server rejection retains the draft and explains the invalid condition without diagnostic paths', async () => {
	vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'INVALID_CLEANUP', info: { code: 'INVALID_CONDITION', path: 'condition.child' } } }), { status: 400 }));
	const onSaved = vi.fn();
	const view = render(RuleEditor, { props: { onSaved } });
	await fireEvent.update(view.getByLabelText('Rule name'), '실패해도 보존');
	await fireEvent.click(view.getByRole('button', { name: 'Enter condition' }));
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await view.findByText('Check the highlighted condition and correct its settings.');
	expect((view.getByLabelText('Rule name') as HTMLInputElement).value).toBe('실패해도 보존');
	expect(view.container.textContent).not.toMatch(/INVALID_CONDITION|condition.child/);
	expect(onSaved).not.toHaveBeenCalled();
});

test.each([
	{ value: 'a', flags: 'z' },
	{ value: '[', flags: '' },
])('잘못된 정규식은 중첩 조건에서도 대화상자를 띄우고 저장하지 않는다: $value / $flags', async ({ value, flags }) => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ rule: { id: 'saved-rule' } })));
	vi.stubGlobal('fetch', fetch);
	const rule: CleanupRule = { id: 'rule-1', name: 'Regex', defaultName: null, action: 'delete', enabled: true, automatic: false, automaticConfirmed: false, condition: { type: 'not', child: { type: 'keyword', mode: 'regex', value, flags, targets: ['text'] } }, legacy: null, lastError: null };
	const view = render(RuleEditor, { props: { rule } });

	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(alert).toHaveBeenCalledOnce());
	expect(alert.mock.calls[0][0]).toMatchObject({ type: 'error', title: 'Regular Expression error', text: expect.stringMatching(/^Condition: 1\nSyntaxError:/) });
	expect(fetch).not.toHaveBeenCalled();
});

test('temporary data failures give retry guidance instead of asking the user to repair references', async () => {
 const rule: CleanupRule = { id: 'rule-1', name: 'Protection', defaultName: null, action: 'keep', enabled: true, automatic: false, automaticConfirmed: false, condition: { type: 'flag', field: 'pinned', value: true }, legacy: null, lastError: { ruleId: 'rule-1', code: 'TEMPORARY_FAILURE', path: 'condition', message: 'Database read failed', userActionable: false } };
 const view = render(RuleEditor, { props: { rule } });
 expect(view.getByText('Temporarily unable to check keep rules. New deletions are paused for safety. Try again later.')).toBeTruthy();
 expect(view.queryByRole('button', { name: 'Select or repair references' })).toBeNull();
});

test('age summaries use the exact unit the field editor shows without rounding the stored seconds', () => {
	expect(summary({ type: 'age', operator: 'gte', seconds: 30 * 86400 })).toBe('At least 30 day(s) old');
	expect(summary({ type: 'age', operator: 'lt', seconds: 1.5 * 86400 })).toBe('Less than 36 hour(s) old');
	expect(summary({ type: 'age', operator: 'lte', seconds: 5400 })).toBe('At most 90 minute(s) old');
	expect(summary({ type: 'age', operator: 'gt', seconds: 90061 })).toBe('More than 90061 second(s) old');
	expect(summary({ type: 'age', operator: 'gt', seconds: 0.5 })).toBe('More than 0.5 second(s) old');
	expect(summary({ type: 'age', operator: 'gte', seconds: 86400.25 })).toBe('At least 86400.25 second(s) old');
});

test('age and count summaries read in each locale\'s word order and keep every comparison boundary', () => {
	// 언어마다 실패를 모두 남기도록 soft 단언을 쓴다.
	const age = (operator: 'gte' | 'gt' | 'lte' | 'lt', seconds: number) => summary({ type: 'age', operator, seconds });
	const count = (operator: 'gte' | 'gt' | 'lte' | 'lt', field: 'reactions' | 'renotes', value: number) => summary({ type: 'count', field, operator, value });
	expect.soft([age('gte', 30 * 86400), age('gt', 7200), age('lte', 5400), age('lt', 0.5)]).toEqual(['At least 30 day(s) old', 'More than 2 hour(s) old', 'At most 90 minute(s) old', 'Less than 0.5 second(s) old']);
	expect.soft([count('gte', 'reactions', 5), count('gt', 'renotes', 0), count('lte', 'reactions', 10), count('lt', 'renotes', 3)]).toEqual(['Received reactions: at least 5', 'Received renotes: more than 0', 'Received reactions: at most 10', 'Received renotes: fewer than 3']);
	activeLocale.current = 'ko-KR';
	expect.soft([age('gte', 30 * 86400), age('gt', 7200), age('lte', 5400), age('lt', 0.5)]).toEqual(['경과 기간 30일 이상', '경과 기간 2시간 초과', '경과 기간 90분 이하', '경과 기간 0.5초 미만']);
	expect.soft([count('gte', 'reactions', 5), count('gt', 'renotes', 0), count('lte', 'reactions', 10), count('lt', 'renotes', 3)]).toEqual(['받은 리액션 수 5 이상', '받은 리노트 수 0 초과', '받은 리액션 수 10 이하', '받은 리노트 수 3 미만']);
	activeLocale.current = 'ja-JP';
	expect.soft([age('gte', 30 * 86400), age('gt', 7200), age('lte', 5400), age('lt', 0.5)]).toEqual(['経過期間が30日以上', '経過期間が2時間を超える', '経過期間が90分以下', '経過期間が0.5秒未満']);
	expect.soft([count('gte', 'reactions', 5), count('gt', 'renotes', 0), count('lte', 'reactions', 10), count('lt', 'renotes', 3)]).toEqual(['受け取ったリアクション数が5以上', '受け取ったリノート数が0を超える', '受け取ったリアクション数が10以下', '受け取ったリノート数が3未満']);
	// 기존 키워드·묶음·NOT 요약 형식은 그대로 둔다.
	activeLocale.current = 'en-US';
	expect.soft(summary({ type: 'keyword', mode: 'literal', value: '고양이', flags: '', targets: ['text', 'cw'] })).toBe('Literal keyword: 고양이 [Text, CW]');
	expect.soft(summary({ type: 'all', children: [] })).toBe('Match all (0)');
	expect.soft(summary({ type: 'not', child: { type: 'count', field: 'reactions', operator: 'gte', value: 5 } })).toBe('Invert condition: Received reactions: at least 5');
});

test('the move menu omits groups whose move would be refused and keeps undoable sibling or ancestor moves', async () => {
	// 1 › 1 › … › 1 은 깊이 7의 묶음이라 하위가 있는 조건을 넣으면 깊이 제한을 넘는다.
	let chain: Condition = { type: 'flag', field: 'pinned', value: true };
	for (let i = 0; i < 7; i++) chain = { type: 'all', children: [chain] };
	const mover: Condition = { type: 'any', children: [{ type: 'hashtag', value: '기록' }] };
	const condition: Condition = { type: 'all', children: [chain, mover] };
	const rule: CleanupRule = { id: 'rule-1', name: 'Move', defaultName: null, action: 'keep', enabled: true, automatic: false, automaticConfirmed: false, condition, legacy: null, lastError: null };
	const view = render(RuleEditor, { props: { rule } });
	await fireEvent.click(view.getByRole('button', { name: 'Move second condition' }));
	expect(popupMenu).toHaveBeenCalledTimes(1);
	const items = popupMenu.mock.calls[0][0] as { text: string; action: () => void }[];
	const texts = items.map(item => item.text);
	expect(texts).toEqual(['Root', '1', '1 › 1', '1 › 1 › 1', '1 › 1 › 1 › 1', '1 › 1 › 1 › 1 › 1', '1 › 1 › 1 › 1 › 1 › 1']);
	expect(texts).not.toContain('2');
	items.find(item => item.text === '1')!.action();
	await waitFor(() => expect(JSON.parse(view.getByTestId('condition').textContent!)).toEqual({ type: 'all', children: [{ ...chain, children: [...(chain as { children: Condition[] }).children, mover] }] }));
	expect(view.queryByText('Condition count or depth limit exceeded.')).toBeNull();
	await fireEvent.click(view.getByRole('button', { name: 'Undo' }));
	expect(JSON.parse(view.getByTestId('condition').textContent!)).toEqual(condition);
	await fireEvent.click(view.getByRole('button', { name: 'Redo' }));
	expect(JSON.parse(view.getByTestId('condition').textContent!).children).toHaveLength(1);
});

test('기본 이름은 세 언어를 따르고 조건만 저장할 때 이름을 명시하지 않는다', async () => {
 const calls: any[] = [];
 vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ rule: { id: 'default' } })); });
 const rule = { id: 'default', name: '고정한 내 글', defaultName: 'pinned', action: 'keep', enabled: true, automatic: false, automaticConfirmed: false, legacy: null, lastError: null, condition: { type: 'flag', field: 'pinned', value: true } } as CleanupRule;
 for (const [language, label] of [['en-US', 'My pinned notes'], ['ko-KR', '고정한 내 글'], ['ja-JP', 'ピン留めした自分のノート']] as const) {
 activeLocale.current = language;
 const view = render(RuleEditor, { props: { rule } });
 expect((view.container.querySelector('input') as HTMLInputElement).value).toBe(label);
 await fireEvent.click(view.getByRole('button', { name: 'Enter condition' }));
 await fireEvent.click(view.getByRole('button', { name: language === 'en-US' ? 'Save' : language === 'ko-KR' ? '저장' : '保存' }));
 await waitFor(() => expect(calls.length).toBeGreaterThan(0));
 expect(calls.at(-1)).not.toHaveProperty('name');
 cleanup();
 }
});
test('기본 문구와 같은 사용자 입력도 명시 이름으로 저장하고 되돌리기는 출처도 복원한다', async () => {
 const calls: any[] = [];
 vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ rule: { id: 'default' } })); });
 const rule = { id: 'default', name: '고정한 내 글', defaultName: 'pinned', action: 'keep', enabled: true, automatic: false, automaticConfirmed: false, legacy: null, lastError: null, condition: { type: 'flag', field: 'pinned', value: true } } as CleanupRule;
 const view = render(RuleEditor, { props: { rule } });
 await fireEvent.update(view.getByLabelText('Rule name'), '고정한 내 글');
 await fireEvent.click(view.getByRole('button', { name: 'Undo' }));
 expect((view.getByLabelText('Rule name') as HTMLInputElement).value).toBe('My pinned notes');
 await fireEvent.click(view.getByRole('button', { name: 'Redo' }));
 await fireEvent.click(view.getByRole('button', { name: 'Save' }));
 await waitFor(() => expect(calls).toHaveLength(1));
 expect(calls[0].name).toBe('고정한 내 글');
});

test('규칙 켜기끄기와 삭제 확인창은 번역한 기본 이름을 표시한다', async () => {
 const rule = { id: 'default', name: '고정한 내 글', defaultName: 'pinned', action: 'keep', enabled: true, automatic: false, automaticConfirmed: false, legacy: null, lastError: null, condition: { type: 'flag', field: 'pinned', value: true } } as CleanupRule;
 const view = render(RuleEditor, { props: { rule } });
 await fireEvent.click(view.getByRole('button', { name: 'Menu' }));
 const items = popupMenu.mock.calls[0][0];
 await items[0].action();
 expect(confirm.mock.calls[0][0].title).toContain('My pinned notes');
 await items[1].action();
 expect(confirm.mock.calls[1][0].title).toBe('My pinned notes');
});

test('summaries show one hashtag marker and selection counts instead of reference IDs', () => {
 expect(summary({ type: 'hashtag', value: '#tag' })).toBe('#tag');
 expect(summary({ type: 'clip', ids: ['private-id'] })).toBe('My clips: 1 selected');
 expect(summary({ type: 'channel', ids: ['channel-id', 'other-id'] })).toBe('Channel: 2 selected');
});
test('missing clip explains repair without diagnostic fields', () => {
 const rule: CleanupRule = { id: 'rule-1', name: 'Protection', defaultName: null, action: 'keep', enabled: true, automatic: false, automaticConfirmed: false, condition: { type: 'clip', ids: ['secret-id'] }, legacy: null, lastError: { ruleId: 'rule-1', code: 'MISSING_CLIP', path: 'condition.children.0', referenceId: 'secret-id', message: 'MISSING_CLIP', userActionable: true } };
 const view = render(RuleEditor, { props: { rule } });
 expect(view.getByText('A selected clip is unavailable. Choose another clip or change this condition.')).toBeTruthy();
 expect(view.getByRole('alert').textContent).not.toMatch(/MISSING_CLIP|condition.children.0|secret-id/);
});

test.each(['CLEANUP_BUSY', 'TEMPORARY_FAILURE'])('request failure %s keeps the draft, invalidates confirmation and offers no condition repair', async code => {
 vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'INVALID_CLEANUP', info: { code, path: 'condition.children.0' } } }), { status: 503 }));
 const view = render(RuleEditor);
 await fireEvent.update(view.getByLabelText('Rule name'), 'Retained name');
 await fireEvent.click(view.getByRole('button', { name: 'Enter condition' }));
 await fireEvent.click(view.getByRole('button', { name: 'Save' }));
 await view.findByText(code === 'CLEANUP_BUSY' ? 'Note cleanup is busy. Please wait a moment and try again.' : 'Temporarily unable to complete this request. Try again later.');
 expect((view.getByLabelText('Rule name') as HTMLInputElement).value).toBe('Retained name');
 expect(view.queryByRole('button', { name: 'Select or repair references' })).toBeNull();
 expect(view.getByRole('alert').textContent).not.toMatch(/INVALID_CLEANUP|condition.children|Repair/);
});

test.each(['keep', 'delete'] as const)('편집기는 %s 임시 오류의 실제 영향을 안내한다', action => {
 const rule: CleanupRule = { id: 'r', name: 'Failed rule', defaultName: null, action, enabled: true, automatic: false, automaticConfirmed: false, legacy: null, condition: { type: 'age', operator: 'gte', seconds: 60 }, lastError: { ruleId: 'r', code: 'TEMPORARY_FAILURE', path: 'condition', message: '', userActionable: false } };
 const view = render(RuleEditor, { props: { rule } });
 expect(view.getByText(action === 'keep' ? 'Temporarily unable to check keep rules. New deletions are paused for safety. Try again later.' : 'Temporarily unable to check this delete rule. It is excluded; other delete rules can still apply. Try again later.')).toBeTruthy();
});
