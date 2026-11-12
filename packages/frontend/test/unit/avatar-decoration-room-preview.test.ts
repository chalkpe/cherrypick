/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import type * as Misskey from 'cherrypick-js';
import XDecoration from '@/pages/settings/avatar-decoration.decoration.vue';
import MkAvatar from '@/components/global/MkAvatar.vue';
import { prefer } from '@/preferences.js';

const me = vi.hoisted(() => ({
	id: 'owner', username: 'owner', host: null, avatarUrl: 'https://example.com/owner.png', avatarDecorations: [], roles: [],
}));

vi.mock('@/os.js', () => ({}));
vi.mock('@/instance.js', () => ({ instance: {} }));
vi.mock('@/i.js', () => ({ ensureSignin: () => me }));
vi.mock('@/preferences.js', async () => {
	const { PreferencesManager } = await import('@/preferences/manager.js');
	return { prefer: new PreferencesManager({
		load: () => null,
		save: () => {},
		cloudGet: async () => null,
		cloudGetBulk: async () => ({}),
		cloudSet: async () => {},
	}, { id: 'owner' }) };
});
vi.mock('@/components/global/MkA.vue', () => ({ default: { template: '<a><slot /></a>' } }));

const decoration = { id: 'frame', url: 'https://example.com/frame.png', name: 'Frame', roleIdsThatCanBeUsedThisDecoration: [] };
const room = {
	id: 'group', name: 'Group', iconUrl: 'https://example.com/group.png', iconBlurhash: null, iconDecorations: [],
	owner: { id: 'owner', username: 'owner', host: null },
} as unknown as Misskey.entities.ChatRoom;

beforeEach(async () => {
	await prefer.cloudReady;
	prefer.commit('enableHighQualityImagePlaceholders', false);
});
afterEach(cleanup);

const global = { components: { MkAvatar }, stubs: { MkCondensedLine: true }, directives: { 'user-preview': {} } };

test('the group decoration catalog previews each decoration on the group icon', () => {
	const { container } = render(XDecoration, { props: { decoration, room }, global });

	expect(container.querySelector('img[src="https://example.com/group.png"]')).not.toBeNull();
	expect(container.querySelector('img[src="https://example.com/owner.png"]')).toBeNull();
	expect(container.querySelector('img[src="https://example.com/frame.png"]')).not.toBeNull();
});

test('the profile decoration catalog keeps previewing on the account avatar', () => {
	const { container } = render(XDecoration, { props: { decoration }, global });

	expect(container.querySelector('img[src="https://example.com/owner.png"]')).not.toBeNull();
	expect(container.querySelector('img[src="https://example.com/frame.png"]')).not.toBeNull();
});
