/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import SessionShow from '@/server/api/endpoints/auth/session/show.js';

const registeredPermission = ['read:account', 'read:notifications', 'write:notes', 'write:reactions', 'write:votes'];

function fixture(token: string, scope: string | null) {
	const app = { id: 'app', name: 'Scope test', permission: [...registeredPermission], isAuthorized: false };
	const packed = { id: 'session', token, app };
	const redis = { get: vi.fn(async () => scope == null ? null : JSON.stringify({ scope, redirectUri: 'https://client.example/callback', codeChallenge: null })) };
	const pack = vi.fn(async () => packed);
	const endpoint = new SessionShow({ findOneBy: async () => packed } as never, { pack } as never, redis as never);
	return { endpoint, redis, pack, app };
}

describe('authorization session consent permissions', () => {
	test('returns the server-stored grant permissions while preserving the registered app', async () => {
		const { endpoint, redis, app } = fixture('mastodon:request', 'read:notifications');
		const result = await endpoint.exec({ token: 'mastodon:request' }, null, null, null);

		expect(redis.get).toHaveBeenCalledWith('mastodonOAuth:mastodon:request');
		expect(result.permission).toEqual(['read:notifications']);
		expect(result.app.permission).toEqual(registeredPermission);
		expect(app.permission).toEqual(registeredPermission);
	});

	test('ignores a client scope parameter and uses the pending request', async () => {
		const { endpoint } = fixture('mastodon:request', 'write:statuses');
		const result = await endpoint.exec({ token: 'mastodon:request', scope: 'read' }, null, null, null);
		expect(result.permission).toEqual(['write:notes', 'write:reactions', 'write:votes']);
	});

	test('preserves an explicit grant with no private endpoint permission', async () => {
		const { endpoint } = fixture('mastodon:request', 'read:search');
		const result = await endpoint.exec({ token: 'mastodon:request' }, null, null, null);
		expect(result.permission).toEqual([]);
	});

	test('rejects an expired Mastodon request instead of showing registered permissions', async () => {
		const { endpoint, pack } = fixture('mastodon:expired', null);
		await expect(endpoint.exec({ token: 'mastodon:expired' }, null, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_SESSION' });
		expect(pack).not.toHaveBeenCalled();
	});

	test('keeps legacy sessions on the registered permission contract', async () => {
		const { endpoint, redis } = fixture('legacy-session', null);
		const result = await endpoint.exec({ token: 'legacy-session', mastodon: true, scope: 'read' }, null, null, null);
		expect(result.app.permission).toEqual(registeredPermission);
		expect(result).not.toHaveProperty('permission');
		expect(redis.get).not.toHaveBeenCalled();
	});
});
