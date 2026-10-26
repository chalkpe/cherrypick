/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { defineComponent, h, nextTick, Suspense } from 'vue';
import { host } from '@@/js/config.js';
import type { MenuItem } from '@/types/menu.js';
import { getAccountMenu, getAccounts } from '@/accounts.js';
import Accounts from '@/pages/settings/accounts.vue';
import { prefer } from '@/preferences.js';
import { store } from '@/store.js';
import { i18n } from '@/i18n.js';

const mocks = vi.hoisted(() => ({ popupMenu: vi.fn(), popup: vi.fn() }));
vi.mock('@/os.js', () => ({ ...mocks }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot /></button>' } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(), misskeyApiGet: vi.fn().mockResolvedValue({ inc: [] }) }));
vi.mock('@/components/MkMiniChart.vue', () => ({ default: { template: '<span />' } }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/signout.js', () => ({ signout: vi.fn() }));
vi.mock('@/utility/show-suspended-dialog.js', () => ({}));
vi.mock('@/utility/unison-reload.js', () => ({ unisonReload: vi.fn(), reloadChannel: { postMessage: vi.fn() } }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', username: 'viewer', token: 'viewer-token', policies: {} } }));
vi.mock('@/store.js', async () => {
	const { ref } = await import('vue');
	return { store: {
		s: { accountTokens: {}, accountInfos: {} },
		r: { accountTokens: ref({}), accountInfos: ref({}) },
		set(key: 'accountTokens' | 'accountInfos', value: never) { this.s[key] = value; this.r[key].value = value; },
	} };
});
vi.mock('@/preferences.js', async () => {
	const { PreferencesManager } = await import('@/preferences/manager.js');
	return { prefer: new PreferencesManager({
		load: () => null, save: () => {}, cloudGet: async () => null,
		cloudGetBulk: async () => ({}), cloudSet: async () => {},
	}, { id: 'viewer' }) };
});

const foreignHost = 'server-a.example';
beforeEach(async () => {
	await prefer.cloudReady;
	prefer.commit('accounts', [
		[host, { id: 'viewer', username: 'viewer' }],
		[host, { id: 'shared-id', username: 'local-signed-out' }],
		[foreignHost, { id: 'shared-id', username: 'foreign-imported' }],
	]);
	store.set('accountTokens', { [host + '/viewer']: 'viewer-token', [foreignHost + '/shared-id']: 'foreign-token' });
	store.set('accountInfos', {});
	mocks.popupMenu.mockClear();
	mocks.popup.mockClear();
});
afterEach(cleanup);

test('account selection excludes imported identities from another server, including matching IDs', async () => {
	const accounts = await getAccounts();
	expect(accounts.map(a => [a.host, a.username])).toEqual([[host, 'viewer'], [host, 'local-signed-out']]);
	const menu = await getAccountMenu({ withExtraOperation: false });
	expect(menu.flatMap(item => typeof item === 'object' && item != null && 'text' in item ? [item.text] : [])).toEqual(['local-signed-out']);
});

async function renderAccounts() {
	const view = render(defineComponent({ render: () => h('div', [h(Suspense, null, { default: () => h(Accounts) })]) }), {
		global: { directives: { 'adaptive-bg': {} }, stubs: {
			SearchMarker: { template: '<div><slot /></div>' },
			MkButton: { template: '<button><slot /></button>' },
			MkAvatar: true,
			MkUserName: { props: ['user'], template: '<span>{{ user.username }}</span>' },
		} },
	});
	await view.findByRole('button', { name: i18n.ts.addAccount });
	return view;
}

async function removeFromMenu() {
	const menu = mocks.popupMenu.mock.calls.at(-1)?.[0] as MenuItem[];
	const remove = menu.find(item => typeof item === 'object' && item != null && 'text' in item && item.text === i18n.ts.remove);
	if (!remove || typeof remove !== 'object' || !('action' in remove)) throw new Error('Missing remove action');
	await remove.action!(new PointerEvent('click'));
	await nextTick();
}

test('same-server account without cached user or token can be removed without signing in', async () => {
	const view = await renderAccounts();
	await fireEvent.click(view.getByRole('button', { name: new RegExp('local-signed-out') }));
	await removeFromMenu();
	expect(view.queryByRole('button', { name: /local-signed-out/ })).toBeNull();
	expect(prefer.s.accounts).toEqual([[host, { id: 'viewer', username: 'viewer' }], [foreignHost, { id: 'shared-id', username: 'foreign-imported' }]]);
	expect(store.s.accountTokens[host + '/viewer']).toBe('viewer-token');
	expect(store.s.accountTokens[foreignHost + '/shared-id']).toBe('foreign-token');
	expect(mocks.popup).not.toHaveBeenCalled();
});

test('foreign imported account can be removed, without offering a local sign-in or deleting a matching local ID', async () => {
	const view = await renderAccounts();
	const row = view.getByRole('button', { name: /foreign-imported/ });
	expect(row.textContent).toContain(foreignHost);
	await fireEvent.click(row);
	const menu = mocks.popupMenu.mock.calls.at(-1)?.[0] as MenuItem[];
	expect(menu.some(item => typeof item === 'object' && item != null && 'text' in item && item.text === i18n.ts.switch)).toBe(false);
	await removeFromMenu();
	expect(view.queryByRole('button', { name: /foreign-imported/ })).toBeNull();
	expect(prefer.s.accounts).toEqual([[host, { id: 'viewer', username: 'viewer' }], [host, { id: 'shared-id', username: 'local-signed-out' }]]);
	expect(store.s.accountTokens[foreignHost + '/shared-id']).toBeUndefined();
	expect(store.s.accountTokens[host + '/viewer']).toBe('viewer-token');
	expect(mocks.popup).not.toHaveBeenCalled();
});

test('removing a cached account updates the open list and clears only that account cache', async () => {
	store.set('accountInfos', {
		[host + '/shared-id']: { id: 'shared-id', username: 'local-signed-out' },
		[foreignHost + '/shared-id']: { id: 'shared-id', username: 'foreign-imported' },
	} as typeof store.s.accountInfos);
	const view = await renderAccounts();
	await fireEvent.keyDown(view.getByRole('button', { name: /local-signed-out/ }), { key: 'Enter' });
	await removeFromMenu();
	expect(view.queryByRole('button', { name: /local-signed-out/ })).toBeNull();
	expect(store.s.accountInfos[host + '/shared-id']).toBeUndefined();
	expect(store.s.accountInfos[foreignHost + '/shared-id']?.username).toBe('foreign-imported');
	view.unmount();
	const reopened = await renderAccounts();
	expect(reopened.queryByRole('button', { name: /local-signed-out/ })).toBeNull();
	expect(reopened.getByRole('button', { name: /foreign-imported/ })).toBeTruthy();
});


test('account management refreshes when cached profile information arrives without changing account identities', async () => {
	const view = await renderAccounts();
	store.set('accountInfos', {
		[host + '/shared-id']: { id: 'shared-id', username: 'updated-local-name' },
	} as typeof store.s.accountInfos);
	await nextTick();
	expect(view.getByRole('button', { name: /updated-local-name/ })).toBeTruthy();
	expect(view.queryByRole('button', { name: /local-signed-out/ })).toBeNull();
});
