/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent, h } from 'vue';

vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token' } }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locales = Object.fromEntries(['en-US', 'ko-KR', 'ja-JP'].map(language => [language, load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as Locale]));
	return { i18n: new I18n(locales['en-US'], false) };
});
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
	props: ['disabled'], emits: ['click'],
	setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()),
}) }));
// 노트·결과·로딩 등 말단 표현만 대체하고 타임라인과 페이지네이션은 실제 컴포넌트를 연결한다.
vi.mock('@/components/MkNote.vue', () => ({ default: defineComponent({
	props: ['note'],
	setup: (props) => () => h('div', { 'data-testid': 'note' }, props.note.text),
}) }));
vi.mock('@/components/global/MkLoading.vue', () => ({ default: defineComponent({ setup: () => () => h('div', 'loading') }) }));
vi.mock('@/components/MkError.vue', () => ({ default: defineComponent({ setup: () => () => h('div', 'error') }) }));
vi.mock('@/components/MkAd.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
vi.mock('@/components/MkPullToRefresh.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
vi.mock('@/components/MkPaginationControl.vue', () => ({ default: defineComponent({ setup: () => () => h('div') }) }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { animation: false, enablePullToRefresh: false }, r: { enableInfiniteScroll: { value: false } } } }));
vi.mock('@/events.js', () => ({ globalEvents: { on: () => {}, off: () => {}, emit: () => {} }, useGlobalEvent: () => {} }));
vi.mock('@/os.js', () => ({ contextMenu: vi.fn() }));
import Preview from '@/pages/settings/note-cleanup/Preview.vue';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const note = (id: string, text: string) => ({ id, text, createdAt: '2026-01-01T00:00:00.000Z', userId: 'me', user: { id: 'me' } });
const page = (notes: unknown[], nextCursor: string | null, complete: boolean) => ({ notes, nextCursor, complete, errors: [], rules: [{ id: 'delete', name: 'Old notes', defaultName: null, action: 'delete' }] });
// MkResult はグローバル登録コンポーネントなので名前解決でスタブを渡す。
const MkResult = defineComponent({
	props: ['type', 'text'],
	setup: (props) => () => h('div', { 'data-testid': 'result' }, props.text ?? props.type),
});
const renderPreview = () => render(Preview, {
	props: { ruleId: 'delete', version: 0 },
	global: { components: { MkResult }, stubs: { MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' } }, directives: { appear: {} } },
});

test('an empty first candidate page still offers loading the next scan range', async () => {
	const requests: { afterId?: string }[] = [];
	vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string);
		requests.push(body);
		return new Response(JSON.stringify(body.afterId
			? page([note('n101', 'later candidate')], null, true)
			: page([], 'cursor-100', false)));
	});
	const view = renderPreview();
	await view.findByTestId('result');
	expect(view.getByTestId('result').textContent).toBe('No notes');
	// 첫 검사 범위에 후보가 없어도 다음 범위로 갈 수 있어야 한다.
	await fireEvent.click(view.getByRole('button', { name: 'Load more' }));
	await view.findByText('later candidate');
	expect(requests.map(request => request.afterId)).toEqual([undefined, 'cursor-100']);
	expect(view.queryByTestId('result')).toBeNull();
});

test('a completed scan with no candidates offers no next page', async () => {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify(page([], null, true))));
	vi.stubGlobal('fetch', fetchMock);
	const view = renderPreview();
	await view.findByTestId('result');
	expect(view.queryByRole('button', { name: 'Load more' })).toBeNull();
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('candidates on the first page keep the normal timeline pagination', async () => {
	const requests: { afterId?: string }[] = [];
	vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string);
		requests.push(body);
		return new Response(JSON.stringify(body.afterId
			? page([note('n2', 'second page')], null, true)
			: page([note('n1', 'first page')], 'cursor-1', false)));
	});
	const view = renderPreview();
	await view.findByText('first page');
	await fireEvent.click(view.getByRole('button', { name: 'Load more' }));
	await view.findByText('second page');
	expect(requests.map(request => request.afterId)).toEqual([undefined, 'cursor-1']);
	expect(view.getAllByTestId('note')).toHaveLength(2);
});
