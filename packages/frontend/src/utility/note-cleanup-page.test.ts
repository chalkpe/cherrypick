/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Locale } from 'i18n';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, h } from 'vue';

vi.mock('@@/js/config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('@@/js/config.js')>()), apiUrl: 'https://cleanup.invalid/api' }));
vi.mock('@/i.js', () => ({ $i: { token: 'dummy-test-token', policies: {} }, ensureSignin: () => {}, iAmModerator: false }));
vi.mock('@/i18n.js', async () => {
	const { I18n } = await import('@@/js/i18n.js');
	const { load } = await import('js-yaml');
	const { readFileSync } = await import('node:fs');
	const locales = Object.fromEntries(['en-US', 'ko-KR', 'ja-JP'].map(language => [language, load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as Locale]));
	return { i18n: new I18n(locales['en-US'], false) };
});
vi.mock('@/page.js', () => ({ definePage: () => {} }));
vi.mock('@/pages/_loading_.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/pages/_error_.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/pages/timeline.vue', () => ({ default: defineComponent({}) }));
vi.mock('@/components/MkButton.vue', () => ({ default: defineComponent({
	props: ['disabled'], emits: ['click'],
	setup: (props, { slots, emit }) => () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()),
}) }));
vi.mock('@/components/MkInfo.vue', () => ({ default: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) }));
import Settings from '@/pages/settings/note-cleanup.vue';
import { ROUTE_DEF } from '@/router.definition.js';
import { Nirax } from '@/lib/nirax.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const stubs = {
	SearchMarker: { template: '<div><slot/></div>' },
	SearchLabel: { template: '<div><slot/></div>' },
	MkLoading: { template: '<div>loading</div>' },
	MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' },
};

test('list, create and edit resolve to separate routes and the create action comes from the query', () => {
	const list = new Nirax(ROUTE_DEF, '/settings/note-cleanup', true, defineComponent({}));
	expect(list.current.child?.route.name).toBe('note-cleanup');
	const create = new Nirax(ROUTE_DEF, '/settings/note-cleanup/new?action=keep', true, defineComponent({}));
	expect(create.current.child?.route.name).toBe('note-cleanup-new');
	expect(create.current.child?.props.get('action')).toBe('keep');
	const edit = new Nirax(ROUTE_DEF, '/settings/note-cleanup/protected-rule', true, defineComponent({}));
	expect(edit.current.child?.route.name).toBe('note-cleanup-edit');
	expect(edit.current.child?.props.get('ruleId')).toBe('protected-rule');
});

test('lists delete and keep rules as links to their edit screens with state icons and automatic suffix', async () => {
	const rules = [
		{ id: 'd1', name: 'Old notes', defaultName: null, action: 'delete', enabled: true, automatic: true, lastError: null },
		{ id: 'd2', name: 'Paused rule', defaultName: null, action: 'delete', enabled: false, automatic: false, lastError: null },
		{ id: 'k1', name: 'Broken clip', defaultName: null, action: 'keep', enabled: true, automatic: false, lastError: { code: 'MISSING_CLIP', path: 'condition' } },
	];
	vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ rules, blocked: true })));
	const view = render(Settings, { global: { stubs } });
	await view.findByRole('link', { name: /Old notes/ });
	expect(view.getByRole('link', { name: /Old notes/ }).getAttribute('href')).toBe('/settings/note-cleanup/d1');
	expect(view.getByRole('link', { name: /Old notes/ }).textContent).toContain('Auto');
	expect(view.getByRole('link', { name: /Paused rule/ }).querySelector('i.ti-player-pause')).toBeTruthy();
	expect(view.getByRole('link', { name: /Broken clip/ }).querySelector('i.ti-alert-triangle')).toBeTruthy();
	expect(view.getByRole('link', { name: /Old notes/ }).querySelector('i.ti-trash')).toBeTruthy();
	expect(view.getAllByRole('link', { name: /Create rule/ })[0].getAttribute('href')).toBe('/settings/note-cleanup/new?action=delete');
	expect(view.getAllByRole('link', { name: /Create rule/ })[1].getAttribute('href')).toBe('/settings/note-cleanup/new?action=keep');
	// 목록에는 정리 실행·미리 보기 수단이 없고 차단 안내도 규칙 화면으로만 보낸다.
	expect(view.queryByRole('button', { name: 'Clean up now' })).toBeNull();
	expect(view.container.textContent).not.toContain('New deletions are paused');
});

test('목록은 기본 이름만 영어로 표시하고 같은 한국어 사용자 이름은 보존한다', async () => {
	const rules = [{ id: 'default', name: '고정한 내 글', defaultName: 'pinned', action: 'keep', enabled: true }, { id: 'custom', name: '고정한 내 글', defaultName: null, action: 'keep', enabled: true }];
	vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ rules, blocked: false })));
	const view = render(Settings, { global: { stubs } });
	await view.findByRole('link', { name: /My pinned notes/ });
	expect(view.getByRole('link', { name: /고정한 내 글/ })).toBeTruthy();
});

test('list busy failure keeps retry available and recovers on the next load', async () => {
	let calls = 0;
	vi.stubGlobal('fetch', async () => ++calls === 1
		? new Response(JSON.stringify({ error: { code: 'CLEANUP_BUSY' } }), { status: 503 })
		: new Response(JSON.stringify({ rules: [{ id: 'd1', name: 'Recovered rule', action: 'delete', enabled: true }], blocked: false })));
	const view = render(Settings, { global: { stubs } });
	await view.findByText('Note cleanup is busy. Please wait a moment and try again.');
	await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
	await view.findByRole('link', { name: /Recovered rule/ });
	expect(view.queryByText('Note cleanup is busy. Please wait a moment and try again.')).toBeNull();
});

test('empty sections still offer creating each rule kind', async () => {
	vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ rules: [], blocked: false })));
	const view = render(Settings, { global: { stubs } });
	await waitFor(() => expect(view.getAllByRole('link', { name: /Create rule/ })).toHaveLength(2));
	expect(view.getByText('Delete rules')).toBeTruthy();
	expect(view.getByText('Keep rules')).toBeTruthy();
});
