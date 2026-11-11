/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { VoiceBackendService } from '@/core/VoiceBackendService.js';
import { VoiceRelayConsumerService, type RelayCall } from '@/core/VoiceRelayConsumerService.js';
import { VoiceRelayError } from '@/core/VoiceRelayClient.js';
import { createFixture } from '../misc/chat-voice-fixture.js';

// In-memory generation storage: the product methods create and mutate every row.
function database() {
 const rows = new Map<string, { generation: string; pending: boolean }>();
 let beforeReturn: (() => Promise<void>) | undefined;
 const query = async (sql: string, values: string[]) => {
  if (sql.startsWith('SELECT pg_advisory_')) return [];
  const key = `${values[0]}:${values[1]}`;
  if (sql.startsWith('INSERT INTO voice_token_generation')) {
   const previous = rows.get(key);
   if (sql.includes('pending=true')) rows.set(key, { generation: values[2], pending: true });
   else if (!previous) rows.set(key, { generation: values[2], pending: false });
   const result = sql.includes('RETURNING') ? [{ ...rows.get(key)! }] : [];
   if (sql.includes('RETURNING') && beforeReturn) { const run = beforeReturn; beforeReturn = undefined; await run(); }
   return result;
  }
  if (sql.startsWith('SELECT generation')) return rows.has(key) ? [{ ...rows.get(key)! }] : [];
  if (sql.startsWith('UPDATE voice_token_generation')) {
   const row = rows.get(key);
   if (row && (values[2] === undefined || values[2] === row.generation)) { row.pending = false; return sql.includes('RETURNING') ? [{ generation: row.generation }] : []; }
   return [];
  }
  throw new Error(`Unexpected query: ${sql}`);
 };
 return { beforeNextAdmissionReturns: (run: () => Promise<void>) => { beforeReturn = run; }, driver: { master: { options: { max: 10 } } }, query, createQueryRunner: () => ({ query, connect: async () => {}, release: async () => {} }) } as any;
}

function fixture(mode: 'direct' | 'relay', relayOnly = false) {
 const chat = createFixture();
 const params = { roomId: 'r1', identity: 'https://local.test/users/m1', userId: 'm1', canScreenShare: false };
 const config = { url: 'https://local.test', voiceCall: { livekit: { internalUrl: 'http://127.0.0.1:1', apiKey: 'devkey', apiSecret: 'secret'.repeat(6) } } } as any;
 if (relayOnly) delete config.voiceCall.livekit;
 const remove = vi.fn(async () => {});
 const relay = { isEnabled: mode === 'relay', hasRetainedCalls: mode === 'relay', providers: mode === 'relay' ? [{}] : [],
  storage: { directLock: async (_key: string, run: () => Promise<unknown>) => run(), lock: async (_key: string, run: () => Promise<unknown>) => run(), read: async () => null },
  get: async () => mode === 'relay' ? { state: 'active' } : null,
  participant: async () => { await remove(); return true; },
 } as any;
 const db = database();
 const voice = new VoiceBackendService(config, relay, db);
 (voice as any).roomService = { removeParticipant: remove, listRooms: async () => [{ name: 'chatRoom:r1', maxParticipants: 10 }] };
 const authorize = () => chat.service.canParticipantJoin('r1', params);
 const join = () => voice.withParticipantAdmission('r1', params.identity, authorize, () => mode === 'direct' ? voice.createJoinToken(params) : Promise.resolve('relay-token'));
 const admit = (token: string) => voice.withRtcAdmission(`/livekit/rtc?access_token=${encodeURIComponent(token)}`, async () => 'connected');
 return { chat, voice, remove, join, admit, params, db, relay };
}

test.each(['direct', 'relay'] as const)('%s retries a failed removal before an authorized rejoin', async mode => {
 const f = fixture(mode);
 try {
  const old = await f.join();
  f.remove.mockRejectedValueOnce(new Error('injected SFU failure'));
  await expect(f.voice.removeParticipant('r1', f.params.identity)).rejects.toThrow('injected SFU failure');
  if (mode === 'direct') await expect(f.admit(old)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  f.remove.mockRejectedValueOnce(new Error('still unavailable'));
  await expect(f.join()).rejects.toThrow('still unavailable');
  if (mode === 'direct') await expect(f.admit(old)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const current = await f.join();
  if (mode === 'direct') {
   expect(await f.admit(current)).toBe('connected');
   await expect(f.admit(old)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  } else expect(current).toBe('relay-token');
 } finally { f.chat.service.onApplicationShutdown(); }
});

test.each(['direct', 'relay'] as const)('%s denies a former member and rechecks role after removal', async mode => {
 const f = fixture(mode);
 try {
  await f.join();
  f.remove.mockRejectedValueOnce(new Error('injected SFU failure'));
  await expect(f.voice.removeParticipant('r1', f.params.identity)).rejects.toThrow('injected SFU failure');
  f.chat.nonMembers.add('m1');
  await expect(f.join()).rejects.toMatchObject({ code: 'PARTICIPANT_REVOKED' });
  expect(f.remove).toHaveBeenCalledTimes(1);
  f.chat.nonMembers.delete('m1');
  f.remove.mockImplementationOnce(async () => { f.chat.roleService.getUserPolicies.mockResolvedValue({ canVoiceCall: false, canScreenShare: false, chatAvailability: 'available' }); });
  await expect(f.join()).rejects.toMatchObject({ code: 'PARTICIPANT_REVOKED' });
  expect(f.remove).toHaveBeenCalledTimes(2);
 } finally { f.chat.service.onApplicationShutdown(); }
});

test.each(['direct', 'relay'] as const)('%s rejects a join observed before a newer removal', async mode => {
 const f = fixture(mode);
 try {
  await f.join();
  f.remove.mockRejectedValueOnce(new Error('injected SFU failure'));
  await expect(f.voice.removeParticipant('r1', f.params.identity)).rejects.toThrow('injected SFU failure');
  f.db.beforeNextAdmissionReturns(() => f.voice.removeParticipant('r1', f.params.identity));
  await expect(f.join()).rejects.toMatchObject({ code: 'PARTICIPANT_REVOKED' });
  expect(await f.join()).toBeTruthy();
 } finally { f.chat.service.onApplicationShutdown(); }
});

test('a missing relay cannot clear a failed removal without a direct SFU', async () => {
 const f = fixture('relay', true);
 try {
  f.remove.mockRejectedValueOnce(new Error('injected SFU failure'));
  await expect(f.voice.removeParticipant('r1', f.params.identity)).rejects.toThrow('injected SFU failure');
  f.relay.participant = async () => null;
  await expect(f.join()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  f.relay.hasRetainedCalls = false; f.relay.providers = [];
  await expect(f.join()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  f.relay.hasRetainedCalls = true;
  f.relay.participant = async () => { await f.remove(); return true; };
  expect(await f.join()).toBe('relay-token');
 } finally { f.chat.service.onApplicationShutdown(); }
});

// The relay protocol is faked at the network boundary; allocation records are
// created and ended only by the product consumer methods.
function relayOnlyFixture() {
 const chat = createFixture();
 const provider = { id: 'relay', origin: 'https://relay.test', enabled: true, validated: true };
 const values = new Map<string, unknown>([['providers', [provider]]]);
 const storage = {
  read: async <T>(key: string): Promise<T | null> => structuredClone((values.get(key) as T | undefined) ?? null),
  write: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
  lock: async <T>(_key: string, run: () => Promise<T>) => run(),
  directLock: async <T>(_key: string, run: () => Promise<T>) => run(),
  query: async () => ({ rows: [...values.entries()].filter(([key, value]) => key.startsWith('allocation:') && (value as RelayCall).state !== 'ended').map(([, value]) => ({ value })) }),
 };
 let allocation: { id: string; generation: string; state: 'active' | 'ended'; reservedSlots: number } | undefined;
 const kick = vi.fn(async (): Promise<unknown> => ({ accepted: true }));
 const client = { request: async (_provider: unknown, method: string, path: string, body?: any): Promise<any> => {
  if (path.endsWith('/capacity')) return { protocolVersion: 1, enabled: true, accepting: true, maxSlots: 100, reservedSlots: 0, remainingSlots: 100, remainingRooms: 1, capabilities: { cancelPending: true } };
  if (path.includes('/allocations?')) throw new VoiceRelayError('NOT_FOUND', 404);
  if (method === 'POST' && path.endsWith('/allocations')) { allocation = { id: 'allocation-1', generation: body.generation, state: 'active', reservedSlots: body.slots }; return allocation; }
  if (path.endsWith('/participants/kick')) return kick();
  if (path.endsWith('/snapshot') && allocation) return { allocationId: allocation.id, generation: allocation.generation, state: allocation.state, participants: [], revision: '1' };
  if (method === 'DELETE' && allocation) { allocation.state = 'ended'; return allocation; }
  if (path.endsWith('/join') && allocation) return { token: 'new-relay-token', iceServers: null, generation: allocation.generation, allocationId: allocation.id, mediaProvider: provider.origin };
  throw new Error(`Unexpected request: ${method} ${path}`);
 } };
 const relay = new VoiceRelayConsumerService({ url: 'https://local.test' } as any, storage as any, client as any);
 relay.providers = [provider];
 const voice = new VoiceBackendService({ url: 'https://local.test' } as any, relay, database());
 const params = { roomId: 'r1', identity: 'https://local.test/users/m1', userId: 'm1', canScreenShare: false };
 const join = () => voice.withParticipantAdmission('r1', params.identity, () => chat.service.canParticipantJoin('r1', params), async () => {
  await voice.ensureRoom('r1', 10);
  return voice.createJoinToken(params);
 });
 return { chat, voice, relay, storage, kick, params, join };
}

test('relay-only removal with no allocation permits an authorized user to start a call', async () => {
 const f = relayOnlyFixture();
 try {
  await f.voice.removeParticipant('r1', f.params.identity);
  expect(await f.join()).toBe('new-relay-token');
  expect((await f.relay.get('r1'))?.state).toBe('active');
 } finally { f.chat.service.onApplicationShutdown(); }
});

test('relay-only failed removal recovers after the allocation is ended', async () => {
 const f = relayOnlyFixture();
 try {
  await f.join();
  f.kick.mockRejectedValueOnce(new Error('relay unavailable'));
  await expect(f.voice.removeParticipant('r1', f.params.identity)).rejects.toThrow('relay unavailable');
  await f.relay.end('r1');
  expect(await f.join()).toBe('new-relay-token');
 } finally { f.chat.service.onApplicationShutdown(); }
});

test('relay-only removal stays pending when kick response is malformed', async () => {
 const f = relayOnlyFixture();
 try {
  await f.join();
  f.kick.mockResolvedValue({});
  await expect(f.voice.removeParticipant('r1', f.params.identity)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  await expect(f.join()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  f.kick.mockResolvedValue({ accepted: true });
  expect(await f.join()).toBe('new-relay-token');
 } finally { f.chat.service.onApplicationShutdown(); }
});

test('a relay kick reporting a missing participant completes revocation', async () => {
 const f = relayOnlyFixture();
 try {
  await f.join();
  // The relay rotates the token generation before reporting a missing participant.
  f.kick.mockResolvedValue({ accepted: false });
  await f.voice.removeParticipant('r1', f.params.identity);
  expect(await f.join()).toBe('new-relay-token');
 } finally { f.chat.service.onApplicationShutdown(); }
});

test('failed relay removal still requires current membership after the allocation ends', async () => {
 const f = relayOnlyFixture();
 try {
  await f.join();
  f.kick.mockRejectedValueOnce(new Error('relay unavailable'));
  await expect(f.voice.removeParticipant('r1', f.params.identity)).rejects.toThrow('relay unavailable');
  await f.relay.end('r1');
  f.chat.nonMembers.add('m1');
  await expect(f.join()).rejects.toMatchObject({ code: 'PARTICIPANT_REVOKED' });
  f.chat.nonMembers.delete('m1');
  expect(await f.join()).toBe('new-relay-token');
 } finally { f.chat.service.onApplicationShutdown(); }
});

test('an uncheckable retained direct allocation keeps relay-only removal pending', async () => {
 const f = relayOnlyFixture();
 const direct = new VoiceBackendService({ url: 'https://local.test', voiceCall: { livekit: { internalUrl: 'http://127.0.0.1:1', apiKey: 'devkey', apiSecret: 'secret'.repeat(6) } } } as any, f.relay, database());
 (direct as any).roomService = { listRooms: async () => [], createRoom: async () => ({}) };
 try {
  await direct.ensureRoom('r1', 10);
  await expect(f.voice.removeParticipant('r1', f.params.identity)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  await expect(f.join()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
 } finally { f.chat.service.onApplicationShutdown(); }
});

test('an allocation lookup failure cannot clear a pending removal', async () => {
 const f = relayOnlyFixture();
 const read = f.storage.read;
 try {
  f.storage.read = async <T>(key: string): Promise<T | null> => { if (key === 'allocation:r1') throw new Error('storage unavailable'); return read<T>(key); };
  await expect(f.voice.removeParticipant('r1', f.params.identity)).rejects.toThrow('storage unavailable');
  await expect(f.join()).rejects.toThrow('storage unavailable');
  f.storage.read = read;
  expect(await f.join()).toBe('new-relay-token');
 } finally { f.chat.service.onApplicationShutdown(); }
});

test('membership is rechecked after confirming an ended allocation', async () => {
 const f = relayOnlyFixture();
 const read = f.storage.read;
 try {
  await f.join();
  f.kick.mockRejectedValueOnce(new Error('relay unavailable'));
  await expect(f.voice.removeParticipant('r1', f.params.identity)).rejects.toThrow('relay unavailable');
  await f.relay.end('r1');
  f.storage.read = async <T>(key: string): Promise<T | null> => {
   const value = await read<T>(key);
   if (key === 'direct:r1') f.chat.nonMembers.add('m1');
   return value;
  };
  await expect(f.join()).rejects.toMatchObject({ code: 'PARTICIPANT_REVOKED' });
  f.storage.read = read;
  f.chat.nonMembers.delete('m1');
  expect(await f.join()).toBe('new-relay-token');
 } finally { f.chat.service.onApplicationShutdown(); }
});
