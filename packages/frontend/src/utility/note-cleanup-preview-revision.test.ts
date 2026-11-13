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
vi.mock('@/pages/settings/note-cleanup/RuleEditor.vue', () => ({ default: defineComponent({
	emits: ['saved', 'refresh'],
	setup: (_, { emit }) => () => h('div', [
		h('button', { onClick: () => emit('saved', 'delete') }, 'Save condition'),
		h('button', { onClick: () => emit('saved', 'keep') }, 'Save protection'),
		h('button', { onClick: () => emit('saved') }, 'Delete protection'),
		h('button', { onClick: () => emit('refresh') }, 'Change activation'),
	]),
}) }));
import Settings from '@/pages/settings/note-cleanup.vue';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const rules = [
	{ id: 'delete', name: 'Delete rule', action: 'delete', enabled: true },
	{ id: 'keep', name: 'Keep rule', action: 'keep', enabled: true },
];
const page = (text: string) => ({
	rules, items: [{ noteId: text, text, createdAt: '2026-01-01T00:00:00.000Z', deleteRuleIds: ['delete'], keepRuleIds: ['keep'], reason: 'protected' }],
	scanned: 1, deleteCount: 0, protectedCount: 1, errors: [], complete: true, nextCursor: null,
});

// 편집기의 기존 이벤트만 모형으로 보내고 부모와 미리 보기는 실제 컴포넌트를 사용한다.
test.each(['Save condition', 'Save protection', 'Delete protection', 'Change activation', 'Refresh'])(
	'%s invalidates the real list preview and ignores its late response', async event => {
		let finishPreview!: (response: Response) => void;
		let finishList!: (response: Response) => void;
		let listCalls = 0;
		let previewCalls = 0;
		const requests: string[] = [];
		const updatedRules = event === 'Delete protection' ? [rules[0]] : rules.map(rule => ({
			...rule, enabled: event === 'Change activation' && rule.id === 'keep' ? false : rule.enabled, condition: { type: 'all' },
		}));
		vi.stubGlobal('fetch', async (url: string) => {
			requests.push(url);
			if (url.endsWith('/list')) {
				if (++listCalls === 1) return new Response(JSON.stringify({ rules, blocked: false, migrated: false }));
				return new Promise<Response>(resolve => { finishList = resolve; });
			}
			if (++previewCalls === 2) return new Promise<Response>(resolve => { finishPreview = resolve; });
			return new Response(JSON.stringify(page(previewCalls === 1 ? 'old result' : 'current result')));
		});
		const view = render(Settings, { global: { stubs: {
			SearchMarker: { template: '<div><slot/></div>' }, SearchLabel: { template: '<div><slot/></div>' }, SearchText: { template: '<div><slot/></div>' }, MkA: { template: '<a><slot/></a>' },
		} } });
		await view.findByRole('button', { name: 'Delete rule' });
		await fireEvent.click(view.getByRole('checkbox'));
		await fireEvent.click(view.getByRole('button', { name: 'Preview saved rules' }));
		await view.findAllByText('old result');
		await fireEvent.click(view.getByRole('button', { name: event }));
		await waitFor(() => expect(view.queryAllByText('old result')).toHaveLength(0));
		expect((view.getByRole('button', { name: 'Preview saved rules' }) as HTMLButtonElement).disabled).toBe(true);
		finishList(new Response(JSON.stringify({ rules: updatedRules, blocked: false, migrated: false })));
		await waitFor(() => expect((view.getByRole('button', { name: 'Preview saved rules' }) as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(view.getByRole('button', { name: 'Preview saved rules' }));
		await fireEvent.click(view.getByRole('button', { name: event }));
		finishPreview(new Response(JSON.stringify(page('late result'))));
		finishList(new Response(JSON.stringify({ rules: updatedRules, blocked: false, migrated: false })));
		await waitFor(() => expect((view.getByRole('button', { name: 'Preview saved rules' }) as HTMLButtonElement).disabled).toBe(false));
		expect(view.queryAllByText('late result')).toHaveLength(0);
		await fireEvent.click(view.getByRole('button', { name: 'Preview saved rules' }));
		await view.findAllByText('current result');
		expect(requests).toHaveLength(6);
		expect(requests.every(url => url.endsWith('/list') || url.endsWith('/preview'))).toBe(true);
	},
);
