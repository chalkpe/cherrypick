/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CloudflareTurnService, parseIceServers } from '@/core/CloudflareTurnService.js';
import { MetaEntityService } from '@/core/entities/MetaEntityService.js';
import UpdateMetaEndpoint from '@/server/api/endpoints/admin/update-meta.js';
import AdminMetaEndpoint, { meta as adminMetaMeta } from '@/server/api/endpoints/admin/meta.js';
import { StatusError } from '@/misc/status-error.js';

const KEY_ID = 'turn-key-id';
const API_TOKEN = 'secret-api-token';
const HOUR = 60 * 60 * 1000;

// Cloudflare の generate-ice-servers が返す形 (iceServers が配列のもの)
function cloudflareBody(username = 'generated-user', credential = 'generated-credential') {
	return {
		iceServers: [
			{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
			{
				urls: [
					'turn:turn.cloudflare.com:3478?transport=udp',
					'turn:turn.cloudflare.com:3478?transport=tcp',
					'turns:turn.cloudflare.com:5349?transport=tcp',
					'turn:turn.cloudflare.com:53?transport=udp',
					'turn:turn.cloudflare.com:80?transport=tcp',
					'turns:turn.cloudflare.com:443?transport=tcp',
				],
				username,
				credential,
			},
		],
	};
}

function expectedIceServers(username = 'generated-user', credential = 'generated-credential') {
	return [
		{ urls: ['stun:stun.cloudflare.com:3478'] },
		{
			urls: [
				'turn:turn.cloudflare.com:3478?transport=udp',
				'turn:turn.cloudflare.com:3478?transport=tcp',
				'turns:turn.cloudflare.com:5349?transport=tcp',
				'turn:turn.cloudflare.com:80?transport=tcp',
				'turns:turn.cloudflare.com:443?transport=tcp',
			],
			username,
			credential,
		},
	];
}

function response(body: unknown) {
	return { ok: true, status: 201, json: vi.fn(async () => body) };
}

function createFixture(metaOverrides: Record<string, unknown> = {}) {
	const meta = { voiceCallCloudflareTurnKeyId: KEY_ID as string | null, voiceCallCloudflareTurnApiToken: API_TOKEN as string | null, ...metaOverrides };
	const httpRequestService = {
		send: vi.fn(async (_url: string, _args: Record<string, unknown>): Promise<unknown> => response(cloudflareBody())),
	};
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const loggerService = { getLogger: () => logger };
	// 内部イベント (metaUpdated) は Redis の購読から届く
	const redisForSub = new EventEmitter();
	const service = new CloudflareTurnService(redisForSub as any, meta as any, httpRequestService as any, loggerService as any);
	service.onModuleInit();
	return { service, meta, httpRequestService, logger, redisForSub };
}

/** GlobalModule の購読と同じく、先に DI.meta を書き換えてから metaUpdated を流す */
function publishMetaUpdated(f: ReturnType<typeof createFixture>, changes: Record<string, unknown>) {
	const before = { ...f.meta };
	Object.assign(f.meta, changes);
	f.redisForSub.emit('message', 'local.test', JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body: { before, after: { ...f.meta } } } }));
}

describe('CloudflareTurnService', () => {
	let f: ReturnType<typeof createFixture>;

	afterEach(() => {
		f?.service.onApplicationShutdown();
		vi.useRealTimers();
	});

	test.each([
		['the key id', { voiceCallCloudflareTurnKeyId: null }],
		['the API token', { voiceCallCloudflareTurnApiToken: null }],
	])('returns null without asking Cloudflare when %s is not set', async (_label, overrides) => {
		f = createFixture(overrides);

		await expect(f.service.getIceServers()).resolves.toBeNull();
		expect(f.httpRequestService.send).not.toHaveBeenCalled();
	});

	test('asks Cloudflare for credentials that last a day and drops port 53', async () => {
		f = createFixture();

		await expect(f.service.getIceServers()).resolves.toEqual(expectedIceServers());

		expect(f.httpRequestService.send).toHaveBeenCalledTimes(1);
		const [url, args] = f.httpRequestService.send.mock.calls[0];
		expect(url).toBe(`https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`);
		expect(args).toMatchObject({
			method: 'POST',
			headers: expect.objectContaining({ 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }),
			timeout: 5000,
			size: 64 * 1024,
			redirect: 'manual',
		});
		expect(JSON.parse(args.body as string)).toEqual({ ttl: 86400 });
	});

	test('escapes the key id in the request path', async () => {
		f = createFixture({ voiceCallCloudflareTurnKeyId: '../../other?x=1' });

		await f.service.getIceServers();

		expect(f.httpRequestService.send.mock.calls[0][0]).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/..%2F..%2Fother%3Fx%3D1/credentials/generate-ice-servers');
	});

	test('accepts iceServers given as a single object', async () => {
		f = createFixture();
		f.httpRequestService.send.mockResolvedValueOnce(response({
			iceServers: { urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'], username: 'u', credential: 'c' },
		}));

		await expect(f.service.getIceServers()).resolves.toEqual([
			{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
		]);
	});

	test('keeps only STUN and TURN URLs and drops servers left without any', async () => {
		f = createFixture();
		f.httpRequestService.send.mockResolvedValueOnce(response({
			iceServers: [
				{ urls: ['https://turn.cloudflare.com/', 'stuns:stun.example:3478', 'javascript:alert(1)', 'stun:stun.example:53'] },
				{ urls: ['turn:[2001:db8::1]:53?transport=udp', 'turn:[2001:db8::53]?transport=udp', 'turns:turn.example'], username: 'u', credential: 'c', extra: 'dropped' },
			],
		}));

		await expect(f.service.getIceServers()).resolves.toEqual([
			{ urls: ['turn:[2001:db8::53]?transport=udp', 'turns:turn.example'], username: 'u', credential: 'c' },
		]);
	});

	test('drops TURN URLs that come without credentials, and keeps the STUN URLs beside them', async () => {
		f = createFixture();
		f.httpRequestService.send.mockResolvedValueOnce(response({
			iceServers: [
				{ urls: ['stun:stun.cloudflare.com:3478'] },
				// STUN は資格情報を使わないので、資格情報の無い TURN と同じ項目にあっても残す
				{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'stun:stun2.example:3478'] },
				{ urls: ['turns:turn.cloudflare.com:443?transport=tcp', 'stun:stun4.example:3478'], username: 'u' },
				{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'u' },
				{ urls: ['turn:turn.cloudflare.com:3478?transport=tcp'], credential: 'c' },
				{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: '', credential: '' },
				// 53 番ポートの TURN を除くと STUN だけが残る
				{ urls: ['turn:turn.cloudflare.com:53?transport=udp', 'stun:stun3.example:3478'] },
				{ urls: ['turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u', credential: 'c' },
			],
		}));

		await expect(f.service.getIceServers()).resolves.toEqual([
			{ urls: ['stun:stun.cloudflare.com:3478'] },
			{ urls: ['stun:stun2.example:3478'] },
			{ urls: ['stun:stun4.example:3478'] },
			{ urls: ['stun:stun3.example:3478'] },
		]);
	});

	test('still keeps at most four servers after splitting off the STUN URLs', async () => {
		f = createFixture();
		f.httpRequestService.send.mockResolvedValueOnce(response({
			iceServers: Array.from({ length: 6 }, (_, i) => ({ urls: [`turn:turn${i}.example:3478`, `stun:stun${i}.example:3478`] })),
		}));

		await expect(f.service.getIceServers()).resolves.toEqual(Array.from({ length: 4 }, (_, i) => ({ urls: [`stun:stun${i}.example:3478`] })));
	});

	test('drops URLs with characters other than printable ASCII', async () => {
		f = createFixture();
		f.httpRequestService.send.mockResolvedValueOnce(response({
			iceServers: [
				{ urls: ['stun:stun.example\u0000:3478', 'stun:stun.example\u007f', 'stun:例え.example:3478', 'stun:stun.example:3478'] },
			],
		}));

		await expect(f.service.getIceServers()).resolves.toEqual([
			{ urls: ['stun:stun.example:3478'] },
		]);
	});

	test.each([
		['no ICE servers', { iceServers: [] }],
		['only port 53', { iceServers: [{ urls: ['stun:stun.cloudflare.com:53'] }] }],
		['an unexpected body', { error: 'nope' }],
		['a non-object body', 'nope'],
	])('returns null when Cloudflare returns %s', async (_label, body) => {
		f = createFixture();
		f.httpRequestService.send.mockResolvedValueOnce(response(body));

		await expect(f.service.getIceServers()).resolves.toBeNull();
		expect(f.logger.warn).toHaveBeenCalled();
	});

	test('reuses the credentials while at least 12 of their 24 hours remain, then asks again', async () => {
		vi.useFakeTimers();
		f = createFixture();

		await expect(f.service.getIceServers()).resolves.toEqual(expectedIceServers());
		vi.advanceTimersByTime(12 * HOUR - 1000);
		await expect(f.service.getIceServers()).resolves.toEqual(expectedIceServers());
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(1);

		f.httpRequestService.send.mockResolvedValueOnce(response(cloudflareBody('fresh-user', 'fresh-credential')));
		vi.advanceTimersByTime(1000);
		await expect(f.service.getIceServers()).resolves.toEqual(expectedIceServers('fresh-user', 'fresh-credential'));
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(2);
	});

	// 資格情報の寿命は Cloudflare が受け取ったときから数えられるので、使い回す間も問い合わせたときから数える
	test('counts the 12 hours of reuse from when it asked, not from when Cloudflare answered', async () => {
		vi.useFakeTimers();
		f = createFixture();
		f.httpRequestService.send.mockImplementationOnce(async () => {
			await new Promise(resolve => setTimeout(resolve, 5000));
			return response(cloudflareBody());
		});

		const first = f.service.getIceServers();
		await vi.advanceTimersByTimeAsync(5000);
		await expect(first).resolves.toEqual(expectedIceServers());

		vi.advanceTimersByTime(12 * HOUR - 5000 - 1);
		await f.service.getIceServers();
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(1);

		f.httpRequestService.send.mockResolvedValueOnce(response(cloudflareBody('fresh-user', 'fresh-credential')));
		vi.advanceTimersByTime(1);
		await expect(f.service.getIceServers()).resolves.toEqual(expectedIceServers('fresh-user', 'fresh-credential'));
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(2);
	});

	test('counts the minute after a failure from when it asked', async () => {
		vi.useFakeTimers();
		f = createFixture();
		f.httpRequestService.send.mockImplementationOnce(async () => {
			await new Promise(resolve => setTimeout(resolve, 5000));
			throw Object.assign(new Error('timed out'), { name: 'AbortError' });
		});

		const first = f.service.getIceServers();
		await vi.advanceTimersByTimeAsync(5000);
		await expect(first).resolves.toBeNull();

		vi.advanceTimersByTime(60_000 - 5000);
		await expect(f.service.getIceServers()).resolves.toEqual(expectedIceServers());
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(2);
	});

	test('shares one request between joins that arrive together', async () => {
		f = createFixture();

		const results = await Promise.all([f.service.getIceServers(), f.service.getIceServers(), f.service.getIceServers()]);

		expect(results).toEqual([expectedIceServers(), expectedIceServers(), expectedIceServers()]);
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(1);
	});

	test.each([
		['an HTTP error', new StatusError('401 Unauthorized', 401, 'Unauthorized')],
		['a timeout', Object.assign(new Error(`request to https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID} failed (Bearer ${API_TOKEN})`), { name: 'AbortError' })],
	])('returns null on %s, logs it without secrets and waits a minute before asking again', async (_label, error) => {
		vi.useFakeTimers();
		f = createFixture();
		f.httpRequestService.send.mockRejectedValueOnce(error);

		await expect(f.service.getIceServers()).resolves.toBeNull();
		expect(f.logger.warn).toHaveBeenCalledTimes(1);
		const logged = JSON.stringify(f.logger.warn.mock.calls);
		expect(logged).not.toContain(API_TOKEN);
		expect(logged).not.toContain(KEY_ID);

		vi.advanceTimersByTime(59_000);
		await expect(f.service.getIceServers()).resolves.toBeNull();
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1000);
		await expect(f.service.getIceServers()).resolves.toEqual(expectedIceServers());
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(2);
	});

	test('forgets the credentials when the key changes', async () => {
		f = createFixture();
		await f.service.getIceServers();

		f.httpRequestService.send.mockResolvedValueOnce(response(cloudflareBody('new-user', 'new-credential')));
		publishMetaUpdated(f, { voiceCallCloudflareTurnKeyId: 'new-key', voiceCallCloudflareTurnApiToken: 'new-token' });

		await expect(f.service.getIceServers()).resolves.toEqual(expectedIceServers('new-user', 'new-credential'));
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(2);
		expect(f.httpRequestService.send.mock.calls[1][0]).toContain('/keys/new-key/');
		expect(f.httpRequestService.send.mock.calls[1][1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer new-token' }) });
	});

	test('forgets a failure when the key changes', async () => {
		f = createFixture();
		f.httpRequestService.send.mockRejectedValueOnce(new StatusError('401 Unauthorized', 401, 'Unauthorized'));
		await expect(f.service.getIceServers()).resolves.toBeNull();

		publishMetaUpdated(f, { voiceCallCloudflareTurnApiToken: 'fixed-token' });

		await expect(f.service.getIceServers()).resolves.toEqual(expectedIceServers());
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(2);
	});

	test('does not keep credentials for a key that changed while they were being fetched', async () => {
		f = createFixture();
		let answer!: (value: unknown) => void;
		f.httpRequestService.send.mockImplementationOnce(() => new Promise(resolve => {
			answer = resolve;
		}));

		const first = f.service.getIceServers();
		await vi.waitFor(() => expect(answer).toBeDefined());
		publishMetaUpdated(f, { voiceCallCloudflareTurnKeyId: 'new-key' });
		answer(response(cloudflareBody('old-user', 'old-credential')));
		await first;

		await expect(f.service.getIceServers()).resolves.toEqual(expectedIceServers());
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(2);
		expect(f.httpRequestService.send.mock.calls[1][0]).toContain('/keys/new-key/');
	});

	test('keeps the credentials when other settings change', async () => {
		f = createFixture();
		await f.service.getIceServers();

		publishMetaUpdated(f, { name: 'renamed' });

		await f.service.getIceServers();
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(1);
	});

	test('stops returning credentials once the key is removed', async () => {
		f = createFixture();
		await f.service.getIceServers();

		publishMetaUpdated(f, { voiceCallCloudflareTurnKeyId: null });

		await expect(f.service.getIceServers()).resolves.toBeNull();
		expect(f.httpRequestService.send).toHaveBeenCalledTimes(1);
	});
});

describe('parseIceServers (ICE servers sent by another server)', () => {
	const valid = [
		{ urls: ['stun:stun.example:3478'] },
		{ urls: ['turn:turn.example:3478?transport=udp', 'turns:turn.example:443?transport=tcp'], username: 'u', credential: 'c' },
	];

	test('keeps valid ICE servers and drops unknown properties', () => {
		expect(parseIceServers([...valid.slice(0, 1), { ...valid[1], extra: 'x' }])).toEqual(valid);
	});

	test.each([
		['missing', undefined],
		['null', null],
		['not an array', { urls: ['stun:stun.example'] }],
		['empty', []],
		['more than 4 servers', Array.from({ length: 5 }, () => valid[0])],
		['a server that is not an object', ['stun:stun.example']],
		['urls that are not an array', [{ urls: 'stun:stun.example' }]],
		['empty urls', [{ urls: [] }]],
		['more than 8 urls', [{ urls: Array.from({ length: 9 }, (_, i) => `stun:stun${i}.example`) }]],
		['a url that is not a string', [{ urls: [1] }]],
		['a url that is not STUN or TURN', [{ urls: ['https://turn.example'] }]],
		['a url with whitespace', [{ urls: ['turn:turn.example:3478 x'] }]],
		['a url that is too long', [{ urls: [`turn:${'a'.repeat(257)}`] }]],
		['a username that is not a string', [{ urls: ['turn:turn.example'], username: 1, credential: 'c' }]],
		['a username that is too long', [{ urls: ['turn:turn.example'], username: 'u'.repeat(513), credential: 'c' }]],
		['a credential that is too long', [{ urls: ['turn:turn.example'], username: 'u', credential: 'c'.repeat(513) }]],
		// ブラウザは資格情報の無い TURN を受け付けず、接続ごと失敗する
		['a TURN url without a username', [{ urls: ['turn:turn.example:3478'], credential: 'c' }]],
		['a TURNS url without a credential', [{ urls: ['turns:turn.example:443?transport=tcp'], username: 'u' }]],
		['a TURN url without any credentials', [{ urls: ['stun:stun.example:3478', 'turn:turn.example:3478'] }]],
		['a TURN url with empty credentials', [{ urls: ['turn:turn.example:3478'], username: '', credential: '' }]],
		// ブラウザは 53 番ポートを拒む
		['a STUN url on port 53', [{ urls: ['stun:stun.example:53'] }]],
		['a TURN url on port 53', [{ urls: ['turn:turn.example:53?transport=udp'], username: 'u', credential: 'c' }]],
		['an IPv6 TURN url on port 53', [{ urls: ['turns:[2001:db8::1]:053'], username: 'u', credential: 'c' }]],
		['a url with a control character', [{ urls: ['stun:stun.example\u0000:3478'] }]],
		['a url with DEL', [{ urls: ['stun:stun.example\u007f'] }]],
		['a url with non-ASCII characters', [{ urls: ['stun:例え.example:3478'] }]],
		['one invalid server among valid ones', [...valid, { urls: ['turn:turn.example:3478'] }]],
	])('treats %s as no ICE servers', (_label, value) => {
		expect(parseIceServers(value)).toBeNull();
	});

	// ICE サーバーはユーザーのブラウザが接続しに行く。他のサーバーが、ユーザーの手元や同じネットワークの機器に接続させないよう、
	// ループバック・プライベート・リンクローカル・未指定のアドレスと localhost を断る。読み方が分かれる書き方も断る
	test.each([
		['localhost', 'stun:localhost:3478'],
		['upper-case LOCALHOST', 'stun:LOCALHOST'],
		['localhost with a trailing dot', 'stun:localhost.:3478'],
		['a name under localhost', 'turn:turn.localhost:3478'],
		['an IPv4 loopback address', 'turn:127.0.0.1:3478'],
		['another IPv4 loopback address', 'stun:127.8.9.10'],
		['an IPv4 private address (10/8)', 'turns:10.1.2.3:443?transport=tcp'],
		['an IPv4 private address (172.16/12)', 'stun:172.31.255.255'],
		['an IPv4 private address (192.168/16)', 'stun:192.168.0.1:3478'],
		['a shared address (100.64/10)', 'stun:100.64.0.1'],
		['an IPv4 link-local address', 'stun:169.254.169.254'],
		['the IPv4 unspecified address', 'stun:0.0.0.0:3478'],
		['an address in 0/8', 'stun:0.1.2.3'],
		['the IPv4 broadcast address', 'stun:255.255.255.255'],
		['an IPv4 multicast address', 'stun:224.0.0.1'],
		['a decimal IPv4 address', 'stun:2130706433:3478'],
		['a hexadecimal IPv4 address', 'stun:0x7f000001'],
		['a hexadecimal IPv4 part', 'stun:0x7f.0.0.1'],
		['an octal IPv4 part', 'stun:0177.0.0.1'],
		['a leading zero in an IPv4 part', 'stun:010.0.0.1'],
		['a shortened IPv4 address', 'stun:127.1'],
		['an IPv4 address with a trailing dot', 'stun:127.0.0.1.'],
		['a public IPv4 address with a trailing dot', 'stun:8.8.8.8.'],
		['a name ending in a number', 'stun:stun.example.123'],
		['the IPv6 loopback address', 'turn:[::1]:3478'],
		['the IPv6 loopback address written out', 'stun:[0:0:0:0:0:0:0:1]'],
		['the IPv6 unspecified address', 'stun:[::]'],
		['an IPv6 link-local address', 'stun:[fe80::1]:3478'],
		['an IPv6 link-local address with a zone', 'stun:[fe80::1%25eth0]'],
		['an IPv6 unique local address', 'stun:[fd12:3456::1]'],
		['an IPv6 site-local address', 'stun:[fec0::1]'],
		['an IPv6 multicast address', 'stun:[ff02::1]'],
		['an IPv4-mapped loopback address', 'stun:[::ffff:127.0.0.1]'],
		['an IPv4-mapped private address in hex', 'turn:[::ffff:a00:1]:3478'],
		['an IPv4-mapped address in upper case', 'stun:[::FFFF:7F00:1]'],
		['an IPv4-compatible address', 'stun:[::127.0.0.1]'],
		['an IPv4-compatible public address', 'stun:[::8.8.8.8]'],
		['an IPv4-translated address', 'stun:[::ffff:0:808:808]'],
		['a NAT64 address of a loopback address', 'stun:[64:ff9b::127.0.0.1]'],
		['an IPv6 address without brackets', 'stun:::1'],
		['an unclosed bracket', 'stun:[2001:db8::1'],
		['something after the bracket', 'stun:[2001:db8::1]x:3478'],
		['a malformed IPv6 address', 'stun:[2001:db8::g]'],
		['an IPv4 address in brackets', 'stun:[8.8.8.8]'],
		['no host', 'stun::3478'],
		['user information', 'turn:user@turn.example:3478'],
		['percent-encoding', 'stun:%6Cocalhost'],
		['an underscore', 'stun:stun_1.example'],
		['an empty label', 'stun:stun..example'],
		['a port that is not a number', 'stun:stun.example:x'],
		['a port that is out of range', 'stun:stun.example:65536'],
		['port 0', 'stun:stun.example:0'],
		['an empty port', 'stun:stun.example:'],
	])('treats a url with %s as no ICE servers', (_label, url) => {
		expect(parseIceServers([{ urls: [url], username: 'u', credential: 'c' }])).toBeNull();
	});

	test.each([
		['a name', 'turn:turn.cloudflare.com:3478?transport=udp'],
		['a name in upper case', 'stun:STUN.Example:3478'],
		['a name with a trailing dot', 'stun:stun.example.:3478'],
		['a name that contains localhost', 'stun:localhost.example'],
		['a name with a numeric first label', 'stun:53.example:3478'],
		['a public IPv4 address', 'stun:8.8.8.8:3478'],
		['a public IPv6 address', 'turns:[2606:4700::6810:84e5]:443?transport=tcp'],
		['an IPv4-mapped public address', 'stun:[::ffff:8.8.8.8]'],
		['the highest port', 'stun:stun.example:65535'],
	])('accepts a url with %s', (_label, url) => {
		const servers = [{ urls: [url], username: 'u', credential: 'c' }];
		expect(parseIceServers(servers)).toEqual(servers);
	});

	test('accepts 53 when it is not the port', () => {
		const servers = [
			{ urls: ['stun:53.example:3478'] },
			{ urls: ['turn:[2001:db8::53]?transport=udp', 'turns:turn.example:5353'], username: 'u', credential: 'c' },
		];
		expect(parseIceServers(servers)).toEqual(servers);
	});

	test('accepts the largest allowed values', () => {
		const largest = Array.from({ length: 4 }, () => ({
			urls: Array.from({ length: 8 }, () => `turn:${'a'.repeat(256)}`),
			username: 'u'.repeat(512),
			credential: 'c'.repeat(512),
		}));
		expect(parseIceServers(largest)).toEqual(largest);
	});
});

describe('Cloudflare TURN setting', () => {
	function updateMetaFixture() {
		const metaService = {
			fetch: vi.fn(async () => ({})),
			update: vi.fn(async () => ({})),
		};
		const endpoint = new (UpdateMetaEndpoint as any)(
			{ resolve: async () => ({ start: vi.fn(), dispose: vi.fn() }) }, {}, metaService, { log: vi.fn() },
		);
		return { endpoint, metaService };
	}

	test('admin/update-meta stores the key id and API token trimmed', async () => {
		const { endpoint, metaService } = updateMetaFixture();

		await endpoint.exec({ voiceCallCloudflareTurnKeyId: '  key  ', voiceCallCloudflareTurnApiToken: '\ttoken\n' }, { id: 'admin' }, undefined);

		expect(metaService.update).toHaveBeenCalledWith(expect.objectContaining({ voiceCallCloudflareTurnKeyId: 'key', voiceCallCloudflareTurnApiToken: 'token' }));
	});

	test.each([[''], ['   '], [null]])('admin/update-meta clears the key id and API token given %j', async (value) => {
		const { endpoint, metaService } = updateMetaFixture();

		await endpoint.exec({ voiceCallCloudflareTurnKeyId: value, voiceCallCloudflareTurnApiToken: value }, { id: 'admin' }, undefined);

		expect(metaService.update).toHaveBeenCalledWith(expect.objectContaining({ voiceCallCloudflareTurnKeyId: null, voiceCallCloudflareTurnApiToken: null }));
	});

	test('admin/update-meta leaves them alone when they are not given', async () => {
		const { endpoint, metaService } = updateMetaFixture();

		await endpoint.exec({ enableRemoteVoiceCall: true }, { id: 'admin' }, undefined);

		const [set] = metaService.update.mock.calls[0] as unknown as [Record<string, unknown>];
		expect(set).not.toHaveProperty('voiceCallCloudflareTurnKeyId');
		expect(set).not.toHaveProperty('voiceCallCloudflareTurnApiToken');
	});

	test('admin/update-meta limits their length', async () => {
		const { endpoint, metaService } = updateMetaFixture();

		await expect(endpoint.exec({ voiceCallCloudflareTurnKeyId: 'k'.repeat(129) }, { id: 'admin' }, undefined)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		await expect(endpoint.exec({ voiceCallCloudflareTurnApiToken: 't'.repeat(513) }, { id: 'admin' }, undefined)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		// 前後の空白を除いても長すぎる
		await expect(endpoint.exec({ voiceCallCloudflareTurnKeyId: ` ${'k'.repeat(129)} ` }, { id: 'admin' }, undefined)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(metaService.update).not.toHaveBeenCalled();
	});

	test('admin/update-meta measures their length after trimming', async () => {
		const { endpoint, metaService } = updateMetaFixture();

		await endpoint.exec({ voiceCallCloudflareTurnKeyId: `  ${'k'.repeat(128)}\n`, voiceCallCloudflareTurnApiToken: `\t${'t'.repeat(512)}  ` }, { id: 'admin' }, undefined);

		expect(metaService.update).toHaveBeenCalledWith(expect.objectContaining({ voiceCallCloudflareTurnKeyId: 'k'.repeat(128), voiceCallCloudflareTurnApiToken: 't'.repeat(512) }));
	});

	test('admin/meta shows them to administrators', async () => {
		expect(adminMetaMeta.requireAdmin).toBe(true);
		expect(adminMetaMeta.res.properties.voiceCallCloudflareTurnKeyId).toMatchObject({ type: 'string', optional: false, nullable: true });
		expect(adminMetaMeta.res.properties.voiceCallCloudflareTurnApiToken).toMatchObject({ type: 'string', optional: false, nullable: true });

		const instance = { voiceCallCloudflareTurnKeyId: KEY_ID, voiceCallCloudflareTurnApiToken: API_TOKEN, policies: {} };
		const endpoint = new (AdminMetaEndpoint as any)(
			{ version: '0', url: 'https://local.test' },
			{ fetch: async () => instance },
			{ fetch: async () => ({ id: 'proxy' }) },
		);
		const result = await endpoint.exec({}, { id: 'admin' }, undefined);
		expect(result).toMatchObject({ voiceCallCloudflareTurnKeyId: KEY_ID, voiceCallCloudflareTurnApiToken: API_TOKEN });
	});

	test('the public meta does not include them', async () => {
		const ads = { where: () => ads, andWhere: () => ads, getMany: async () => [] };
		const meta = { voiceCallCloudflareTurnKeyId: KEY_ID, voiceCallCloudflareTurnApiToken: API_TOKEN, policies: {}, enableRemoteVoiceCall: true, federation: 'all', rootUserId: 'root' };
		const service = new MetaEntityService(
			{ url: 'https://local.test', version: '0' } as any,
			meta as any,
			{ createQueryBuilder: () => ads } as any,
			{ fetch: async () => ({ username: 'proxy' }) } as any,
			{ isEnabled: true } as any,
		);

		const packed = JSON.stringify([await service.pack(), await service.packDetailed()]);

		expect(packed).not.toContain('voiceCallCloudflareTurn');
		expect(packed).not.toContain(KEY_ID);
		expect(packed).not.toContain(API_TOKEN);
	});
});
