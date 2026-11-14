/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import { createFakePrefer } from './fake-prefer.js';

const mocks = vi.hoisted(() => ({
	streamHandlers: new Map<string, (...args: any[]) => void>(),
	channelHandlers: new Map<string, (...args: any[]) => void>(),
	updateCurrentAccount: vi.fn(),
	playMisskeySfx: vi.fn(),
	misskeyApi: vi.fn(),
	confirm: vi.fn(async () => ({ canceled: true })),
	prefer: null as any,
	initChatUnreadSubscription: vi.fn(),
	resolveChatUnreadGap: vi.fn(),
	store: { realtimeMode: true, accountSetupWizard: -1, darkMode: false },
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
vi.mock('@/store.js', () => ({ store: { loaded: Promise.resolve(), s: mocks.store, set: vi.fn() } }));
vi.mock('@/chat-unread-subscription.js', () => ({
	initChatUnreadSubscription: mocks.initChatUnreadSubscription,
	resolveChatUnreadGap: mocks.resolveChatUnreadGap,
}));
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
vi.mock('@/accounts.js', () => ({ updateCurrentAccount: mocks.updateCurrentAccount }));
vi.mock('@/utility/unison-reload.js', () => ({ unisonReload: vi.fn() }));
vi.mock('@/utility/is-birthday.js', () => ({ isBirthday: () => false }));
vi.mock('@/filters/user.js', () => ({ userName: () => 'Viewer' }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/utility/snow-effect-watcher.js', () => ({ watchSnowEffect: vi.fn() }));

import { mainBoot } from '@/boot/main-boot.js';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.streamHandlers.clear();
	mocks.channelHandlers.clear();
	mocks.store.realtimeMode = true;
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

// 재연결은 모든 사용자의 공통 경로다. 쪽지 미읽음은 버전 붙은 이벤트가 담당하므로, 재연결 자체가 계정 조회를 추가하면 안 된다.
test('a stream reconnect does not refresh the account by itself', async () => {
	await mainBoot();

	mocks.streamHandlers.get('_connected_')?.();
	expect(mocks.updateCurrentAccount).not.toHaveBeenCalled();

	mocks.streamHandlers.get('_disconnected_')!();
	mocks.streamHandlers.get('_connected_')?.();
	expect(mocks.updateCurrentAccount).not.toHaveBeenCalled();
});

test('other main-channel events keep their existing direct account updates', async () => {
	await mainBoot();

	mocks.channelHandlers.get('readAllNotifications')!();
	expect(mocks.updateCurrentAccount).toHaveBeenCalledWith({ hasUnreadNotification: false, unreadNotificationsCount: 0 });

	mocks.channelHandlers.get('meUpdated')!({ id: 'viewer' });
	expect(mocks.updateCurrentAccount).toHaveBeenCalledWith({ id: 'viewer' });
	expect(mocks.updateCurrentAccount).toHaveBeenCalledTimes(2);
});

test('the disconnect dialog still asks to reload', async () => {
	mocks.prefer.s.serverDisconnectedBehavior = 'dialog';
	await mainBoot();

	mocks.streamHandlers.get('_disconnected_')!();
	expect(mocks.confirm).toHaveBeenCalledTimes(1);
	expect(mocks.updateCurrentAccount).not.toHaveBeenCalled();
});

// 쪽지 이벤트는 버전 붙은 상태를 직접 적용한다. 이벤트마다 계정 전체를 재조회하지 않는다.
test('chat events apply the versioned unread state without an account request', async () => {
	await mainBoot();

	mocks.channelHandlers.get('chatUnread')?.({ version: 1, hasUnreadChatMessages: true });
	expect(mocks.updateCurrentAccount).toHaveBeenCalledWith({ hasUnreadChatMessages: true });
	expect(mocks.misskeyApi).not.toHaveBeenCalled();
});

// 쪽지 구독의 공백 상태는 부팅 때 채팅 이벤트 처리와 함께 시작한다. 재연결 자체에 계정 조회를 넣지 않는다
test('boot starts the chat unread subscription when realtime mode is on', async () => {
	await mainBoot();

	expect(mocks.initChatUnreadSubscription).toHaveBeenCalledTimes(1);
});

test('boot does not start the chat unread subscription when realtime mode was off', async () => {
	mocks.store.realtimeMode = false;
	await mainBoot();

	expect(mocks.initChatUnreadSubscription).not.toHaveBeenCalled();
});

test('applying a chat unread event resolves the subscription gap', async () => {
	await mainBoot();

	mocks.channelHandlers.get('chatUnread')?.({ version: 2, hasUnreadChatMessages: false });
	expect(mocks.resolveChatUnreadGap).toHaveBeenCalledTimes(1);

	// 폐기된 옛 버전은 공백을 해소하지 않는다
	mocks.channelHandlers.get('chatUnread')?.({ version: 1, hasUnreadChatMessages: true });
	expect(mocks.resolveChatUnreadGap).toHaveBeenCalledTimes(1);
});

test('an older version arriving late does not overwrite the newer unread state', async () => {
	await mainBoot();

	mocks.channelHandlers.get('chatUnread')?.({ version: 2, hasUnreadChatMessages: false });
	mocks.channelHandlers.get('chatUnread')?.({ version: 1, hasUnreadChatMessages: true });
	mocks.channelHandlers.get('chatUnread')?.({ version: 2, hasUnreadChatMessages: false });
	expect(mocks.updateCurrentAccount).toHaveBeenCalledTimes(1);
	expect(mocks.updateCurrentAccount).toHaveBeenCalledWith({ hasUnreadChatMessages: false });
});

test('a new chat message plays the sound without an account request', async () => {
	await mainBoot();

	mocks.channelHandlers.get('newChatMessage')!({});
	expect(mocks.playMisskeySfx).toHaveBeenCalledWith('chatMessage');
	expect(mocks.updateCurrentAccount).not.toHaveBeenCalled();
	expect(mocks.misskeyApi).not.toHaveBeenCalled();
});
