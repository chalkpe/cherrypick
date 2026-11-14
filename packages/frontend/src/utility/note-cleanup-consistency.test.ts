/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { Suspense, defineComponent, h } from 'vue';

vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token' }, ensureSignin: () => ({ id: 'me' }) }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locales = Object.fromEntries(['en-US', 'ko-KR', 'ja-JP'].map(language => [language, load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as Locale]));
	return { i18n: new I18n(locales['en-US'], false) };
});
vi.mock('@/page.js', () => ({ definePage: () => {} }));
const push = vi.hoisted(() => vi.fn());
vi.mock('@/router.js', () => ({ useRouter: () => ({ push }) }));
const popupMenu = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/os.js', () => ({ confirm: vi.fn(async () => ({ canceled: true })), popupMenu, alert: vi.fn(async () => {}), toast }));
vi.mock('@/components/MkInput.vue', () => ({ default: defineComponent({
	props: ['modelValue'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('label', [slots.label?.(), h('input', { value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) })]),
}) }));
vi.mock('@/components/MkTextarea.vue', () => ({ default: defineComponent({
	props: ['modelValue'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('div', [h('label', [slots.label?.(), h('textarea', { value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value) })]), h('div', slots.caption?.())]),
}) }));
vi.mock('@/components/MkSelect.vue', () => ({ default: defineComponent({
	props: ['modelValue', 'items'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('label', [slots.label?.(), h('select', { value: props.modelValue, onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value) }, (props.items ?? []).map((item: { value: string; label: string }) => h('option', { value: item.value }, item.label)))]),
}) }));
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
	props: ['disabled'], emits: ['click'],
	setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: (event: MouseEvent) => emit('click', event) }, slots.default?.()),
}) }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: defineComponent({
	props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('button', {
		role: 'switch', 'aria-checked': props.modelValue ? 'true' : 'false', disabled: props.disabled,
		onClick: () => { if (!props.disabled) emit('update:modelValue', !props.modelValue); },
	}, slots.default?.()),
}) }));
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
vi.mock('@/components/MkFolder.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', [slots.label?.(), slots.default?.()]) }) }));
vi.mock('@/components/MkDraggable.vue', () => ({ default: defineComponent({
	props: ['modelValue'],
	setup: (props, { slots }) => () => h('div', props.modelValue.map((item: unknown, index: number) => slots.default?.({ item, index, dragStart: () => {} }))),
}) }));
vi.mock('@/pages/settings/note-cleanup/Preview.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
import type { NoteCleanupCondition as Condition } from 'cherrypick-js/entities.js';
import type { CleanupRule } from '@/utility/note-cleanup-api.js';
import ConditionEditor from '@/pages/settings/note-cleanup/ConditionEditor.vue';
import ConditionFields from '@/pages/settings/note-cleanup/ConditionFields.vue';
import EditPage from '@/pages/settings/note-cleanup.edit.vue';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); popupMenu.mockReset(); toast.mockClear(); push.mockClear(); });

test('changing the header type restarts the condition with the new type defaults', async () => {
	const onChange = vi.fn();
	const condition: Condition = { type: 'all', children: [{ type: 'hashtag', value: '태그' }] };
	const view = render(ConditionEditor, { props: { condition, path: [], onChange } });
	await fireEvent.update(view.container.querySelector('select')!, 'keyword');
	expect(onChange).toHaveBeenCalledWith([], { type: 'keyword', mode: 'literal', value: '', flags: '', targets: ['text', 'cw', 'poll'] });
	await fireEvent.update(view.container.querySelector('select')!, 'flag:pinned');
	expect(onChange).toHaveBeenCalledWith([], { type: 'flag', field: 'pinned', value: true });
});

test('groups add keyword conditions and the dots menu offers icon actions limited by position', async () => {
	const onChange = vi.fn();
	const onDuplicate = vi.fn();
	const onShift = vi.fn();
	const condition: Condition = { type: 'all', children: [{ type: 'hashtag', value: '첫째' }, { type: 'hashtag', value: '둘째' }] };
	const view = render(ConditionEditor, { props: { condition, path: [], onChange, onDuplicate, onShift } });
	await fireEvent.click(view.getByRole('button', { name: 'Add condition' }));
	expect(onChange).toHaveBeenCalledWith([], { type: 'all', children: [...condition.children, { type: 'keyword', mode: 'literal', value: '', flags: '', targets: ['text', 'cw', 'poll'] }] });
	const menus = view.getAllByRole('button', { name: 'Menu' });
	expect(menus).toHaveLength(2);
	await fireEvent.click(menus[0]);
	let items = popupMenu.mock.calls[0][0] as { icon: string; text: string; action: () => void }[];
	expect(items.map(item => item.icon)).toEqual(['ti ti-copy', 'ti ti-arrow-down', 'ti ti-arrows-move']);
	items[0].action();
	expect(onDuplicate).toHaveBeenCalledWith([0]);
	await fireEvent.click(menus[1]);
	items = popupMenu.mock.calls[1][0];
	expect(items.map(item => item.icon)).toEqual(['ti ti-copy', 'ti ti-arrow-up', 'ti ti-arrows-move']);
	items[1].action();
	expect(onShift).toHaveBeenCalledWith([1], -1);
	// 최상위 조건에는 복제·이동·삭제 메뉴가 없다.
	expect(view.container.querySelector('[data-condition-path=""] > div > button[aria-label="Menu"]')).toBeNull();
});

test('keyword fields accept multiple lines and regex lives in the advanced folder', async () => {
	const onUpdate = vi.fn();
	const view = render(ConditionFields, { props: { condition: { type: 'keyword', mode: 'literal', value: '', flags: '', targets: ['text'] }, onUpdate } });
	expect(view.getByText('Separate multiple keywords with line breaks.')).toBeTruthy();
	await fireEvent.update(view.container.querySelector('textarea')!, '고양이\n강아지');
	expect(onUpdate).toHaveBeenCalledWith({ type: 'keyword', mode: 'literal', value: '고양이\n강아지', flags: '', targets: ['text'] });
	expect(view.getByText('Advanced settings')).toBeTruthy();
	await fireEvent.click(view.getByRole('switch', { name: 'Use regular expressions' }));
	expect(onUpdate).toHaveBeenCalledWith({ type: 'keyword', mode: 'regex', value: '', flags: '', targets: ['text'] });
});

// 해시태그 입력은 원문 그대로 내보내고 어떤 조건도 입력값 요약 줄을 만들지 않는다.
test.each([['tag'], ['#tag'], ['##tag']])('hashtag input keeps the raw value %s without a summary line', async value => {
	const onUpdate = vi.fn();
	const view = render(ConditionFields, { props: { condition: { type: 'hashtag', value: '' }, onUpdate } });
	await fireEvent.update(view.container.querySelector('input')!, value);
	expect(onUpdate).toHaveBeenCalledWith({ type: 'hashtag', value });
	expect(view.container.textContent).not.toContain('#');
});

function renderEdit(rule: CleanupRule) {
	vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/list') ? { rules: [rule], blocked: false } : { rule })));
	const Host = defineComponent({ setup: () => () => h('div', [h(Suspense, null, { default: () => h(EditPage, { ruleId: rule.id }), fallback: () => h('div', 'loading') })]) });
	return render(Host);
}

const baseRule = (condition: Condition): CleanupRule => ({
	id: 'r', name: 'Rule', defaultName: null, action: 'keep', enabled: true, automatic: false, automaticConfirmed: false, legacy: null, condition, lastError: null,
});

test('the move menu lists only reachable groups and moving appends to the chosen group', async () => {
	const mover: Condition = { type: 'any', children: [{ type: 'hashtag', value: '기록' }] };
	const condition: Condition = { type: 'all', children: [{ type: 'all', children: [{ type: 'flag', field: 'pinned', value: true }] }, mover] };
	const view = renderEdit(baseRule(condition));
	await view.findByLabelText('Rule name');
	await fireEvent.click(view.container.querySelector('[data-condition-path="1"] > div > button[aria-label="Menu"]')!);
	const conditionMenu = popupMenu.mock.calls[0][0] as { text: string; action: () => void }[];
	conditionMenu.find(item => item.text === 'Move to another group')!.action();
	const items = popupMenu.mock.calls[1][0] as { text: string; action: () => void }[];
	expect(items.map(item => item.text)).toEqual(['Root', 'Match all 1']);
	items[1].action();
	await waitFor(() => expect(toast).toHaveBeenCalledWith('Condition moved.'));
	const moved = view.container.querySelector('[data-condition-path="0.1"] input') as HTMLInputElement;
	await waitFor(() => expect(moved?.value).toBe('기록'));
	expect(view.container.querySelector('[data-condition-path="1"]')).toBeNull();
});

test('duplicating a condition copies its value without sharing the reactive original', async () => {
	const condition: Condition = { type: 'all', children: [{ type: 'hashtag', value: '원본' }] };
	const view = renderEdit(baseRule(condition));
	await view.findByLabelText('Rule name');
	await fireEvent.click(view.container.querySelector('[data-condition-path="0"] > div > button[aria-label="Menu"]')!);
	const items = popupMenu.mock.calls[0][0] as { text: string; action: () => void }[];
	items.find(item => item.text === 'Duplicate')!.action();
	await waitFor(() => expect(view.container.querySelector('[data-condition-path="1"] input')).not.toBeNull());
	const copied = view.container.querySelector('[data-condition-path="1"] input') as HTMLInputElement;
	expect(copied.value).toBe('원본');
	await fireEvent.update(copied, '복제');
	expect((view.container.querySelector('[data-condition-path="0"] input') as HTMLInputElement).value).toBe('원본');
	expect((view.container.querySelector('[data-condition-path="1"] input') as HTMLInputElement).value).toBe('복제');
});

test('moving into a group that would exceed the depth limit shows the limit message', async () => {
	let chain: Condition = { type: 'flag', field: 'pinned', value: true };
	for (let i = 0; i < 7; i++) chain = { type: 'all', children: [chain] };
	const mover: Condition = { type: 'any', children: [{ type: 'hashtag', value: '기록' }] };
	const view = renderEdit(baseRule({ type: 'all', children: [chain, mover] }));
	await view.findByLabelText('Rule name');
	await fireEvent.click(view.container.querySelector('[data-condition-path="1"] > div > button[aria-label="Menu"]')!);
	const conditionMenu = popupMenu.mock.calls[0][0] as { text: string; action: () => void }[];
	conditionMenu.find(item => item.text === 'Move to another group')!.action();
	const items = popupMenu.mock.calls[1][0] as { text: string; action: () => void }[];
	expect(items.map(item => item.text)).toEqual(['Root', 'Match all 1', 'Match all 2', 'Match all 3', 'Match all 4', 'Match all 5', 'Match all 6', 'Match all 7']);
	items.at(-1)!.action();
	await view.findByText('Condition count or depth limit exceeded.');
	expect(toast).not.toHaveBeenCalled();
});
