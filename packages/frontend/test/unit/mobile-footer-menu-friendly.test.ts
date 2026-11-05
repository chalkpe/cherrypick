/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { host } from '@@/js/config.js';
import type { MenuItem } from '@/types/menu.js';
import MobileFooterMenuFriendly from '@/ui/friendly/mobile-footer-menu-friendly.vue';
import { prefer } from '@/preferences.js';

const mocks = vi.hoisted(() => ({ popupMenu: vi.fn(), popup: vi.fn(), haptic: vi.fn() }));
vi.mock('@/os.js', () => ({ popupMenu: mocks.popupMenu, popup: mocks.popup }));
vi.mock('@/utility/haptic.js', () => ({ haptic: mocks.haptic }));
vi.mock('@/router.js', () => ({ mainRouter: { currentRoute: { value: { name: 'index' } }, push: vi.fn() } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(), misskeyApiGet: vi.fn() }));
vi.mock('@/signout.js', () => ({ signout: vi.fn() }));
vi.mock('@/utility/show-suspended-dialog.js', () => ({}));
vi.mock('@/utility/unison-reload.js', () => ({ unisonReload: vi.fn(), reloadChannel: { postMessage: vi.fn() } }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', username: 'viewer', token: 'viewer-token', policies: {} } }));
vi.mock('@/store.js', async () => {
	const { ref } = await import('vue');
	return { store: {
		s: { showHomeButtonInNavbar: true, accountTokens: {}, accountInfos: {} },
		r: { accountTokens: ref({}), accountInfos: ref({}) },
	} };
});
vi.mock('@/preferences.js', async () => {
	const { PreferencesManager } = await import('@/preferences/manager.js');
	return { prefer: new PreferencesManager({
		load: () => null, save: () => {}, cloudGet: async () => null,
		cloudGetBulk: async () => ({}), cloudSet: async () => {},
	}, { id: 'viewer' }) };
});

const viewer = [host, { id: 'viewer', username: 'viewer' }];
const secondAccount = [host, { id: 'second', username: 'second' }];
const foreignAccount = ['server-a.example', { id: 'foreign', username: 'foreign' }];

async function longPressHomeButton() {
	const { container } = render(MobileFooterMenuFriendly);
	const homeButton = container.querySelector('.ti-home')!.closest('button')!;
	await fireEvent.touchStart(homeButton);
	await vi.advanceTimersByTimeAsync(500);
}

beforeEach(async () => {
	await prefer.cloudReady;
	prefer.commit('enableLongPressOpenAccountMenu', true);
	mocks.popupMenu.mockClear();
	mocks.haptic.mockClear();
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

test.each([
	['only the current account is registered', [viewer]],
	['the other registered account belongs to another server', [viewer, foreignAccount]],
])('does not react to a long press on the home button when %s', async (_, accounts) => {
	prefer.commit('accounts', accounts as never);

	await longPressHomeButton();

	expect(mocks.popupMenu).not.toHaveBeenCalled();
	expect(mocks.haptic).not.toHaveBeenCalled();
});

test('opens the account menu on a long press on the home button when another account can be chosen', async () => {
	prefer.commit('accounts', [viewer, secondAccount] as never);

	await longPressHomeButton();

	expect(mocks.haptic).toHaveBeenCalledOnce();
	expect(mocks.popupMenu).toHaveBeenCalledOnce();
	expect(mocks.popupMenu.mock.calls[0][0] as MenuItem[]).toHaveLength(2);
});
