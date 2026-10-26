/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as crypto from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { ApRequestCreator, ApRequestService } from '@/core/activitypub/ApRequestService.js';
import { ApSignedRequestVerifierService } from '@/core/activitypub/ApSignedRequestVerifierService.js';
import type { Config } from '@/config.js';
import type { MiRemoteUser } from '@/models/User.js';

const config = { url: 'https://local.test', host: 'local.test' } as Config;
const KEY_ID = 'https://remote.test/users/alice#main-key';
const TOKEN_URL = 'https://local.test/livekit/federation/token';
const BODY = JSON.stringify({ room: 'https://local.test/chat/rooms/room1', canScreenShare: false });

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const remoteUser = { id: 'alice', host: 'remote.test', uri: 'https://remote.test/users/alice' } as MiRemoteUser;

function createVerifier(known = true) {
	const apDbResolverService = {
		getAuthUserFromKeyId: vi.fn(async (keyId: string) => known
			? { user: remoteUser, key: { keyId, keyPem: publicKey, userId: remoteUser.id } }
			: null),
	};
	const verifier = new ApSignedRequestVerifierService(config, apDbResolverService as any);
	return { verifier, apDbResolverService };
}

// 送信側と同じ ApRequestCreator で署名し、受信側の Fastify が見る形に直す。
async function signedRequest(url = TOKEN_URL, body = BODY, additionalHeaders: Record<string, string> = {}) {
	const signed = await ApRequestCreator.createSignedPost({
		key: { keyId: KEY_ID, privateKeyPem: privateKey },
		url,
		body,
		additionalHeaders,
	});
	const u = new URL(url);
	return {
		method: 'POST',
		url: `${u.pathname}${u.search}`,
		headers: { ...signed.request.headers, host: u.host },
	};
}

describe('ApSignedRequestVerifierService', () => {
	test('accepts a request signed by a known remote user', async () => {
		const { verifier, apDbResolverService } = createVerifier();

		const user = await verifier.verify(await signedRequest(), BODY);

		expect(user).toBe(remoteUser);
		expect(apDbResolverService.getAuthUserFromKeyId).toHaveBeenCalledWith(KEY_ID);
	});

	test('rejects a body that does not match the digest', async () => {
		const { verifier } = createVerifier();

		const user = await verifier.verify(await signedRequest(), JSON.stringify({ room: 'https://local.test/chat/rooms/other', canScreenShare: true }));

		expect(user).toBeNull();
	});

	test('rejects a request signed for another host', async () => {
		const { verifier } = createVerifier();

		const user = await verifier.verify(await signedRequest('https://other.test/livekit/federation/token'), BODY);

		expect(user).toBeNull();
	});

	test('rejects a request whose date is too old', async () => {
		const { verifier } = createVerifier();
		const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toUTCString();

		const user = await verifier.verify(await signedRequest(TOKEN_URL, BODY, { Date: tenMinutesAgo }), BODY);

		expect(user).toBeNull();
	});

	test('rejects an old signed date even when an unsigned fresh x-date is added', async () => {
		const { verifier } = createVerifier();
		const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toUTCString();
		const request = await signedRequest(TOKEN_URL, BODY, { Date: tenMinutesAgo });

		const user = await verifier.verify({ ...request, headers: { ...request.headers, 'x-date': new Date().toUTCString() } }, BODY);

		expect(user).toBeNull();
	});

	test('rejects a signed date that cannot be parsed', async () => {
		const { verifier } = createVerifier();

		const user = await verifier.verify(await signedRequest(TOKEN_URL, BODY, { Date: 'not a date' }), BODY);

		expect(user).toBeNull();
	});

	test('rejects a key it has never seen', async () => {
		const { verifier } = createVerifier(false);

		const user = await verifier.verify(await signedRequest(), BODY);

		expect(user).toBeNull();
	});

	test('rejects a signature that does not cover the digest', async () => {
		const { verifier } = createVerifier();
		// 署名自体は正しいが digest を含まないので、本文と digest を差し替えられてしまう
		const date = new Date().toUTCString();
		const signingString = [
			'(request-target): post /livekit/federation/token',
			`date: ${date}`,
			'host: local.test',
		].join('\n');
		const signature = crypto.sign('sha256', Buffer.from(signingString), privateKey).toString('base64');

		const user = await verifier.verify({
			method: 'POST',
			url: '/livekit/federation/token',
			headers: {
				date,
				host: 'local.test',
				digest: ApRequestCreator.createDigest(BODY),
				signature: `keyId="${KEY_ID}",algorithm="rsa-sha256",headers="(request-target) date host",signature="${signature}"`,
			},
		}, BODY);

		expect(user).toBeNull();
	});

	test('rejects a request without a signature', async () => {
		const { verifier } = createVerifier();

		const user = await verifier.verify({
			method: 'POST',
			url: '/livekit/federation/token',
			headers: { host: 'local.test', date: new Date().toUTCString(), digest: ApRequestCreator.createDigest(BODY) },
		}, BODY);

		expect(user).toBeNull();
	});
});

describe('ApRequestService.signedPostJson', () => {
	test('signedPostJson returns the parsed response body', async () => {
		const responseBody = { url: 'wss://local.test/livekit', token: 'jwt', participants: [] };
		const httpRequestService = {
			send: vi.fn(async () => new Response(JSON.stringify(responseBody), { headers: { 'content-type': 'application/json' } })),
		};
		const userKeypairService = {
			getUserKeypair: vi.fn(async () => ({ userId: 'bob', publicKey, privateKey })),
		};
		const service = new ApRequestService(
			{ url: 'https://member.test' } as Config,
			userKeypairService as any,
			httpRequestService as any,
			{ getLogger: () => ({}) } as any,
			{} as any,
		);
		const object = { room: 'https://local.test/chat/rooms/room1', canScreenShare: true };

		const result = await service.signedPostJson({ id: 'bob' }, TOKEN_URL, object, 10_000);

		expect(result).toEqual(responseBody);
		expect(httpRequestService.send).toHaveBeenCalledTimes(1);
		const [url, args] = httpRequestService.send.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string; timeout: number }];
		expect(url).toBe(TOKEN_URL);
		expect(args.method).toBe('POST');
		expect(args.body).toBe(JSON.stringify(object));
		expect(args.timeout).toBe(10_000);
		expect(args.headers.signature).toContain('keyId="https://member.test/users/bob#main-key"');
		expect(args.headers.digest).toBe(ApRequestCreator.createDigest(JSON.stringify(object)));
	});
});
