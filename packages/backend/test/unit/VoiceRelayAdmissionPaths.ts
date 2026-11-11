/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { DataSource } from 'typeorm';
import Fastify from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { describe, expect, test, vi } from 'vitest';
import { VoiceRelayStorage } from '@/core/VoiceRelayStorage.js';
import { VoiceBackendService } from '@/core/VoiceBackendService.js';
import { LiveKitServerService } from '@/server/LiveKitServerService.js';
import * as admission from '@/core/voice-relay/admission.js';
import type { AddressInfo } from 'node:net';

/** Token-generation storage is mocked here; its locking is tested against real PG separately. */
function directDatabase() {
 const rows = new Map<string, string>();
 return { driver: { master: { options: { max: 100 } } }, createQueryRunner: () => ({
  connect: async () => {}, release: async () => {},
  query: async (sql: string, values: string[]) => {
   const key = `${values?.[0]}:${values?.[1]}`;
   if (sql.startsWith('INSERT INTO voice_token_generation') && !rows.has(key)) rows.set(key, values[2]);
   if (sql.startsWith('SELECT generation')) return rows.has(key) ? [{ generation: rows.get(key) }] : [];
   return [];
  },
 }) } as any;
}

const ROOM_MAX_PARTICIPANTS = 10;

/** LiveKit의 RoomService(ListRooms) Twirp JSON 계약대로 요청한 이름의 방을 돌려준다. */
function serveListRooms(request: http.IncomingMessage, response: http.ServerResponse, requests: string[][]): boolean {
 if (request.method !== 'POST' || request.url !== '/twirp/livekit.RoomService/ListRooms') return false;
 const chunks: Buffer[] = [];
 request.on('data', chunk => chunks.push(Buffer.from(chunk)));
 request.on('end', () => {
  const { names = [] } = JSON.parse(Buffer.concat(chunks).toString()) as { names?: string[] };
  requests.push(names);
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ rooms: names.map(name => ({ name, maxParticipants: ROOM_MAX_PARTICIPANTS })) }));
 });
 return true;
}

async function startSfuDirectory(requests: string[][]): Promise<{ internalUrl: string; close: () => Promise<void> }> {
 const server = http.createServer((request, response) => {
  if (serveListRooms(request, response, requests)) return;
  response.writeHead(404);
  response.end();
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
 return {
  internalUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
 };
}

describe.skipIf(!process.env.VOICE_RELAY_TEST_DATABASE_URL)('consumer HTTP and websocket admission', () => {
	test.each(['relay', 'direct'])('%s HTTP/WS admission preserves the intended pool behavior', async mode => {
		const u = new URL(process.env.VOICE_RELAY_TEST_DATABASE_URL!);
		const config = { url: 'https://local.test', db: { host: u.hostname, port: Number(u.port), db: u.pathname.slice(1), user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } } as any;
		const storage = new VoiceRelayStorage(config); (storage.pool.options as any).connectionTimeoutMillis = 300;
		const responses: http.ServerResponse[] = []; const sockets: import('node:stream').Duplex[] = [];
		const roomRequests: string[][] = [];
		const received = new EventEmitter();
		const waitForCount = (event: string, count: () => number, expected: number) => new Promise<void>(resolve => { const check = () => { if (count() >= expected) { received.off(event, check); resolve(); } }; received.on(event, check); check(); });
		const upstream = http.createServer((request, res) => { if (serveListRooms(request, res, roomRequests)) return; responses.push(res); received.emit('http'); });
		upstream.on('upgrade', (_req, socket) => { socket.on('error', () => {}); sockets.push(socket); received.emit('socket'); });
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const targetPort = (upstream.address() as AddressInfo).port;
		if (mode === 'direct') { config.voiceCall = { livekit: { internalUrl: `http://127.0.0.1:${targetPort}`, apiKey: 'key', apiSecret: 'x'.repeat(32) } }; storage.read = async () => null; }
		const relay = { storage, isEnabled: mode === 'relay', rtc: async (raw: string) => { const id = new URL(raw, 'https://local.test').searchParams.get('access_token')!; return { roomId: id, generation: 'g', remoteId: id, url: new URL(`http://127.0.0.1:${targetPort}/rtc?access_token=${id}`), headers: {} }; }, get: async (id: string) => mode === 'direct' ? null : ({ state: 'active', generation: 'g', remoteId: id }) } as any;
		const voice = new VoiceBackendService(config, relay, directDatabase());
		const token = async (id: string) => mode === 'relay' ? id : encodeURIComponent(await voice.createJoinToken({ roomId: id, identity: id, userId: id, canScreenShare: false }));
		const service = new LiveKitServerService(config, voice, {} as any, {} as any, {} as any, { send: (url: string, options: any) => fetch(url, { headers: options.headers }) } as any);
		const app = Fastify(); await app.register(service.createServer, { prefix: '/livekit' });
		app.server.on('upgrade', (req, socket, head) => service.handleUpgrade(req, socket, head));
		await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as AddressInfo).port;
		const clients: WebSocket[] = []; const pending: Promise<unknown>[] = [];
		if (process.env.VOICE_RELAY_SIMULATE_OLD_ADMISSION === '1') vi.spyOn(admission, 'withAdmission').mockImplementation(async (_pool, _rejected, run) => run());
		try {
			for (let i = 0; i < 2; i++) pending.push(fetch(`http://127.0.0.1:${port}/livekit/rtc/v1?access_token=${await token(`http${i}`)}`, { signal: AbortSignal.timeout(3000) }).catch(() => null));
			for (let i = 0; i < 2; i++) { const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc/v1?access_token=${await token(`ws${i}`)}`); ws.on('error', () => {}); clients.push(ws); }
			await Promise.all([waitForCount('http', () => responses.length, 2), waitForCount('socket', () => sockets.length, 2)]);
			if (mode === 'relay') {
				const rejected = await fetch(`http://127.0.0.1:${port}/livekit/rtc/v1?access_token=${await token('excess')}`, { signal: AbortSignal.timeout(800) });
				expect(rejected.status).toBe(429);
				const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc/v1?access_token=${await token('excess-ws')}`); ws.on('error', () => {}); clients.push(ws);
				expect(await new Promise(resolve => ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); }))).toBe(403);
			} else {
				const extra = fetch(`http://127.0.0.1:${port}/livekit/rtc/v1?access_token=${await token('excess')}`, { signal: AbortSignal.timeout(3000) });
				await waitForCount('http', () => responses.length, 3);
				responses.pop()!.end('ok'); expect((await extra).status).toBe(200);
				expect(roomRequests).toContainEqual(['chatRoom:http0']);
			}
			expect((await storage.pool.query('SELECT 1 AS n')).rows[0].n).toBe(1);
			const idle = new Promise<void>(resolve => { const check = () => queueMicrotask(() => { if (storage.pool.idleCount === storage.pool.totalCount) { storage.pool.off('release', check); resolve(); } }); storage.pool.on('release', check); check(); });
			for (const res of responses.splice(0)) res.end('ok');
			for (const socket of sockets.splice(0)) socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
			await Promise.all(pending);
			await idle;
			const retry = fetch(`http://127.0.0.1:${port}/livekit/rtc/v1?access_token=${await token('retry')}`);
			await waitForCount('http', () => responses.length, 1); responses.pop()!.end('ok');
			expect((await retry).status).toBe(200);
		} finally {
			vi.restoreAllMocks(); for (const res of responses) res.end('done'); for (const socket of sockets) socket.destroy(); for (const ws of clients) ws.terminate();
			await Promise.allSettled(pending); await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); await storage.onApplicationShutdown();
		}
	});
});

test.each([1, 2])('admission reserves two connections for pool max %i', async max => {
	const pool = { options: { max } } as pg.Pool;
	await expect(admission.withAdmission(pool, () => new Error('limited'), async () => {})).rejects.toThrow('limited');
});

test('nested work reuses a permit and an escaped callback cannot reuse it after release', async () => {
	const pool = { options: { max: 3 } } as pg.Pool; let resume!: () => void;
	const gate = new Promise<void>(resolve => { resume = resolve; }); let escaped!: Promise<void>;
	await admission.withAdmission(pool, () => new Error('limited'), async () => {
		await admission.withAdmission(pool, () => new Error('limited'), async () => {});
		escaped = gate.then(() => admission.withAdmission(pool, () => new Error('limited'), async () => {}));
	});
	let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
	const holding = admission.withAdmission(pool, () => new Error('limited'), () => hold);
	try { resume(); await expect(escaped).rejects.toThrow('limited'); } finally { release(); await holding; }
});

test.skipIf(!process.env.VOICE_RELAY_TEST_DATABASE_URL)('consumer locks reserve pool headroom for unrelated queries', async () => {
	const storage = new VoiceRelayStorage({ db: {} } as any);
	await storage.pool.end();
	const pool = new pg.Pool({ connectionString: process.env.VOICE_RELAY_TEST_DATABASE_URL, max: 6, connectionTimeoutMillis: 500 });
	Object.assign(storage, { pool });
	let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
	let fourEntered!: () => void; const fourEnteredBarrier = new Promise<void>(resolve => { fourEntered = resolve; });
	let entered = 0;
	const prefix = crypto.randomUUID();
	const jobs = Array.from({ length: 5 }, (_, i) => storage.lock(`${prefix}-${i}`, async () => { entered++; if (entered === 4) fourEntered(); await gate; }));
	const settled = Promise.allSettled(jobs);
	try {
		await fourEnteredBarrier;
		expect(entered).toBe(4);
		expect((await pool.query('SELECT 1 AS n')).rows[0].n).toBe(1);
	} finally { release(); await settled; await storage.onApplicationShutdown(); }
});

test('delegated websocket does not cross the browser credential and response header boundary', async () => {
	let authorization: string | undefined;
	const upstream = http.createServer();
	upstream.on('upgrade', (request, socket) => {
		authorization = request.headers.authorization;
		socket.end('HTTP/1.1 403 Forbidden\r\nSet-Cookie: boundary=bad\r\nLocation: /bad\r\nRefresh: 0;url=/bad\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
	});
	await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
	const port = (upstream.address() as AddressInfo).port;
	const voice = { isEnabled: true, withRtcAdmission: async (_url: string, connect: any) => connect({ url: new URL(`http://127.0.0.1:${port}/rtc`), headers: {} }) } as any;
	const service = new LiveKitServerService({ url: 'https://local.test' } as any, voice, {} as any, {} as any, {} as any);
	const app = Fastify(); await app.register(service.createServer, { prefix: '/livekit' });
	app.server.on('upgrade', (req, socket, head) => service.handleUpgrade(req, socket, head));
	await app.listen({ host: '127.0.0.1', port: 0 });
	const client = new WebSocket(`ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/livekit/rtc?access_token=test`, { headers: { Authorization: 'Bearer test-boundary' } });
	client.on('error', () => {});
	try {
		const headers = await new Promise<http.IncomingHttpHeaders>(resolve => client.on('unexpected-response', (_req, response) => { response.resume(); resolve(response.headers); }));
		expect(authorization).toBeUndefined();
		expect(headers['set-cookie']).toBeUndefined();
		expect(headers.location).toBeUndefined();
		expect(headers.refresh).toBeUndefined();
	} finally { client.terminate(); await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test('delegated websocket 101 only forwards handshake response headers', async () => {
	let authorization: string | undefined;
	const upstream = http.createServer(); const wss = new WebSocketServer({ noServer: true });
	wss.on('headers', headers => { headers.push('Set-Cookie: boundary=bad', 'Location: /bad', 'Refresh: 0;url=/bad'); });
	upstream.on('upgrade', (request, socket, head) => {
		authorization = request.headers.authorization;
		wss.handleUpgrade(request, socket, head, ws => { ws.send('ready'); });
	});
	await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
	const port = (upstream.address() as AddressInfo).port;
	const voice = { isEnabled: true, withRtcAdmission: async (_url: string, connect: any) => connect({ url: new URL(`http://127.0.0.1:${port}/rtc`), headers: {} }) } as any;
	const service = new LiveKitServerService({ url: 'https://local.test' } as any, voice, {} as any, {} as any, {} as any);
	const app = Fastify(); await app.register(service.createServer, { prefix: '/livekit' });
	app.server.on('upgrade', (req, socket, head) => service.handleUpgrade(req, socket, head));
	await app.listen({ host: '127.0.0.1', port: 0 });
	const client = new WebSocket(`ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/livekit/rtc?access_token=test`, { headers: { Authorization: 'Bearer test-boundary' } });
	client.on('error', () => {});
	try {
		const headers = await new Promise<http.IncomingHttpHeaders>(resolve => client.on('upgrade', response => resolve(response.headers)));
		expect(authorization).toBeUndefined();
		expect(headers['sec-websocket-accept']).toBeTypeOf('string');
		expect(headers['set-cookie']).toBeUndefined();
		expect(headers.location).toBeUndefined();
		expect(headers.refresh).toBeUndefined();
	} finally { client.terminate(); for (const ws of wss.clients) ws.terminate(); await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); wss.close(); }
});

test('disabled voice rejects RTC before admission', async () => {
	const admission = vi.fn(async () => { throw new Error('must not inspect'); });
	const voice = { isEnabled: false, withRtcAdmission: admission } as any;
	const service = new LiveKitServerService({ url: 'https://local.test' } as any, voice, {} as any, {} as any, {} as any);
	const app = Fastify(); await app.register(service.createServer, { prefix: '/livekit' });
	try {
		const response = await app.inject({ method: 'GET', url: '/livekit/rtc/validate?access_token=abc' });
		expect(response.statusCode).toBe(404);
		expect(admission).not.toHaveBeenCalled();
		expect(service.handles({ url: '/livekit/rtc' } as any)).toBe(false);
	} finally { await app.close(); }
});

test('direct-only voice does not touch relay storage or admission', async () => {
	const roomRequests: string[][] = [];
	const sfu = await startSfuDirectory(roomRequests);
	try {
		const config = { url: 'https://local.test', voiceCall: { livekit: { internalUrl: sfu.internalUrl, apiKey: 'key', apiSecret: 'x'.repeat(32) } } } as any;
		const relay = { get: vi.fn(async () => { throw new Error('relay storage accessed'); }), storage: {}, isEnabled: false, hasRetainedCalls: false } as any;
		const voice = new VoiceBackendService(config, relay, directDatabase());
		const token = await voice.createJoinToken({ roomId: 'direct', identity: 'user', userId: 'user', canScreenShare: false });
		expect(await voice.relayCredentials('direct', { identity: 'user', userId: 'user', canScreenShare: false })).toBeNull();
		expect(await voice.connectionInfo('direct')).toEqual({});
		expect(await voice.withRtcAdmission(`/livekit/rtc?access_token=${encodeURIComponent(token)}`, async route => route ?? 'direct')).toBe('direct');
		expect(relay.get).not.toHaveBeenCalled();
		expect(roomRequests).toContainEqual(['chatRoom:direct']);
	} finally {
		await sfu.close();
	}
});

test('unverified relay lookup has a bounded per-address budget before storage', async () => {
 const lookup = vi.fn(async () => null);
 const voice = new VoiceBackendService({ url: 'https://local.test' } as any, { storage: { pool: { options: { max: 6 } } }, rtc: lookup } as any, new DataSource({ type: 'postgres' }));
 for (let i = 0; i < 600; i++) await expect(voice.withRtcAdmission(`/livekit/rtc?access_token=${i}`, async () => {}, 'address-one')).rejects.toMatchObject({ code: 'FORBIDDEN' });
 await expect(voice.withRtcAdmission('/livekit/rtc?access_token=next', async () => {}, 'address-one')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
 expect(lookup).toHaveBeenCalledTimes(600);
 await expect(voice.withRtcAdmission('/livekit/rtc?access_token=other', async () => {}, 'address-two')).rejects.toMatchObject({ code: 'FORBIDDEN' });
 expect(lookup).toHaveBeenCalledTimes(601);
});

test.skipIf(!process.env.VOICE_RELAY_TEST_DATABASE_URL)('local RTC is not blocked by saturated relay admissions when both are configured', async () => {
 const u = new URL(process.env.VOICE_RELAY_TEST_DATABASE_URL!);
 const roomRequests: string[][] = [];
 const sfu = await startSfuDirectory(roomRequests);
 const config = { url: 'https://local.test', db: { host: u.hostname, port: Number(u.port), db: u.pathname.slice(1), user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) }, voiceCall: { livekit: { internalUrl: sfu.internalUrl, apiKey: 'key', apiSecret: 'x'.repeat(32) } } } as any;
 const storage = new VoiceRelayStorage(config);
 storage.read = async () => null;
 const relay = { storage, providers: [{ id: 'relay' }], get: async () => null, isEnabled: true } as any;
 const voice = new VoiceBackendService(config, relay, directDatabase());
 let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
 let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; }); let count = 0;
 let held: Promise<void>[] = [];
	try {
		const token = await voice.createJoinToken({ roomId: 'local', identity: 'user', userId: 'user', canScreenShare: false });
		held = Array.from({ length: 4 }, () => admission.withAdmission(storage.pool, () => new Error('limited'), async () => { if (++count === 4) reached(); await gate; }));
		await entered;
		expect(await voice.relayCredentials('local', { identity: 'user', userId: 'user', canScreenShare: false })).toBeNull();
		expect(await voice.withRtcAdmission(`/livekit/rtc?access_token=${encodeURIComponent(token)}`, async () => 'connected')).toBe('connected');
		expect(roomRequests).toContainEqual(['chatRoom:local']);
	} finally {
		release();
		await Promise.allSettled(held);
		await storage.onApplicationShutdown();
		await sfu.close();
	}
});

test.skipIf(!process.env.VOICE_RELAY_TEST_DATABASE_URL)('local room creation proceeds while relay admission is saturated', async () => {
 const u = new URL(process.env.VOICE_RELAY_TEST_DATABASE_URL!);
 const config = { url: 'https://local.test', db: { host: u.hostname, port: Number(u.port), db: u.pathname.slice(1), user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) }, voiceCall: { livekit: { internalUrl: 'http://127.0.0.1:1', apiKey: 'key', apiSecret: 'x'.repeat(32) } } } as any;
 const storage = new VoiceRelayStorage(config); storage.read = async () => null; storage.write = async () => {};
 const voice = new VoiceBackendService(config, { storage, providers: [{ id: 'relay' }], get: async () => null, isEnabled: true } as any, new DataSource({ type: 'postgres', url: u.toString() }));
 Object.assign(voice, { roomService: { listRooms: async () => [], createRoom: async () => ({}) } });
 let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
 let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; }); let count = 0;
 const held = Array.from({ length: 4 }, () => admission.withAdmission(storage.pool, () => new Error('limited'), async () => { if (++count === 4) reached(); await gate; }));
 let attempt: Promise<void> | undefined;
 try { await entered; attempt = voice.ensureRoom('local', 3); expect(await Promise.race([attempt.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500))])).toBe(true); } finally { release(); await Promise.allSettled([...held, ...(attempt ? [attempt] : [])]); await storage.onApplicationShutdown(); }
});

test.each(['direct', 'relay'])('%s RTC rechecks current participant authorization before forwarding', async mode => {
 let forwarded = 0; let upgraded = 0;
 const roomRequests: string[][] = [];
 const upstream = http.createServer((request, response) => { if (serveListRooms(request, response, roomRequests)) return; forwarded++; response.end('ok'); });
 upstream.on('upgrade', (_request, socket) => { upgraded++; socket.destroy(); });
 await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
 const port = (upstream.address() as AddressInfo).port;
 const local = { internalUrl: `http://127.0.0.1:${port}`, apiKey: 'local-key', apiSecret: 'x'.repeat(32) };
 const config = { url: 'https://local.test', voiceCall: mode === 'direct' ? { livekit: local } : {} } as any;
 const token = new AccessToken(mode === 'direct' ? local.apiKey : 'provider-key', 'x'.repeat(32), { identity: 'https://local.test/users/member', metadata: JSON.stringify({ userId: 'member' }) });
 token.addGrant({ room: 'chatRoom:room', roomJoin: true, canPublish: true, canPublishSources: [] });
 const relay = { isEnabled: mode === 'relay', hasRetainedCalls: false, storage: { pool: { options: { max: 6 } }, lock: async (_key: string, fn: any) => fn() }, rtc: async () => ({ url: new URL(`http://127.0.0.1:${port}/rtc`), headers: {}, roomId: 'room', generation: 'g', remoteId: 'a' }), get: async () => ({ state: 'active', generation: 'g', remoteId: 'a' }) } as any;
 const voice = new VoiceBackendService(config, relay, directDatabase());
 const jwt = mode === 'direct' ? await voice.createJoinToken({ roomId: 'room', identity: 'https://local.test/users/member', userId: 'member', canScreenShare: true }) : await token.toJwt();
 let allowed = true;
 const chat = { canParticipantJoin: vi.fn(async () => allowed) } as any;
 const service = new LiveKitServerService(config, voice, chat, {} as any, {} as any, { send: (url: string) => fetch(url) } as any);
 const app = Fastify(); await app.register(service.createServer, { prefix: '/livekit' });
 app.server.on('upgrade', (request, socket, head) => service.handleUpgrade(request, socket, head));
 await app.listen({ host: '127.0.0.1', port: 0 });
 try {
  const url = `/livekit/rtc/validate?access_token=${encodeURIComponent(jwt)}`;
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
  expect(chat.canParticipantJoin).toHaveBeenCalledWith('room', { identity: 'https://local.test/users/member', userId: 'member', canScreenShare: true });
  allowed = false;
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
  expect(forwarded).toBe(1);
  const socket = new WebSocket(`ws://127.0.0.1:${(app.server.address() as AddressInfo).port}${url}`);
  socket.on('error', () => {});
  expect(await new Promise(resolve => socket.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); }))).toBe(403);
  expect(upgraded).toBe(0);
  if (mode === 'direct') expect(roomRequests).toContainEqual(['chatRoom:room']);
  else expect(roomRequests).toHaveLength(0);
 } finally { await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
