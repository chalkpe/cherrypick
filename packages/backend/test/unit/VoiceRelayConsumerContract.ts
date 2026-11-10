/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { jwtVerify } from 'jose';
import { expect, test } from 'vitest';
import type { Config } from '@/config.js';
import type { HttpRequestService } from '@/core/HttpRequestService.js';
import { VoiceRelayClient } from '@/core/VoiceRelayClient.js';
import { VoiceRelayConsumerService, type RelayCall } from '@/core/VoiceRelayConsumerService.js';
import type { VoiceRelayStorage } from '@/core/VoiceRelayStorage.js';
import { createFixture as createChatFixture } from '../misc/chat-voice-fixture.js';

const issuer = 'https://consumer.test';
const audience = 'https://relay.test';
const secret = 's'.repeat(48);
type Allocation = { id: string; generation: string; state: 'active' | 'ended'; reservedSlots: number };

/** In-memory protocol fixture. It does not represent a running relay or a database. */
function createFixture() {
 const values = new Map<string, unknown>();
 const calls: Array<{ method: string; path: string }> = [];
 let allocation: Allocation | undefined;
 const storage = {
  read: async <T>(key: string): Promise<T | null> => structuredClone((values.get(key) as T | undefined) ?? null),
  write: async (key: string, value: unknown): Promise<void> => { values.set(key, structuredClone(value)); },
  lock: async <T>(_key: string, run: () => Promise<T>): Promise<T> => run(),
  query: async (sql: string, params?: unknown[]) => {
   const active = [...values.entries()].flatMap(([key, value]) => {
    const call = value as RelayCall;
    return key.startsWith('allocation:') && call.state !== 'ended' ? [call] : [];
   });
   if (sql.startsWith('SELECT 1')) return { rows: [], rowCount: active.filter(call => call.provider.id === params?.[0]).length };
   if (sql.startsWith('SELECT value')) return { rows: active.map(value => ({ value })), rowCount: active.length };
   return { rows: [], rowCount: 0 };
  },
 } as unknown as VoiceRelayStorage;
 const http = {
  send: async (raw: string, options: { method: string; headers: Record<string, string>; body?: string }) => {
   const url = new URL(raw);
   const token = options.headers.authorization.slice('Bearer '.length);
   const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'], issuer, audience, requiredClaims: ['iat', 'exp'], maxTokenAge: 60, clockTolerance: 5 });
   if (url.origin !== audience || payload.aud !== audience || payload.sub !== undefined || protectedHeader.typ !== 'voice-relay-client+jwt' || Object.keys(protectedHeader).length !== 2) throw new Error('invalid relay authorization');
   calls.push({ method: options.method, path: url.pathname });
   let status = 200;
   let body: unknown;
   if (url.pathname.endsWith('/capacity')) body = { protocolVersion: 1, enabled: true, accepting: true, maxSlots: 102, reservedSlots: allocation?.state === 'active' ? allocation.reservedSlots : 0, remainingSlots: 102, remainingRooms: 1, capabilities: { cancelPending: true, includeIceServers: true } };
   else if (url.pathname.endsWith('/allocations') && options.method === 'GET') { status = 404; body = { code: 'NOT_FOUND' }; } else if (url.pathname.endsWith('/allocations') && options.method === 'POST') {
    const request = JSON.parse(options.body ?? '{}') as { generation: string; slots: number };
    allocation = { id: 'allocation-1', generation: request.generation, reservedSlots: request.slots, state: 'active' };
    body = allocation;
   } else if (url.pathname.endsWith('/snapshot') && allocation) body = { allocationId: allocation.id, generation: allocation.generation, state: allocation.state, participants: [], revision: '1' };
   else if (url.pathname.endsWith('/allocation-1') && options.method === 'DELETE' && allocation) { allocation.state = 'ended'; body = allocation; } else throw new Error(`unexpected protocol request ${options.method} ${url.pathname}`);
   return { ok: status === 200, status, json: async () => body };
  },
 } as unknown as HttpRequestService;
 const config = { url: `${issuer}/configured-path` } as Config;
 const client = new VoiceRelayClient(config, http, storage);
 const consumer = new VoiceRelayConsumerService(config, storage, client);
 return { calls, consumer };
}

test('the product consumer keeps an active relay allocation when selection is disabled', async () => {
 const { calls, consumer } = createFixture();
 await consumer.saveProvider({ id: 'relay', origin: audience, enabled: true, secret });
 await consumer.checkProvider('relay');
 const first = await consumer.ensure('room', 51);
 await consumer.saveProvider({ id: 'relay', origin: audience, enabled: false });
 const second = await consumer.ensure('room', 51);
 expect(second.remoteId).toBe(first.remoteId);
 expect(second.generation).toBe(first.generation);
 expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/allocations'))).toHaveLength(1);
 await consumer.end('room');
 expect((await consumer.get('room'))?.state).toBe('ended');
});

test('call admission reserves the configured limit and retains it until the allocation ends', async () => {
 const { consumer } = createFixture();
 const chat = createChatFixture();
 await consumer.saveProvider({ id: 'relay', origin: audience, enabled: true, secret });
 await consumer.checkProvider('relay');
 chat.liveKitService.ensureRoom.mockImplementation(async (roomId, slots) => { await consumer.ensure(roomId, slots); });
 const user = { id: 'u1', host: null, uri: null } as any;
 try {
  await chat.service.issueJoinToken(user, { id: 'room' } as any, false);
  expect((await consumer.get('room'))?.slots).toBe(10);

  chat.metaService.fetch.mockResolvedValueOnce({ ...chat.meta, voiceCallMaxParticipants: 25 } as typeof chat.meta);
  await chat.service.issueJoinToken(user, { id: 'room' } as any, false);
  expect((await consumer.get('room'))?.slots).toBe(10);

  await consumer.end('room');
  chat.metaService.fetch.mockResolvedValueOnce({ ...chat.meta, voiceCallMaxParticipants: 25 } as typeof chat.meta);
  await chat.service.issueJoinToken(user, { id: 'next-room' } as any, false);
  expect((await consumer.get('next-room'))?.slots).toBe(25);
 } finally {
  chat.service.onApplicationShutdown();
 }
});
