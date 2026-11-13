/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import { createFakePrefer } from './fake-prefer.js';

const mocks = vi.hoisted(() => ({
	streamHandlers: new Map<string, (...args: any[]) => void>(),
	channelHandlers: new Map<string, (...args: any[]) => void>(),
	refreshChatUnreadState: vi.fn(),
	updateCurrentAccount: vi.fn(),
	playMisskeySfx: vi.fn(),
	confirm: vi.fn(async () => ({ canceled: true })),
	prefer: null as any,
}));

vi.mock('@/boot/common.js', () => ({ common: vi.fn(async () => ({ isClientUpdated: false, isClientMigrated: false, lastVersion: '2026.11.0' })) }));
vi.mock('@@/js/config.js', () => ({ ui: 'default' }));
vi.mock('@/os.js', () => ({
	alert: vi.fn(),
	confirm: mocks.confirm,
	popup: vi.fn(() => ({ dispose: vi.fn() })),
	post: vi.fn(),
	toast: vi.fn(),
}));
vi.mock('@/stream.js', () => ({
	useStream: () => ({
		on: (event: string, handler: (...args: any[]) => void) => mocks.streamHandlers.set(event, handler),
		useChannel: () => ({
			on: (event: string, handler: (...args: any[]) => void) => mocks.channelHandlers.set(event, handler),
		}),
	}),
}));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: mocks.playMisskeySfx }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', token: 'viewer-token', isDeleted: false, loggedInDays: 0, notesCount: 0, followersCount: 0, createdAt: '2026-01-01T00:00:00.000Z', policies: { canSetFederationAvatarShape: false } } }));
vi.mock('@/instance.js', () => ({ instance: { repositoryUrl: 'https://github.com/chalkpe/cherrypick' } }));
vi.mock('@/store.js', () => ({ store: { loaded: Promise.resolve(), s: { realtimeMode: true, accountSetupWizard: -1, darkMode: false }, set: vi.fn() } }));
vi.mock('@/utility/reaction-picker.js', () => ({ reactionPicker: { init: vi.fn() } }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn(), claimedAchievements: ['client30min', 'client60min', 'justPlainLucky'] }));
vi.mock('@/utility/initialize-sw.js', () => ({ initializeSw: vi.fn() }));
vi.mock('@/utility/emoji-picker.js', () => ({ emojiPicker: { init: vi.fn() } }));
vi.mock('@/router.js', () => ({ mainRouter: { push: vi.fn() } }));
vi.mock('@/utility/hotkey.js', () => ({ makeHotkey: vi.fn(() => () => {}) }));
vi.mock('@/custom-emojis.js', () => ({ addCustomEmoji: vi.fn(), removeCustomEmojis: vi.fn(), updateCustomEmojis: vi.fn() }));
vi.mock('@/preferences.js', () => {
	mocks.prefer = createFakePrefer({
		menu: [],
		serverDisconnectedBehavior: 'quiet',
		enableSeasonalScreenEffect: false,
		welcomeBackToast: false,
		setFederationAvatarShape: false,
		syncDeviceDarkMode: false,
		'deck.useSimpleUiForNonRootPages': false,
	});
	return { prefer: mocks.prefer };
});
vi.mock('@/accounts.js', () => ({ refreshChatUnreadState: mocks.refreshChatUnreadState, updateCurrentAccount: mocks.updateCurrentAccount }));
vi.mock('@/utility/unison-reload.js', () => ({ unisonReload: vi.fn() }));
vi.mock('@/utility/is-birthday.js', () => ({ isBirthday: () => false }));
vi.mock('@/filters/user.js', () => ({ userName: () => 'Viewer' }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/utility/snow-effect-watcher.js', () => ({ watchSnowEffect: vi.fn() }));

import { mainBoot } from '@/boot/main-boot.js';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.streamHandlers.clear();
	mocks.channelHandlers.clear();
	mocks.prefer.reset({
		menu: [],
		serverDisconnectedBehavior: 'quiet',
		enableSeasonalScreenEffect: false,
		welcomeBackToast: false,
		setFederationAvatarShape: false,
		syncDeviceDarkMode: false,
		'deck.useSimpleUiForNonRootPages': false,
	});
});

// 재연결은 모든 사용자의 공통 경로다. 쪽지 미읽음 복구은 쪽지 이벤트와 재시도가 담당하므로, 재연결 자체가 계정 조회를 추가하면 안 된다.
test('a stream reconnect does not refresh the account by itself', async () => {
	await mainBoot();

	mocks.streamHandlers.get('_connected_')?.();
	expect(mocks.refreshChatUnreadState).not.toHaveBeenCalled();

	mocks.streamHandlers.get('_disconnected_')!();
	mocks.streamHandlers.get('_connected_')?.();
	expect(mocks.refreshChatUnreadState).not.toHaveBeenCalled();
});

test('chat events still refresh the account through the chat-only refresh', async () => {
	await mainBoot();

	mocks.channelHandlers.get('newChatMessage')!({});
	expect(mocks.refreshChatUnreadState).toHaveBeenCalledTimes(1);
	expect(mocks.playMisskeySfx).toHaveBeenCalledWith('chatMessage');

	mocks.channelHandlers.get('readAllChatMessages')!();
	mocks.channelHandlers.get('chatUnreadChanged')!();
	expect(mocks.refreshChatUnreadState).toHaveBeenCalledTimes(3);
});

test('other main-channel events keep their existing direct account updates', async () => {
	await mainBoot();

	mocks.channelHandlers.get('readAllNotifications')!();
	expect(mocks.updateCurrentAccount).toHaveBeenCalledWith({ hasUnreadNotification: false, unreadNotificationsCount: 0 });

	mocks.channelHandlers.get('meUpdated')!({ id: 'viewer' });
	expect(mocks.updateCurrentAccount).toHaveBeenCalledWith({ id: 'viewer' });
	expect(mocks.refreshChatUnreadState).not.toHaveBeenCalled();
});

test('the disconnect dialog still asks to reload', async () => {
	mocks.prefer.s.serverDisconnectedBehavior = 'dialog';
	await mainBoot();

	mocks.streamHandlers.get('_disconnected_')!();
	expect(mocks.confirm).toHaveBeenCalledTimes(1);
	expect(mocks.refreshChatUnreadState).not.toHaveBeenCalled();
});
