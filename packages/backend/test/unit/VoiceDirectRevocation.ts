/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';
import Fastify from 'fastify';
import { DataSource } from 'typeorm';
import { AccessToken, RoomServiceClient, TokenVerifier } from 'livekit-server-sdk';
import { WebSocket } from 'ws';
import { expect, test, vi } from 'vitest';
import { VoiceBackendService } from '@/core/VoiceBackendService.js';
import { LiveKitServerService } from '@/server/LiveKitServerService.js';
import { createFixture } from '../misc/chat-voice-fixture.js';
import type { AddressInfo } from 'node:net';

const require = createRequire(import.meta.url);
const { SignalResponse } = createRequire(require.resolve('livekit-server-sdk'))('@livekit/protocol');
const livekitUrl = process.env.VOICE_RELAY_TEST_LIVEKIT_URL;

test('a failed PostgreSQL advisory unlock discards its pooled connection', async () => {
 const discard = vi.fn(async () => {});
 const runner = { connect: async () => {}, release: async () => {}, releasePostgresConnection: discard, query: async (sql: string) => {
  if (sql.startsWith('SELECT pg_advisory_unlock')) throw new Error('injected unlock failure');
  if (sql.startsWith('SELECT generation')) return [{ generation: randomUUID(), pending: false }];
  return [];
 } };
 const dataSource = { driver: { master: { options: { max: 6 } } }, createQueryRunner: () => runner } as any;
 const config = { url: 'https://local.test', voiceCall: { livekit: { internalUrl: 'http://127.0.0.1:1', apiKey: 'devkey', apiSecret: 'secret' } } } as any;
 const voice = new VoiceBackendService(config, { isEnabled: false, hasRetainedCalls: false } as any, dataSource);
 let rejected = false;
 try { await voice.createJoinToken({ roomId: 'room', identity: 'member', userId: 'member', canScreenShare: false }); } catch { rejected = true; }
 expect(rejected).toBe(true);
 expect(discard).toHaveBeenCalledOnce();
});

test.skipIf(!process.env.VOICE_RELAY_TEST_DATABASE_URL || !livekitUrl)('direct kick persists revocation across workers, token refresh and HTTP/WS while allowing a new join', async () => {
 const schema = `direct_revoke_${randomUUID().replaceAll('-', '')}`;
 const admin = new pg.Pool({ connectionString: process.env.VOICE_RELAY_TEST_DATABASE_URL });
 const pool = new pg.Pool({ connectionString: process.env.VOICE_RELAY_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
 const dataSource = new DataSource({ type: 'postgres', url: process.env.VOICE_RELAY_TEST_DATABASE_URL, entities: [], synchronize: false, dropSchema: false, migrationsRun: false, extra: { options: `-c search_path=${schema}`, max: 10 } });
 const restartDataSource = new DataSource(dataSource.options);
 const livekit = new RoomServiceClient(livekitUrl!, 'devkey', 'secret');
 const roomId = `revoke-${randomUUID()}`, roomName = `chatRoom:${roomId}`, identity = 'https://local.test/users/m1';
 const config = { url: 'https://local.test', voiceCall: { livekit: { internalUrl: livekitUrl!, apiKey: 'devkey', apiSecret: 'secret' } } } as any;
 const relay = { isEnabled: false, hasRetainedCalls: false } as any;
 const first = new VoiceBackendService(config, relay, dataSource);
 const second = new VoiceBackendService(config, relay, dataSource);
 const chat = createFixture();
 const server = new LiveKitServerService(config, second, chat.service, {} as any, {} as any);
 const app = Fastify(); const sockets: WebSocket[] = [];
 const params = { roomId, identity, userId: 'm1', canScreenShare: false };
 try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query('CREATE TABLE voice_token_generation (room_id text NOT NULL, identity_digest text NOT NULL, generation uuid NOT NULL, pending boolean NOT NULL DEFAULT false, PRIMARY KEY (room_id, identity_digest))');
  await dataSource.initialize();
  await livekit.createRoom({ name: roomName, emptyTimeout: 120 });
  await app.register(server.createServer, { prefix: '/livekit' });
  app.server.on('upgrade', (request, socket, head) => server.handleUpgrade(request, socket, head));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  let receiveRefresh: ((token: string) => void) | undefined;
  const signal = (token: string) => new Promise<boolean>((resolve, reject) => {
   const url = new URL(`ws://127.0.0.1:${port}/livekit/rtc`);
   url.searchParams.set('access_token', token); url.searchParams.set('auto_subscribe', '0'); url.searchParams.set('sdk', 'js'); url.searchParams.set('version', '2.23.0'); url.searchParams.set('protocol', '15');
   const socket = new WebSocket(url); sockets.push(socket); const timeout = setTimeout(() => reject(new Error('signal timeout')), 8000);
   socket.on('unexpected-response', (_req, response) => { clearTimeout(timeout); response.resume(); resolve(false); });
   socket.on('error', () => {});
   socket.on('message', data => {
    const message = SignalResponse.fromBinary(data).message;
    if (message.case === 'join') { clearTimeout(timeout); resolve(true); }
    if (message.case === 'refreshToken') receiveRefresh?.(message.value);
   });
  });
  const old = await first.createJoinToken(params);
  const oldClaims = await new TokenVerifier('devkey', 'secret').verify(old);
  expect(await signal(old)).toBe(true);
  const livekitRefresh = new Promise<string>((resolve, reject) => {
   const timeout = setTimeout(() => reject(new Error('LiveKit refresh timeout')), 5000);
   receiveRefresh = token => { clearTimeout(timeout); receiveRefresh = undefined; resolve(token); };
  });
  await livekit.updateParticipant(roomName, identity, { permission: { canSubscribe: true, canPublish: false, canPublishData: false } });
  const realRefresh = await livekitRefresh;
  expect(JSON.parse((await new TokenVerifier('devkey', 'secret').verify(realRefresh)).metadata!).voiceSessionGeneration === JSON.parse(oldClaims.metadata!).voiceSessionGeneration).toBe(true);
  await second.removeParticipant(roomId, identity);
  expect(await signal(old)).toBe(false);
  expect(await signal(realRefresh)).toBe(false);
  const refreshed = new AccessToken('devkey', 'secret', { identity, metadata: oldClaims.metadata, ttl: '10m' });
  refreshed.addGrant({ roomJoin: true, room: roomName });
  expect(await signal(await refreshed.toJwt())).toBe(false);
  const validation = await fetch(`http://127.0.0.1:${port}/livekit/rtc/validate?access_token=${encodeURIComponent(old)}`);
  expect(validation.status).toBe(403);
  const legacy = new AccessToken('devkey', 'secret', { identity, metadata: JSON.stringify({ userId: 'm1' }), ttl: '10m' });
  legacy.addGrant({ roomJoin: true, room: roomName });
  expect(await signal(await legacy.toJwt())).toBe(false);
  const current = await first.createJoinToken(params);
  const currentClaims = await new TokenVerifier('devkey', 'secret').verify(current);
  expect(JSON.parse(currentClaims.metadata!).voiceSessionGeneration === JSON.parse(oldClaims.metadata!).voiceSessionGeneration).toBe(false);
  expect((await pool.query('SELECT generation FROM voice_token_generation WHERE room_id=$1', [roomId])).rows[0].generation === JSON.parse(currentClaims.metadata!).voiceSessionGeneration).toBe(true);
  expect(await signal(current)).toBe(true);
  for (const [otherRoom, otherIdentity] of [[`${roomName}-other`, identity], [roomName, `${identity}-other`]]) {
   const misplaced = new AccessToken('devkey', 'secret', { identity: otherIdentity, metadata: currentClaims.metadata, ttl: '10m' });
   misplaced.addGrant({ roomJoin: true, room: otherRoom });
   expect(await signal(await misplaced.toJwt())).toBe(false);
  }

  // A join that races a kick waits for the kick's SFU removal and receives the new generation.
  const roomService = (second as any).roomService;
  const remove = roomService.removeParticipant.bind(roomService);
  let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  roomService.removeParticipant = async (...args: unknown[]) => { entered(); await gate; return remove(...args); };
  const kick = second.removeParticipant(roomId, identity);
  await enteredPromise;
  let issued = false;
  const joining = first.createJoinToken(params).then(value => { issued = true; return value; });
  try {
   await vi.waitFor(async () => {
    const result = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE 'SELECT pg_advisory_lock%'");
    expect(result.rows[0].count).toBeGreaterThan(0);
   });
   expect(issued).toBe(false);
  } finally { release(); }
  await kick;
  const afterKick = await joining;
  expect(await signal(current)).toBe(false);
  expect(await signal(afterKick)).toBe(true);

  // SFU failure must not roll back the persisted revocation; another worker rejects it.
  roomService.removeParticipant = async () => { throw new Error('injected SFU failure'); };
  await expect(second.removeParticipant(roomId, identity)).rejects.toThrow('injected SFU failure');
  await restartDataSource.initialize();
  const restarted = new VoiceBackendService(config, relay, restartDataSource);
  await expect(restarted.withRtcAdmission(`/livekit/rtc?access_token=${encodeURIComponent(afterKick)}`, async () => 'incorrect')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  let pendingRejected = false;
  try { await restarted.createJoinToken(params); } catch (error) { pendingRejected = (error as { code?: string }).code === 'DIRECT_REMOVAL_PENDING'; }
  expect(pendingRejected).toBe(true);
  roomService.removeParticipant = remove;
  await second.removeParticipant(roomId, identity);
  const recovered = await restarted.createJoinToken(params);
  expect(await signal(recovered)).toBe(true);

  // A real connected LiveKit participant is removed when the role event is delivered.
  chat.liveKitService.listParticipants.mockImplementation(async id => second.listParticipants(id));
  chat.liveKitService.removeParticipant.mockImplementation(async (id, who) => second.removeParticipant(id, who));
  await chat.redis.sadd('chatVoice:active', roomId);
  chat.service.onModuleInit();
  chat.roleService.getUserPolicies.mockResolvedValue({ canVoiceCall: false, canScreenShare: false, chatAvailability: 'available' });
  chat.redisForSub.emit('message', 'local.test', JSON.stringify({ channel: 'internal', message: { type: 'roleUpdated', body: {} } }));
  await vi.waitFor(() => expect(chat.liveKitService.removeParticipant).toHaveBeenCalledWith(roomId, identity));
  await vi.waitFor(async () => expect((await livekit.listParticipants(roomName)).some(participant => participant.identity === identity)).toBe(false));
  expect(await signal(recovered)).toBe(false);
 } finally {
  chat.service.onApplicationShutdown();
  for (const socket of sockets) socket.terminate();
  await app.close(); await livekit.deleteRoom(roomName).catch(() => {});
  expect(await livekit.listRooms([roomName])).toHaveLength(0);
  if (dataSource.isInitialized) await dataSource.destroy();
  if (restartDataSource.isInitialized) await restartDataSource.destroy();
  await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
 }
}, 20000);
