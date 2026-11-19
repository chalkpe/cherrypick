/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify from 'fastify';
import { describe, expect, onTestFinished, test } from 'vitest';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { getErrorData, getErrorStatus } from '@/server/api/mastodon/MastodonLogger.js';
import { ApiStatusMastodon } from '@/server/api/mastodon/endpoints/status.js';
import { ApiTimelineMastodon } from '@/server/api/mastodon/endpoints/timeline.js';

type Body = Record<string, unknown>;

/**
 * A Fastify server standing in for the Misskey API that the Mastodon routes call back into.
 */
async function createUpstream(handlers: Record<string, (body: Body) => unknown>) {
	const upstream = Fastify();
	const calls: { endpoint: string, body: Body }[] = [];
	for (const [endpoint, handler] of Object.entries(handlers)) {
		upstream.post(`/api/${endpoint}`, async (request, reply) => {
			const body = (request.body ?? {}) as Body;
			calls.push({ endpoint, body });
			return reply.send(handler(body));
		});
	}
	onTestFinished(() => upstream.close());
	const address = new URL(await upstream.listen({ host: '127.0.0.1', port: 0 }));
	return { calls, config: { url: address.origin, port: Number(address.port) } };
}

function createApp() {
	const app = Fastify();
	app.setErrorHandler((error, _request, reply) => reply.code(getErrorStatus(error)).send(getErrorData(error)));
	onTestFinished(() => app.close());
	return app;
}

const me = { id: 'user', isSuspended: false };
const signedIn = async (token: string | null) => token ? [me, { permission: ['read:account', 'write:notes'] }, null] : [null, null, null];

const author = { id: 'author', username: 'author', host: null, name: null, emojis: [], avatarUrl: 'https://files.example/avatar.png', bannerUrl: 'https://files.example/banner.png' };
// A user as the Misskey API lists it for another user's note, which has neither an avatar nor a header image
const bareAuthor = { id: 'author', username: 'author', host: null, name: null, emojis: [] };

function note(id: string, extra: Body = {}) {
	return {
		id,
		createdAt: '2026-01-01T00:00:00.000Z',
		text: `note ${id}`,
		cw: null,
		user: author,
		userId: 'author',
		replyId: null,
		renoteId: null,
		repliesCount: 0,
		renoteCount: 0,
		reactions: {},
		reactionEmojis: {},
		emojis: [],
		files: [],
		fileIds: [],
		visibility: 'public',
		...extra,
	};
}

describe('Mastodon status context of a thread', () => {
	async function context(token: string | null) {
		// Every note has three replies and every reply has three more, as in a busy thread
		const upstream = await createUpstream({
			'notes/children': body => body.noteId === 'root'
				? Array.from({ length: 100 }, (_, i) => note(`c${String(i).padStart(3, '0')}`, { replyId: 'root', repliesCount: 3 }))
				: Array.from({ length: 3 }, (_, i) => note(`${String(body.noteId)}-${i}`, { replyId: body.noteId, repliesCount: 0 })),
			'notes/conversation': () => Array.from({ length: 100 }, (_, i) => note(`a${String(i).padStart(3, '0')}`)),
		});
		const client = new MastodonClientService(upstream.config as never, { authenticate: async () => signedIn(token) } as never);
		const converted: number[] = [];
		const converters = { convertStatuses: async (statuses: unknown[]) => { converted.push(statuses.length); return statuses; } };
		const app = createApp();
		new ApiStatusMastodon(converters as never, client, {} as never, {} as never).register(app);
		const response = await app.inject({ method: 'GET', url: '/v1/statuses/root/context', headers: token ? { authorization: `Bearer ${token}` } : {} });
		return { response, calls: upstream.calls, converted };
	}

	test('reads a thread without a token with two internal requests and at most 40 ancestors and 60 descendants', async () => {
		const { response, calls, converted } = await context(null);

		expect(response.statusCode).toBe(200);
		expect(calls.map(c => c.endpoint).sort()).toEqual(['notes/children', 'notes/conversation']);
		const { ancestors, descendants } = response.json();
		expect(ancestors.length).toBeGreaterThan(0);
		expect(ancestors.length).toBeLessThanOrEqual(40);
		expect(descendants.length).toBeGreaterThan(0);
		expect(descendants.length).toBeLessThanOrEqual(60);
		expect(converted.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100);
	});

	test('keeps following the replies of a signed in viewer as before', async () => {
		const { response, calls } = await context('token');

		expect(response.statusCode).toBe(200);
		// notes/children and notes/conversation, then one notes/children for each of the first 20 replies
		expect(calls).toHaveLength(22);
		const { ancestors, descendants } = response.json();
		expect(ancestors).toHaveLength(100);
		expect(descendants).toHaveLength(160);
	});
});

describe('Mastodon status visibility', () => {
	async function post() {
		const upstream = await createUpstream({
			'notes/create': () => ({ createdNote: note('created') }),
			'notes/drafts/create': () => ({ createdDraft: { id: 'draft', text: 'hello', fileIds: [], files: [], visibility: 'followers', scheduledAt: Date.now() + 3600 * 1000 } }),
		});
		const client = new MastodonClientService(upstream.config as never, { authenticate: signedIn } as never);
		const converters = { convertStatus: async (status: { id: string }) => ({ id: status.id }) };
		const preferences = { getDefaultVisibility: async () => 'unlisted' };
		const app = createApp();
		new ApiStatusMastodon(converters as never, client, {} as never, preferences as never).register(app);
		const send = (payload: Body) => app.inject({ method: 'POST', url: '/v1/statuses', headers: { authorization: 'Bearer token' }, payload });
		const created = () => upstream.calls.filter(c => c.endpoint === 'notes/create' || c.endpoint === 'notes/drafts/create');
		return { send, created, calls: upstream.calls };
	}

	test.each([
		['public', 'public', undefined],
		['unlisted', 'home', undefined],
		['private', 'followers', undefined],
		['direct', 'specified', undefined],
		['local', 'public', true],
	])('posts with the visibility %s as %s', async (visibility, expected, localOnly) => {
		const { send, created } = await post();
		const response = await send({ status: 'hello', visibility });
		expect(response.statusCode).toBe(200);
		expect(created()).toHaveLength(1);
		expect(created()[0].body).toMatchObject({ visibility: expected });
		expect(created()[0].body.localOnly).toBe(localOnly);
	});

	test('posts with the default visibility of the user when none is given', async () => {
		const { send, created } = await post();
		const response = await send({ status: 'hello' });
		expect(response.statusCode).toBe(200);
		expect(created()[0].body).toMatchObject({ visibility: 'home' });
	});

	test.each([
		['an unknown word', 'secret'],
		['a differently cased word', 'Public'],
		['a number', 5],
		['a list', ['public']],
		['an object', { value: 'public' }],
		['true', true],
	])('rejects %s as a visibility without posting', async (_name, visibility) => {
		const { send, created } = await post();
		const response = await send({ status: 'hello', visibility });
		expect(response.statusCode).toBe(422);
		expect(response.json().error).toMatch(/^Validation failed/);
		expect(created()).toHaveLength(0);
	});

	test('rejects an unknown visibility of a scheduled status without creating a draft', async () => {
		const { send, created } = await post();
		const scheduledAt = new Date(Date.now() + 3600 * 1000).toISOString();

		const rejected = await send({ status: 'hello', visibility: 'secret', scheduled_at: scheduledAt });
		expect(rejected.statusCode).toBe(422);
		expect(created()).toHaveLength(0);

		const accepted = await send({ status: 'hello', visibility: 'private', scheduled_at: scheduledAt });
		expect(accepted.statusCode).toBe(200);
		expect(created()).toHaveLength(1);
		expect(created()[0]).toMatchObject({ endpoint: 'notes/drafts/create', body: { visibility: 'followers' } });
	});
});

describe('Mastodon list members', () => {
	async function lists(limit = 50) {
		const upstream = await createUpstream({
			'users/lists/push': () => ({}),
			'users/lists/pull': () => ({}),
		});
		const client = new MastodonClientService(upstream.config as never, { authenticate: signedIn } as never);
		const roleService = { getUserPolicies: async () => ({ userEachUserListsLimit: limit }) };
		const app = createApp();
		new ApiTimelineMastodon(client, {} as never, roleService as never).register(app);
		const send = (method: 'POST' | 'DELETE', account_ids: unknown) => app.inject({ method, url: '/v1/lists/list1/accounts', headers: { authorization: 'Bearer token' }, payload: { account_ids } });
		return { send, calls: upstream.calls };
	}

	test.each([['POST', 'users/lists/push'], ['DELETE', 'users/lists/pull']] as const)('%s handles each account once however often it is listed', async (method, endpoint) => {
		const { send, calls } = await lists();
		const response = await send(method, ['a', 'b', 'a', 'c', 'b', 'a', 'a']);
		expect(response.statusCode).toBe(200);
		expect(calls.map(c => c.endpoint)).toEqual([endpoint, endpoint, endpoint]);
		expect(calls.map(c => c.body.userId)).toEqual(['a', 'b', 'c']);
	});

	test.each([['POST', 'users/lists/push'], ['DELETE', 'users/lists/pull']] as const)('%s takes as many accounts as a list may hold', async (method, endpoint) => {
		const { send, calls } = await lists(50);
		const ids = Array.from({ length: 50 }, (_, i) => `user${i}`);
		const response = await send(method, ids);
		expect(response.statusCode).toBe(200);
		expect(calls.filter(c => c.endpoint === endpoint)).toHaveLength(50);
	});

	test.each(['POST', 'DELETE'] as const)('%s rejects more accounts than a list may hold without any internal request', async method => {
		const { send, calls } = await lists(50);
		const ids = Array.from({ length: 51 }, (_, i) => `user${i}`);
		const response = await send(method, ids);
		expect(response.statusCode).toBe(422);
		expect(response.json().error).toMatch(/^Validation failed/);
		expect(calls).toHaveLength(0);
	});

	test('counts the accounts after removing duplicates against the policy of the user', async () => {
		const { send, calls } = await lists(2);
		const accepted = await send('POST', ['a', 'b', 'a', 'b', 'a']);
		expect(accepted.statusCode).toBe(200);
		expect(calls).toHaveLength(2);

		const rejected = await send('POST', ['a', 'b', 'c']);
		expect(rejected.statusCode).toBe(422);
		expect(calls).toHaveLength(2);
	});
});

describe('Mastodon responses that are not converted by the server', () => {
	async function responses() {
		const reacted = note('n1', { user: bareAuthor, reactions: { '👍': 1 }, myReaction: '👍' });
		const upstream = await createUpstream({
			'notes/show': () => reacted,
			'notes/reactions/create': () => ({}),
			'notes/reactions/delete': () => ({}),
			'notes/delete': () => ({}),
		});
		const client = new MastodonClientService(upstream.config as never, { authenticate: signedIn } as never);
		const app = createApp();
		new ApiStatusMastodon({} as never, client, {} as never, { getDefaultVisibility: async () => 'public' } as never).register(app);
		const headers = { authorization: 'Bearer token' };
		return {
			react: () => app.inject({ method: 'POST', url: '/v1/statuses', headers, payload: { status: '👍', in_reply_to_id: 'n1' } }),
			unreact: () => app.inject({ method: 'POST', url: '/v1/statuses', headers, payload: { status: '/unreact', in_reply_to_id: 'n1' } }),
			remove: () => app.inject({ method: 'DELETE', url: '/v1/statuses/n1', headers }),
		};
	}

	test.each(['react', 'unreact', 'remove'] as const)('uses images of this server for an account without an avatar or a header in the response to %s', async name => {
		const response = await (await responses())[name]();
		expect(response.statusCode).toBe(200);
		expect(response.body).not.toContain('joinsharkey');

		const { account } = response.json();
		expect(account.avatar).toMatch(/^(data:image\/png;base64,|https:\/\/.+\/identicon\/)/);
		expect(account.header).toMatch(/^data:image\/png;base64,/);
		expect(account.header_static).toBe(account.header);
		expect(account.avatar_static).toBe(account.avatar);
	});
});
