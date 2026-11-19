/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import Fastify from 'fastify';
import { NoImplementedError } from 'megalodon';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { AuthenticationError } from '@/server/api/AuthenticateService.js';
import { ApiError } from '@/server/api/error.js';
import { MastodonApiServerService } from '@/server/api/mastodon/MastodonApiServerService.js';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { MastodonServerUtilityService } from '@/server/api/mastodon/MastodonServerUtilityService.js';
import type { FastifyInstance } from 'fastify';

const unused = { register: () => {} };

interface ServerOptions {
	routes?: (fastify: FastifyInstance) => void;
	authenticate?: (token: string | null) => Promise<unknown[]>;
	upstream?: { url: string, port: number };
}

async function createServer(options: ServerOptions = {}) {
	const config = { maxFileSize: 1024 * 1024, ...options.upstream };
	const me = { id: 'user', isSuspended: false };
	const authenticate = options.authenticate ?? (async () => [null, null, null]);
	const clientService = new MastodonClientService(config as never, { authenticate } as never);
	const logged: unknown[] = [];
	const service = new MastodonApiServerService(
		{} as never,
		{ exception: (_request: unknown, error: unknown) => logged.push(error), error: () => {} } as never,
		clientService,
		unused as never,
		{ register: options.routes ?? (() => {}) } as never,
		unused as never,
		unused as never,
		unused as never,
		unused as never,
		unused as never,
		unused as never,
		unused as never,
		unused as never,
		new MastodonServerUtilityService(config as never),
		{} as never,
	);
	const app = Fastify();
	app.register((fastify, opts, done) => service.createServer(fastify, opts, done));
	onTestFinished(() => app.close());
	await app.ready();
	return { app, me, logged };
}

describe('Mastodon error responses', () => {
	const secrets = ['value too long', 'character varying', 'ENOENT', '/var/lib/secret', 'ECONNREFUSED', '10.0.0.5', 'secretField', 'plain secret'];

	function routes(fastify: FastifyInstance) {
		fastify.get<{ Params: { kind: string } }>('/v1/boom/:kind', async request => {
			switch (request.params.kind) {
				case 'database':
					throw Object.assign(new Error('value too long for type character varying(128)'), { name: 'QueryFailedError', code: '22001' });
				case 'system':
					throw Object.assign(new Error("ENOENT: no such file or directory, open '/var/lib/secret/file'"), { code: 'ENOENT' });
				case 'type':
					throw new TypeError("Cannot read properties of undefined (reading 'secretField')");
				case 'plain-error':
					throw new Error('plain secret');
				case 'string':
					throw 'plain secret'; // eslint-disable-line no-throw-literal
				case 'axios-no-response': {
					const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
					throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { isAxiosError: true, cause });
				}
				case 'axios-no-cause':
					throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { isAxiosError: true });
				case 'api-error':
					throw new ApiError({ message: 'Your app does not have the necessary permissions to use this endpoint.', code: 'PERMISSION_DENIED', id: 'id', kind: 'permission', httpStatusCode: 403 });
				case 'authentication':
					throw new AuthenticationError('Credential required.');
				case 'not-implemented':
					throw new NoImplementedError('not supported');
				case 'misskey-no-such-note':
					throw Object.assign(new Error('Request failed with status code 400'), {
						isAxiosError: true,
						response: { status: 400, data: { error: { message: 'No such note.', code: 'NO_SUCH_NOTE', id: 'id', kind: 'client' } } },
					});
				case 'misskey-permission':
					throw Object.assign(new Error('Request failed with status code 403'), {
						isAxiosError: true,
						response: { status: 403, data: { error: { message: 'Your app does not have the necessary permissions to use this endpoint.', code: 'PERMISSION_DENIED', id: 'id', kind: 'permission' } } },
					});
				case 'misskey-internal':
					throw Object.assign(new Error('Request failed with status code 500'), {
						isAxiosError: true,
						response: { status: 500, data: { error: { message: 'Internal error occurred. Please contact us if the error persists.', code: 'INTERNAL_ERROR', id: 'id', kind: 'server' } } },
					});
				default:
					return {};
			}
		});

		fastify.post('/v1/boom-body', async () => ({}));
	}

	test.each(['database', 'system', 'type', 'plain-error', 'string', 'axios-no-response', 'axios-no-cause'])('does not put the message of an unexpected %s exception in the response', async kind => {
		const { app } = await createServer({ routes });
		const response = await app.inject({ method: 'GET', url: `/v1/boom/${kind}` });

		expect(response.statusCode).toBe(500);
		for (const secret of secrets) expect(response.body).not.toContain(secret);
		expect(response.json().error).toMatch(/^(INTERNAL_ERROR|UNKNOWN_ERROR)$/);
	});

	test('keeps the details of an unexpected exception in the log', async () => {
		const { app, logged } = await createServer({ routes });
		await app.inject({ method: 'GET', url: '/v1/boom/database' });
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({ message: 'value too long for type character varying(128)', code: '22001' });
	});

	test.each([
		['api-error', 403, { error: 'Your app does not have the necessary permissions to use this endpoint.', error_description: 'PERMISSION_DENIED' }],
		['authentication', 401, { error: 'The access token is invalid' }],
		['not-implemented', 501, { error: 'NOT_IMPLEMENTED', error_description: 'This endpoint is not supported by this server.' }],
		['misskey-no-such-note', 404, { error: 'No such note.', error_description: 'NO_SUCH_NOTE' }],
		['misskey-permission', 403, { error: 'Your app does not have the necessary permissions to use this endpoint.', error_description: 'PERMISSION_DENIED' }],
		['misskey-internal', 500, { error: 'Internal error occurred. Please contact us if the error persists.', error_description: 'INTERNAL_ERROR' }],
	])('converts the %s error as before', async (kind, status, body) => {
		const { app } = await createServer({ routes });
		const response = await app.inject({ method: 'GET', url: `/v1/boom/${kind}` });
		expect(response.statusCode).toBe(status);
		expect(response.json()).toEqual(body);
	});

	test('keeps the response to a request the server cannot parse', async () => {
		const { app } = await createServer({ routes });
		const response = await app.inject({ method: 'POST', url: '/v1/boom-body', headers: { 'content-type': 'application/json' }, payload: '{' });
		expect(response.statusCode).toBe(400);
		expect(response.json().error_description).toMatch(/^FST_ERR_/);
	});
});

describe('Mastodon media upload', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function upload() {
		const upstream = Fastify();
		let created = 0;
		upstream.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
		upstream.post('/api/drive/files/create', async (_request, reply) => {
			created++;
			return reply.send({ id: 'file1', name: 'a.png', type: 'image/png', url: 'https://files.example/a.png', thumbnailUrl: 'https://files.example/t.png', comment: null, blurhash: null, properties: { width: 1, height: 1 } });
		});
		onTestFinished(() => upstream.close());
		const address = new URL(await upstream.listen({ host: '127.0.0.1', port: 0 }));

		const me = { id: 'user', isSuspended: false };
		const authenticate = async (token: string | null) => {
			if (token === 'drive') return [me, { permission: ['read:drive', 'write:drive'] }, null];
			if (token === 'readonly') return [me, { permission: ['read:drive'] }, null];
			if (token === 'suspended') return [{ ...me, isSuspended: true }, { permission: ['read:drive', 'write:drive'] }, null];
			return [null, null, null];
		};
		const { app } = await createServer({ authenticate, upstream: { url: address.origin, port: Number(address.port) } });
		return { app, created: () => created };
	}

	const boundary = '----media-boundary';
	const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--${boundary}--\r\n`;

	test.each(['/v1/media', '/v2/media'])('rejects an upload to %s without a token before reading the file', async url => {
		const { app, created } = await upload();
		const readFile = vi.spyOn(fs.promises, 'readFile');

		const response = await app.inject({ method: 'POST', url, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });

		expect(response.statusCode).toBe(401);
		expect(readFile).not.toHaveBeenCalled();
		expect(created()).toBe(0);
	});

	test.each(['/v1/media', '/v2/media'])('rejects an upload to %s with a token that cannot write the drive before reading the file', async url => {
		const { app, created } = await upload();
		const readFile = vi.spyOn(fs.promises, 'readFile');

		const response = await app.inject({ method: 'POST', url, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: 'Bearer readonly' }, payload });

		expect(response.statusCode).toBe(403);
		expect(readFile).not.toHaveBeenCalled();
		expect(created()).toBe(0);
	});

	test.each(['/v1/media', '/v2/media'])('rejects an upload to %s from a suspended account with 403', async url => {
		const { app, created } = await upload();
		const readFile = vi.spyOn(fs.promises, 'readFile');

		const response = await app.inject({ method: 'POST', url, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: 'Bearer suspended' }, payload });

		expect(response.statusCode).toBe(403);
		expect(response.json()).toMatchObject({ error: 'Your account has been suspended.', error_description: 'YOUR_ACCOUNT_SUSPENDED' });
		expect(readFile).not.toHaveBeenCalled();
		expect(created()).toBe(0);
	});

	test.each(['/v1/media', '/v2/media'])('uploads a file to %s with a token that can write the drive', async url => {
		const { app, created } = await upload();

		const response = await app.inject({ method: 'POST', url, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: 'Bearer drive' }, payload });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ id: 'file1', type: 'image', url: 'https://files.example/a.png' });
		expect(created()).toBe(1);
	});
});
