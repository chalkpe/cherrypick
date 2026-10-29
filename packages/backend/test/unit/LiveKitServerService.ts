/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as http from 'node:http';
import { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import Fastify from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { LiveKitService } from '@/core/LiveKitService.js';
import { LiveKitServerService } from '@/server/LiveKitServerService.js';
import { getIpHash } from '@/misc/get-ip-hash.js';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { ApSignedRequestVerifierService } from '@/core/activitypub/ApSignedRequestVerifierService.js';

const SECRET = 'a'.repeat(32);
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function liveKitService(enabled = true, internalUrl = 'http://127.0.0.1:1') {
	const service = new LiveKitService({
		url: 'https://local.test',
		voiceCall: enabled ? { livekit: { internalUrl, apiKey: 'key', apiSecret: SECRET } } : undefined,
	} as any);
	return service;
}

const CONFIG = { url: 'https://local.test', host: 'local.test', enableIpRateLimit: false };

function createService(liveKit: LiveKitService, deps: {
	config?: object;
	chatVoiceService?: object;
	verifier?: object;
	rateLimiterService?: object;
} = {}) {
	return new LiveKitServerService(
		(deps.config ?? CONFIG) as any,
		liveKit,
		(deps.chatVoiceService ?? { handleWebhook: vi.fn() }) as any,
		(deps.verifier ?? { verify: vi.fn() }) as any,
		(deps.rateLimiterService ?? { limit: vi.fn(async () => null) }) as any,
	);
}

async function createApp(enabled = true) {
	const chatVoiceService = { handleWebhook: vi.fn() };
	const service = createService(liveKitService(enabled), { chatVoiceService });
	const app = Fastify();
	await app.register(service.createServer, { prefix: '/livekit' });
	await app.ready();
	cleanups.push(() => app.close());
	return { app, chatVoiceService };
}

async function sign(body: string) {
	const at = new AccessToken('key', SECRET);
	at.sha256 = createHash('sha256').update(body).digest('base64');
	return await at.toJwt();
}

async function listen(server: http.Server): Promise<number> {
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
	return (server.address() as AddressInfo).port;
}

/**
 * 偽の LiveKit: WebSocket はエコー、HTTP の validate は 200 を返す。
 * access_token で挙動を切り替える (bad: 401, chunked: chunked な 401, hang: 応答しない)。
 */
async function fakeLiveKit() {
	const paths: string[] = [];
	const headers: http.IncomingHttpHeaders[] = [];
	const hungClosed: Promise<void>[] = [];
	const hungSockets: { destroy: () => void }[] = [];
	cleanups.push(() => {
		for (const socket of hungSockets) socket.destroy();
	});
	const server = http.createServer((req, res) => {
		paths.push(req.url ?? '');
		if (req.url?.includes('access_token=hang')) return;
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('valid');
	});
	const wss = new WebSocketServer({ noServer: true });
	server.on('upgrade', (req, socket, head) => {
		paths.push(req.url ?? '');
		headers.push(req.headers);
		if (req.url?.includes('access_token=bad')) {
			socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
			return;
		}
		if (req.url?.includes('access_token=chunked')) {
			socket.end('HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n6\r\ndenied\r\n0\r\n\r\n');
			return;
		}
		if (req.url?.includes('access_token=hang')) {
			// 応答しない LiveKit。相手が切ったことに気付けるよう読み進める
			hungClosed.push(new Promise(resolve => socket.on('close', () => resolve())));
			socket.on('end', () => socket.destroy());
			socket.on('error', () => {});
			socket.resume();
			hungSockets.push(socket);
			return;
		}
		wss.handleUpgrade(req, socket, head, ws => ws.on('message', data => ws.send(data.toString())));
	});
	cleanups.push(() => {
		for (const client of wss.clients) client.terminate();
		wss.close();
	});
	const port = await listen(server);
	return { paths, headers, hungClosed, url: `http://127.0.0.1:${port}` };
}

/** プロキシ経由で届いてはいけないサーバー */
async function forbiddenServer() {
	const hits: string[] = [];
	const server = http.createServer((req, res) => {
		hits.push(req.url ?? '');
		res.end('secret');
	});
	server.on('upgrade', (req, socket) => {
		hits.push(req.url ?? '');
		socket.end('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecret');
	});
	const port = await listen(server);
	return { hits, port };
}

/** 生のアップグレード要求を送り、返ってきた状態コードを返す (WebSocket クライアントは URL を正規化してしまうため) */
function rawUpgradeStatus(port: number, path: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: '127.0.0.1', port, path, method: 'GET',
			headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
		});
		req.on('upgrade', (res, socket) => {
			socket.destroy();
			resolve(res.statusCode ?? 0);
		});
		req.on('response', res => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on('error', reject);
		req.end();
	});
}

async function frontServer(service: LiveKitServerService) {
	const server = http.createServer((req, res) => {
		res.writeHead(404);
		res.end();
	});
	server.on('upgrade', (req, socket, head) => {
		if (service.handles(req)) service.handleUpgrade(req, socket, head);
		else socket.destroy();
	});
	return await listen(server);
}

const REMOTE_USER = { id: 'ru1', host: 'remote.test', uri: 'https://remote.test/users/ru1' };
const ROOM_URI = 'https://local.test/chat/rooms/r1';
const RATE_LIMITED = { code: 'RATE_LIMIT_EXCEEDED', info: { remaining: 0 } };

/** 署名の検証と通話サービスを偽物にしたトークン経路 */
async function createTokenApp(opts: { enabled?: boolean; signer?: object | null; enableIpRateLimit?: boolean; verifier?: object } = {}) {
	// このサーバーにあるルームは r1 だけ
	const chatVoiceService = {
		handleWebhook: vi.fn(),
		issueRemoteJoinToken: vi.fn(async (_user: object, roomId: string, _canScreenShare: boolean): Promise<object | 'forbidden'> => roomId === 'r1' ? {
			url: 'https://local.test/livekit',
			token: 'jwt',
			participants: [{ identity: 'https://local.test/users/u1', screenSharing: true }],
			updatedAt: 1234,
		} : 'forbidden'),
	};
	const verifier = { verify: vi.fn(async () => opts.signer === undefined ? REMOTE_USER : opts.signer) };
	const rateLimiterService = { limit: vi.fn(async (_limitation: { key: string }, _actor: string): Promise<object | null> => null) };
	const service = createService(liveKitService(opts.enabled ?? true), {
		config: { ...CONFIG, enableIpRateLimit: opts.enableIpRateLimit ?? false },
		chatVoiceService,
		verifier: opts.verifier ?? verifier,
		rateLimiterService,
	});
	const app = Fastify();
	await app.register(service.createServer, { prefix: '/livekit' });
	await app.ready();
	cleanups.push(() => app.close());
	return { app, chatVoiceService, verifier, rateLimiterService };
}

const SIGNED_HEADERS = {
	host: 'local.test',
	date: new Date().toUTCString(),
	digest: 'SHA-256=x',
	signature: 'keyId="https://remote.test/users/ru1#main-key",algorithm="rsa-sha256",headers="(request-target) date host digest",signature="x"',
};

function requestToken(app: Awaited<ReturnType<typeof createTokenApp>>['app'], body: string | object = { room: ROOM_URI, canScreenShare: true }, headers: Record<string, string> = SIGNED_HEADERS) {
	return app.inject({
		method: 'POST',
		url: '/livekit/federation/token',
		headers: { 'content-type': 'application/activity+json', ...headers },
		payload: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

describe('LiveKitServerService', () => {
	test('accepts a correctly signed webhook and hands it to the voice service', async () => {
		const { app, chatVoiceService } = await createApp();
		const body = JSON.stringify({ event: 'participant_joined', room: { name: 'chatRoom:r1' } });

		const res = await app.inject({ method: 'POST', url: '/livekit/webhook', headers: { 'content-type': 'application/webhook+json', authorization: await sign(body) }, payload: body });

		expect(res.statusCode).toBe(204);
		expect(chatVoiceService.handleWebhook).toHaveBeenCalledWith(expect.objectContaining({ event: 'participant_joined' }));
	});

	test('rejects a webhook whose body does not match its signature', async () => {
		const { app, chatVoiceService } = await createApp();
		const signedBody = JSON.stringify({ event: 'participant_joined', room: { name: 'chatRoom:r1' } });
		const sentBody = JSON.stringify({ event: 'participant_left', room: { name: 'chatRoom:r1' } });

		const res = await app.inject({ method: 'POST', url: '/livekit/webhook', headers: { 'content-type': 'application/webhook+json', authorization: await sign(signedBody) }, payload: sentBody });

		expect(res.statusCode).toBe(401);
		expect(chatVoiceService.handleWebhook).not.toHaveBeenCalled();
	});

	test('returns 404 for webhooks when voice calls are disabled', async () => {
		const { app, chatVoiceService } = await createApp(false);
		const body = JSON.stringify({ event: 'participant_joined' });

		const res = await app.inject({ method: 'POST', url: '/livekit/webhook', headers: { 'content-type': 'application/webhook+json', authorization: 'x' }, payload: body });

		expect(res.statusCode).toBe(404);
		expect(chatVoiceService.handleWebhook).not.toHaveBeenCalled();
	});

	test('proxies the connection validation request to LiveKit', async () => {
		const livekit = await fakeLiveKit();
		const service = createService(liveKitService(true, livekit.url));
		const app = Fastify();
		await app.register(service.createServer, { prefix: '/livekit' });
		cleanups.push(() => app.close());

		const res = await app.inject({ method: 'GET', url: '/livekit/rtc/v1/validate?access_token=t' });

		expect(res.statusCode).toBe(200);
		expect(res.body).toBe('valid');
		expect(livekit.paths).toEqual(['/rtc/v1/validate?access_token=t']);
	});

	test('proxies a WebSocket upgrade to LiveKit without the /livekit prefix', async () => {
		const livekit = await fakeLiveKit();
		const service = createService(liveKitService(true, livekit.url));
		const port = await frontServer(service);

		const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc/v1?access_token=t`);
		cleanups.push(() => ws.terminate());
		const reply = await new Promise<string>((resolve, reject) => {
			ws.on('open', () => ws.send('ping'));
			ws.on('message', data => resolve(data.toString()));
			ws.on('error', reject);
		});

		expect(reply).toBe('ping');
		expect(livekit.paths).toEqual(['/rtc/v1?access_token=t']);
	});

	test('passes a refused upgrade through with its status', async () => {
		const livekit = await fakeLiveKit();
		const service = createService(liveKitService(true, livekit.url));
		const port = await frontServer(service);

		const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc/v1?access_token=bad`);
		ws.on('error', () => {});
		cleanups.push(() => ws.terminate());
		const status = await new Promise<number | undefined>(resolve => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)));

		expect(status).toBe(401);
	});

	test('answers 502 when LiveKit is unreachable during an upgrade', async () => {
		const service = createService(liveKitService(true, 'http://127.0.0.1:1'));
		const port = await frontServer(service);

		const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc/v1?access_token=t`);
		ws.on('error', () => {});
		cleanups.push(() => ws.terminate());
		const status = await new Promise<number | undefined>(resolve => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)));

		expect(status).toBe(502);
	});

	test.each([
		'/livekit/rtc/..%2f..%2ftwirp/livekit.RoomService/ListRooms',
		'/livekit/rtc/%5cadmin', '/livekit/rtc/../rtc/v1',
		'/livekit/rtc/%2e%2e/rtc/v1', '/livekit/rtc/%252fadmin',
		'/livekit/rtc/\\admin',
	])('rejects ambiguous RTC path before upstream: %s', async path => {
		const livekit = await fakeLiveKit();
		const port = await frontServer(createService(liveKitService(true, livekit.url)));
		expect(await rawUpgradeStatus(port, path)).toBe(404);
		expect(livekit.paths).toEqual([]);
	});

	test.each(['head', 'chunks', 'timeout', 'refusal'])('cleans pre-upgrade buffers and closes the client on %s', async mode => {
		const livekit = await fakeLiveKit();
		const service = createService(liveKitService(true, livekit.url));
		service.upstreamTimeoutMs = 20;
		const writes: Buffer[] = [];
		const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { writes.push(Buffer.from(chunk)); done(); } });
		cleanups.push(() => { socket.destroy(); });
		service.handleUpgrade({ url: `/livekit/rtc/v1?access_token=${mode === 'refusal' ? 'bad' : 'hang'}`, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } } as http.IncomingMessage,
			socket, Buffer.alloc(mode === 'head' ? 65 * 1024 : 32 * 1024));
		if (mode === 'chunks') {
			socket.emit('data', Buffer.alloc(16 * 1024));
			socket.emit('data', Buffer.alloc(17 * 1024));
		}
		await vi.waitFor(() => expect(socket.destroyed).toBe(true));
		expect(socket.listenerCount('data')).toBe(0);
		expect(socket.listenerCount('end')).toBe(0);
		const count = writes.length;
		socket.emit('data', Buffer.alloc(1024));
		expect(writes).toHaveLength(count);
	});

	test.each(['timeout', 'head', 'chunks', 'refusal', 'path', 'upgrade'])('keeps socket error ownership through an EPIPE response write (%s)', async mode => {
		const livekit = await fakeLiveKit();
		const service = createService(liveKitService(true, livekit.url));
		service.upstreamTimeoutMs = 20;
		const missingHandler: string[] = [];
		let writes = 0;
		const socket = new Duplex({
			read() {},
			write(_chunk, _encoding, done) {
				writes++;
				if (socket.listenerCount('error') === 0) {
					missingHandler.push(mode);
					// RED でもテストプロセスを落とさず、実際の Duplex の EPIPE を観測する。
					socket.once('error', () => {});
				}
				done(Object.assign(new Error('simulated peer reset'), { code: 'EPIPE' }));
			},
		});
		cleanups.push(() => { socket.destroy(); });
		service.handleUpgrade({ url: mode === 'path' ? '/livekit/invalid' : `/livekit/rtc/v1?access_token=${mode === 'refusal' ? 'bad' : mode === 'upgrade' ? 't' : 'hang'}`, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } } as http.IncomingMessage,
			socket, Buffer.alloc(mode === 'head' ? 65 * 1024 : mode === 'upgrade' ? 0 : 32 * 1024));
		if (mode === 'chunks') socket.emit('data', Buffer.alloc(33 * 1024));
		await vi.waitFor(() => expect(socket.closed).toBe(true));
		expect(writes).toBeGreaterThan(0);
		expect(missingHandler).toEqual([]);
		expect(socket.listenerCount('data')).toBe(0);
		expect(socket.listenerCount('end')).toBe(0);
	});

	test('refuses upgrade paths that would leave the LiveKit server', async () => {
		const livekit = await fakeLiveKit();
		const other = await forbiddenServer();
		const service = createService(liveKitService(true, livekit.url));
		const port = await frontServer(service);

		for (const path of [`/livekit//127.0.0.1:${other.port}/secret`, `/livekit/\\127.0.0.1:${other.port}/secret`, '/livekit/other/path']) {
			expect(await rawUpgradeStatus(port, path)).toBe(404);
		}
		expect(other.hits).toEqual([]);
		expect(livekit.paths).toEqual([]);
	});

	test('does not follow redirects from LiveKit on the validation route', async () => {
		const other = await forbiddenServer();
		const redirecting = http.createServer((_req, res) => {
			res.writeHead(302, { location: `http://127.0.0.1:${other.port}/secret` });
			res.end();
		});
		const redirectingPort = await listen(redirecting);
		const service = createService(liveKitService(true, `http://127.0.0.1:${redirectingPort}`));
		const app = Fastify();
		await app.register(service.createServer, { prefix: '/livekit' });
		cleanups.push(() => app.close());

		const res = await app.inject({ method: 'GET', url: '/livekit/rtc/v1/validate?access_token=t' });

		expect(res.body).not.toContain('secret');
		expect(other.hits).toEqual([]);
	});

	test('forwards only the headers LiveKit needs', async () => {
		const livekit = await fakeLiveKit();
		const service = createService(liveKitService(true, livekit.url));
		const port = await frontServer(service);

		const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc/v1?access_token=t`, { headers: { cookie: 'token=secret', authorization: 'Bearer lk' } });
		cleanups.push(() => ws.terminate());
		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});

		expect(livekit.headers[0].cookie).toBeUndefined();
		expect(livekit.headers[0].authorization).toBe('Bearer lk');
		expect(livekit.headers[0]['sec-websocket-key']).toBeTruthy();
	});

	test('passes a chunked refusal through in a form the client can read', async () => {
		const livekit = await fakeLiveKit();
		const service = createService(liveKitService(true, livekit.url));
		const port = await frontServer(service);

		const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc/v1?access_token=chunked`);
		ws.on('error', () => {});
		cleanups.push(() => ws.terminate());
		const [status, body] = await new Promise<[number | undefined, string]>(resolve => ws.on('unexpected-response', (_req, res) => {
			let text = '';
			res.on('data', chunk => text += chunk);
			res.on('end', () => resolve([res.statusCode, text]));
		}));

		expect(status).toBe(401);
		expect(body).toBe('denied');
	});

	test('drops the upstream request when the client gives up first', async () => {
		const livekit = await fakeLiveKit();
		const service = createService(liveKitService(true, livekit.url));
		const port = await frontServer(service);

		const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc/v1?access_token=hang`);
		ws.on('error', () => {});
		await vi.waitFor(() => expect(livekit.hungClosed).toHaveLength(1));
		ws.terminate();

		await expect(Promise.race([livekit.hungClosed[0].then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('still open'), 1000))])).resolves.toBe('closed');
	});

	test('answers 504 when LiveKit does not answer an upgrade in time', async () => {
		const livekit = await fakeLiveKit();
		const service = createService(liveKitService(true, livekit.url));
		Object.assign(service, { upstreamTimeoutMs: 200 });
		const port = await frontServer(service);

		expect(await rawUpgradeStatus(port, '/livekit/rtc/v1?access_token=hang')).toBe(504);
	});

	test('answers 504 when LiveKit does not answer the validation request in time', async () => {
		const livekit = await fakeLiveKit();
		const service = createService(liveKitService(true, livekit.url));
		Object.assign(service, { upstreamTimeoutMs: 200 });
		const app = Fastify();
		await app.register(service.createServer, { prefix: '/livekit' });
		cleanups.push(() => app.close());

		const res = await app.inject({ method: 'GET', url: '/livekit/rtc/v1/validate?access_token=hang' });

		expect(res.statusCode).toBe(504);
	});

	test('only claims /livekit/ paths while voice calls are enabled', () => {
		const enabled = createService(liveKitService(true));
		const disabled = createService(liveKitService(false));

		expect(enabled.handles({ url: '/livekit/rtc/v1' } as http.IncomingMessage)).toBe(true);
		expect(enabled.handles({ url: '/streaming' } as http.IncomingMessage)).toBe(false);
		expect(enabled.handles({ url: '/livekitx/rtc' } as http.IncomingMessage)).toBe(false);
		expect(disabled.handles({ url: '/livekit/rtc/v1' } as http.IncomingMessage)).toBe(false);
	});

	describe('federation token', () => {
		test('answers 401 to an unsigned token request', async () => {
			const { app, verifier, chatVoiceService } = await createTokenApp({ signer: null });
			const { signature: _, ...unsigned } = SIGNED_HEADERS;

			const res = await requestToken(app, undefined, unsigned);

			expect(res.statusCode).toBe(401);
			expect(verifier.verify).toHaveBeenCalled();
			expect(chatVoiceService.issueRemoteJoinToken).not.toHaveBeenCalled();
		});

		test('answers 403 for a room URI on another server', async () => {
			const { app, chatVoiceService } = await createTokenApp();

			for (const room of [
				'https://other.test/chat/rooms/r1',
				'https://local.test.other.test/chat/rooms/r1',
				'http://local.test/chat/rooms/r1',
				'https://local.test/chat/rooms/r1/voice',
				'https://local.test/chat/rooms/r1?x=1',
				'https://local.test/chat/rooms/',
				'https://local.test/users/r1',
			]) {
				const res = await requestToken(app, { room, canScreenShare: false });
				expect(res.statusCode, room).toBe(403);
				expect(res.body, room).toBe('');
			}
			expect(chatVoiceService.issueRemoteJoinToken).not.toHaveBeenCalled();
		});

		test('answers 403 for a room that does not exist', async () => {
			const { app, chatVoiceService } = await createTokenApp();

			const res = await requestToken(app, { room: 'https://local.test/chat/rooms/gone', canScreenShare: false });

			expect(res.statusCode).toBe(403);
			// ルームがあるかどうかは、メンバーかどうかなどと一緒に通話サービスが確かめる
			expect(chatVoiceService.issueRemoteJoinToken).toHaveBeenCalledWith(REMOTE_USER, 'gone', false);
		});

		test('answers 403 when the voice service refuses', async () => {
			const { app, chatVoiceService } = await createTokenApp();
			chatVoiceService.issueRemoteJoinToken.mockResolvedValue('forbidden');

			const res = await requestToken(app);

			expect(res.statusCode).toBe(403);
		});

		test('answers a missing room exactly like a room the caller may not use', async () => {
			const { app, chatVoiceService } = await createTokenApp();

			const missing = await requestToken(app, { room: 'https://local.test/chat/rooms/gone', canScreenShare: false });
			chatVoiceService.issueRemoteJoinToken.mockResolvedValue('forbidden');
			const refused = await requestToken(app, { room: ROOM_URI, canScreenShare: false });

			expect(chatVoiceService.issueRemoteJoinToken).toHaveBeenCalledTimes(2);
			expect(missing.statusCode).toBe(403);
			expect([missing.statusCode, missing.body, missing.headers['content-type'], missing.headers['content-length']])
				.toEqual([refused.statusCode, refused.body, refused.headers['content-type'], refused.headers['content-length']]);
		});

		test('answers 500 with an empty body when something fails inside', async () => {
			const { app, verifier, chatVoiceService } = await createTokenApp();

			chatVoiceService.issueRemoteJoinToken.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:7880'));
			const liveKitDown = await requestToken(app);
			expect(liveKitDown.statusCode).toBe(500);
			expect(liveKitDown.body).toBe('');

			verifier.verify.mockRejectedValueOnce(new Error('relation "user_publickey" does not exist'));
			const databaseDown = await requestToken(app);
			expect(databaseDown.statusCode).toBe(500);
			expect(databaseDown.body).toBe('');
		});

		test('returns the token and participants for a valid request', async () => {
			const { app, verifier, chatVoiceService } = await createTokenApp();
			const body = JSON.stringify({ room: ROOM_URI, canScreenShare: true });

			const res = await requestToken(app, body);

			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({
				url: 'https://local.test/livekit',
				token: 'jwt',
				participants: [{ identity: 'https://local.test/users/u1', screenSharing: true }],
				updatedAt: 1234,
			});
			expect(verifier.verify).toHaveBeenCalledWith(
				expect.objectContaining({ method: 'POST', url: '/livekit/federation/token', headers: expect.objectContaining({ host: 'local.test', signature: SIGNED_HEADERS.signature }) }),
				body,
			);
			expect(chatVoiceService.issueRemoteJoinToken).toHaveBeenCalledWith(REMOTE_USER, 'r1', true);
		});

		test('includes this server\'s TURN servers in the token response', async () => {
			const { app, chatVoiceService } = await createTokenApp();
			const iceServers = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }];
			chatVoiceService.issueRemoteJoinToken.mockResolvedValueOnce({
				url: 'https://local.test/livekit',
				token: 'jwt',
				iceServers,
				participants: [],
				updatedAt: 1234,
			});

			const res = await requestToken(app);

			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ url: 'https://local.test/livekit', token: 'jwt', iceServers, participants: [], updatedAt: 1234 });
		});

		test('answers null TURN servers when none are configured', async () => {
			const { app, chatVoiceService } = await createTokenApp();
			chatVoiceService.issueRemoteJoinToken.mockResolvedValueOnce({ url: 'https://local.test/livekit', token: 'jwt', iceServers: null, participants: [], updatedAt: 1234 });

			const res = await requestToken(app);

			expect(res.json()).toEqual({ url: 'https://local.test/livekit', token: 'jwt', iceServers: null, participants: [], updatedAt: 1234 });
		});

		test('accepts a request signed the way member servers sign it', async () => {
			const { publicKey, privateKey } = generateKeyPairSync('rsa', {
				modulusLength: 2048,
				publicKeyEncoding: { type: 'spki', format: 'pem' },
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			});
			const keyId = 'https://remote.test/users/ru1#main-key';
			const verifier = new ApSignedRequestVerifierService(
				CONFIG as any,
				{ findOneBy: vi.fn(async () => ({ keyId, userId: REMOTE_USER.id, keyPem: publicKey })) } as any,
				{ findOneBy: vi.fn(async () => ({ ...REMOTE_USER, isDeleted: false })) } as any,
				{ getLogger: () => ({ debug: vi.fn() }) } as any,
			);
			const { app, chatVoiceService } = await createTokenApp({ verifier });
			const body = JSON.stringify({ room: ROOM_URI, canScreenShare: false });
			const signed = await ApRequestCreator.createSignedPost({ key: { keyId, privateKeyPem: privateKey }, url: 'https://local.test/livekit/federation/token', body, additionalHeaders: {} });

			// 送る側の HTTP クライアントは Host を URL から付ける (署名後のヘッダーには残らない)
			const res = await app.inject({ method: 'POST', url: '/livekit/federation/token', headers: { ...signed.request.headers, host: 'local.test' }, payload: body });

			expect(res.statusCode).toBe(200);
			expect(chatVoiceService.issueRemoteJoinToken).toHaveBeenCalledWith(expect.objectContaining({ id: REMOTE_USER.id }), 'r1', false);
		});

		test('answers 404 to token requests when voice calls are disabled', async () => {
			const { app, verifier } = await createTokenApp({ enabled: false });

			const res = await requestToken(app);

			expect(res.statusCode).toBe(404);
			expect(verifier.verify).not.toHaveBeenCalled();
		});

		test('answers 404 when voice calls are disabled before looking at the body\'s size or type', async () => {
			const { app, verifier } = await createTokenApp({ enabled: false });

			const oversizedToken = await requestToken(app, { room: ROOM_URI, canScreenShare: false, padding: 'x'.repeat(16 * 1024) });
			const unknownTypeToken = await app.inject({ method: 'POST', url: '/livekit/federation/token', headers: { ...SIGNED_HEADERS, 'content-type': 'application/xml' }, payload: '<x/>' });
			const oversizedWebhook = await app.inject({ method: 'POST', url: '/livekit/webhook', headers: { 'content-type': 'application/webhook+json' }, payload: 'x'.repeat(1024 * 1024 + 1) });
			const unknownTypeWebhook = await app.inject({ method: 'POST', url: '/livekit/webhook', headers: { 'content-type': 'text/plain' }, payload: 'x' });
			const validation = await app.inject({ method: 'GET', url: '/livekit/rtc/v1/validate?access_token=x' });

			expect([oversizedToken, unknownTypeToken, oversizedWebhook, unknownTypeWebhook, validation].map(res => [res.statusCode, res.body])).toEqual([
				[404, ''], [404, ''], [404, ''], [404, ''], [404, ''],
			]);
			expect(verifier.verify).not.toHaveBeenCalled();
		});

		test('keeps the 404 for disabled voice calls inside /livekit', async () => {
			const app = Fastify();
			await app.register(createService(liveKitService(false)).createServer, { prefix: '/livekit' });
			app.post('/api/ping', async () => ({ ok: true }));
			await app.ready();
			cleanups.push(() => app.close());

			const res = await app.inject({ method: 'POST', url: '/api/ping', payload: { x: 1 } });

			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ ok: true });
		});

		test('still refuses an unknown body type with 415 while voice calls are enabled', async () => {
			const { app, verifier } = await createTokenApp();

			const res = await app.inject({ method: 'POST', url: '/livekit/federation/token', headers: { ...SIGNED_HEADERS, 'content-type': 'application/xml' }, payload: '<x/>' });

			expect(res.statusCode).toBe(415);
			expect(verifier.verify).not.toHaveBeenCalled();
		});

		test('answers 400 to a verified request whose body is not a token request', async () => {
			const { app, chatVoiceService } = await createTokenApp();

			for (const body of [
				'not json',
				'null',
				'[]',
				'"text"',
				JSON.stringify({ room: 1, canScreenShare: false }),
				JSON.stringify({ room: ROOM_URI, canScreenShare: 'yes' }),
				JSON.stringify({ room: ROOM_URI }),
			]) {
				const res = await requestToken(app, body);
				expect(res.statusCode, body).toBe(400);
			}
			expect(chatVoiceService.issueRemoteJoinToken).not.toHaveBeenCalled();
		});

		test('refuses token request bodies over 16 KiB before checking them', async () => {
			const { app, verifier } = await createTokenApp();

			const res = await requestToken(app, { room: ROOM_URI, canScreenShare: false, padding: 'x'.repeat(16 * 1024) });

			expect(res.statusCode).toBe(413);
			expect(verifier.verify).not.toHaveBeenCalled();
		});

		test('limits token requests per IP before checking the signature', async () => {
			const { app, verifier, rateLimiterService } = await createTokenApp({ enableIpRateLimit: true });
			rateLimiterService.limit.mockImplementation(async limitation => limitation.key === 'voiceFederationTokenIp' ? RATE_LIMITED : null);

			const res = await requestToken(app);

			expect(res.statusCode).toBe(429);
			expect(rateLimiterService.limit).toHaveBeenCalledWith({ key: 'voiceFederationTokenIp', duration: 60_000, max: 60 }, getIpHash('127.0.0.1'));
			expect(verifier.verify).not.toHaveBeenCalled();
		});

		test('limits token requests per remote user after verification', async () => {
			const { app, verifier, chatVoiceService, rateLimiterService } = await createTokenApp();
			rateLimiterService.limit.mockImplementation(async limitation => limitation.key === 'voiceFederationToken' ? RATE_LIMITED : null);

			const res = await requestToken(app);

			expect(res.statusCode).toBe(429);
			expect(verifier.verify).toHaveBeenCalled();
			// IP での制限が無効なら、制限はユーザー単位の一回だけ
			expect(rateLimiterService.limit.mock.calls).toEqual([[{ key: 'voiceFederationToken', duration: 60_000, max: 30 }, 'ru1']]);
			expect(chatVoiceService.issueRemoteJoinToken).not.toHaveBeenCalled();
		});
	});
});

describe('federated reported voice status', () => {
	test('requires a verified user and passes that user to the status service', async () => {
		const user = { id: 'remote-user' };
		const verifier = { verify: vi.fn().mockResolvedValue(null) };
		const chatVoiceService = { reportStatus: vi.fn().mockResolvedValue(true) };
		const service = createService(liveKitService(), { verifier, chatVoiceService });
		const app = Fastify();
		await app.register(service.createServer, { prefix: '/livekit' });
		cleanups.push(() => app.close());
		const payload = { room: 'https://local.test/chat/rooms/r1', sessionId: 'PA_1', micMuted: true, deafened: false };
		expect((await app.inject({ method: 'POST', url: '/livekit/federation/status', payload })).statusCode).toBe(401);
		expect(chatVoiceService.reportStatus).not.toHaveBeenCalled();
		verifier.verify.mockResolvedValue(user as never);
		expect((await app.inject({ method: 'POST', url: '/livekit/federation/status', payload })).statusCode).toBe(200);
		expect(chatVoiceService.reportStatus).toHaveBeenCalledWith(user, 'r1', 'PA_1', { micMuted: true, deafened: false });
		chatVoiceService.reportStatus.mockResolvedValue(false);
		expect((await app.inject({ method: 'POST', url: '/livekit/federation/status', payload })).statusCode).toBe(403);
		expect((await app.inject({ method: 'POST', url: '/livekit/federation/status', payload: { ...payload, micMuted: 'true' } })).statusCode).toBe(400);
	});

	// 一台のサーバーがそのユーザー全員の報告を同じ IP から送ってくる。トークン発行と同じ IP の予算では、数人が切り替えるだけで足りなくなる
	test('limits status reports per IP with room for every user of a server', async () => {
		const user = { id: 'remote-user' };
		const verifier = { verify: vi.fn().mockResolvedValue(user) };
		const chatVoiceService = { reportStatus: vi.fn().mockResolvedValue(true) };
		const rateLimiterService = { limit: vi.fn(async (limitation: { key: string }) => limitation.key === 'voiceFederationStatusIp' ? RATE_LIMITED : null) };
		const service = createService(liveKitService(), { config: { ...CONFIG, enableIpRateLimit: true }, verifier, chatVoiceService, rateLimiterService });
		const app = Fastify();
		await app.register(service.createServer, { prefix: '/livekit' });
		cleanups.push(() => app.close());

		const res = await app.inject({ method: 'POST', url: '/livekit/federation/status', payload: { room: 'https://local.test/chat/rooms/r1', sessionId: 'PA_1', micMuted: true, deafened: false } });

		expect(res.statusCode).toBe(429);
		expect(verifier.verify).not.toHaveBeenCalled();
		expect(rateLimiterService.limit).toHaveBeenCalledWith({ key: 'voiceFederationStatusIp', duration: 60_000, max: 600 }, getIpHash('127.0.0.1'));
	});

	test('limits status reports per remote user', async () => {
		const user = { id: 'remote-user' };
		const verifier = { verify: vi.fn().mockResolvedValue(user) };
		const chatVoiceService = { reportStatus: vi.fn().mockResolvedValue(true) };
		const rateLimiterService = { limit: vi.fn(async () => null) };
		const service = createService(liveKitService(), { verifier, chatVoiceService, rateLimiterService });
		const app = Fastify();
		await app.register(service.createServer, { prefix: '/livekit' });
		cleanups.push(() => app.close());

		const res = await app.inject({ method: 'POST', url: '/livekit/federation/status', payload: { room: 'https://local.test/chat/rooms/r1', sessionId: 'PA_1', micMuted: true, deafened: false } });

		expect(res.statusCode).toBe(200);
		expect(rateLimiterService.limit).toHaveBeenCalledWith({ key: 'voiceFederationStatus', duration: 60_000, max: 30 }, user.id);
	});
});
