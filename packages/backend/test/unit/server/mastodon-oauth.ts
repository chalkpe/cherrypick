/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify from 'fastify';
import { describe, expect, onTestFinished, test } from 'vitest';
import { MastodonOAuthService, MastodonOAuthError, parseMastodonScopes, toCherryPickPermissions } from '@/server/api/mastodon/MastodonOAuthService.js';
import { ApiAppsMastodon } from '@/server/api/mastodon/endpoints/apps.js';

function permissions(scopes: string): string[] {
	return toCherryPickPermissions(parseMastodonScopes(scopes)).sort();
}

const allReadPermissions = [
	'read:account',
	'read:blocks',
	'read:drive',
	'read:favorites',
	'read:following',
	'read:mutes',
	'read:notifications',
];

const allWritePermissions = [
	'write:account',
	'write:blocks',
	'write:drive',
	'write:favorites',
	'write:following',
	'write:mutes',
	'write:notes',
	'write:notifications',
	'write:reactions',
	'write:report-abuse',
	'write:votes',
];

const allFollowPermissions = [
	'read:blocks',
	'read:following',
	'read:mutes',
	'write:blocks',
	'write:following',
	'write:mutes',
];

describe('Mastodon scope mapping', () => {
	test.each([
		['read:account', ['read:account']],
		['read:accounts', ['read:account']],
		['read:notifications', ['read:notifications']],
		['read:statuses', ['read:account']],
		['read:follows', ['read:following']],
		['read:blocks', ['read:blocks']],
		['read:mutes', ['read:mutes']],
		['read:favourites', ['read:favorites']],
		['read:bookmarks', ['read:favorites']],
		['read:drive', ['read:drive']],
		['read:filters', ['read:account']],
		['read:lists', ['read:account']],
		['read:search', []],
		['write:statuses', ['write:notes', 'write:reactions', 'write:votes']],
		['write:favourites', ['write:favorites', 'write:reactions']],
		['write:bookmarks', ['write:favorites']],
		['write:follows', ['write:following']],
		['write:blocks', ['write:blocks']],
		['write:mutes', ['write:mutes']],
		['write:media', ['write:drive']],
		['write:accounts', ['write:account']],
		['write:account', ['write:account']],
		['write:notifications', ['write:notifications']],
		['write:reports', ['write:report-abuse']],
		['write:filters', ['write:account']],
		['write:lists', ['write:account']],
		['write:conversations', []],
		['push', ['read:notifications']],
		['profile', ['read:account']],
	])('%s grants only its own permissions', (scope, expected) => {
		expect(permissions(scope)).toEqual((expected as string[]).slice().sort());
	});

	test('grants every read permission only for the explicit read scope', () => {
		expect(permissions('read')).toEqual(allReadPermissions.slice().sort());
	});

	test('grants every write permission only for the explicit write scope', () => {
		expect(permissions('write')).toEqual(allWritePermissions.slice().sort());
	});

	test('maps follow to the follow permission set', () => {
		expect(permissions('follow')).toEqual(allFollowPermissions.slice().sort());
	});

	test('merges repeated and multiple scopes', () => {
		expect(permissions('read:notifications write:statuses read:notifications')).toEqual([
			'read:notifications',
			'write:notes',
			'write:reactions',
			'write:votes',
		]);
	});

	test.each([
		['write:statuses', ['write:account', 'write:drive', 'write:following', 'write:blocks', 'write:mutes', 'write:notifications', 'write:report-abuse']],
		['write:favourites', ['write:account', 'write:drive', 'write:following', 'write:blocks', 'write:mutes', 'write:notifications', 'write:report-abuse']],
		['write:follows', ['write:account', 'write:drive', 'write:blocks', 'write:mutes', 'write:notifications', 'write:report-abuse']],
		['write:blocks', ['write:account', 'write:drive', 'write:following', 'write:mutes', 'write:notifications', 'write:report-abuse']],
		['write:mutes', ['write:account', 'write:drive', 'write:following', 'write:blocks', 'write:notifications', 'write:report-abuse']],
		['write:media', ['write:account', 'write:following', 'write:blocks', 'write:mutes', 'write:notifications', 'write:report-abuse']],
	])('%s does not grant unrelated write permissions', (scope, unrelated) => {
		const granted = permissions(scope);
		for (const permission of unrelated as string[]) {
			expect(granted).not.toContain(permission);
		}
	});

	test.each([
		'read:unknown',
		'write:unknown',
		'read:',
		'admin:read',
		'admin:write',
		'crypto',
		'read:statuses:extra',
	])('rejects the unknown scope %s with invalid_scope', scope => {
		expect(() => toCherryPickPermissions([scope])).toThrow(MastodonOAuthError);
		expect(() => toCherryPickPermissions([scope])).toThrow(expect.objectContaining({ error: 'invalid_scope' }));
	});

	test('rejects an empty scope list instead of issuing a token with no permissions', () => {
		expect(() => toCherryPickPermissions([])).toThrow(expect.objectContaining({ error: 'invalid_scope' }));
	});
});

describe('Mastodon app registration', () => {
	function server(inserts: { permission: string[] }[]) {
		const app = Fastify();
		onTestFinished(() => app.close());
		const appsRepository = {
			insertOne: async (data: { permission: string[] }) => {
				inserts.push(data);
				return data;
			},
		};
		new ApiAppsMastodon(appsRepository as never, {} as never, { gen: () => 'app-id' } as never, {} as never).register(app);
		return app;
	}

	test('rejects unknown scopes without creating an app', async () => {
		const inserts: { permission: string[] }[] = [];
		const response = await server(inserts).inject({
			method: 'POST',
			url: '/v1/apps',
			payload: {
				client_name: 'Unknown scope app',
				redirect_uris: 'https://client.example/callback',
				scopes: 'write:statuses read:unknown',
			},
		});

		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({ error: 'invalid_scope' });
		expect(inserts).toHaveLength(0);
	});

	test('registers granular scopes with their least-privilege permissions', async () => {
		const inserts: { permission: string[] }[] = [];
		const response = await server(inserts).inject({
			method: 'POST',
			url: '/v1/apps',
			payload: {
				client_name: 'Write statuses app',
				redirect_uris: 'https://client.example/callback',
				scopes: 'write:statuses read:notifications',
			},
		});

		expect(response.statusCode).toBe(200);
		expect(inserts).toHaveLength(1);
		expect(inserts[0].permission.slice().sort()).toEqual(['read:notifications', 'write:notes', 'write:reactions', 'write:votes']);
		expect(inserts[0].permission).not.toContain('write:account');
	});
});

describe('Mastodon authorization', () => {
	test('rejects an unknown scope with invalid_scope before creating a session', async () => {
		let sessions = 0;
		const service = new MastodonOAuthService(
			{} as never,
			{} as never,
			{ findOneBy: async () => ({ id: 'app', permission: ['read:account'], callbackUrl: 'https://client.example/callback' }) } as never,
			{ insertOne: async () => { sessions++; return {}; } } as never,
			{} as never,
			{} as never,
			{ getLogger: () => ({ info: () => {}, error: () => {} }) } as never,
		);
		const reply = {
			status: 0,
			body: undefined as unknown,
			code(status: number) { this.status = status; return this; },
			send(body: unknown) { this.body = body; },
			redirect() {},
		};

		await service.authorize({
			client_id: 'app',
			redirect_uri: 'https://client.example/callback',
			response_type: 'code',
			scope: 'read:unknown',
		}, reply as never);

		expect(reply.status).toBe(400);
		expect(reply.body).toMatchObject({ error: 'invalid_scope' });
		expect(sessions).toBe(0);
	});
});

describe('Mastodon scope mapping edge cases', () => {
	test.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])('rejects the prototype key %s instead of reading it from Object.prototype', scope => {
		expect(() => toCherryPickPermissions([scope])).toThrow(expect.objectContaining({ error: 'invalid_scope' }));
	});

	test.each(['READ', 'Write:statuses', 'read:Notifications'])('does not normalize the case of %s into a known scope', scope => {
		expect(() => toCherryPickPermissions([scope])).toThrow(expect.objectContaining({ error: 'invalid_scope' }));
	});

	test('rejects the whole request when a known scope is mixed with an unknown one', () => {
		expect(() => toCherryPickPermissions(['write:statuses', 'admin:write'])).toThrow(expect.objectContaining({ error: 'invalid_scope' }));
	});

	test('keeps the explicit top-level read scope broad without granting any write permission', () => {
		const granted = permissions('read write:statuses');
		expect(granted).toEqual([...allReadPermissions, 'write:notes', 'write:reactions', 'write:votes'].sort());
	});

	test('profile only reads the account', () => {
		expect(permissions('profile')).toEqual(['read:account']);
	});

	test('parses "+" separated and array scopes the same way as space separated ones', () => {
		expect(toCherryPickPermissions(parseMastodonScopes('write:statuses+read:notifications')).sort())
			.toEqual(permissions('write:statuses read:notifications'));
		expect(toCherryPickPermissions(parseMastodonScopes(['write:statuses', 'read:notifications'])).sort())
			.toEqual(permissions('write:statuses read:notifications'));
	});

	test('rejects a scope string with only separators', () => {
		expect(() => toCherryPickPermissions(parseMastodonScopes(' + '))).toThrow(expect.objectContaining({ error: 'invalid_scope' }));
	});
});

describe('Mastodon app registration edge cases', () => {
	function server(inserts: { permission: string[] }[]) {
		const app = Fastify();
		onTestFinished(() => app.close());
		const appsRepository = {
			insertOne: async (data: { permission: string[] }) => {
				inserts.push(data);
				return data;
			},
		};
		new ApiAppsMastodon(appsRepository as never, {} as never, { gen: () => 'app-id' } as never, {} as never).register(app);
		return app;
	}

	test('rejects a prototype key smuggled in an array of scopes without creating an app', async () => {
		const inserts: { permission: string[] }[] = [];
		const response = await server(inserts).inject({
			method: 'POST',
			url: '/v1/apps',
			payload: {
				client_name: 'Prototype scope app',
				redirect_uris: 'https://client.example/callback',
				scopes: ['write:statuses', '__proto__'],
			},
		});

		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({ error: 'invalid_scope' });
		expect(inserts).toHaveLength(0);
	});

	test('falls back to the read scope when no scope is given', async () => {
		const inserts: { permission: string[] }[] = [];
		const response = await server(inserts).inject({
			method: 'POST',
			url: '/v1/apps',
			payload: {
				client_name: 'Default scope app',
				redirect_uris: 'https://client.example/callback',
			},
		});

		expect(response.statusCode).toBe(200);
		expect(inserts[0].permission.slice().sort()).toEqual(allReadPermissions);
	});
});

describe('Mastodon authorization code grant', () => {
	const clientSecret = 'client-secret';

	function service(appPermission: string[]) {
		const redis = new Map<string, string>();
		const issued: { permission: string[] }[] = [];
		let sessions = 0;
		const oauth = new MastodonOAuthService(
			{ authUrl: 'https://local.example/auth' } as never,
			{
				set: async (key: string, value: string) => { redis.set(key, value); },
				get: async (key: string) => redis.get(key) ?? null,
				getdel: async (key: string) => {
					const value = redis.get(key) ?? null;
					redis.delete(key);
					return value;
				},
			} as never,
			{
				findOneBy: async () => ({
					id: 'app',
					permission: appPermission,
					callbackUrl: 'https://client.example/callback',
					secret: clientSecret,
				}),
			} as never,
			{
				insertOne: async (data: { token: string }) => { sessions++; return data; },
				findOneBy: async ({ token }: { token: string }) => ({ id: 'session', token, userId: 'user' }),
				delete: async () => {},
			} as never,
			{ insertOne: async (data: { permission: string[]; token: string }) => { issued.push(data); return data; } } as never,
			{ gen: () => '0000000000', parse: () => ({ date: new Date(0) }) } as never,
			{ getLogger: () => ({ info: () => {}, error: () => {} }) } as never,
		);
		return { oauth, issued, sessions: () => sessions };
	}

	function reply() {
		return {
			status: 200,
			body: undefined as unknown,
			location: undefined as string | undefined,
			code(status: number) { this.status = status; return this; },
			header() { return this; },
			send(body: unknown) { this.body = body; },
			redirect(url: string) { this.location = url; },
		};
	}

	const allPermissions = [...allReadPermissions, ...allWritePermissions];

	test('issues a token with only the granular permissions of the authorized scope, even when the app was registered with everything', async () => {
		const { oauth, issued } = service(allPermissions);
		const authorizeReply = reply();
		await oauth.authorize({
			client_id: 'app',
			redirect_uri: 'https://client.example/callback',
			response_type: 'code',
			scope: 'write:statuses',
		}, authorizeReply as never);
		expect(authorizeReply.location).toBeDefined();
		const code = new URL(authorizeReply.location!).pathname.split('/').at(-1)!;

		const tokenReply = reply();
		await oauth.token({
			grant_type: 'authorization_code',
			client_id: 'app',
			client_secret: clientSecret,
			code,
			redirect_uri: 'https://client.example/callback',
		}, tokenReply as never);

		expect(tokenReply.status).toBe(200);
		expect(tokenReply.body).toMatchObject({ scope: 'write:statuses' });
		expect(issued).toHaveLength(1);
		expect(issued[0].permission.slice().sort()).toEqual(['write:notes', 'write:reactions', 'write:votes']);
	});

	test('rejects an unknown scope even when the app was registered with every permission', async () => {
		const { oauth, sessions } = service(allPermissions);
		const authorizeReply = reply();
		await oauth.authorize({
			client_id: 'app',
			redirect_uri: 'https://client.example/callback',
			response_type: 'code',
			scope: 'read:unknown',
		}, authorizeReply as never);

		expect(authorizeReply.status).toBe(400);
		expect(authorizeReply.body).toMatchObject({ error: 'invalid_scope' });
		expect(authorizeReply.location).toBeUndefined();
		expect(sessions()).toBe(0);
	});

	test('rejects a top-level scope that exceeds the granular permissions the app registered', async () => {
		const { oauth, sessions } = service(['write:notes', 'write:reactions', 'write:votes']);
		const authorizeReply = reply();
		await oauth.authorize({
			client_id: 'app',
			redirect_uri: 'https://client.example/callback',
			response_type: 'code',
			scope: 'write',
		}, authorizeReply as never);

		expect(authorizeReply.status).toBe(400);
		expect(authorizeReply.body).toMatchObject({ error: 'invalid_scope' });
		expect(sessions()).toBe(0);
	});
});
