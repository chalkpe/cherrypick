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

function rsaKeyPair() {
	return crypto.generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
}

const { publicKey, privateKey } = rsaKeyPair();
const otherKeyPair = rsaKeyPair();

const remoteUser = { id: 'alice', host: 'remote.test', uri: 'https://remote.test/users/alice', isDeleted: false } as MiRemoteUser;

function createVerifier(known = true) {
	const keys = new Map<string, { userId: string; keyId: string; keyPem: string }>();
	if (known) keys.set(KEY_ID, { userId: remoteUser.id, keyId: KEY_ID, keyPem: publicKey });
	const users = new Map<string, MiRemoteUser>([[remoteUser.id, remoteUser]]);
	const userPublickeysRepository = {
		findOneBy: vi.fn(async ({ keyId }: { keyId: string }) => keys.get(keyId) ?? null),
	};
	const usersRepository = {
		findOneBy: vi.fn(async ({ id }: { id: string }) => users.get(id) ?? null),
	};
	const verifier = new ApSignedRequestVerifierService(config, userPublickeysRepository as any, usersRepository as any);
	return { verifier, keys, users, userPublickeysRepository };
}

// 送信側と同じ ApRequestCreator で署名し、受信側の Fastify が見る形に直す。
async function signedRequest(options: { url?: string; body?: string; additionalHeaders?: Record<string, string>; keyId?: string; privateKeyPem?: string } = {}) {
	const url = options.url ?? TOKEN_URL;
	const signed = await ApRequestCreator.createSignedPost({
		key: { keyId: options.keyId ?? KEY_ID, privateKeyPem: options.privateKeyPem ?? privateKey },
		url,
		body: options.body ?? BODY,
		additionalHeaders: options.additionalHeaders ?? {},
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
		const { verifier, userPublickeysRepository } = createVerifier();

		const user = await verifier.verify(await signedRequest(), BODY);

		expect(user).toBe(remoteUser);
		expect(userPublickeysRepository.findOneBy).toHaveBeenCalledWith({ keyId: KEY_ID });
	});

	test('rejects a body that does not match the digest', async () => {
		const { verifier } = createVerifier();

		const user = await verifier.verify(await signedRequest(), JSON.stringify({ room: 'https://local.test/chat/rooms/other', canScreenShare: true }));

		expect(user).toBeNull();
	});

	test('rejects a request signed for another host', async () => {
		const { verifier } = createVerifier();

		const user = await verifier.verify(await signedRequest({ url: 'https://other.test/livekit/federation/token' }), BODY);

		expect(user).toBeNull();
	});

	test('rejects a request whose date is too old', async () => {
		const { verifier } = createVerifier();
		const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toUTCString();

		const user = await verifier.verify(await signedRequest({ additionalHeaders: { Date: tenMinutesAgo } }), BODY);

		expect(user).toBeNull();
	});

	test('rejects an old signed date even when an unsigned fresh x-date is added', async () => {
		const { verifier } = createVerifier();
		const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toUTCString();
		const request = await signedRequest({ additionalHeaders: { Date: tenMinutesAgo } });

		const user = await verifier.verify({ ...request, headers: { ...request.headers, 'x-date': new Date().toUTCString() } }, BODY);

		expect(user).toBeNull();
	});

	test('rejects a signed date that cannot be parsed', async () => {
		const { verifier } = createVerifier();

		const user = await verifier.verify(await signedRequest({ additionalHeaders: { Date: 'not a date' } }), BODY);

		expect(user).toBeNull();
	});

	test('rejects a date header that was replaced after signing', async () => {
		const { verifier } = createVerifier();
		// 署名した date と差し替えた date はどちらも許容範囲内だが、文字列が違うので署名が合わない
		const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toUTCString();
		const request = await signedRequest({ additionalHeaders: { Date: twoMinutesAgo } });

		const user = await verifier.verify({ ...request, headers: { ...request.headers, date: new Date().toUTCString() } }, BODY);

		expect(user).toBeNull();
	});

	test('rejects a known keyId signed with a different private key', async () => {
		const { verifier } = createVerifier();

		const user = await verifier.verify(await signedRequest({ privateKeyPem: otherKeyPair.privateKey }), BODY);

		expect(user).toBeNull();
	});

	test('rejects the old key once the stored key for that keyId has changed', async () => {
		const { verifier, keys } = createVerifier();
		expect(await verifier.verify(await signedRequest(), BODY)).toBe(remoteUser);

		keys.set(KEY_ID, { userId: remoteUser.id, keyId: KEY_ID, keyPem: otherKeyPair.publicKey });

		expect(await verifier.verify(await signedRequest(), BODY)).toBeNull();
		expect(await verifier.verify(await signedRequest({ privateKeyPem: otherKeyPair.privateKey }), BODY)).toBe(remoteUser);
	});

	test('rejects a key whose owner has been deleted', async () => {
		const { verifier, users } = createVerifier();
		users.set(remoteUser.id, { ...remoteUser, isDeleted: true });

		const user = await verifier.verify(await signedRequest(), BODY);

		expect(user).toBeNull();
	});

	test('rejects a key it has never seen', async () => {
		const { verifier } = createVerifier(false);

		const user = await verifier.verify(await signedRequest(), BODY);

		expect(user).toBeNull();
	});

	test('rejects an overlong keyId without looking it up', async () => {
		const { verifier, userPublickeysRepository } = createVerifier();
		const keyId = `https://remote.test/users/${'a'.repeat(512)}#main-key`;

		const user = await verifier.verify(await signedRequest({ keyId }), BODY);

		expect(user).toBeNull();
		expect(userPublickeysRepository.findOneBy).not.toHaveBeenCalled();
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
		// 指定が無ければ HttpRequestService の既定 (リダイレクトを辿る、上限 10MB) のまま
		expect(args).toMatchObject({ redirect: undefined, size: undefined });
	});

	test('signedPostJson passes redirect handling and a response size limit through', async () => {
		const httpRequestService = {
			send: vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
		};
		const service = new ApRequestService(
			{ url: 'https://member.test' } as Config,
			{ getUserKeypair: vi.fn(async () => ({ userId: 'bob', publicKey, privateKey })) } as any,
			httpRequestService as any,
			{ getLogger: () => ({}) } as any,
			{} as any,
		);

		await service.signedPostJson({ id: 'bob' }, TOKEN_URL, {}, 10_000, { redirect: 'manual', size: 64 * 1024 });

		const [, args] = httpRequestService.send.mock.calls[0] as unknown as [string, { redirect: string; size: number }];
		expect(args.redirect).toBe('manual');
		expect(args.size).toBe(64 * 1024);
	});
});
