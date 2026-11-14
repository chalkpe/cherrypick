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
	waitGap: vi.fn(),
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
	beginChatUnreadRecheck: () => { mocks.chatGap = false; return { issue: true, failToken: 1 }; },
	restoreChatUnreadGapIfUnchanged: () => { mocks.chatGap = true; },
	waitChatUnreadGapResolved: (timeoutMs: number) => mocks.waitGap(timeoutMs),
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
	mocks.waitGap.mockReset();
	// 기본은 타임아웃: 이벤트가 끝내 도착하지 않은 상황
	mocks.waitGap.mockResolvedValue(false);
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
	expect(mocks.waitGap).not.toHaveBeenCalled();
});

// 공백이 있어도 모두읽음이 보낸 버전 붙은 이벤트가 도착하면 이벤트를 믿고 재조회하지 않는다
test('a subscription gap waits for the read-all event before asking the server', async () => {
	mocks.store.realtimeMode = true;
	mocks.chatEventsActive = true;
	mocks.chatGap = true;
	let finishWait!: (resolved: boolean) => void;
	mocks.waitGap.mockReturnValue(new Promise<boolean>(resolve => { finishWait = resolve; }));
	mocks.apiWithDialog.mockResolvedValue(undefined);
	vi.spyOn(window, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'viewer', policies: { chatAvailability: 'available' }, hasUnreadChatMessages: false })));
	const view = renderSettings();

	await fireEvent.click(await view.findByRole('button', { name: i18n.ts.readAllChatMessages }));
	await waitFor(() => expect(mocks.waitGap).toHaveBeenCalledWith(5000));
	expect(window.fetch).not.toHaveBeenCalled();

	// 기다리는 동안 버전 붙은 이벤트가 도착해 공백이 해소된 상황
	mocks.chatGap = false;
	finishWait(true);
	await flushContinuations();

	expect(window.fetch).not.toHaveBeenCalled();
});

// 이벤트가 끝내 도착하지 않으면(타임아웃) 서버의 현재 상태로 확인한다
test('a subscription gap still asks the server when the event never arrives', async () => {
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

// 실제 경합 순서: WS 이벤트가 HTTP 완료보다 먼저 도착해 공백이 이미 해소된 경우, 대기도 재조회도 없다
test('an event that beat the read-all response skips both the wait and the request', async () => {
	mocks.store.realtimeMode = true;
	mocks.chatEventsActive = true;
	mocks.chatGap = true;
	let finishRead!: () => void;
	mocks.apiWithDialog.mockReturnValue(new Promise<void>(resolve => { finishRead = resolve; }));
	vi.spyOn(window, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'viewer', policies: { chatAvailability: 'available' }, hasUnreadChatMessages: false })));
	const view = renderSettings();

	await fireEvent.click(await view.findByRole('button', { name: i18n.ts.readAllChatMessages }));
	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/read-all', {}));

	// HTTP 완료를 기다리는 동안 이벤트가 먼저 적용됨
	mocks.chatGap = false;
	finishRead();
	await flushContinuations();

	expect(mocks.waitGap).not.toHaveBeenCalled();
	expect(window.fetch).not.toHaveBeenCalled();
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
