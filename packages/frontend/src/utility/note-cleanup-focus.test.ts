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
vi.mock('@/os.js', () => ({ confirm: vi.fn(async () => ({ canceled: true })), popupMenu: vi.fn(), alert: vi.fn(async () => {}), toast: vi.fn() }));
vi.mock('@/components/MkInput.vue', () => ({ default: defineComponent({
	props: ['modelValue'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('label', [slots.label?.(), h('input', { value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) })]),
}) }));
vi.mock('@/components/MkTextarea.vue', () => ({ default: defineComponent({
	props: ['modelValue'], emits: ['update:modelValue'],
	setup: (props, { slots, emit }) => () => h('label', [slots.label?.(), h('textarea', { value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value) })]),
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
import type { CleanupRule } from '@/utility/note-cleanup-api.js';
import EditPage from '@/pages/settings/note-cleanup.edit.vue';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockClear(); });

function renderEdit(rule: CleanupRule) {
	vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/list') ? { rules: [rule], blocked: false } : { rule })));
	const Host = defineComponent({ setup: () => () => h('div', [h(Suspense, null, { default: () => h(EditPage, { ruleId: rule.id }), fallback: () => h('div', 'loading') })]) });
	return render(Host);
}

const base: CleanupRule = {
	id: 'r', name: 'Rule', defaultName: null, action: 'keep', enabled: true, automatic: false, automaticConfirmed: false, legacy: null,
	condition: { type: 'all', children: [{ type: 'all', children: [{ type: 'hashtag', value: 'target' }] }, { type: 'all', children: [{ type: 'hashtag', value: 'sibling' }] }] },
	lastError: null,
};

test('reveal moves focus into the exact failing condition without touching its sibling', async () => {
	const view = renderEdit({ ...base, lastError: { ruleId: 'r', code: 'MISSING_CLIP', path: 'condition.children.0.children.0', message: 'MISSING_CLIP' } } as CleanupRule);
	await view.findByRole('button', { name: 'Edit' });
	await fireEvent.click(view.getByRole('button', { name: 'Edit' }));
	const target = view.container.querySelector('[data-condition-path="0.0"]')!;
	await waitFor(() => expect(target.contains(window.document.activeElement)).toBe(true));
	expect(window.document.activeElement?.tagName).toBe('INPUT');
	const sibling = view.container.querySelector('[data-condition-path="1.0"]')!;
	expect(sibling.contains(window.document.activeElement)).toBe(false);
});

test('a group-level error focuses the group itself instead of the first child input', async () => {
	const view = renderEdit({ ...base, lastError: { ruleId: 'r', code: 'INVALID_CONDITION', path: 'condition', message: 'INVALID_CONDITION' } } as CleanupRule);
	await view.findByRole('button', { name: 'Edit' });
	await fireEvent.click(view.getByRole('button', { name: 'Edit' }));
	await waitFor(() => expect(window.document.activeElement).toBe(view.container.querySelector('[data-condition-path=""]')));
});

test('saving an incomplete draft focuses the first incomplete field', async () => {
	const view = renderEdit({ ...base, action: 'delete', condition: { type: 'all', children: [{ type: 'hashtag', value: 'ok' }, { type: 'keyword', mode: 'literal', value: '', flags: '', targets: ['text'] }] } } as CleanupRule);
	await view.findByLabelText('Rule name');
	await fireEvent.click(view.getByRole('button', { name: 'Save' }));
	await view.findByText('Complete the condition values, search fields and references.');
	const target = view.container.querySelector('[data-condition-path="1"]')!;
	await waitFor(() => expect(target.contains(window.document.activeElement)).toBe(true));
	expect(window.document.activeElement?.tagName).toBe('TEXTAREA');
});
