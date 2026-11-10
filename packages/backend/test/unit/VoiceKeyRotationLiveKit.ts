/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import Fastify from 'fastify';
import { DataSource } from 'typeorm';
import { AccessToken, RoomServiceClient, TokenVerifier } from 'livekit-server-sdk';
import { WebSocket } from 'ws';
import { expect, test } from 'vitest';
import { VoiceBackendService } from '@/core/VoiceBackendService.js';
import { LiveKitServerService } from '@/server/LiveKitServerService.js';
import type { AddressInfo } from 'node:net';

const require = createRequire(import.meta.url);
const { SignalResponse } = createRequire(require.resolve('livekit-server-sdk'))('@livekit/protocol');
const databaseUrl = process.env.VOICE_RELAY_TEST_DATABASE_URL;
const credentialFile = process.env.VOICE_ROTATION_CREDENTIAL_FILE;
const livekitUrl = process.env.VOICE_ROTATION_LIVEKIT_URL;

function rejectedSocket(ws: WebSocket): Promise<number | undefined> {
 return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.terminate(); reject(new Error('Expected signaling rejection')); }, 8000);
  ws.once('unexpected-response', (_request, response) => { clearTimeout(timer); response.resume(); resolve(response.statusCode); });
  ws.once('open', () => { clearTimeout(timer); ws.terminate(); reject(new Error('Revoked signaling was accepted')); });
  ws.once('error', () => { clearTimeout(timer); reject(new Error('WebSocket error')); });
 });
}

test.skipIf(!databaseUrl || !credentialFile || !livekitUrl)('direct signaling accepts real refresh key and retains authorization and kick revocation', async () => {
 const keys = JSON.parse(readFileSync(credentialFile!, 'utf8')) as { apiKey: string; apiSecret: string; refreshKey: string; refreshSecret: string };
 const schema = `rotation_direct_${randomUUID().replaceAll('-', '')}`;
 const admin = new pg.Pool({ connectionString: databaseUrl });
 const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
 const db = new DataSource({ type: 'postgres', url: databaseUrl, entities: [], synchronize: false, dropSchema: false, migrationsRun: false, extra: { options: `-c search_path=${schema}`, max: 8 } });
 const roomId = `rotation-${randomUUID()}`, room = `chatRoom:${roomId}`, identity = 'https://local.test/users/member';
 const config = { url: 'https://local.test', voiceCall: { livekit: { internalUrl: livekitUrl, apiKey: keys.apiKey, apiSecret: keys.apiSecret, verificationKeys: [{ apiKey: keys.refreshKey, apiSecret: keys.refreshSecret }] } } } as any;
 const relay = { isEnabled: false, hasRetainedCalls: false, storage: { pool }, rtc: async () => null } as any;
 const voice = new VoiceBackendService(config, relay, db);
 const chat = { canParticipantJoin: async (id: string, participant: { identity: string; userId: string }) => id === roomId && participant.identity === identity && participant.userId === 'member' } as any;
 const server = new LiveKitServerService(config, voice, chat, {} as any, {} as any);
 const app = Fastify(); const livekit = new RoomServiceClient(livekitUrl!, keys.apiKey, keys.apiSecret);
 const sockets: WebSocket[] = [];
 try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query('CREATE TABLE voice_token_generation (room_id text NOT NULL, identity_digest text NOT NULL, generation uuid NOT NULL, pending boolean NOT NULL DEFAULT false, PRIMARY KEY (room_id, identity_digest))');
  await db.initialize(); await livekit.createRoom({ name: room, emptyTimeout: 120 });
  await app.register(server.createServer, { prefix: '/livekit' });
  app.server.on('upgrade', (request, socket, head) => server.handleUpgrade(request, socket, head));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const connect = (token: string) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/livekit/rtc?access_token=${encodeURIComponent(token)}&protocol=16&sdk=js&version=2.23.0&auto_subscribe=0`); sockets.push(ws); return ws; };
  const wait = (ws: WebSocket, kind: string): Promise<any> => new Promise((resolve, reject) => {
   const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); ws.off('error', onError); };
   const onMessage = (data: any) => { const message = SignalResponse.fromBinary(new Uint8Array(data as Buffer)).message; if (message.case === kind) { cleanup(); resolve(message.value); } };
   const onError = () => { cleanup(); reject(new Error('WebSocket error')); };
   const timer = setTimeout(() => { cleanup(); reject(new Error(`Missing ${kind}`)); }, 8000);
   ws.on('message', onMessage); ws.once('error', onError);
  });
  const token = await voice.createJoinToken({ roomId, identity, userId: 'member', canScreenShare: false });
  const original = await new TokenVerifier(keys.apiKey, keys.apiSecret).verify(token);
  const first = connect(token); const joined = wait(first, 'join'); const automatic = wait(first, 'refreshToken'); await joined;
  let refreshed = await automatic as string;
  for (let attempt = 0; attempt < 80; attempt++) {
   try { await new TokenVerifier(keys.refreshKey, keys.refreshSecret).verify(refreshed); break; } catch {
    const next = wait(first, 'refreshToken'); await livekit.updateParticipant(room, identity, { attributes: { probe: String(attempt) } }); refreshed = await next;
   }
  }
  const claims = await new TokenVerifier(keys.refreshKey, keys.refreshSecret).verify(refreshed);
  expect(claims.metadata).toBe(original.metadata);
  first.terminate(); const second = connect(refreshed); await wait(second, 'join');
  const validate = async (t: string) => (await fetch(`http://127.0.0.1:${port}/livekit/rtc/validate?access_token=${encodeURIComponent(t)}`)).status;
  const mint = async (key: string, secret: string, options: { room?: string; identity?: string; metadata?: string } = {}) => { const t = new AccessToken(key, secret, { identity: options.identity ?? identity, metadata: options.metadata ?? claims.metadata }); t.addGrant({ room: options.room ?? room, roomJoin: true }); return t.toJwt(); };
  expect(await validate(await mint(keys.refreshKey, keys.refreshSecret, { room: 'chatRoom:other' }))).toBe(403);
  expect(await validate(await mint(keys.refreshKey, keys.refreshSecret, { identity: 'other' }))).toBe(403);
  expect(await validate(await mint(keys.refreshKey, keys.refreshSecret, { metadata: JSON.stringify({ userId: 'member', voiceSessionGeneration: randomUUID() }) }))).toBe(403);
  expect(await validate(await mint('unknown', keys.refreshSecret))).toBe(403);
  expect(await validate(await mint(keys.refreshKey, 'x'.repeat(32)))).toBe(403);
  await voice.removeParticipant(roomId, identity);
  expect(await validate(token)).toBe(403); expect(await validate(refreshed)).toBe(403);
  expect(await rejectedSocket(connect(token))).toBe(403); expect(await rejectedSocket(connect(refreshed))).toBe(403);
 } finally {
  for (const socket of sockets) socket.terminate(); await app.close(); await livekit.deleteRoom(room).catch(() => {});
  if (db.isInitialized) await db.destroy(); await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
 }
}, 40000);
