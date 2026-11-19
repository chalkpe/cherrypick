/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify from 'fastify';
import { describe, expect, onTestFinished, test } from 'vitest';
import { MastodonOAuthService } from '@/server/api/mastodon/MastodonOAuthService.js';
import { ApiAppsMastodon } from '@/server/api/mastodon/endpoints/apps.js';
import { getErrorData, getErrorStatus } from '@/server/api/mastodon/MastodonLogger.js';

/**
 * Counts calls per actor and key like RateLimiterService does, and answers with the limit information once max is exceeded.
 */
function createRateLimiter() {
	const counts = new Map<string, number>();
	const calls: { key: string; duration?: number; max?: number; actor: string }[] = [];
	return {
		calls,
		limit: async (limitation: { key: string; duration?: number; max?: number }, actor: string) => {
			calls.push({ key: limitation.key, duration: limitation.duration, max: limitation.max, actor });
			const id = `${actor}:${limitation.key}`;
			const count = (counts.get(id) ?? 0) + 1;
			counts.set(id, count);
			return count > (limitation.max ?? Infinity) ? { info: { remaining: 0, resetMs: 1000, resetSec: 1, fullResetMs: 1000, fullResetSec: 1 } } : null;
		},
	};
}

function appsServer(options: { enableIpRateLimit?: boolean, insertError?: Error } = {}) {
	const app = Fastify();
	app.setErrorHandler((error, _request, reply) => reply.code(getErrorStatus(error)).send(getErrorData(error)));
	onTestFinished(() => app.close());
	const inserts: { name: string }[] = [];
	const appsRepository = {
		insertOne: async (data: { name: string }) => {
			if (options.insertError) throw options.insertError;
			inserts.push(data);
			return { ...data, id: 'app-id', secret: 'secret' };
		},
	};
	const rateLimiter = createRateLimiter();
	new ApiAppsMastodon(
		appsRepository as never,
		{} as never,
		{ gen: () => 'app-id' } as never,
		{} as never,
		{ enableIpRateLimit: options.enableIpRateLimit ?? true } as never,
		rateLimiter as never,
	).register(app);
	return { app, inserts, rateLimiter };
}

const registration = {
	client_name: 'Test client',
	redirect_uris: 'https://client.example/callback',
	scopes: 'read',
};

describe('Mastodon app registration limits', () => {
	test('answers 429 after 30 registrations an hour from one address without creating more apps', async () => {
		const { app, inserts, rateLimiter } = appsServer();

		for (let i = 0; i < 30; i++) {
			const response = await app.inject({ method: 'POST', url: '/v1/apps', payload: registration, remoteAddress: '192.0.2.10' });
			expect(response.statusCode).toBe(200);
		}
		expect(inserts).toHaveLength(30);

		const limited = await app.inject({ method: 'POST', url: '/v1/apps', payload: registration, remoteAddress: '192.0.2.10' });
		expect(limited.statusCode).toBe(429);
		expect(inserts).toHaveLength(30);
		expect(rateLimiter.calls[0]).toMatchObject({ duration: 60 * 60 * 1000, max: 30 });

		// Another address has its own budget
		const other = await app.inject({ method: 'POST', url: '/v1/apps', payload: registration, remoteAddress: '192.0.2.11' });
		expect(other.statusCode).toBe(200);
		expect(inserts).toHaveLength(31);
	});

	test('does not limit registrations when IP rate limiting is turned off', async () => {
		const { app, inserts, rateLimiter } = appsServer({ enableIpRateLimit: false });
		for (let i = 0; i < 40; i++) {
			const response = await app.inject({ method: 'POST', url: '/v1/apps', payload: registration });
			expect(response.statusCode).toBe(200);
		}
		expect(inserts).toHaveLength(40);
		expect(rateLimiter.calls).toHaveLength(0);
	});

	test.each([
		['client_name', { client_name: 'n'.repeat(129) }],
		['website', { website: 'https://client.example/' + 'w'.repeat(500) }],
		['redirect_uris', { redirect_uris: `https://client.example/${'r'.repeat(500)}` }],
		['redirect_uris of several URIs', { redirect_uris: [`https://client.example/${'a'.repeat(250)}`, `https://client.example/${'b'.repeat(250)}`] }],
	])('answers 422 for a too long %s without creating an app', async (_name, override) => {
		const { app, inserts } = appsServer();
		const response = await app.inject({ method: 'POST', url: '/v1/apps', payload: { ...registration, ...override } });
		expect(response.statusCode).toBe(422);
		expect(response.json().error).toMatch(/^Validation failed/);
		expect(inserts).toHaveLength(0);
	});

	test('registers an app with values at the column lengths', async () => {
		const { app, inserts } = appsServer();
		const website = 'https://client.example/' + 'w'.repeat(512 - 'https://client.example/'.length);
		const redirect = 'https://client.example/' + 'r'.repeat(512 - 'https://client.example/'.length);
		const response = await app.inject({
			method: 'POST',
			url: '/v1/apps',
			payload: { client_name: 'n'.repeat(128), website, redirect_uris: redirect, scopes: 'read' },
		});
		expect(response.statusCode).toBe(200);
		expect(inserts).toHaveLength(1);
		expect(response.json()).toMatchObject({ name: 'n'.repeat(128), website, redirect_uri: redirect });
	});
});

describe('Mastodon authorization session limits', () => {
	function authorizeService(options: { enableIpRateLimit?: boolean } = {}) {
		const sessions: unknown[] = [];
		const rateLimiter = createRateLimiter();
		const service = new MastodonOAuthService(
			{ authUrl: 'https://example.test/auth', enableIpRateLimit: options.enableIpRateLimit ?? true } as never,
			{ set: async () => 'OK' } as never,
			{ findOneBy: async () => ({ id: 'app', permission: ['read:account'], callbackUrl: 'https://client.example/callback' }) } as never,
			{ insertOne: async (data: unknown) => { sessions.push(data); return { token: 'mastodon:token' }; } } as never,
			{} as never,
			{ gen: () => 'session-id' } as never,
			{ getLogger: () => ({ info: () => {}, error: () => {} }) } as never,
			rateLimiter as never,
		);
		return { service, sessions, rateLimiter };
	}

	function reply(ip: string) {
		return {
			status: 0,
			body: undefined as unknown,
			location: undefined as string | undefined,
			request: { ip },
			code(status: number) { this.status = status; return this; },
			send(body: unknown) { this.body = body; },
			redirect(location: string) { this.location = location; },
		};
	}

	const params = { client_id: 'app', redirect_uri: 'https://client.example/callback', response_type: 'code', scope: 'read:account' };

	test('answers 429 after 60 sessions an hour from one address without creating more sessions', async () => {
		const { service, sessions, rateLimiter } = authorizeService();

		for (let i = 0; i < 60; i++) {
			const r = reply('192.0.2.20');
			await service.authorize(params, r as never);
			expect(r.location).toBeDefined();
		}
		expect(sessions).toHaveLength(60);

		const limited = reply('192.0.2.20');
		await service.authorize(params, limited as never);
		expect(limited.status).toBe(429);
		expect(limited.location).toBeUndefined();
		expect(sessions).toHaveLength(60);
		expect(rateLimiter.calls[0]).toMatchObject({ duration: 60 * 60 * 1000, max: 60 });

		const other = reply('192.0.2.21');
		await service.authorize(params, other as never);
		expect(other.location).toBeDefined();
		expect(sessions).toHaveLength(61);
	});

	test('does not limit sessions when IP rate limiting is turned off', async () => {
		const { service, sessions } = authorizeService({ enableIpRateLimit: false });
		for (let i = 0; i < 70; i++) {
			const r = reply('192.0.2.20');
			await service.authorize(params, r as never);
			expect(r.location).toBeDefined();
		}
		expect(sessions).toHaveLength(70);
	});
});
