/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, h } from 'vue';

vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token', policies: {} }, ensureSignin: () => {}, iAmModerator: false }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locales = Object.fromEntries(['en-US', 'ko-KR', 'ja-JP'].map(language => [language, load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as Locale]));
	return { i18n: new I18n(locales['en-US'], false) };
});
vi.mock('@/page.js', () => ({ definePage: () => {} }));
vi.mock('@/os.js', () => ({ confirm: async () => ({ canceled: true }) }));
vi.mock('@/pages/_loading_.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/pages/_error_.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/pages/timeline.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
 props: ['disabled'], emits: ['click'],
 setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()),
}) }));
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
vi.mock('@/pages/settings/note-cleanup/Preview.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
vi.mock('@/components/MkSelect.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
vi.mock('@/components/MkTextarea.vue', () => ({ default: defineComponent({ setup: () => () => h('textarea') }) }));
vi.mock('@/utility/autocomplete.js', () => ({ Autocomplete: class {} }));
vi.mock('@/pages/settings/note-cleanup/ConditionEditor.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
import Settings from '@/pages/settings/note-cleanup.vue';
import ConditionFields from '@/pages/settings/note-cleanup/ConditionFields.vue';
import { summary } from '@/pages/settings/note-cleanup/labels.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('목록과 실제 편집기 요청은 보호 차단과 재조회 회복을 함께 따른다', async () => {
 const rule = { id: 'r', name: 'Delete rule', defaultName: null, action: 'delete', enabled: true, automatic: false, automaticConfirmed: false, legacy: null, condition: { type: 'hashtag', value: '#tag' } };
 let blocked = true;
 const requests: string[] = [];
 vi.stubGlobal('fetch', async (url: string) => {
  requests.push(url);
  return new Response(JSON.stringify(url.endsWith('/list') ? { rules: [rule], migrated: false, blocked } : { queued: true }));
 });
 const view = render(Settings, { global: { stubs: { SearchMarker: { template: '<div><slot/></div>' }, SearchLabel: { template: '<div><slot/></div>' }, SearchText: { template: '<div><slot/></div>' } } } });
 await view.findByRole('button', { name: 'Delete rule' });
 await fireEvent.click(view.getByRole('button', { name: 'Delete rule' }));
 await fireEvent.click(view.getByRole('checkbox', { name: 'Request cleanup' }));
 const editorRequest = () => view.getByRole('button', { name: /^Request cleanup$/ }) as HTMLButtonElement;
 const listRequest = () => view.getByRole('button', { name: 'Request cleanup (1)' }) as HTMLButtonElement;
 expect(view.getByRole('alert').textContent).toContain('New deletions are paused');
 expect(listRequest().disabled).toBe(true);
 expect(editorRequest().disabled).toBe(true);
 await fireEvent.click(editorRequest());
 expect(requests.filter(url => url.endsWith('/request'))).toHaveLength(0);
 blocked = false;
 await fireEvent.click(view.getByRole('button', { name: 'Refresh' }));
 await waitFor(() => expect(listRequest().disabled).toBe(false));
 expect(editorRequest().disabled).toBe(false);
 expect(view.queryByRole('alert')).toBeNull();
 await fireEvent.click(editorRequest());
 await waitFor(() => expect(requests.filter(url => url.endsWith('/request'))).toHaveLength(1));
});

test.each(['tag', '#tag', '##tag'])('실제 태그 입력은 %s 원문과 요약을 유지하고 고정 #를 더하지 않는다', async value => {
 const onUpdate = vi.fn();
 const view = render(ConditionFields, { props: { condition: { type: 'hashtag', value: '' }, onUpdate } });
 const input = view.container.querySelector('input') as HTMLInputElement;
 await fireEvent.update(input, value);
 await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ type: 'hashtag', value }));
 expect(input.value).toBe(value);
 expect(view.container.textContent).not.toContain('#');
 expect(summary({ type: 'hashtag', value })).toBe('#tag');
});
