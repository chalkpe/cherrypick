/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import type { MenuItem } from '@/types/menu.js';

const mocks = vi.hoisted(() => ({
	popupMenu: vi.fn(),
	confirm: vi.fn(),
	finishConfirm: null as null | ((result: { canceled: boolean }) => void),
	api: vi.fn(async () => ({ name: 'first' })),
	apiGet: vi.fn(async () => ({ name: 'first' })),
	apiWithDialog: vi.fn(),
	copy: vi.fn(),
	palette: vi.fn(),
	react: vi.fn(),
	mute: vi.fn(),
	unmute: vi.fn(),
	muted: false,
}));

vi.mock('@/os.js', () => ({
	popupMenu: mocks.popupMenu,
	confirm: mocks.confirm,
	apiWithDialog: mocks.apiWithDialog,
	popup: () => ({ dispose: vi.fn() }),
	popupAsyncWithDialog: async () => ({ dispose: vi.fn() }),
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api, misskeyApiGet: mocks.apiGet }));
vi.mock('@/utility/copy-to-clipboard.js', () => ({ copyToClipboard: mocks.copy }));
vi.mock('@/utility/emoji-palette.js', () => ({ addToEmojiPalette: mocks.palette }));
vi.mock('@/utility/media-proxy.js', () => ({ getProxiedImageUrl: (url: string) => url, getStaticImageUrl: (url: string) => url }));
vi.mock('@/custom-emojis.js', async () => ({ customEmojis: (await import('vue')).ref([]), customEmojisMap: new Map() }));
vi.mock('@/i.js', () => ({ $i: { isAdmin: true, isModerator: true, policies: { canManageCustomEmojis: true } } }));
vi.mock('@/components/MkCustomEmojiDetailedDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('@/utility/emoji-mute', async importOriginal => {
	const { computed } = await import('vue');
	return {
		...await importOriginal<typeof import('@/utility/emoji-mute.js')>(),
		checkMuted: () => computed(() => mocks.muted),
		mute: mocks.mute,
		unmute: mocks.unmute,
	};
});

import MkCustomEmoji from '@/components/global/MkCustomEmoji.vue';
import MkEmoji from '@/components/global/MkEmoji.vue';
import { DI } from '@/di.js';
import { i18n } from '@/i18n.js';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.muted = false;
	mocks.finishConfirm = null;
	mocks.confirm.mockImplementation(() => new Promise(resolve => { mocks.finishConfirm = resolve; }));
});
afterEach(cleanup);

function menuAction(icon: string) {
	const items = mocks.popupMenu.mock.lastCall?.[0] as MenuItem[];
	const item = items.find(value => value != null && typeof value === 'object' && 'icon' in value && value.icon === icon);
	if (item == null || typeof item !== 'object' || !('action' in item)) throw new Error(`Missing menu item ${icon}`);
	return item.action;
}

const global = { provide: { [DI.mfmEmojiReactCallback]: mocks.react } };

describe('open emoji menu targets', () => {
	test('imports the remote emoji named in the menu after props change', async () => {
		const view = render(MkCustomEmoji, { props: { name: 'first', host: 'remote.test', url: '/first.png', menu: true }, global });
		await fireEvent.click(view.container.querySelector('img')!);
		const action = menuAction('ti ti-plus');
		expect(mocks.popupMenu.mock.lastCall?.[0][0].text).toBe(':first:');

		await view.rerender({ name: 'second', host: 'other.test', url: '/second.png' });
		await action(new PointerEvent('click'));

		expect(mocks.apiWithDialog).toHaveBeenCalledWith('admin/emoji/steal', { name: 'first', host: 'remote.test' });
	});

	test.each([
		{ icon: 'ti ti-copy', call: 'copy' },
		{ icon: 'ti ti-mood-plus', call: 'react' },
		{ icon: 'ti ti-palette', call: 'palette' },
		{ icon: 'ti ti-pencil', call: 'api' },
		{ icon: 'ti ti-info-circle', call: 'apiGet' },
	] as const)('keeps the local custom emoji for $call', async ({ icon, call }) => {
		const view = render(MkCustomEmoji, { props: { name: 'first', url: '/first.png', menu: true, menuReaction: true }, global });
		await fireEvent.click(view.container.querySelector('img')!);
		const action = menuAction(icon);

		await view.rerender({ name: 'second', url: '/second.png' });
		await action(new PointerEvent('click'));

		if (call === 'api' || call === 'apiGet') expect(mocks[call]).toHaveBeenCalledWith('emoji', { name: 'first' });
		else expect(mocks[call]).toHaveBeenCalledWith(':first:');
	});

	test.each([
		{ icon: 'ti ti-copy', call: 'copy' },
		{ icon: 'ti ti-mood-plus', call: 'react' },
		{ icon: 'ti ti-palette', call: 'palette' },
	] as const)('keeps the Unicode emoji for $call', async ({ icon, call }) => {
		const view = render(MkEmoji, { props: { emoji: '😀', menu: true, menuReaction: true }, global });
		await fireEvent.click(view.container.querySelector('img')!);
		const action = menuAction(icon);

		await view.rerender({ emoji: '😺' });
		await action(new PointerEvent('click'));

		expect(mocks[call]).toHaveBeenCalledWith('😀');
	});

	test.each([false, true])('keeps custom mute/unmute targets through menu and confirmation (%s)', async muted => {
		mocks.muted = muted;
		const view = render(MkCustomEmoji, { props: { name: 'first', host: 'remote.test', url: '/first.png', menu: true }, global });
		await fireEvent.click(view.container.querySelector('img')!);
		const action = menuAction(muted ? 'ti ti-mood-smile' : 'ti ti-mood-off');

		await view.rerender({ name: 'second', host: 'other.test', url: '/second.png' });
		action(new PointerEvent('click'));
		expect(mocks.confirm.mock.lastCall?.[0].title).toBe((muted ? i18n.tsx.unmuteX : i18n.tsx.muteX)({ x: ':first@remote.test:' }));
		await view.rerender({ name: 'third', url: '/third.png' });
		mocks.finishConfirm!({ canceled: false });
		await nextTick();

		expect(muted ? mocks.unmute : mocks.mute).toHaveBeenCalledWith(':first@remote.test:');
	});

	test.each([false, true])('keeps Unicode mute/unmute targets through menu and confirmation (%s)', async muted => {
		mocks.muted = muted;
		const view = render(MkEmoji, { props: { emoji: '😀', menu: true }, global });
		await fireEvent.click(view.container.querySelector('img')!);
		const action = menuAction(muted ? 'ti ti-mood-smile' : 'ti ti-mood-off');

		await view.rerender({ emoji: '😺' });
		action(new PointerEvent('click'));
		expect(mocks.confirm.mock.lastCall?.[0].title).toBe((muted ? i18n.tsx.unmuteX : i18n.tsx.muteX)({ x: '😀' }));
		await view.rerender({ emoji: '🐶' });
		mocks.finishConfirm!({ canceled: false });
		await nextTick();

		expect(muted ? mocks.unmute : mocks.mute).toHaveBeenCalledWith('😀');
	});
});
