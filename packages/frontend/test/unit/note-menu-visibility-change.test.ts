/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import type * as Misskey from 'cherrypick-js';
import { getNoteMenu } from '@/utility/get-note-menu.js';

vi.mock('@/os.js', () => ({ popup: vi.fn(), confirm: vi.fn(), apiWithDialog: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: { id: 'moderator', isModerator: true, isAdmin: false, policies: {} } }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: new Proxy({ _visibility: { public: 'public', home: 'home', followers: 'followers', specified: 'specified' } }, { get: (t: any, k) => t[k] ?? String(k) }) } }));
vi.mock('@/instance.js', () => ({ instance: {} }));
vi.mock('@/store.js', () => ({ store: { s: {} } }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: { getItem: () => null } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: {}, r: {} } }));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: () => [] }));
vi.mock('@/cache.js', () => ({ clipsCache: {}, favoritedChannelsCache: {} }));
vi.mock('@/utility/get-user-menu.js', () => ({ getUserMenu: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn().mockResolvedValue({ isFavorited: false, isMutedThread: false, isWatching: false }) }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/components/MkRippleEffect.vue', () => ({ default: {} }));

function visibilityMenu(visibility: Misskey.entities.Note['visibility']) {
	const note = {
		id: 'note', userId: 'author', visibility, channel: null, files: [], reactions: {},
		user: { id: 'author', username: 'author', host: null },
	} as unknown as Misskey.entities.Note;
	const { menu } = getNoteMenu({ note, translation: ref(null), translating: ref(false) });
	return menu.find((item: any) => item.type === 'parent' && item.text === 'changeVisibility') as any;
}

describe('moderator visibility menu', () => {
	test.each([
		['public', ['home', 'followers', 'specified']],
		['home', ['followers', 'specified']],
		['followers', ['specified']],
	] as const)('lists only the narrower choices for %s notes', (current, expected) => {
		const children = visibilityMenu(current).children;
		expect(children.map((c: any) => c.text)).toEqual(expected);
		expect(children.every((c: any) => !('disabled' in c))).toBe(true);
	});

	test('has no visibility item for specified notes', () => {
		expect(visibilityMenu('specified')).toBeUndefined();
	});
});
