/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import type { MenuItem } from '@/types/menu.js';

const mocks = vi.hoisted(() => ({ popupMenu: vi.fn(), save: vi.fn(), me: { id: 'viewer', username: 'viewer' } }));
vi.mock('@/os.js', () => ({ popupMenu: mocks.popupMenu }));
vi.mock('@/i.js', () => ({ $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ currentRoute: { value: { path: '/' } } }) }));
vi.mock('@/ui/_common_/common.js', () => ({ openInstanceMenu: vi.fn() }));
vi.mock('@/navbar.js', () => ({ navbarItemDef: {} }));
vi.mock('@/accounts.js', () => ({ getAccountMenu: vi.fn() }));
vi.mock('@/instance.js', () => ({ instance: { name: 'Test' } }));
vi.mock('@/preferences.js', async () => {
	const { PreferencesManager } = await import('@/preferences/manager.js');
	return { prefer: new PreferencesManager({
		load: () => null, save: () => {}, cloudGet: async () => null,
		cloudGetBulk: async () => ({}), cloudSet: async () => {},
	}, { id: 'viewer' }) };
});
vi.mock('@/store.js', async () => {
	const { ref } = await import('vue');
	return { store: {
		s: { realtimeMode: true },
		r: { realtimeMode: ref(true), menuDisplay: ref('sideFull') },
		set: mocks.save,
	} };
});

import CommonNavbar from '@/ui/_common_/navbar.vue';
import FriendlyNavbar from '@/ui/friendly/navbar.vue';
import { prefer } from '@/preferences.js';
import { store } from '@/store.js';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	mocks.popupMenu.mockReset();
	mocks.save.mockReset();
});

describe.each([
	['common', CommonNavbar],
	['friendly', FriendlyNavbar],
] as const)('%s navigation', (_, Navbar) => {
	test.each([true, false])('saves the realtime mode before reloading when it was %s', async initial => {
		let finishSaving!: () => void;
		const saving = new Promise<void>(resolve => { finishSaving = resolve; });
		mocks.save.mockReturnValue(saving);
		store.s.realtimeMode = initial;
		store.r.realtimeMode.value = initial;
		prefer.commit('menu', []);
		const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
		const { container } = render(Navbar, {
			props: { asDrawer: true },
			global: { stubs: { MkA: true, MkAvatar: true, MkAcct: true, MkUserName: true }, directives: { tooltip: () => {} } },
		});

		await fireEvent.click(container.querySelector('.ti-bolt, .ti-bolt-off')!.closest('button')!);
		const items = mocks.popupMenu.mock.lastCall![0] as MenuItem[];
		const action = items.find(item => item && typeof item === 'object' && 'action' in item);
		if (!action || typeof action !== 'object' || !('action' in action)) throw new Error('Realtime menu action missing');
		const completed = action.action(new PointerEvent('click'));

		expect(mocks.save).toHaveBeenCalledWith('realtimeMode', !initial);
		expect(reload).not.toHaveBeenCalled();

		finishSaving();
		await completed;

		expect(reload).toHaveBeenCalledOnce();
	});
});
