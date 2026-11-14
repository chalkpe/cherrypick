/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import type * as Misskey from 'cherrypick-js';
import MkAvatar from '@/components/global/MkAvatar.vue';
import MkUserName from '@/components/global/MkUserName.vue';
import MkUserCardMini from '@/components/MkUserCardMini.vue';
import { i18n } from '@/i18n.js';
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
	prefer.commit('showRemoteAvatarDecorations', true);
	prefer.commit('deidentifyMutedUsers', true);
	prefer.commit('mutedAvatarDecorationUsers', []);
	prefer.commit('friendlyUiShowAvatarDecorationsInNavBtn', true);
});
afterEach(cleanup);

const room = {
	id: 'group', name: '그룹', owner: user, iconUrl: 'https://example.com/group.png', iconBlurhash: null,
	iconDecorations: user.avatarDecorations,
} as Misskey.entities.ChatRoom;

test('그룹 그림은 계정 링크와 계정별 장식 숨김을 사용하지 않는다', async () => {
	prefer.commit('mutedAvatarDecorationUsers', ['group', 'alice']);
	const { container } = render(MkAvatar, { props: { room, link: true, preview: true, indicator: true }, global: { directives: { 'user-preview': {} } } });

	expect(container.querySelector('a')).toBeNull();
	expect(container.firstElementChild?.getAttribute('title')).toBe('그룹');
	expect(container.querySelector('img[src="https://example.com/group.png"]')).not.toBeNull();
	expect(container.querySelector(decorationSelector)).not.toBeNull();

	prefer.commit('showAvatarDecorations', false);
	await nextTick();
	expect(container.querySelector(decorationSelector)).toBeNull();
});

test('원격 그룹 장식은 그룹 소유 서버와 보는 사람의 기존 설정을 따른다', async () => {
	const { container, rerender } = render(MkAvatar, { props: { room: { ...room, owner: { ...user, host: 'remote.example' } } }, global: { directives: { 'user-preview': {} } } });
	expect(container.querySelector(decorationSelector)).not.toBeNull();

	prefer.commit('showRemoteAvatarDecorations', false);
	await nextTick();
	expect(container.querySelector(decorationSelector)).toBeNull();
	expect(container.querySelector('img[src="https://example.com/group.png"]')).not.toBeNull();

	await rerender({ room });
	expect(container.querySelector(decorationSelector)).not.toBeNull();
});

test('그룹 변경은 이미 마운트된 그림과 장식에 반영된다', async () => {
	const { container, rerender } = render(MkAvatar, { props: { room }, global: { directives: { 'user-preview': {} } } });
	await rerender({ room: { ...room, iconUrl: 'https://example.com/identicon.png', iconDecorations: [] } });

	expect(container.querySelector('img[src="https://example.com/identicon.png"]')).not.toBeNull();
	expect(container.querySelector(decorationSelector)).toBeNull();
});

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


test.each([false, true])('hides only remote decorations without hiding avatars (floating button: %s)', async (isFloatingBtn) => {
	const remoteUser = { ...user, id: 'bob', host: 'remote.example' };
	const { container, rerender } = render(MkAvatar, { props: { user: remoteUser, isFloatingBtn }, global: { directives: { 'user-preview': {} } } });
	expect(container.querySelector(decorationSelector)).not.toBeNull();
	prefer.commit('showRemoteAvatarDecorations', false);
	await nextTick();
	expect(container.querySelector(decorationSelector)).toBeNull();
	expect(container.querySelector('img[src="https://example.com/avatar.png"]')).not.toBeNull();
	await rerender({ user });
	expect(container.querySelector(decorationSelector)).not.toBeNull();
	await rerender({ user: remoteUser });
	prefer.commit('showRemoteAvatarDecorations', true);
	await nextTick();
	expect(container.querySelector(decorationSelector)).not.toBeNull();
	prefer.commit('mutedAvatarDecorationUsers', ['bob']);
	await nextTick();
	expect(container.querySelector(decorationSelector)).toBeNull();
});


test('de-identifies a fully muted user independently of decoration-only muting', async () => {
	const mutedUser = { ...user, isMuted: true };
	const { container, rerender } = render(MkAvatar, { props: { user: mutedUser, preview: true }, global: { directives: { 'user-preview': {} } } });
	expect(container.querySelector('img[src="/favicon.ico"]')).not.toBeNull();
	expect(container.querySelector(decorationSelector)).toBeNull();
	expect(container.firstElementChild?.getAttribute('title')).not.toContain('alice');
	prefer.commit('deidentifyMutedUsers', false);
	await nextTick();
	expect(container.querySelector('img[src="https://example.com/avatar.png"]')).not.toBeNull();
	expect(container.querySelector(decorationSelector)).not.toBeNull();
	prefer.commit('deidentifyMutedUsers', true);
	await rerender({ user });
	prefer.commit('mutedAvatarDecorationUsers', ['alice']);
	await nextTick();
	expect(container.querySelector('img[src="https://example.com/avatar.png"]')).not.toBeNull();
	expect(container.querySelector(decorationSelector)).toBeNull();
});


test('replaces muted names and mini-card account details, and restores them reactively', async () => {
	const mutedUser = { ...user, name: 'Alice Example', isMuted: true };
	const name = render(MkUserName, { props: { user: mutedUser }, global: { stubs: { Mfm: { props: ['text'], template: '<span>{{ text }}</span>' } } } });
	const card = render(MkUserCardMini, { props: { user: mutedUser, withChart: false }, global: { directives: { 'adaptive-bg': {} }, stubs: { MkAvatar: true, MkUserName: true, Mfm: { props: ['text'], template: '<span>{{ text }}</span>' } } } });
	expect(name.container.textContent).toBe(i18n.ts.mutedUsers);
	expect(card.container.textContent).toContain(i18n.ts.mutedUsers);
	expect(card.container.textContent).not.toContain('@alice');
	prefer.commit('deidentifyMutedUsers', false);
	await nextTick();
	expect(name.container.textContent).toBe('Alice Example');
	expect(card.container.textContent).toContain('@alice');
});
