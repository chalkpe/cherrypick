/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify from 'fastify';
import { describe, expect, onTestFinished, test } from 'vitest';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { MastodonFilterService } from '@/server/api/mastodon/MastodonFilterService.js';
import { getErrorData, getErrorStatus } from '@/server/api/mastodon/MastodonLogger.js';
import { ApiFilterMastodon } from '@/server/api/mastodon/endpoints/filter.js';
import { ApiStatusMastodon } from '@/server/api/mastodon/endpoints/status.js';
import type { FastifyRequest } from 'fastify';

function server() {
	const app = Fastify();
	app.setErrorHandler((error, _request, reply) => reply.code(getErrorStatus(error)).send(getErrorData(error)));
	onTestFinished(() => app.close());
	return app;
}

describe('Mastodon filter write permissions', () => {
	test.each(['POST', 'PUT', 'DELETE', 'GET'] as const)('checks permissions for %s of a filter without keywords', async method => {
		const app = server();
		const me = { id: 'user', isSuspended: false };
		let permissions = ['read:account'];
		const auth = { authenticate: async () => [me, { permission: permissions }, null] };
		const client = new MastodonClientService({} as never, auth as never);
		const stored = new Map<string, string>();
		const redis = {
			hvals: async () => [...stored.values()],
			hset: async (_key: string, id: string, value: string) => stored.set(id, value),
			hdel: async (_key: string, id: string) => stored.delete(id),
		};
		const profiles = { findOneByOrFail: async () => ({ mutedWords: [], hardMutedWords: [] }) };
		let nextId = 0;
		const filters = new MastodonFilterService(redis as never, profiles as never, { gen: () => String(++nextId) } as never, client, {} as never);
		const existing = await filters.create(me as never, {} as FastifyRequest, { title: 'original' });
		const before = [...stored.entries()];
		new ApiFilterMastodon(client, filters).register(app);

		const response = await app.inject({
			method,
			url: method === 'POST' ? '/v2/filters' : `/v2/filters/${existing.id}`,
			...(method === 'DELETE' || method === 'GET' ? {} : { payload: { title: 'unauthorized' } }),
		});
		expect(response.statusCode).toBe(method === 'GET' ? 200 : 403);
		expect([...stored.entries()]).toEqual(before);

		permissions = ['read:account', 'write:account'];
		const allowed = await app.inject({
			method,
			url: method === 'POST' ? '/v2/filters' : `/v2/filters/${existing.id}`,
			...(method === 'DELETE' || method === 'GET' ? {} : { payload: { title: 'authorized' } }),
		});
		expect(allowed.statusCode).toBe(200);
		if (method !== 'GET') expect([...stored.entries()]).not.toEqual(before);
	});
});

describe('Mastodon media request amplification', () => {
	test.each(['create', 'update', 'schedule'])('rejects too many media IDs before internal requests on %s', async operation => {
		const upstream = server();
		let internalRequests = 0;
		const allMediaRequests = Promise.withResolvers<void>();
		upstream.post('/api/drive/files/update', async (_request, reply) => {
			internalRequests++;
			if (internalRequests === 16) allMediaRequests.resolve();
			await allMediaRequests.promise;
			return reply.code(401).send({ error: 'Credential required' });
		});
		const address = new URL(await upstream.listen({ host: '127.0.0.1', port: 0 }));
		const client = new MastodonClientService(
			{ url: address.origin, port: Number(address.port) } as never,
			{ authenticate: async () => [null, null, null] } as never,
		);
		const app = server();
		new ApiStatusMastodon({} as never, client, {} as never, {} as never).register(app);

		for (const mediaIds of [Array.from({ length: 17 }, (_, i) => `file${i}`), ['same', 'same'], 'file', [1], ['']]) {
			const response = await app.inject({
				method: operation === 'update' ? 'PUT' : 'POST',
				url: operation === 'update' ? '/v1/statuses/note' : '/v1/statuses',
				payload: {
					status: 'test', sensitive: 'true',
					media_ids: mediaIds,
					...(operation === 'schedule' ? { scheduled_at: new Date(Date.now() + 60000).toISOString() } : {}),
				},
			});
			expect(response.statusCode).toBe(400);
			expect(internalRequests).toBe(0);
		}

		// The maximum valid list still reaches the internal API and keeps its authentication failure.
		const allowed = await app.inject({
			method: operation === 'update' ? 'PUT' : 'POST',
			url: operation === 'update' ? '/v1/statuses/note' : '/v1/statuses',
			payload: {
				status: 'test', sensitive: 'true',
				media_ids: Array.from({ length: 16 }, (_, i) => `file${i}`),
				...(operation === 'schedule' ? { scheduled_at: new Date(Date.now() + 60000).toISOString() } : {}),
			},
		});
		expect(allowed.statusCode).toBe(401);
		expect(internalRequests).toBe(16);
	});
});
