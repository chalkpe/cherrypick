/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { RoomServiceClient } from 'livekit-server-sdk';
import { expect, test, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import { VoiceBackendService } from '@/core/VoiceBackendService.js';
import type { VoiceRelayConsumerService, RelayCall } from '@/core/VoiceRelayConsumerService.js';

test('preference changes keep existing direct and relay rooms on their original backends', async () => {
 const values = new Map<string, unknown>();
 const rooms = new Set<string>();
 const create = vi.spyOn(RoomServiceClient.prototype, 'createRoom').mockImplementation(async ({ name }) => {
  rooms.add(name);
  return {} as Awaited<ReturnType<RoomServiceClient['createRoom']>>;
 });
 const list = vi.spyOn(RoomServiceClient.prototype, 'listRooms').mockImplementation(async names => [...rooms].filter(name => names?.includes(name)).map(name => ({ name })) as Awaited<ReturnType<RoomServiceClient['listRooms']>>);
 const existing: RelayCall = { roomId: 'relay-room', generation: 'generation', provider: { id: 'relay', origin: 'https://relay.test', enabled: true, validated: true }, remoteId: 'allocation', state: 'active', slots: 51 };
 const ensure = vi.fn(async () => existing);
 const storage = {
  read: async <T>(key: string): Promise<T | null> => (values.get(key) as T | undefined) ?? null,
  write: async (key: string, value: unknown): Promise<void> => { values.set(key, structuredClone(value)); },
  directLock: async <T>(_key: string, run: () => Promise<T>): Promise<T> => run(),
 };
 const relay = { storage, providers: [existing.provider], isEnabled: true, hasRetainedCalls: true, get: async (roomId: string) => roomId === existing.roomId ? existing : null, ensure } as unknown as VoiceRelayConsumerService;
 const config = { url: 'https://consumer.test', voiceCall: { livekit: { internalUrl: 'http://127.0.0.1:1', apiKey: 'key', apiSecret: 's'.repeat(32) }, preferRelay: false } } as Config;
 try {
  const backend = new VoiceBackendService(config, relay, {} as DataSource);
  await backend.ensureRoom('direct-room', 51);
  config.voiceCall!.preferRelay = true;
  await backend.ensureRoom('direct-room', 51);
  expect(create).toHaveBeenCalledTimes(2);
  expect(ensure).not.toHaveBeenCalled();
  config.voiceCall!.preferRelay = false;
  await backend.ensureRoom('relay-room', 51);
  expect(ensure).toHaveBeenCalledWith('relay-room', 51);
  expect(create).toHaveBeenCalledTimes(2);
 } finally {
  create.mockRestore();
  list.mockRestore();
 }
});

test('an existing direct call keeps its reserved limit after the administrator changes it', async () => {
 const values = new Map<string, unknown>([['direct:room', { generation: 'first', state: 'active', slots: 10 }]]);
 const create = vi.spyOn(RoomServiceClient.prototype, 'createRoom').mockResolvedValue({} as Awaited<ReturnType<RoomServiceClient['createRoom']>>);
 const list = vi.spyOn(RoomServiceClient.prototype, 'listRooms').mockResolvedValue([{ name: 'chatRoom:room' }] as Awaited<ReturnType<RoomServiceClient['listRooms']>>);
 const storage = {
  read: async <T>(key: string): Promise<T | null> => (values.get(key) as T | undefined) ?? null,
  write: async (key: string, value: unknown): Promise<void> => { values.set(key, structuredClone(value)); },
  directLock: async <T>(_key: string, run: () => Promise<T>): Promise<T> => run(),
 };
 const relay = { storage, providers: [{}], isEnabled: true, get: async () => null } as unknown as VoiceRelayConsumerService;
 const config = { url: 'https://consumer.test', voiceCall: { livekit: { internalUrl: 'http://127.0.0.1:1', apiKey: 'key', apiSecret: 's'.repeat(32) } } } as Config;
 try {
  const backend = new VoiceBackendService(config, relay, {} as DataSource);

  await backend.ensureRoom('room', 25);

  expect(create).toHaveBeenCalledWith(expect.objectContaining({ maxParticipants: 10 }));
  expect(values.get('direct:room')).toMatchObject({ slots: 10 });
 } finally {
  create.mockRestore();
  list.mockRestore();
 }
});

test('records the existing LiveKit limit when relay configuration is added during a direct call', async () => {
 const values = new Map<string, unknown>();
 const create = vi.spyOn(RoomServiceClient.prototype, 'createRoom').mockResolvedValue({} as Awaited<ReturnType<RoomServiceClient['createRoom']>>);
 const list = vi.spyOn(RoomServiceClient.prototype, 'listRooms').mockResolvedValue([{ name: 'chatRoom:room', maxParticipants: 10 }] as Awaited<ReturnType<RoomServiceClient['listRooms']>>);
 const storage = {
  read: async <T>(key: string): Promise<T | null> => (values.get(key) as T | undefined) ?? null,
  write: async (key: string, value: unknown): Promise<void> => { values.set(key, structuredClone(value)); },
  directLock: async <T>(_key: string, run: () => Promise<T>): Promise<T> => run(),
 };
 const relay = { storage, providers: [{}], isEnabled: true, get: async () => null } as unknown as VoiceRelayConsumerService;
 const config = { url: 'https://consumer.test', voiceCall: { livekit: { internalUrl: 'http://127.0.0.1:1', apiKey: 'key', apiSecret: 's'.repeat(32) } } } as Config;
 try {
  const backend = new VoiceBackendService(config, relay, {} as DataSource);

  await backend.ensureRoom('room', 25);

  expect(create).toHaveBeenCalledWith(expect.objectContaining({ maxParticipants: 10 }));
  expect(values.get('direct:room')).toMatchObject({ slots: 10 });
 } finally {
  create.mockRestore();
  list.mockRestore();
 }
});

test('disabling direct calls retires only allocations whose SFU rooms have ended', async () => {
 type Allocation = { generation: string; state: 'pending' | 'active' | 'ended'; slots: number };
 const values = new Map<string, Allocation>([
  ['direct:ended', { generation: 'a', state: 'active', slots: 10 }],
  ['direct:live', { generation: 'b', state: 'active', slots: 10 }],
  ['direct:unknown', { generation: 'c', state: 'active', slots: 10 }],
 ]);
 const list = vi.spyOn(RoomServiceClient.prototype, 'listRooms').mockImplementation(async names => {
  if (names?.includes('chatRoom:unknown')) throw new Error('SFU unavailable');
  return names?.includes('chatRoom:live') ? [{ name: 'chatRoom:live' }] as Awaited<ReturnType<RoomServiceClient['listRooms']>> : [];
 });
 const storage = {
  query: async () => ({ rows: [...values.keys()].map(key => ({ key })) }),
  read: async (key: string) => values.get(key),
  write: async (key: string, value: Allocation) => { values.set(key, structuredClone(value)); },
  directLock: async <T>(_key: string, run: () => Promise<T>) => run(),
 };
 const relay = { storage, providers: [{}], isEnabled: true } as unknown as VoiceRelayConsumerService;
 const config = { url: 'https://consumer.test', voiceCall: { livekit: { internalUrl: 'http://127.0.0.1:1', apiKey: 'key', apiSecret: 's'.repeat(32) } } } as Config;
 try {
  const backend = new VoiceBackendService(config, relay, {} as DataSource);

  await backend.retireEndedDirectRooms();

  expect(values.get('direct:ended')?.state).toBe('ended');
  expect(values.get('direct:live')?.state).toBe('active');
  expect(values.get('direct:unknown')?.state).toBe('active');
 } finally {
  list.mockRestore();
 }
});

test('a retained direct call can move to the relay after its SFU room later ends', async () => {
 const fingerprint = createHash('sha256').update(JSON.stringify(['https://livekit.test', 'key'])).digest('hex');
 const values = new Map<string, unknown>([['direct:room', { generation: 'a', state: 'active', slots: 10, server: { fingerprint } }]]);
 const list = vi.spyOn(RoomServiceClient.prototype, 'listRooms').mockResolvedValue([{ name: 'chatRoom:room' }] as Awaited<ReturnType<RoomServiceClient['listRooms']>>);
 const ensure = vi.fn(async () => {});
 const storage = {
  read: async <T>(key: string): Promise<T | null> => (values.get(key) as T | undefined) ?? null,
  write: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
  lock: async <T>(_key: string, run: () => Promise<T>) => run(),
 };
 const relay = { storage, providers: [{}], isEnabled: true, get: async () => null, ensure } as unknown as VoiceRelayConsumerService;
 const config = { url: 'https://consumer.test' } as Config;
 const settings = { voiceCallLivekitSource: 'disabled', voiceCallLivekitUrl: 'https://livekit.test', voiceCallLivekitApiKey: 'key', voiceCallLivekitApiSecret: 'secret' } as any;
 try {
  const backend = new VoiceBackendService(config, relay, {} as DataSource, settings);

  await expect(backend.ensureRoom('room', 10)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  expect(values.get('direct:room')).toMatchObject({ state: 'active' });
  expect(ensure).not.toHaveBeenCalled();

  list.mockRejectedValueOnce(new Error('SFU unavailable'));
  await expect(backend.ensureRoom('room', 10)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  expect(values.get('direct:room')).toMatchObject({ state: 'active' });

  list.mockResolvedValueOnce([]);
  await backend.ensureRoom('room', 10);

  expect(values.get('direct:room')).toMatchObject({ state: 'ended' });
  expect(ensure).toHaveBeenCalledWith('room', 10);

  values.set('direct:legacy', { generation: 'old', state: 'active', slots: 10 });
  list.mockResolvedValueOnce([]);
  await backend.ensureRoom('legacy', 10);
  expect(values.get('direct:legacy')).toMatchObject({ state: 'ended' });
  expect(ensure).toHaveBeenCalledWith('legacy', 10);
 } finally {
  list.mockRestore();
 }
});
