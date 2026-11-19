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
import type { FastifyRequest } from 'fastify';

const CONTEXTS = ['home', 'notifications', 'public', 'thread', 'account'];

async function setup() {
	const upstream = Fastify();
	const wordMuteUpdates: unknown[] = [];
	upstream.post('/api/i/update', async (request, reply) => {
		wordMuteUpdates.push(request.body);
		return reply.send({});
	});
	onTestFinished(() => upstream.close());
	const address = new URL(await upstream.listen({ host: '127.0.0.1', port: 0 }));

	const app = Fastify();
	app.setErrorHandler((error, _request, reply) => reply.code(getErrorStatus(error)).send(getErrorData(error)));
	onTestFinished(() => app.close());

	const me = { id: 'user', isSuspended: false };
	const auth = { authenticate: async () => [me, { permission: ['read:account', 'write:account'] }, null] };
	const client = new MastodonClientService({ url: address.origin, port: Number(address.port) } as never, auth as never);
	const stored = new Map<string, string>();
	const redis = {
		hvals: async () => [...stored.values()],
		hset: async (_key: string, id: string, value: string) => stored.set(id, value),
		hdel: async (_key: string, id: string) => stored.delete(id),
	};
	const profile = { mutedWords: [] as unknown[], hardMutedWords: [] as unknown[] };
	const profiles = { findOneByOrFail: async () => profile };
	let nextId = 0;
	const filters = new MastodonFilterService(redis as never, profiles as never, { gen: () => `id${++nextId}` } as never, client, {} as never);
	new ApiFilterMastodon(client, filters).register(app);

	return { app, me, filters, stored, wordMuteUpdates, profile };
}

describe('Mastodon filter titles, contexts and counts', () => {
	test('creates, reads and updates a filter with a title of 256 characters and every context', async () => {
		const { app, stored } = await setup();
		const title = 'a'.repeat(256);

		const created = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title, context: CONTEXTS } });
		expect(created.statusCode).toBe(200);
		expect(created.json()).toMatchObject({ title, context: CONTEXTS, filter_action: 'warn', keywords: [] });
		expect(stored.size).toBe(1);

		const id = created.json().id;
		const updated = await app.inject({ method: 'PUT', url: `/v2/filters/${id}`, payload: { title: 'renamed', context: ['home', 'thread'] } });
		expect(updated.statusCode).toBe(200);
		expect(updated.json()).toMatchObject({ id, title: 'renamed', context: ['home', 'thread'] });

		const read = await app.inject({ method: 'GET', url: `/v2/filters/${id}` });
		expect(read.json()).toMatchObject({ id, title: 'renamed', context: ['home', 'thread'] });
		const list = await app.inject({ method: 'GET', url: '/v2/filters' });
		expect(list.json()).toHaveLength(1);
	});

	test('keeps the default contexts of a filter created without any', async () => {
		const { app } = await setup();
		const created = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'defaults' } });
		expect(created.statusCode).toBe(200);
		expect(created.json().context).toEqual(CONTEXTS);
	});

	test('stores a context listed more than once a single time', async () => {
		const { app } = await setup();
		const created = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'twice', context: ['home', 'home', 'thread', 'home'] } });
		expect(created.statusCode).toBe(200);
		expect(created.json().context).toEqual(['home', 'thread']);
	});

	test('rejects a title of 257 characters on create and update without storing it', async () => {
		const { app, stored } = await setup();
		const created = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'x'.repeat(257) } });
		expect(created.statusCode).toBe(422);
		expect(created.json().error).toMatch(/^Validation failed/);
		expect(stored.size).toBe(0);

		const existing = (await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'short' } })).json();
		const before = [...stored.entries()];
		const updated = await app.inject({ method: 'PUT', url: `/v2/filters/${existing.id}`, payload: { title: 'x'.repeat(257) } });
		expect(updated.statusCode).toBe(422);
		expect([...stored.entries()]).toEqual(before);
	});

	test('rejects an unknown context on create and update without storing it', async () => {
		const { app, stored } = await setup();
		const created = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'bad', context: ['home', 'timeline'] } });
		expect(created.statusCode).toBe(422);
		expect(stored.size).toBe(0);

		const existing = (await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'good' } })).json();
		const before = [...stored.entries()];
		const updated = await app.inject({ method: 'PUT', url: `/v2/filters/${existing.id}`, payload: { context: ['nowhere'] } });
		expect(updated.statusCode).toBe(422);
		expect([...stored.entries()]).toEqual(before);
	});

	test('rejects a context list with thousands of entries only when it holds unknown values', async () => {
		const { app, stored } = await setup();
		const many = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'many', context: Array.from({ length: 5000 }, (_, i) => `context${i}`) } });
		expect(many.statusCode).toBe(422);
		expect(stored.size).toBe(0);
	});

	test('accepts 200 filters per user and rejects the 201st without storing it', async () => {
		const { app, me, filters, stored } = await setup();
		for (let i = 0; i < 200; i++) {
			await filters.create(me as never, {} as FastifyRequest, { title: `filter ${i}` });
		}
		expect(stored.size).toBe(200);
		const before = [...stored.keys()];

		const response = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'one too many' } });
		expect(response.statusCode).toBe(422);
		expect(response.json().error).toMatch(/^Validation failed/);
		expect([...stored.keys()]).toEqual(before);

		// A filter can still be changed and deleted at the limit
		const id = before[0];
		const updated = await app.inject({ method: 'PUT', url: `/v2/filters/${id}`, payload: { title: 'still editable' } });
		expect(updated.statusCode).toBe(200);
		const deleted = await app.inject({ method: 'DELETE', url: `/v2/filters/${id}` });
		expect(deleted.statusCode).toBe(200);
		const again = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'room again' } });
		expect(again.statusCode).toBe(200);
	});

	test('applies the same limits to the v1 filter routes', async () => {
		const { app, stored, wordMuteUpdates } = await setup();

		const unknownContext = await app.inject({ method: 'POST', url: '/v1/filters', payload: { phrase: 'word', context: ['home', 'timeline'] } });
		expect(unknownContext.statusCode).toBe(422);
		expect(stored.size).toBe(0);
		expect(wordMuteUpdates).toHaveLength(0);

		const created = await app.inject({ method: 'POST', url: '/v1/filters', payload: { phrase: 'word', context: ['home', 'public'], irreversible: 'false', whole_word: 'true' } });
		expect(created.statusCode).toBe(200);
		expect(created.json()).toMatchObject({ phrase: 'word', context: ['home', 'public'], whole_word: true });
		expect(stored.size).toBe(1);
		const id = created.json().id;

		const before = [...stored.entries()];
		const updated = await app.inject({ method: 'PUT', url: `/v1/filters/${id}`, payload: { context: ['nowhere'] } });
		expect(updated.statusCode).toBe(422);
		expect([...stored.entries()]).toEqual(before);

		const fine = await app.inject({ method: 'PUT', url: `/v1/filters/${id}`, payload: { context: ['thread'] } });
		expect(fine.statusCode).toBe(200);
		expect(fine.json().context).toEqual(['thread']);
	});

	test('creates a v1 filter for a phrase longer than a title may be', async () => {
		const { app } = await setup();
		const phrase = 'p'.repeat(300);
		const created = await app.inject({ method: 'POST', url: '/v1/filters', payload: { phrase } });
		expect(created.statusCode).toBe(200);
		expect(created.json().phrase).toBe(phrase);
	});

	test('rejects the 201st filter on the v1 route', async () => {
		const { app, me, filters, stored } = await setup();
		for (let i = 0; i < 200; i++) {
			await filters.create(me as never, {} as FastifyRequest, { title: `filter ${i}` });
		}
		const response = await app.inject({ method: 'POST', url: '/v1/filters', payload: { phrase: 'word' } });
		expect(response.statusCode).toBe(422);
		expect(stored.size).toBe(200);
	});

	test('stores a keyword listed more than once a single time on create and on repeated updates', async () => {
		const { app, stored } = await setup();
		const keywords = Array.from({ length: 1000 }, () => ({ keyword: 'same', whole_word: false }));
		const created = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'dups', keywords_attributes: keywords } });
		expect(created.statusCode).toBe(200);
		expect(created.json().keywords).toHaveLength(1);
		const id = created.json().id;
		const size = [...stored.values()][0].length;

		for (let i = 0; i < 5; i++) {
			const updated = await app.inject({ method: 'PUT', url: `/v2/filters/${id}`, payload: { keywords_attributes: keywords } });
			expect(updated.statusCode).toBe(200);
			expect(updated.json().keywords).toHaveLength(1);
		}
		expect([...stored.values()][0].length).toBe(size);
	});

	test('accepts 200 different keywords in a filter and rejects the 201st without storing it', async () => {
		const { app, stored } = await setup();
		const words = (n: number) => Array.from({ length: n }, (_, i) => ({ keyword: `word${i}`, whole_word: false }));

		const tooMany = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'too many', keywords_attributes: words(201) } });
		expect(tooMany.statusCode).toBe(422);
		expect(tooMany.json().error).toMatch(/^Validation failed/);
		expect(stored.size).toBe(0);

		const created = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'full', keywords_attributes: words(200) } });
		expect(created.statusCode).toBe(200);
		expect(created.json().keywords).toHaveLength(200);
		const id = created.json().id;
		const before = [...stored.entries()];

		const added = await app.inject({ method: 'POST', url: `/v2/filters/${id}/keywords`, payload: { keyword: 'one more' } });
		expect(added.statusCode).toBe(422);
		const updated = await app.inject({ method: 'PUT', url: `/v2/filters/${id}`, payload: { keywords_attributes: [{ keyword: 'one more' }] } });
		expect(updated.statusCode).toBe(422);
		expect([...stored.entries()]).toEqual(before);

		const again = await app.inject({ method: 'PUT', url: `/v2/filters/${id}`, payload: { keywords_attributes: [{ keyword: 'word5' }] } });
		expect(again.statusCode).toBe(200);
		expect(again.json().keywords).toHaveLength(200);
	});

	test('creates, updates and deletes keywords with distinct values as before', async () => {
		const { app } = await setup();
		const created = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'normal', keywords_attributes: [{ keyword: 'a' }, { keyword: 'b', whole_word: true }] } });
		expect(created.statusCode).toBe(200);
		expect(created.json().keywords.map((k: { keyword: string }) => k.keyword)).toEqual(['a', 'b']);
		const id = created.json().id;
		const [a] = created.json().keywords;

		const added = await app.inject({ method: 'POST', url: `/v2/filters/${id}/keywords`, payload: { keyword: 'c' } });
		expect(added.statusCode).toBe(200);
		const removed = await app.inject({ method: 'DELETE', url: `/v2/filters/keywords/${a.id}` });
		expect(removed.statusCode).toBe(200);
		const read = await app.inject({ method: 'GET', url: `/v2/filters/${id}` });
		expect(read.json().keywords.map((k: { keyword: string }) => k.keyword)).toEqual(['b', 'c']);
	});

	test('stores a keyword once when a v1 filter is changed to a phrase it already has', async () => {
		const { app, me, filters, stored } = await setup();
		await filters.create(me as never, { headers: {} } as FastifyRequest, { title: 'two', keywords: [{ keyword: 'first', wholeWord: false }, { keyword: 'second', wholeWord: false }] });
		const [first] = (await app.inject({ method: 'GET', url: '/v1/filters' })).json();

		const updated = await app.inject({ method: 'PUT', url: `/v1/filters/${first.id}`, payload: { phrase: 'second' } });
		expect(updated.statusCode).toBe(200);
		expect(JSON.parse([...stored.values()][0]).keywords).toHaveLength(1);
	});

	test('ignores spaces around a context and drops empty ones', async () => {
		const { app } = await setup();
		const created = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'spaces', context: [' home', 'thread ', '', '  '] } });
		expect(created.statusCode).toBe(200);
		expect(created.json().context).toEqual(['home', 'thread']);

		const id = created.json().id;
		const updated = await app.inject({ method: 'PUT', url: `/v2/filters/${id}`, payload: { context: [' public ', ''] } });
		expect(updated.statusCode).toBe(200);
		expect(updated.json().context).toEqual(['public']);

		const unknown = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'unknown', context: ['home', ' timeline '] } });
		expect(unknown.statusCode).toBe(422);
	});

	test('does not count expired filters toward the limit', async () => {
		const { app, me, filters, stored } = await setup();
		for (let i = 0; i < 200; i++) {
			await filters.create(me as never, {} as FastifyRequest, { title: `filter ${i}`, expiresIn: i < 5 ? 1 : undefined });
		}
		expect(stored.size).toBe(200);
		await new Promise(resolve => setTimeout(resolve, 1100));
		const response = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'fits' } });
		expect(response.statusCode).toBe(200);
		for (let i = 0; i < 4; i++) {
			expect((await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: `fits ${i}` } })).statusCode).toBe(200);
		}

		const full = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'does not fit' } });
		expect(full.statusCode).toBe(422);
	});

	test('deletes a keyword of a word mute at the filter limit', async () => {
		const { app, me, filters, profile, wordMuteUpdates } = await setup();
		for (let i = 0; i < 200; i++) {
			await filters.create(me as never, {} as FastifyRequest, { title: `filter ${i}` });
		}
		profile.mutedWords.push('muted');
		const list = (await app.inject({ method: 'GET', url: '/v2/filters' })).json();
		const synthetic = list.find((f: { id: string }) => f.id.startsWith('misskey-'));
		expect(synthetic).toBeDefined();

		const removed = await app.inject({ method: 'DELETE', url: `/v2/filters/keywords/${synthetic.keywords[0].id}` });
		expect(removed.statusCode).toBe(200);
		expect(wordMuteUpdates.at(-1)).toMatchObject({ mutedWords: [] });

		const created = await app.inject({ method: 'POST', url: '/v2/filters', payload: { title: 'full' } });
		expect(created.statusCode).toBe(422);
	});

	test('answers a suspended account with 403', async () => {
		const { app, me } = await setup();
		me.isSuspended = true;
		const response = await app.inject({ method: 'GET', url: '/v2/filters' });
		expect(response.statusCode).toBe(403);
		expect(response.json()).toMatchObject({ error: 'Your account has been suspended.', error_description: 'YOUR_ACCOUNT_SUSPENDED' });
	});
});
