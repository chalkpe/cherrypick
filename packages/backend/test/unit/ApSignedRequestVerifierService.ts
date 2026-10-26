/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as crypto from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { ApRequestCreator, ApRequestService } from '@/core/activitypub/ApRequestService.js';
import { ApSignedRequestVerifierService } from '@/core/activitypub/ApSignedRequestVerifierService.js';
import type { Config } from '@/config.js';
import type { MiRemoteUser, MiUser } from '@/models/User.js';

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
	const users = new Map<string, MiUser>([[remoteUser.id, remoteUser]]);
	const userPublickeysRepository = {
		findOneBy: vi.fn(async ({ keyId }: { keyId: string }) => keys.get(keyId) ?? null),
	};
	const usersRepository = {
		findOneBy: vi.fn(async ({ id }: { id: string }) => users.get(id) ?? null),
	};
	const logger = { debug: vi.fn() };
	const verifier = new ApSignedRequestVerifierService(config, userPublickeysRepository as any, usersRepository as any, { getLogger: () => logger } as any);
	return { verifier, keys, users, userPublickeysRepository, logger };
}

/** keyId をちょうど length 文字にする */
function keyIdOfLength(length: number) {
	const prefix = 'https://remote.test/users/';
	const suffix = '#main-key';
	return `${prefix}${'a'.repeat(length - prefix.length - suffix.length)}${suffix}`;
}

/** 署名する見出しと署名文字列を自分で決めて、KEY_ID の鍵で署名した要求 */
function handSignedRequest(headerNames: string, signingLines: (headers: { date: string; digest: string }) => string[]) {
	const date = new Date().toUTCString();
	const digest = ApRequestCreator.createDigest(BODY);
	const signature = crypto.sign('sha256', Buffer.from(signingLines({ date, digest }).join('\n')), privateKey).toString('base64');
	return {
		method: 'POST',
		url: '/livekit/federation/token',
		headers: {
			date,
			host: 'local.test',
			digest,
			signature: `keyId="${KEY_ID}",algorithm="rsa-sha256",headers="${headerNames}",signature="${signature}"`,
		},
	};
}

// 送信側と同じ ApRequestCreator で署名し、受信側の Fastify が見る形に直す。
async function signedRequest(options: { url?: string; body?: string; digest?: string; additionalHeaders?: Record<string, string>; keyId?: string; privateKeyPem?: string } = {}) {
	const url = options.url ?? TOKEN_URL;
	const signed = await ApRequestCreator.createSignedPost({
		key: { keyId: options.keyId ?? KEY_ID, privateKeyPem: options.privateKeyPem ?? privateKey },
		url,
		body: options.body ?? BODY,
		digest: options.digest,
		additionalHeaders: options.additionalHeaders ?? {},
	});
	const u = new URL(url);
	const headers: Record<string, string> = { ...signed.request.headers, host: u.host };
	return {
		method: 'POST',
		url: `${u.pathname}${u.search}`,
		headers,
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

	test('rejects a key whose owner is a user of this server', async () => {
		const { verifier, users } = createVerifier();
		users.set(remoteUser.id, { ...remoteUser, host: null, uri: null });

		const user = await verifier.verify(await signedRequest(), BODY);

		expect(user).toBeNull();
	});

	test('rejects a key it has never seen', async () => {
		const { verifier } = createVerifier(false);

		const user = await verifier.verify(await signedRequest(), BODY);

		expect(user).toBeNull();
	});

	test('rejects a keyId longer than the stored column without looking it up', async () => {
		const { verifier, userPublickeysRepository } = createVerifier();

		// user_publickey.keyId は varchar(256)
		const user = await verifier.verify(await signedRequest({ keyId: keyIdOfLength(257) }), BODY);

		expect(user).toBeNull();
		expect(userPublickeysRepository.findOneBy).not.toHaveBeenCalled();

		await verifier.verify(await signedRequest({ keyId: keyIdOfLength(256) }), BODY);
		expect(userPublickeysRepository.findOneBy).toHaveBeenCalledWith({ keyId: keyIdOfLength(256) });
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
		const request = handSignedRequest('(request-target) date host', ({ date }) => [
			'(request-target): post /livekit/federation/token',
			`date: ${date}`,
			'host: local.test',
		]);

		const user = await verifier.verify(request, BODY);

		expect(user).toBeNull();
	});

	test('rejects a signature that covers the old request-line pseudo-header', async () => {
		const { verifier } = createVerifier();
		// 古い草案の request-line は HTTP のバージョンを含むが、検証に渡す要求には無い。
		// 古い草案も読む設定では "HTTP/undefined" として署名文字列に入り、その文字列に署名すれば通ってしまう
		const request = handSignedRequest('request-line (request-target) date host digest', ({ date, digest }) => [
			'POST /livekit/federation/token HTTP/undefined',
			'(request-target): post /livekit/federation/token',
			`date: ${date}`,
			'host: local.test',
			`digest: ${digest}`,
		]);

		const user = await verifier.verify(request, BODY);

		expect(user).toBeNull();
	});

	test('accepts a hand-made signature over the required headers', async () => {
		const { verifier } = createVerifier();
		// 上の二つの拒否が、手で作った署名そのものの誤りによるものでないことを確かめる
		const request = handSignedRequest('(request-target) date host digest', ({ date, digest }) => [
			'(request-target): post /livekit/federation/token',
			`date: ${date}`,
			'host: local.test',
			`digest: ${digest}`,
		]);

		const user = await verifier.verify(request, BODY);

		expect(user).toBe(remoteUser);
	});

	test('rejects a digest made with another algorithm', async () => {
		const { verifier } = createVerifier();
		const sha512 = `SHA-512=${crypto.createHash('sha512').update(BODY).digest('base64')}`;
		// 値は SHA-256 のものだが、名前が違う
		const mislabeled = `SHA-512=${crypto.createHash('sha256').update(BODY).digest('base64')}`;

		for (const digest of [sha512, mislabeled]) {
			const user = await verifier.verify(await signedRequest({ digest }), BODY);
			expect(user, digest).toBeNull();
		}
	});

	test('rejects a malformed digest', async () => {
		const { verifier } = createVerifier();
		const sha256 = crypto.createHash('sha256').update(BODY).digest('base64');

		for (const digest of [
			'',
			sha256,
			'SHA-256',
			'SHA-256=',
			`=${sha256}`,
			`SHA 256=${sha256}`,
			`SHA-256=${sha256},SHA-512=x`,
			`SHA-256=${sha256} `,
		]) {
			// digest も署名に含めるので、署名は正しい
			const user = await verifier.verify(await signedRequest({ digest }), BODY);
			expect(user, JSON.stringify(digest)).toBeNull();
		}
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

	describe('debug log of the failed check', () => {
		const cases: [string, () => Promise<{ request: Awaited<ReturnType<typeof signedRequest>>; body?: string; setup?: (v: ReturnType<typeof createVerifier>) => void }>, string][] = [
			['no signature', async () => {
				const { signature: _, ...headers } = (await signedRequest()).headers;
				return { request: { ...(await signedRequest()), headers } };
			}, 'Rejected a signed request at the "signature header" check'],
			['another host', async () => ({ request: await signedRequest({ url: 'https://other.test/livekit/federation/token' }) }), 'Rejected a signed request at the "host" check (key host: remote.test)'],
			['an unparsable date', async () => ({ request: await signedRequest({ additionalHeaders: { Date: 'not a date' } }) }), 'Rejected a signed request at the "date" check (key host: remote.test)'],
			['another body', async () => ({ request: await signedRequest(), body: '{}' }), 'Rejected a signed request at the "digest" check (key host: remote.test)'],
			['an overlong keyId', async () => ({ request: await signedRequest({ keyId: keyIdOfLength(257) }) }), 'Rejected a signed request at the "keyId length" check'],
			['an unknown key', async () => ({ request: await signedRequest(), setup: v => v.keys.clear() }), 'Rejected a signed request at the "key lookup" check (key host: remote.test)'],
			['a deleted owner', async () => ({ request: await signedRequest(), setup: v => v.users.set(remoteUser.id, { ...remoteUser, isDeleted: true }) }), 'Rejected a signed request at the "key owner" check (key host: remote.test)'],
			['another private key', async () => ({ request: await signedRequest({ privateKeyPem: otherKeyPair.privateKey }) }), 'Rejected a signed request at the "signature" check (key host: remote.test)'],
		];

		test.each(cases)('names the check that refused %s', async (_label, build, message) => {
			const v = createVerifier();
			const { request, body, setup } = await build();
			setup?.(v);

			expect(await v.verifier.verify(request, body ?? BODY)).toBeNull();

			expect(v.logger.debug.mock.calls).toEqual([[message]]);
			// keyId のホスト以外の部分、署名、本文は残さない
			const logged = JSON.stringify(v.logger.debug.mock.calls);
			expect(logged).not.toContain('/users/');
			expect(logged).not.toContain(/signature="([^"]+)"/.exec(String(request.headers.signature))?.[1] ?? '(no signature)');
			expect(logged).not.toContain('canScreenShare');
		});

		test('logs nothing for an accepted request', async () => {
			const v = createVerifier();

			expect(await v.verifier.verify(await signedRequest(), BODY)).toBe(remoteUser);

			expect(v.logger.debug).not.toHaveBeenCalled();
		});
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

	test('signedPost signs and sends the digest it is given, with the default send options', async () => {
		const httpRequestService = {
			send: vi.fn(async (_url: string, _args: Record<string, unknown>) => new Response('')),
		};
		const service = new ApRequestService(
			{ url: 'https://member.test' } as Config,
			{ getUserKeypair: vi.fn(async () => ({ userId: 'bob', publicKey, privateKey })) } as any,
			httpRequestService as any,
			{ getLogger: () => ({}) } as any,
			{} as any,
		);

		// 配送ジョブは前もって計算した digest を渡す
		await service.signedPost({ id: 'bob' }, TOKEN_URL, '{"type":"Create"}', 'SHA-256=precomputed');

		const [url, args] = httpRequestService.send.mock.calls[0];
		expect(url).toBe(TOKEN_URL);
		expect(args).toEqual({
			method: 'POST',
			headers: expect.objectContaining({ digest: 'SHA-256=precomputed', signature: expect.stringContaining('headers="(request-target) date host digest"') }),
			body: '{"type":"Create"}',
		});
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

describe('sending and verifying', () => {
	const MEMBER_KEY_ID = 'https://member.test/users/bob#main-key';
	const member = { id: 'bob', host: 'member.test', uri: 'https://member.test/users/bob', isDeleted: false } as MiRemoteUser;

	// メンバーのサーバー (member.test) が送ったものを、ホスト (local.test) の検証器がそのまま受け入れる
	test.each(['signedPost', 'signedPostJson'] as const)('%s sends a request that the verifier accepts', async method => {
		const httpRequestService = {
			send: vi.fn(async (_url: string, _args: { method: string; headers: Record<string, string>; body: string }) => new Response('{}', { headers: { 'content-type': 'application/json' } })),
		};
		const service = new ApRequestService(
			{ url: 'https://member.test' } as Config,
			{ getUserKeypair: vi.fn(async () => ({ userId: 'bob', publicKey, privateKey })) } as any,
			httpRequestService as any,
			{ getLogger: () => ({}) } as any,
			{} as any,
		);
		const object = { room: 'https://local.test/chat/rooms/room1', canScreenShare: true };

		if (method === 'signedPost') {
			await service.signedPost({ id: 'bob' }, TOKEN_URL, object);
		} else {
			await service.signedPostJson({ id: 'bob' }, TOKEN_URL, object, 10_000);
		}

		const { verifier, keys, users } = createVerifier(false);
		keys.set(MEMBER_KEY_ID, { userId: member.id, keyId: MEMBER_KEY_ID, keyPem: publicKey });
		users.set(member.id, member);
		const [url, args] = httpRequestService.send.mock.calls[0];
		const u = new URL(url);
		// 受け取る側には、送る側の HTTP クライアントが URL から付けた Host が届く
		const received = { method: args.method, url: `${u.pathname}${u.search}`, headers: { ...args.headers, host: u.host } };

		expect(await verifier.verify(received, args.body)).toBe(member);
		expect(args.headers.signature).toContain('headers="(request-target) date host digest"');
	});
});
