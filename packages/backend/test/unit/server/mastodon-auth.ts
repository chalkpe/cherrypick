/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify from 'fastify';
import { describe, expect, onTestFinished, test } from 'vitest';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { ApiPushMastodon } from '@/server/api/mastodon/endpoints/push.js';
import type { FastifyRequest } from 'fastify';

describe('Mastodon account suspension', () => {
	test.each(['native', 'app', 'flash'])('rejects suspended accounts using %s tokens for direct operations', async kind => {
		const me = { id: 'user', isSuspended: true };
		const auth = { authenticate: async () => [me, kind === 'app' ? { permission: ['read:account'] } : null, kind === 'flash' ? { permissions: ['read:account'] } : null] };
		const client = new MastodonClientService({} as never, auth as never);
		await expect(client.requireAuth({ headers: {} } as FastifyRequest, 'read:account')).rejects.toMatchObject({
			code: 'YOUR_ACCOUNT_SUSPENDED', kind: 'permission',
		});
	});

	test('allows an active account with the required permission', async () => {
		const me = { id: 'user', isSuspended: false };
		const auth = { authenticate: async () => [me, { permission: ['read:account'] }, null] };
		const client = new MastodonClientService({} as never, auth as never);
		await expect(client.requireAuth({ headers: {} } as FastifyRequest, 'read:account')).resolves.toBe(me);
		await expect(client.requireAuth({ headers: {} } as FastifyRequest, 'write:account')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
	});

	test.each(['GET', 'POST', 'PUT', 'DELETE'] as const)('rejects suspended accounts on %s push subscriptions before accessing storage', async method => {
		const app = Fastify();
		onTestFinished(() => app.close());
		const auth = { authenticate: async () => [{ id: 'user', isSuspended: true }, { id: 'token', permission: ['read:notifications'] }, null] };
		let storageAccesses = 0;
		const subscription = { id: 1, endpoint: 'https://push.example/subscription', alerts: {}, policy: 'all' };
		const push = {
			serverKey: 'public-key',
			get: async () => { storageAccesses++; return subscription; },
			save: async () => { storageAccesses++; return subscription; },
			remove: async () => { storageAccesses++; },
		};
		new ApiPushMastodon(auth as never, push as never).register(app);
		const response = await app.inject({
			method, url: '/v1/push/subscription',
			...(method === 'POST' ? { payload: { subscription: { endpoint: subscription.endpoint, keys: { p256dh: 'key', auth: 'auth' } } } } : {}),
		});
		expect(response.statusCode).toBe(403);
		expect(storageAccesses).toBe(0);
	});
});
