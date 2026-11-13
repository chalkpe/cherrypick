/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { refreshCurrentAccount, updateCurrentAccount } from '@/accounts.js';
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

// 계정 삭제는 쪽지와 무관한 공용 경로다. 삭제된 계정은 재시도 없이 로그아웃한다.
test('a deleted account signs out without retrying', async () => {
	updateCurrentAccount({ hasUnreadChatMessages: false });
	let calls = 0;
	vi.spyOn(window, 'fetch').mockImplementation(() => {
		calls++;
		return Promise.resolve(new Response(JSON.stringify({ error: { id: 'e5b3b9f0-2b8f-4b9f-9c1f-8c5c1b2e1b1a' } })));
	});

	await refreshCurrentAccount({ protectChatUnread: true });

	expect(calls).toBe(1);
	expect(signout).toHaveBeenCalled();
});
