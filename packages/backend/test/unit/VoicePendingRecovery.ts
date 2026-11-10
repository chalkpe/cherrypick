/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { VoiceBackendService } from '@/core/VoiceBackendService.js';
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
  storage: { directLock: async (_key: string, run: () => Promise<unknown>) => run() },
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
