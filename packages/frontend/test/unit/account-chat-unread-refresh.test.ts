/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { refreshChatUnreadState, refreshCurrentAccount, updateCurrentAccount } from '@/accounts.js';
import { $i } from '@/i.js';
import { miLocalStorage } from '@/local-storage.js';
import { signout } from '@/signout.js';

vi.mock('@/os.js', () => ({ alert: vi.fn(async () => {}), waiting: vi.fn(), popup: vi.fn(), popupMenu: vi.fn(), success: vi.fn() }));
vi.mock('@/signout.js', () => ({ signout: vi.fn() }));
vi.mock('@/utility/show-suspended-dialog.js', () => ({ showSuspendedDialog: vi.fn(async () => {}) }));
vi.mock('@/utility/unison-reload.js', () => ({ unisonReload: vi.fn(), reloadChannel: { postMessage: vi.fn() } }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', token: 'viewer-token', hasUnreadChatMessages: true } }));
vi.mock('@/store.js', () => ({ store: { s: { accountInfos: {}, accountTokens: {} }, set: vi.fn() } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { accounts: [] }, r: { accounts: { value: [] } }, commit: vi.fn() } }));

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

test.each([true, false])('a delayed account snapshot does not replace a newer chat state when its value was %s', async snapshot => {
	updateCurrentAccount({ hasUnreadChatMessages: snapshot });
	let respond!: (value: Response) => void;
	vi.spyOn(window, 'fetch').mockReturnValue(new Promise<Response>(resolve => { respond = resolve; }));

	const refreshed = refreshCurrentAccount({ protectChatUnread: true });
	updateCurrentAccount({ hasUnreadChatMessages: !snapshot });
	respond(new Response(JSON.stringify({ id: 'viewer', name: 'Updated profile', hasUnreadChatMessages: snapshot })));
	await refreshed;

	expect($i?.hasUnreadChatMessages).toBe(!snapshot);
	expect($i?.name).toBe('Updated profile');
	expect($i?.token).toBe('viewer-token');
	expect(JSON.parse(miLocalStorage.getItem('account')!).hasUnreadChatMessages).toBe(!snapshot);
});

test('an unrelated account update does not block a fresh unread snapshot', async () => {
	updateCurrentAccount({ hasUnreadChatMessages: true });
	let respond!: (value: Response) => void;
	vi.spyOn(window, 'fetch').mockReturnValue(new Promise<Response>(resolve => { respond = resolve; }));

	const refreshed = refreshCurrentAccount({ protectChatUnread: true });
	updateCurrentAccount({ hasUnreadNotification: false });
	respond(new Response(JSON.stringify({ id: 'viewer', hasUnreadChatMessages: false })));
	await refreshed;

	expect($i?.hasUnreadChatMessages).toBe(false);
});

test.each([true, false])('the newer account request wins when responses finish in reverse order (%s)', async latest => {
	const responses: ((value: Response) => void)[] = [];
	vi.spyOn(window, 'fetch').mockImplementation(() => new Promise<Response>(resolve => { responses.push(resolve); }));

	const older = refreshCurrentAccount({ protectChatUnread: true });
	const newer = refreshCurrentAccount({ protectChatUnread: true });
	responses[1](new Response(JSON.stringify({ id: 'viewer', name: 'Newer profile', hasUnreadChatMessages: latest })));
	await newer;
	responses[0](new Response(JSON.stringify({ id: 'viewer', name: 'Older profile', hasUnreadChatMessages: !latest })));
	await older;

	expect($i?.hasUnreadChatMessages).toBe(latest);
	expect($i?.name).toBe('Newer profile');
});

test('unread events during a refresh ask for one more account, sent after them', async () => {
	const responses: ((value: Response) => void)[] = [];
	const fetch = vi.spyOn(window, 'fetch').mockImplementation(() => new Promise<Response>(resolve => { responses.push(resolve); }));

	// A new-message event, then a read event that the server sent after the read, arrive while the first request is out.
	const settled = refreshChatUnreadState();
	refreshChatUnreadState();
	refreshChatUnreadState();
	expect(fetch).toHaveBeenCalledTimes(1);

	responses[0](new Response(JSON.stringify({ id: 'viewer', hasUnreadChatMessages: true })));
	await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
	responses[1](new Response(JSON.stringify({ id: 'viewer', hasUnreadChatMessages: false })));
	await settled;

	expect(fetch).toHaveBeenCalledTimes(2);
	expect($i?.hasUnreadChatMessages).toBe(false);
});

test('ordinary account refreshes retain their existing completion order', async () => {
	const responses: ((value: Response) => void)[] = [];
	vi.spyOn(window, 'fetch').mockImplementation(() => new Promise<Response>(resolve => { responses.push(resolve); }));

	const older = refreshCurrentAccount();
	const newer = refreshCurrentAccount();
	responses[1](new Response(JSON.stringify({ id: 'viewer', name: 'Newer' })));
	await newer;
	responses[0](new Response(JSON.stringify({ id: 'viewer', name: 'Older' })));
	await older;

	expect($i?.name).toBe('Older');
});

// 일시적인 조회 실패가 동기화 이벤트를 소모한 채 끝내면, 다음 이벤트나 재시작 전까지 표시가 어긋난다.
test.each([
	{ direction: 'new message', before: false, after: true },
	{ direction: 'read elsewhere', before: true, after: false },
])('a failed unread sync recovers without another event ($direction)', async ({ before, after }) => {
	vi.useFakeTimers();
	updateCurrentAccount({ hasUnreadChatMessages: before });
	let calls = 0;
	vi.spyOn(window, 'fetch').mockImplementation(() => {
		calls++;
		if (calls === 1) return Promise.reject(new Error('network down'));
		return Promise.resolve(new Response(JSON.stringify({ id: 'viewer', hasUnreadChatMessages: after })));
	});

	const settled = refreshChatUnreadState();
	await vi.advanceTimersByTimeAsync(60_000);
	await settled;

	expect(calls).toBe(2);
	expect($i?.hasUnreadChatMessages).toBe(after);
});

test('a server-error unread sync also recovers without another event', async () => {
	vi.useFakeTimers();
	updateCurrentAccount({ hasUnreadChatMessages: false });
	let calls = 0;
	vi.spyOn(window, 'fetch').mockImplementation(() => {
		calls++;
		if (calls === 1) return Promise.resolve(new Response('', { status: 503 }));
		return Promise.resolve(new Response(JSON.stringify({ id: 'viewer', hasUnreadChatMessages: true })));
	});

	const settled = refreshChatUnreadState();
	await vi.advanceTimersByTimeAsync(60_000);
	await settled;

	expect(calls).toBe(2);
	expect($i?.hasUnreadChatMessages).toBe(true);
});

test('retries stop once the unread sync succeeds', async () => {
	vi.useFakeTimers();
	updateCurrentAccount({ hasUnreadChatMessages: false });
	let calls = 0;
	vi.spyOn(window, 'fetch').mockImplementation(() => {
		calls++;
		if (calls === 1) return Promise.reject(new Error('network down'));
		return Promise.resolve(new Response(JSON.stringify({ id: 'viewer', hasUnreadChatMessages: true })));
	});

	const settled = refreshChatUnreadState();
	await vi.advanceTimersByTimeAsync(60_000);
	await settled;
	await vi.advanceTimersByTimeAsync(120_000);

	expect(calls).toBe(2);
});

test('events during a retry wait still merge into one retry', async () => {
	vi.useFakeTimers();
	updateCurrentAccount({ hasUnreadChatMessages: false });
	let calls = 0;
	vi.spyOn(window, 'fetch').mockImplementation(() => {
		calls++;
		if (calls === 1) return Promise.reject(new Error('network down'));
		return Promise.resolve(new Response(JSON.stringify({ id: 'viewer', hasUnreadChatMessages: true })));
	});

	const settled = refreshChatUnreadState();
	await vi.advanceTimersByTimeAsync(100);
	refreshChatUnreadState();
	refreshChatUnreadState();
	await vi.advanceTimersByTimeAsync(60_000);
	await settled;

	expect(calls).toBe(2);
	expect($i?.hasUnreadChatMessages).toBe(true);
});

test('a deleted account is not retried', async () => {
	vi.useFakeTimers();
	updateCurrentAccount({ hasUnreadChatMessages: false });
	let calls = 0;
	vi.spyOn(window, 'fetch').mockImplementation(() => {
		calls++;
		return Promise.resolve(new Response(JSON.stringify({ error: { id: 'e5b3b9f0-2b8f-4b9f-9c1f-8c5c1b2e1b1a' } })));
	});

	const settled = refreshChatUnreadState();
	await vi.advanceTimersByTimeAsync(120_000);
	await settled;

	expect(calls).toBe(1);
	expect(signout).toHaveBeenCalled();
});
