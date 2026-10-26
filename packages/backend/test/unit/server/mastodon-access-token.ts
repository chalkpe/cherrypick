/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, onTestFinished, test } from 'vitest';
import { getAccessToken } from '@/server/api/mastodon/MastodonClientService.js';
import { MastodonStreamingService } from '@/server/api/mastodon/MastodonStreamingService.js';
import { AuthenticationError } from '@/server/api/AuthenticateService.js';
import type { FastifyRequest } from 'fastify';

describe('Mastodon HTTP access token', () => {
	function request(headers: Record<string, string> = {}, query: Record<string, unknown> = {}): FastifyRequest {
		return { headers, query } as unknown as FastifyRequest;
	}

	test('reads the token from an Authorization: Bearer header', () => {
		expect(getAccessToken(request({ authorization: 'Bearer secret-token' }))).toBe('secret-token');
	});

	test('ignores the access_token query parameter', () => {
		expect(getAccessToken(request({}, { access_token: 'secret-token' }))).toBeNull();
	});

	test('does not accept an Authorization header without the Bearer scheme', () => {
		expect(getAccessToken(request({ authorization: 'secret-token' }))).toBeNull();
	});

	test('returns null when no credentials are present', () => {
		expect(getAccessToken(request())).toBeNull();
	});
});

describe('Mastodon HTTP access token edge cases', () => {
	function request(headers: Record<string, string> = {}, query: Record<string, unknown> = {}): FastifyRequest {
		return { headers, query } as unknown as FastifyRequest;
	}

	test('uses only the header when both the header and the query parameter carry a token', () => {
		expect(getAccessToken(request({ authorization: 'Bearer header-token' }, { access_token: 'query-token' }))).toBe('header-token');
	});

	test.each([
		'Basic dXNlcjpwYXNz',
		'Token secret-token',
		'secret-token Bearer',
		'Bearersecret-token',
		'Bearer',
		'Bearer ',
		'',
	])('does not treat the Authorization header %j as a token', authorization => {
		expect(getAccessToken(request({ authorization }, { access_token: 'query-token' }))).toBeNull();
	});

	test('does not fall back to the last word of a multi-part non-Bearer header', () => {
		expect(getAccessToken(request({ authorization: 'Basic Bearer secret-token' }))).toBeNull();
	});
});

describe('Mastodon streaming access token', () => {
	async function upgrade(url: string, headers: Record<string, string> = {}) {
		const tokens: (string | null)[] = [];
		const service = new MastodonStreamingService(
			new EventEmitter() as never, {} as never,
			{ authenticate: async (token: string | null) => { tokens.push(token); throw new AuthenticationError('stop'); } } as never,
			{} as never, {} as never,
			{ getLogger: () => ({ error: () => {} }) } as never,
		);
		onTestFinished(() => service.onApplicationShutdown());
		const written: string[] = [];
		const socket = { write: (data: string) => written.push(data), destroy: () => {} };
		await service.handleUpgrade({ url, headers } as never, socket as never, Buffer.alloc(0));
		return { tokens, written };
	}

	test('still accepts the access_token query parameter because WebSocket clients cannot set headers', async () => {
		const { tokens, written } = await upgrade('/api/v1/streaming?stream=user&access_token=query-token');
		expect(tokens).toEqual(['query-token']);
		expect(written[0]).toContain('401');
	});

	test('prefers the Bearer header over the query parameter', async () => {
		const { tokens } = await upgrade('/api/v1/streaming?access_token=query-token', { authorization: 'Bearer header-token' });
		expect(tokens).toEqual(['header-token']);
	});

	test('accepts the token from the WebSocket subprotocol', async () => {
		const { tokens } = await upgrade('/api/v1/streaming', { 'sec-websocket-protocol': 'protocol-token' });
		expect(tokens).toEqual(['protocol-token']);
	});
});
