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

const mocks = vi.hoisted(() => ({
	apiWithDialog: vi.fn(),
	store: { accountInfos: {}, realtimeMode: false } as { accountInfos: Record<string, unknown>; realtimeMode: boolean },
	chatEventsActive: false,
	chatGap: true,
}));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog }));
// 쪽지 구독의 공백 상태는 화면 밖에서 관리된다. 시험에서는 그 상태를 직접 놓는다
vi.mock('@/chat-unread-subscription.js', () => ({
	chatUnreadEventsActive: () => mocks.chatEventsActive,
	chatUnreadSubscriptionGap: () => mocks.chatGap,
	resolveChatUnreadGap: () => { mocks.chatGap = false; },
}));
vi.mock('@/signout.js', () => ({ signout: vi.fn() }));
vi.mock('@/utility/show-suspended-dialog.js', () => ({}));
vi.mock('@/utility/unison-reload.js', () => ({ unisonReload: vi.fn(), reloadChannel: { postMessage: vi.fn() } }));
vi.mock('@/i.js', () => {
	const me = { id: 'viewer', token: 'viewer-token', hasUnreadChatMessages: true, policies: { chatAvailability: 'available' } };
	return { $i: me, ensureSignin: () => me };
});
vi.mock('@/store.js', () => ({ store: { s: mocks.store, set: vi.fn() } }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ state: 'connected', on: vi.fn(), off: vi.fn(), useChannel: vi.fn() }) }));
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
	mocks.store.realtimeMode = false;
	mocks.chatEventsActive = false;
	mocks.chatGap = true;
});

// read-all 완료 뒤의 판단은 Promise 후속 처리에서 일어난다. 실제 시간 대기로 추정하지 않고 명시적으로 비운다
async function flushContinuations() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function renderSettings() {
	const wrapper = defineComponent({ render: () => h('div', [h(Suspense, null, { default: () => h(SettingsOther) })]) });
	return render(wrapper, { global: { stubs: {
		PageWithHeader: { template: '<div><slot /></div>' },
		SearchIcon: true,
		SearchLabel: { template: '<span><slot /></span>' },
		SearchText: { template: '<span><slot /></span>' },
		SearchMarker: { template: '<div><slot /></div>' },
		MkFolder: { template: '<section><slot /></section>' },
		MkRolePreview: true,
	} } });
}

test('a delayed read-all response preserves unread received after the server cleared older messages', async () => {
	mocks.chatEventsActive = false;
	let finishRead!: () => void;
	mocks.apiWithDialog.mockReturnValue(new Promise<void>(resolve => { finishRead = resolve; }));
	vi.spyOn(window, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'viewer', policies: { chatAvailability: 'available' }, hasUnreadChatMessages: true })));
	const view = renderSettings();
	await fireEvent.click(await view.findByRole('button', { name: i18n.ts.readAllChatMessages }));

	updateCurrentAccount({ hasUnreadChatMessages: false });
	updateCurrentAccount({ hasUnreadChatMessages: true });
	finishRead();

	await waitFor(() => expect($i?.hasUnreadChatMessages).toBe(true));
	expect(window.fetch).toHaveBeenCalled();
});

// 건강한 실시간 구독에서는 버전 붙은 chatUnread 이벤트가 상태를 확정하므로 계정 전체를 다시 조회하지 않는다
test('a healthy realtime subscription needs no account request after read-all', async () => {
	mocks.store.realtimeMode = true;
	mocks.chatEventsActive = true;
	mocks.chatGap = false;
	let finishRead!: () => void;
	mocks.apiWithDialog.mockReturnValue(new Promise<void>(resolve => { finishRead = resolve; }));
	vi.spyOn(window, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'viewer', policies: { chatAvailability: 'available' }, hasUnreadChatMessages: false })));
	const view = renderSettings();

	await fireEvent.click(await view.findByRole('button', { name: i18n.ts.readAllChatMessages }));
	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/read-all', {}));

	finishRead();
	await flushContinuations();

	expect(window.fetch).not.toHaveBeenCalled();
});

// 구독에 공백이 있으면 이벤트가 도착하지 않으므로 서버의 현재 상태로 확인한다
test('a subscription gap still asks the server after read-all', async () => {
	mocks.store.realtimeMode = true;
	mocks.chatEventsActive = true;
	mocks.chatGap = true;
	mocks.apiWithDialog.mockResolvedValue(undefined);
	vi.spyOn(window, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'viewer', policies: { chatAvailability: 'available' }, hasUnreadChatMessages: false })));
	const view = renderSettings();

	await fireEvent.click(await view.findByRole('button', { name: i18n.ts.readAllChatMessages }));

	await waitFor(() => expect(window.fetch).toHaveBeenCalled());
	await flushContinuations();
	expect(mocks.chatGap).toBe(false);
});

// 부팅 뒤 실시간 모드를 켜고 새로고침을 건너뛰면 이벤트 핸들러가 등록되지 않은 상태다
test('realtime mode turned on after boot without a reload still asks the server', async () => {
	mocks.store.realtimeMode = true;
	mocks.chatEventsActive = false;
	mocks.chatGap = false;
	mocks.apiWithDialog.mockResolvedValue(undefined);
	vi.spyOn(window, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'viewer', policies: { chatAvailability: 'available' }, hasUnreadChatMessages: false })));
	const view = renderSettings();

	await fireEvent.click(await view.findByRole('button', { name: i18n.ts.readAllChatMessages }));

	await waitFor(() => expect(window.fetch).toHaveBeenCalled());
});
