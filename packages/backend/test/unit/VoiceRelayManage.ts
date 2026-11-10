/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import type { MiLocalUser } from '@/models/User.js';
import type { VoiceRelayConsumerService } from '@/core/VoiceRelayConsumerService.js';
import type { ModerationLogService } from '@/core/ModerationLogService.js';
import ManageRelay from '@/server/api/endpoints/admin/voice-relay/manage.js';

test('administrator saves a relay with only its address and secret, and never receives its secret', async () => {
 let saved: Parameters<VoiceRelayConsumerService['saveProvider']>[0] | undefined;
 const secret = 'x'.repeat(48);
 const consumer: Pick<VoiceRelayConsumerService, 'saveProvider' | 'allProviders'> = {
  saveProvider: async input => { saved = input; return []; },
  allProviders: async () => [{ id: 'relay', origin: 'https://relay.test', enabled: true, validated: true, credentialVersion: 'internal' }],
 };
 const logs: Pick<ModerationLogService, 'log'> = { log: async () => {} };
 const endpoint = new ManageRelay(consumer as VoiceRelayConsumerService, logs as ModerationLogService);
 const result = await endpoint.exec({ action: 'save-provider', origin: 'https://relay.test', secret }, {} as MiLocalUser, null, null);
 expect(saved).toMatchObject({ origin: 'https://relay.test', secret });
 expect(saved).not.toHaveProperty('clientId');
 expect(result.providers).toEqual([{ id: 'relay', origin: 'https://relay.test', enabled: true, validated: true }]);
 expect(JSON.stringify(result)).not.toContain(secret);
 expect(JSON.stringify(result)).not.toContain('credentialVersion');
});
