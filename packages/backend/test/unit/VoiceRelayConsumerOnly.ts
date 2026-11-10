/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { meta, paramDef } from '@/server/api/endpoints/admin/voice-relay/manage.js';

test('voice relay management exposes only consumer operations', () => {
	expect(paramDef.properties.action.enum).toEqual(['list', 'save-provider', 'remove-provider', 'check-provider']);
	expect(Object.keys(meta.res.properties).sort()).toEqual(['capacity', 'providers']);
});

test('consumer settings store no client key or client identifier', async () => {
 const { VoiceRelayConsumerService } = await import('@/core/VoiceRelayConsumerService.js');
 const { VoiceRelayClient } = await import('@/core/VoiceRelayClient.js');
 const values = new Map<string, unknown>();
 const storage = {
  read: async <T>(key: string): Promise<T | null> => (values.get(key) as T | undefined) ?? null,
  write: async (key: string, value: unknown): Promise<void> => { values.set(key, value); },
  query: async () => ({ rows: [], rowCount: 0 }),
  lock: async <T>(_key: string, run: () => Promise<T>): Promise<T> => run(),
 } as unknown as import('@/core/VoiceRelayStorage.js').VoiceRelayStorage;
 const config = { url: 'https://consumer.test' } as import('@/config.js').Config;
 const client = new VoiceRelayClient(config, {} as import('@/core/HttpRequestService.js').HttpRequestService, storage);
 const consumer = new VoiceRelayConsumerService(config, storage, client);
 const [saved] = await consumer.saveProvider({ id: 'relay', origin: 'https://relay.test', secret: 'x'.repeat(48), enabled: true });
 expect(saved).not.toHaveProperty('clientId');
 expect(saved).not.toHaveProperty('keyId');
 expect(saved).not.toHaveProperty('secret');
});

test('initial migration creates only consumer storage and direct revocation state', async () => {
 const { VoiceRelay1794234432342 } = await import('../../migration/1794234432342-VoiceRelay.js');
 const statements: string[] = [];
 const runner = { query: async (sql: string) => { statements.push(sql); } };
 await new VoiceRelay1794234432342().up(runner);
 const createdTables = statements.filter(sql => sql.startsWith('CREATE TABLE'));
 expect(createdTables).toHaveLength(2);
 expect(createdTables.some(sql => sql.includes('voice_token_generation'))).toBe(true);
 expect(createdTables.some(sql => sql.includes('consumer_state'))).toBe(true);
 expect(statements.join('\n')).not.toMatch(/client_request_limits|participant_tokens|relay_installation|allocations"|"clients"|webhooks/);
 const down: string[] = [];
 await new VoiceRelay1794234432342().down({ query: async (sql: string) => { down.push(sql); } });
 expect(down).toHaveLength(2);
});
