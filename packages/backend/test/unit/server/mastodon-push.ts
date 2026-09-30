/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createECDH, randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import push from 'web-push';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { MastodonPushService } from '@/server/api/mastodon/MastodonPushService.js';
import type { Config } from '@/config.js';
import type { Packed } from '@/misc/json-schema.js';

// Use a TCP listener: receiving a TLS handshake is enough to detect a private-network
// request, without certificates, disabling TLS verification, or contacting external hosts.
describe('Mastodon push network policy', () => {
	test.each([
		{ allowed: false, bypassProxy: false },
		{ allowed: true, bypassProxy: false },
		{ allowed: false, bypassProxy: true },
	])('respects network policy ($allowed, proxy bypass: $bypassProxy)', async ({ allowed, bypassProxy }) => {
		vi.stubEnv('NODE_ENV', 'production');
		onTestFinished(() => { vi.unstubAllEnvs(); });
		let receivedBytes = 0;
		const server = createServer(socket => {
			socket.on('error', () => {});
			socket.on('data', data => {
				receivedBytes += data.length;
				socket.destroy();
			});
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
		const address = server.address();
		if (address == null || typeof address === 'string') throw new Error('Missing listener address');

		const config = {
			url: 'https://social.example',
			allowedPrivateNetworks: allowed ? ['127.0.0.0/8'] : [],
			// A bypassed proxy must not override private-address filtering.
			proxy: bypassProxy ? `http://127.0.0.1:${address.port}` : undefined,
			proxyBypassHosts: bypassProxy ? ['127.0.0.1'] : [],
		} as unknown as Config;
		const vapid = push.generateVAPIDKeys();
		const clientKey = createECDH('prime256v1');
		clientKey.generateKeys();
		const subscription = {
			id: 1, userId: 'user', accessTokenId: 'token',
			endpoint: `https://127.0.0.1:${address.port}/push`,
			p256dh: clientKey.getPublicKey().toString('base64url'),
			auth: randomBytes(16).toString('base64url'),
			standard: true, alerts: { follow: true }, policy: 'all',
		};
		const service = new MastodonPushService(
			config,
			{ enableServiceWorker: true, swPublicKey: vapid.publicKey, swPrivateKey: vapid.privateKey } as never,
			{ smembers: async () => ['token'], set: async () => 'OK', get: async () => JSON.stringify(subscription) } as never,
			new EventEmitter() as never,
			{ findOneBy: async () => ({ token: 'access-token' }) } as never,
			{ userProfileCache: { fetch: async () => ({ lang: 'en' }) } } as never,
			{ getLogger: () => ({ warn: () => {} }) } as never,
			new HttpRequestService(config),
		);
		onTestFinished(() => service.onApplicationShutdown());
		await service['deliver']('user', {
			id: 'notification', type: 'follow', userId: 'follower',
			user: { username: 'follower', name: null },
		} as Packed<'Notification'>);

		if (allowed) {
			expect(receivedBytes).toBeGreaterThan(0);
		} else {
			expect(receivedBytes).toBe(0);
		}
	});
});
