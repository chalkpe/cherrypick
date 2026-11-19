/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { misskeyApi } from '@/utility/misskey-api.js';

const session = vi.hoisted(() => ({ account: { token: 'current-session' } }));
vi.mock('@/i.js', () => ({ get $i() { return session.account; } }));

afterEach(() => {
	vi.restoreAllMocks();
});

test('uses the credential for each request without changing the caller data', async () => {
	const fetch = vi.spyOn(window, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
	const data = Object.freeze({ text: 'A note', i: 'caller-credential' });

	await misskeyApi('notes/create', data, 'selected-session');
	await misskeyApi('notes/create', data);
	await misskeyApi('notes/create', data, null);

	expect(fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)))).toEqual([
		{ text: 'A note', i: 'selected-session' },
		{ text: 'A note', i: 'current-session' },
		{ text: 'A note', i: null },
	]);
	expect(data.i).toBe('caller-credential');
});
