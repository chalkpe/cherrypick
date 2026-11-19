/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import type * as Misskey from 'cherrypick-js';
import { getNoteMenu } from '@/utility/get-note-menu.js';

const state = vi.hoisted(() => ({
	me: null as null | Record<string, unknown>,
	trusted: [] as string[],
	popups: [] as string[],
}));

vi.mock('@/os.js', () => ({
	popup: (_component: unknown, props: { url?: string }, events: { done?: (r: { canceled: boolean }) => void; closed?: () => void }) => {
		if (props.url != null) state.popups.push(props.url);
		queueMicrotask(() => events.done?.({ canceled: true }));
		return { dispose: () => {} };
	},
	confirm: vi.fn(),
	post: vi.fn(),
	apiWithDialog: vi.fn(),
}));
vi.mock('@/i.js', () => ({ get $i() { return state.me; } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: new Proxy({ _visibility: {} }, { get: (t: any, k) => t[k] ?? String(k) }) } }));
vi.mock('@/instance.js', () => ({ instance: { get trustedLinkUrlPatterns() { return state.trusted; } } }));
vi.mock('@/store.js', () => ({ store: { s: {} } }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: { getItem: () => null } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { externalNavigationWarning: true }, r: { trustedDomains: { value: [] } } } }));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: () => [] }));
vi.mock('@/cache.js', () => ({ clipsCache: { fetch: async () => [] }, favoritedChannelsCache: { fetch: async () => [] } }));
vi.mock('@/utility/get-user-menu.js', () => ({ getUserMenu: vi.fn(() => ({ menu: [] })) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(async () => ({ isFavorited: false, isMutedThread: false, isWatching: false })) }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/components/MkRippleEffect.vue', () => ({ default: {} }));
vi.mock('@/components/MkUrlWarningDialog.vue', () => ({ default: {} }));

const remoteNote = {
	id: 'note', userId: 'remote-user', visibility: 'public', channel: null, files: [], reactions: {}, createdAt: '2020-01-01T00:00:00.000Z',
	renote: null, reply: null,
	url: 'https://remote.example/@user/1',
	uri: 'https://remote.example/notes/1',
	user: { id: 'remote-user', username: 'user', host: 'remote.example' },
} as unknown as Misskey.entities.Note;

async function collectShowOnRemote(): Promise<Array<() => void>> {
	const { menu } = getNoteMenu({ note: remoteNote, translation: ref(null), translating: ref(false) });
	const found: Array<() => void> = [];
	const walk = async (items: any[]): Promise<void> => {
		for (const raw of items) {
			const item = await raw;
			if (item == null) continue;
			if (item.text === 'showOnRemote') found.push(item.action);
			if (typeof item.children === 'function') await walk(await item.children());
			else if (Array.isArray(item.children)) await walk(item.children);
		}
	};
	await walk(menu as any[]);
	return found;
}

describe('ノートメニューの「リモートで表示」', () => {
	const open = vi.fn();

	beforeEach(() => {
		state.trusted = [];
		state.popups = [];
		open.mockReset();
		vi.stubGlobal('open', open);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test.each([
		['ログイン中', { id: 'me', isModerator: false, isAdmin: false, policies: {} }],
		['未ログイン', null],
	])('信頼されていないURLは警告を表示し、確認前には開かない: %s', async (_name, me) => {
		state.me = me;
		const actions = await collectShowOnRemote();
		expect(actions.length).toBeGreaterThan(0);

		for (const action of actions) {
			state.popups = [];
			action();
			await vi.waitFor(() => expect(state.popups).toEqual(['https://remote.example/@user/1']));
		}
		expect(open).not.toHaveBeenCalled();
	});

	test.each([
		['ログイン中', { id: 'me', isModerator: false, isAdmin: false, policies: {} }],
		['未ログイン', null],
	])('信頼されたURLは警告なしでそのまま開く: %s', async (_name, me) => {
		state.me = me;
		state.trusted = ['remote.example'];
		const actions = await collectShowOnRemote();
		expect(actions.length).toBeGreaterThan(0);

		for (const action of actions) {
			open.mockReset();
			action();
			await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://remote.example/@user/1', '_blank', 'noopener'));
		}
		expect(state.popups).toEqual([]);
	});
});
