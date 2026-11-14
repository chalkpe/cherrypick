/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, h, onMounted } from 'vue';

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
// 이 시험의 버튼은 타임라인 흉내가 그리므로 미리 보기의 버튼·로딩은 말단만 대체한다.
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
	props: ['disabled'], emits: ['click'],
	setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()),
}) }));
vi.mock('@/components/global/MkLoading.vue', () => ({ default: defineComponent({ setup: () => () => h('div', 'loading') }) }));
// 실제 타임라인 대신 페이지네이터가 공급하는 노트와 다음 페이지 버튼만 그린다.
vi.mock('@/components/MkNotesTimeline.vue', () => ({ default: defineComponent({
	props: ['paginator'],
	setup: (props) => {
		onMounted(() => props.paginator.init());
		return () => h('div', [
			...props.paginator.items.value.map((note: { id: string; text: string }) => h('div', { key: note.id }, note.text)),
			props.paginator.canFetchNewer.value ? h('button', { onClick: () => props.paginator.fetchNewer() }, 'Load more') : null,
		]);
	},
}) }));
import { CleanupPreviewPaginator } from '@/utility/note-cleanup-preview.js';
import Preview from '@/pages/settings/note-cleanup/Preview.vue';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const note = (id: string, text: string) => ({ id, text, createdAt: '2026-01-01T00:00:00.000Z', userId: 'me', user: { id: 'me' } });
const page = (notes: unknown[], nextCursor: string | null, complete: boolean) => ({ notes, nextCursor, complete, errors: [], rules: [{ id: 'delete', name: 'Old notes', defaultName: null, action: 'delete' }] });

test('paginator loads delete candidates oldest-first and appends the next page through the cursor', async () => {
	const requests: { afterId?: string }[] = [];
	vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string);
		requests.push(body);
		return new Response(JSON.stringify(body.afterId
			? page([note('n2', 'second page')], null, true)
			: page([note('n1', 'first page')], 'cursor-1', false)));
	});
	const paginator = new CleanupPreviewPaginator(['delete']);
	expect(paginator.order.value).toBe('oldest');
	await paginator.init();
	expect(paginator.items.value.map(item => item.id)).toEqual(['n1']);
	expect(paginator.canFetchNewer.value).toBe(true);
	await paginator.fetchNewer();
	expect(paginator.items.value.map(item => item.id)).toEqual(['n1', 'n2']);
	expect(paginator.canFetchNewer.value).toBe(false);
	expect(requests).toEqual([
		{ ruleIds: ['delete'], limit: 100, i: 'dummy-test-token' },
		{ ruleIds: ['delete'], afterId: 'cursor-1', limit: 100, i: 'dummy-test-token' },
	]);
});

test('a complete pass with a leftover cursor offers no next page and sends no extra request', async () => {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify(page([note('n1', 'only page')], 'stale-cursor', true))));
	vi.stubGlobal('fetch', fetchMock);
	const paginator = new CleanupPreviewPaginator(['delete']);
	await paginator.init();
	expect(paginator.canFetchNewer.value).toBe(false);
	await paginator.fetchNewer();
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('reload starts again from the first page and a failed load raises the error state', async () => {
	let calls = 0;
	vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string);
		calls++;
		if (calls === 2) return new Response(JSON.stringify({ error: { code: 'CLEANUP_BUSY' } }), { status: 503 });
		return new Response(JSON.stringify(page([note(body.afterId ?? 'n1', body.afterId ? 'next' : 'first')], null, true)));
	});
	const paginator = new CleanupPreviewPaginator(['delete']);
	await paginator.init();
	await paginator.reload();
	expect(paginator.error.value).toBe(true);
	await paginator.reload();
	expect(paginator.error.value).toBe(false);
	expect(paginator.items.value.map(item => item.id)).toEqual(['n1']);
	expect(calls).toBe(3);
});

test('overlapping loads are ignored so pages never duplicate', async () => {
	let finish!: (response: Response) => void;
	let calls = 0;
	const fetchMock = vi.fn(() => ++calls === 1
		? Promise.resolve(new Response(JSON.stringify(page([note('n1', 'first')], 'cursor-1', false))))
		: new Promise<Response>(resolve => { finish = resolve; }));
	vi.stubGlobal('fetch', fetchMock);
	const paginator = new CleanupPreviewPaginator(['delete']);
	await paginator.init();
	const appending = paginator.fetchNewer();
	await paginator.fetchNewer();
	expect(fetchMock).toHaveBeenCalledTimes(2);
	finish(new Response(JSON.stringify(page([note('n2', 'second')], null, true))));
	await appending;
	expect(paginator.items.value.map(item => item.id)).toEqual(['n1', 'n2']);
});

test('preview renders the timeline candidates and links each failing rule to its edit screen', async () => {
	vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
		...page([note('n1', 'candidate note')], null, true),
		errors: [{ ruleId: 'keep', code: 'MISSING_CHANNEL', path: 'condition.children.0', referenceId: 'secret-ref' }],
		rules: [{ id: 'keep', name: '내가 즐겨찾기한 내 글', defaultName: 'favorite', action: 'keep' }, { id: 'delete', name: 'Old notes', defaultName: null, action: 'delete' }],
	})));
	const view = render(Preview, { props: { ruleId: 'delete', version: 0 }, global: { stubs: { MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' } } } });
	await view.findByText('candidate note');
	const link = view.getByRole('link', { name: 'My favorited notes' });
	expect(link.getAttribute('href')).toBe('/settings/note-cleanup/keep');
	expect(view.getByText('A selected channel is unavailable. Choose another channel or change this condition.')).toBeTruthy();
	expect(view.container.textContent).not.toMatch(/MISSING_CHANNEL|condition.children.0|secret-ref/);
});

test('saving the rule bumps the version and the preview reloads from the first page', async () => {
	const requests: { afterId?: string }[] = [];
	vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string);
		requests.push(body);
		return new Response(JSON.stringify(page([note('n1', `result ${requests.length}`)], requests.length === 1 ? 'cursor-1' : null, requests.length !== 1)));
	});
	const view = render(Preview, { props: { ruleId: 'delete', version: 0 }, global: { stubs: { MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' } } } });
	await view.findByText('result 1');
	await fireEvent.click(view.getByRole('button', { name: 'Load more' }));
	await view.findByText('result 2');
	await view.rerender({ ruleId: 'delete', version: 1 });
	await view.findByText('result 3');
	expect(view.queryByText('result 2')).toBeNull();
	expect(requests.map(request => request.afterId)).toEqual([undefined, 'cursor-1', undefined]);
});

test('a delayed first response never overwrites the preview reloaded after a save', async () => {
	let finishOld!: (response: Response) => void;
	let calls = 0;
	vi.stubGlobal('fetch', () => ++calls === 1
		? new Promise<Response>(resolve => { finishOld = resolve; })
		: Promise.resolve(new Response(JSON.stringify(page([note('new', 'new rule result')], null, true)))));
	const paginator = new CleanupPreviewPaginator(['delete']);
	const initing = paginator.init();
	// 저장이 먼저 끝나 새 첫 페이지를 읽은 뒤, 이전 응답이 늦게 도착하는 순서.
	await paginator.reload();
	expect(paginator.items.value.map(item => item.id)).toEqual(['new']);
	finishOld(new Response(JSON.stringify(page([note('old', 'stale result')], 'old-cursor', false))));
	await initing;
	expect(paginator.items.value.map(item => item.id)).toEqual(['new']);
	expect(paginator.complete.value).toBe(true);
	expect(paginator.canFetchNewer.value).toBe(false);
	expect(paginator.error.value).toBe(false);
	expect(calls).toBe(2);
});

test('a delayed append response never lands in the preview reloaded after a save', async () => {
	let finishAppend!: (response: Response) => void;
	let calls = 0;
	vi.stubGlobal('fetch', () => {
		calls++;
		if (calls === 1) return Promise.resolve(new Response(JSON.stringify(page([note('n1', 'first')], 'cursor-1', false))));
		if (calls === 2) return new Promise<Response>(resolve => { finishAppend = resolve; });
		return Promise.resolve(new Response(JSON.stringify(page([note('new', 'new rule result')], null, true))));
	});
	const paginator = new CleanupPreviewPaginator(['delete']);
	await paginator.init();
	const appending = paginator.fetchNewer();
	await paginator.reload();
	expect(paginator.items.value.map(item => item.id)).toEqual(['new']);
	finishAppend(new Response(JSON.stringify(page([note('n2', 'stale append')], null, true))));
	await appending;
	expect(paginator.items.value.map(item => item.id)).toEqual(['new']);
	expect(paginator.complete.value).toBe(true);
	expect(paginator.canFetchNewer.value).toBe(false);
});

test('a failed reload keeps the error state and a later successful reload clears it', async () => {
	let calls = 0;
	vi.stubGlobal('fetch', () => ++calls === 1
		? Promise.resolve(new Response(JSON.stringify(page([note('n1', 'first')], null, true))))
		: calls === 2
			? Promise.resolve(new Response(JSON.stringify({ error: { code: 'CLEANUP_BUSY' } }), { status: 503 }))
			: Promise.resolve(new Response(JSON.stringify(page([note('n2', 'recovered')], null, true)))));
	const paginator = new CleanupPreviewPaginator(['delete']);
	await paginator.init();
	await paginator.reload();
	expect(paginator.error.value).toBe(true);
	await paginator.reload();
	expect(paginator.error.value).toBe(false);
	expect(paginator.items.value.map(item => item.id)).toEqual(['n2']);
});

test('readiness tracks the current first page and clears while a reload is in flight', async () => {
	let finishReload!: (response: Response) => void;
	let calls = 0;
	vi.stubGlobal('fetch', () => ++calls === 1
		? Promise.resolve(new Response(JSON.stringify(page([note('n1', 'first')], null, true))))
		: new Promise<Response>(resolve => { finishReload = resolve; }));
	const paginator = new CleanupPreviewPaginator(['delete']);
	expect(paginator.ready.value).toBe(false);
	await paginator.init();
	expect(paginator.ready.value).toBe(true);
	const reloading = paginator.reload();
	expect(paginator.ready.value).toBe(false);
	finishReload(new Response(JSON.stringify(page([note('n2', 'second')], null, true))));
	await reloading;
	expect(paginator.ready.value).toBe(true);
});
