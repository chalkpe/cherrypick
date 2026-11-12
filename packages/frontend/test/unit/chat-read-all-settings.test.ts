/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, h, Suspense } from 'vue';
import { updateCurrentAccount } from '@/accounts.js';
import { $i } from '@/i.js';
import { i18n } from '@/i18n.js';

const mocks = vi.hoisted(() => ({ apiWithDialog: vi.fn() }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog }));
vi.mock('@/signout.js', () => ({ signout: vi.fn() }));
vi.mock('@/utility/show-suspended-dialog.js', () => ({}));
vi.mock('@/utility/unison-reload.js', () => ({ unisonReload: vi.fn(), reloadChannel: { postMessage: vi.fn() } }));
vi.mock('@/i.js', () => {
	const me = { id: 'viewer', token: 'viewer-token', hasUnreadChatMessages: true, policies: { chatAvailability: 'available' } };
	return { $i: me, ensureSignin: () => me };
});
vi.mock('@/store.js', () => ({ store: { s: { accountInfos: {} }, set: vi.fn() } }));
vi.mock('@/preferences.js', async () => {
	const { ref } = await import('vue');
	return { prefer: { model: () => ref(false) } };
});
vi.mock('@/preferences/utility.js', () => ({ cloudBackup: vi.fn() }));
vi.mock('@/utility/storage.js', () => ({ getStoragePersistenceStatusRef: async () => ({ value: false }), storagePersistenceSupported: false }));
vi.mock('@/utility/reload-suggest.js', () => ({}));
vi.mock('@/tips.js', () => ({}));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/pages/settings/migration.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/global/SearchMarker.vue', () => ({ default: { template: '<div><slot /></div>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot /></button>' } }));

import SettingsOther from '@/pages/settings/other.vue';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

test('a delayed read-all response preserves unread received after the server cleared older messages', async () => {
	let finishRead!: () => void;
	mocks.apiWithDialog.mockReturnValue(new Promise<void>(resolve => { finishRead = resolve; }));
	vi.spyOn(window, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'viewer', policies: { chatAvailability: 'available' }, hasUnreadChatMessages: true })));
	const wrapper = defineComponent({ render: () => h('div', [h(Suspense, null, { default: () => h(SettingsOther) })]) });
	const view = render(wrapper, { global: { stubs: {
		PageWithHeader: { template: '<div><slot /></div>' },
		SearchIcon: true,
		SearchLabel: { template: '<span><slot /></span>' },
		SearchText: { template: '<span><slot /></span>' },
		SearchMarker: { template: '<div><slot /></div>' },
		MkFolder: { template: '<section><slot /></section>' },
		MkRolePreview: true,
	} } });
	await fireEvent.click(await view.findByRole('button', { name: i18n.ts.readAllChatMessages }));

	updateCurrentAccount({ hasUnreadChatMessages: false });
	updateCurrentAccount({ hasUnreadChatMessages: true });
	finishRead();

	await waitFor(() => expect($i?.hasUnreadChatMessages).toBe(true));
	expect(window.fetch).toHaveBeenCalled();
});
