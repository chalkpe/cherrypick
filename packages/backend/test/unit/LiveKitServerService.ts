/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import Fastify from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { LiveKitService } from '@/core/LiveKitService.js';
import { LiveKitServerService } from '@/server/LiveKitServerService.js';

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

async function createApp(enabled = true) {
	const chatVoiceService = { handleWebhook: vi.fn() };
	const service = new LiveKitServerService(liveKitService(enabled), chatVoiceService as any);
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
		const service = new LiveKitServerService(liveKitService(true, livekit.url), { handleWebhook: vi.fn() } as any);
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
		const service = new LiveKitServerService(liveKitService(true, livekit.url), { handleWebhook: vi.fn() } as any);
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
		const service = new LiveKitServerService(liveKitService(true, livekit.url), { handleWebhook: vi.fn() } as any);
		const port = await frontServer(service);

		const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc/v1?access_token=bad`);
		ws.on('error', () => {});
		cleanups.push(() => ws.terminate());
		const status = await new Promise<number | undefined>(resolve => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)));

		expect(status).toBe(401);
	});

	test('answers 502 when LiveKit is unreachable during an upgrade', async () => {
		const service = new LiveKitServerService(liveKitService(true, 'http://127.0.0.1:1'), { handleWebhook: vi.fn() } as any);
		const port = await frontServer(service);

		const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc/v1?access_token=t`);
		ws.on('error', () => {});
		cleanups.push(() => ws.terminate());
		const status = await new Promise<number | undefined>(resolve => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)));

		expect(status).toBe(502);
	});

	test('refuses upgrade paths that would leave the LiveKit server', async () => {
		const livekit = await fakeLiveKit();
		const other = await forbiddenServer();
		const service = new LiveKitServerService(liveKitService(true, livekit.url), { handleWebhook: vi.fn() } as any);
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
		const service = new LiveKitServerService(liveKitService(true, `http://127.0.0.1:${redirectingPort}`), { handleWebhook: vi.fn() } as any);
		const app = Fastify();
		await app.register(service.createServer, { prefix: '/livekit' });
		cleanups.push(() => app.close());

		const res = await app.inject({ method: 'GET', url: '/livekit/rtc/v1/validate?access_token=t' });

		expect(res.body).not.toContain('secret');
		expect(other.hits).toEqual([]);
	});

	test('forwards only the headers LiveKit needs', async () => {
		const livekit = await fakeLiveKit();
		const service = new LiveKitServerService(liveKitService(true, livekit.url), { handleWebhook: vi.fn() } as any);
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
		const service = new LiveKitServerService(liveKitService(true, livekit.url), { handleWebhook: vi.fn() } as any);
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
		const service = new LiveKitServerService(liveKitService(true, livekit.url), { handleWebhook: vi.fn() } as any);
		const port = await frontServer(service);

		const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc/v1?access_token=hang`);
		ws.on('error', () => {});
		await vi.waitFor(() => expect(livekit.hungClosed).toHaveLength(1));
		ws.terminate();

		await expect(Promise.race([livekit.hungClosed[0].then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('still open'), 1000))])).resolves.toBe('closed');
	});

	test('answers 504 when LiveKit does not answer an upgrade in time', async () => {
		const livekit = await fakeLiveKit();
		const service = new LiveKitServerService(liveKitService(true, livekit.url), { handleWebhook: vi.fn() } as any);
		Object.assign(service, { upstreamTimeoutMs: 200 });
		const port = await frontServer(service);

		expect(await rawUpgradeStatus(port, '/livekit/rtc/v1?access_token=hang')).toBe(504);
	});

	test('answers 504 when LiveKit does not answer the validation request in time', async () => {
		const livekit = await fakeLiveKit();
		const service = new LiveKitServerService(liveKitService(true, livekit.url), { handleWebhook: vi.fn() } as any);
		Object.assign(service, { upstreamTimeoutMs: 200 });
		const app = Fastify();
		await app.register(service.createServer, { prefix: '/livekit' });
		cleanups.push(() => app.close());

		const res = await app.inject({ method: 'GET', url: '/livekit/rtc/v1/validate?access_token=hang' });

		expect(res.statusCode).toBe(504);
	});

	test('only claims /livekit/ paths while voice calls are enabled', () => {
		const enabled = new LiveKitServerService(liveKitService(true), { handleWebhook: vi.fn() } as any);
		const disabled = new LiveKitServerService(liveKitService(false), { handleWebhook: vi.fn() } as any);

		expect(enabled.handles({ url: '/livekit/rtc/v1' } as http.IncomingMessage)).toBe(true);
		expect(enabled.handles({ url: '/streaming' } as http.IncomingMessage)).toBe(false);
		expect(enabled.handles({ url: '/livekitx/rtc' } as http.IncomingMessage)).toBe(false);
		expect(disabled.handles({ url: '/livekit/rtc/v1' } as http.IncomingMessage)).toBe(false);
	});
});
