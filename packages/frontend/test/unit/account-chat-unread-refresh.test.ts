/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { refreshCurrentAccount, updateCurrentAccount } from '@/accounts.js';
import { $i } from '@/i.js';
import { miLocalStorage } from '@/local-storage.js';

vi.mock('@/os.js', () => ({}));
vi.mock('@/signout.js', () => ({ signout: vi.fn() }));
vi.mock('@/utility/show-suspended-dialog.js', () => ({}));
vi.mock('@/utility/unison-reload.js', () => ({ unisonReload: vi.fn(), reloadChannel: { postMessage: vi.fn() } }));
vi.mock('@/i.js', () => ({ $i: { id: 'viewer', token: 'viewer-token', hasUnreadChatMessages: true } }));
vi.mock('@/store.js', () => ({ store: { s: { accountInfos: {} }, set: vi.fn() } }));

afterEach(() => vi.restoreAllMocks());

test.each([true, false])('a delayed account snapshot does not replace a newer chat state when its value was %s', async snapshot => {
	updateCurrentAccount({ hasUnreadChatMessages: snapshot });
	let respond!: (value: Response) => void;
	vi.spyOn(window, 'fetch').mockReturnValue(new Promise<Response>(resolve => { respond = resolve; }));

	const refreshed = refreshCurrentAccount();
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

	const refreshed = refreshCurrentAccount();
	updateCurrentAccount({ hasUnreadNotification: false });
	respond(new Response(JSON.stringify({ id: 'viewer', hasUnreadChatMessages: false })));
	await refreshed;

	expect($i?.hasUnreadChatMessages).toBe(false);
});
