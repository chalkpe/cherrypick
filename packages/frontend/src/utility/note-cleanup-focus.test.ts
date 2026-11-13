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
const popupMenu = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn(async () => ({ canceled: true })));
vi.mock('@/os.js', () => ({ confirm, popupMenu, pageFolderTeleportCount: { value: 0 } }));
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

vi.mock('@/preferences.js', () => ({ prefer: { s: {} } }));
vi.mock('@/utility/get-bg-color.js', () => ({ getBgColor: () => 'transparent' }));
vi.mock('@/theme.js', () => ({ themeManager: { currentCompiledTheme: { panel: 'transparent' } } }));
vi.mock('@/utility/device-kind.js', () => ({ deviceKind: 'desktop' }));
vi.mock('@/utility/haptic.js', () => ({ haptic: () => {} }));
vi.mock('@/components/MkFolderPage.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/pages/settings/note-cleanup/ConditionFields.vue', () => ({ default: defineComponent({ setup: () => () => h('input') }) }));
vi.mock('@/pages/settings/note-cleanup/ConditionPicker.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/components/MkDraggable.vue', () => ({ default: defineComponent({ props: ['modelValue'], setup: (props, { slots }) => () => h('div', props.modelValue.map((item: unknown, index: number) => slots.default?.({ item, index, dragStart: () => {} }))) }) }));
import RuleEditor from '@/pages/settings/note-cleanup/RuleEditor.vue';
afterEach(() => cleanup());
test('real ConditionEditor and MkFolder reveal only the error ancestors and preserve a closed sibling', async () => {
 const condition = { type: 'all', children: [{ type: 'all', children: [{ type: 'hashtag', value: 'target' }] }, { type: 'all', children: [{ type: 'hashtag', value: 'sibling' }] }] };
 const rule = { id: 'r', name: 'Rule', defaultName: null, action: 'keep', enabled: true, automatic: false, automaticConfirmed: false, legacy: null, condition, lastError: { code: 'MISSING_CLIP', path: 'condition.children.0.children.0' } };
 const view = render(RuleEditor, { props: { rule: rule as never }, global: { stubs: { MkStickyContainer: { template: '<div><slot name="header"/><slot/><slot name="footer"/></div>' }, MkCondensedLine: { template: '<span><slot/></span>' } } } });
 const header = (path: string) => view.container.querySelector(`[data-condition-path="${path}"] > [role="group"] [data-testid="folder-header"]`)!;
 await fireEvent.click(header('1'));
 await waitFor(() => expect(header('1').getAttribute('aria-expanded')).toBe('false'));
 await fireEvent.click(header('0'));
 await fireEvent.click(header(''));
 await fireEvent.click(view.getByRole('button', { name: 'Select or repair references' }));
 await waitFor(() => expect(header('').getAttribute('aria-expanded')).toBe('true'));
 await waitFor(() => expect(header('0').getAttribute('aria-expanded')).toBe('true'));
 expect(header('1').getAttribute('aria-expanded')).toBe('false');
 await waitFor(() => expect(view.container.querySelector('[data-condition-path="0.0"]')?.contains(window.document.activeElement)).toBe(true));
 await view.rerender({ rule: { ...rule, lastError: { code: 'INVALID_CONDITION', path: 'condition' } } as never });
 await fireEvent.click(view.getByRole('button', { name: 'Select or repair references' }));
 await waitFor(() => expect(window.document.activeElement).toBe(view.container.querySelector('[data-condition-path=""]')));
});
