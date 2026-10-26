/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import type * as Misskey from 'cherrypick-js';
import MkAvatar from '@/components/global/MkAvatar.vue';
import { prefer } from '@/preferences.js';

vi.mock('@/os.js', () => ({}));
vi.mock('@/instance.js', () => ({ instance: {} }));
vi.mock('@/preferences.js', async () => {
	const { PreferencesManager } = await import('@/preferences/manager.js');
	return { prefer: new PreferencesManager({
		load: () => null,
		save: () => {},
		cloudGet: async () => null,
		cloudGetBulk: async () => ({}),
		cloudSet: async () => {},
	}, { id: 'viewer' }) };
});
vi.mock('@/components/global/MkA.vue', () => ({ default: { template: '<a><slot /></a>' } }));

const user = {
	id: 'alice', username: 'alice', host: null, avatarUrl: 'https://example.com/avatar.png',
	avatarDecorations: [{ id: 'decoration', url: 'https://example.com/decoration.png' }],
} as Misskey.entities.User;
const decorationSelector = 'img[src="https://example.com/decoration.png"]';

beforeEach(async () => {
	await prefer.cloudReady;
	prefer.commit('enableHighQualityImagePlaceholders', false);
	prefer.commit('showAvatarDecorations', true);
	prefer.commit('mutedAvatarDecorationUsers', []);
	prefer.commit('friendlyUiShowAvatarDecorationsInNavBtn', true);
});
afterEach(cleanup);

test.each([false, true])('updates mounted avatars on mute and unmute (floating button: %s)', async (isFloatingBtn) => {
	const { container } = render(MkAvatar, { props: { user, isFloatingBtn }, global: { directives: { 'user-preview': {} } } });
	expect(container.querySelector(decorationSelector)).not.toBeNull();
	prefer.commit('mutedAvatarDecorationUsers', ['alice']);
	await nextTick();
	expect(container.querySelector(decorationSelector)).toBeNull();
	expect(container.querySelector('img[src="https://example.com/avatar.png"]')).not.toBeNull();
	prefer.commit('mutedAvatarDecorationUsers', []);
	await nextTick();
	expect(container.querySelector(decorationSelector)).not.toBeNull();
});

test('does not hide another user and rechecks mute when the avatar user changes', async () => {
	prefer.commit('mutedAvatarDecorationUsers', ['alice']);
	const { container, rerender } = render(MkAvatar, { props: { user: { ...user, id: 'bob' } }, global: { directives: { 'user-preview': {} } } });
	expect(container.querySelector(decorationSelector)).not.toBeNull();
	await rerender({ user });
	expect(container.querySelector(decorationSelector)).toBeNull();
});

test('keeps mute effective even when decorations are forced for a preview', () => {
	prefer.commit('mutedAvatarDecorationUsers', ['alice']);
	const { container } = render(MkAvatar, { props: { user, forceShowDecoration: true }, global: { directives: { 'user-preview': {} } } });
	expect(container.querySelector(decorationSelector)).toBeNull();
});

test('respects global and floating button decoration settings', async () => {
	prefer.commit('showAvatarDecorations', false);
	const { container, rerender } = render(MkAvatar, { props: { user }, global: { directives: { 'user-preview': {} } } });
	expect(container.querySelector(decorationSelector)).toBeNull();
	await rerender({ forceShowDecoration: true });
	expect(container.querySelector(decorationSelector)).not.toBeNull();
	prefer.commit('showAvatarDecorations', true);
	prefer.commit('friendlyUiShowAvatarDecorationsInNavBtn', false);
	await rerender({ isFloatingBtn: true });
	expect(container.querySelector(decorationSelector)).toBeNull();
});
