/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { expect, test, vi } from 'vitest';
import { VoiceBackendService } from '@/core/VoiceBackendService.js';

const active = { apiKey: 'active', apiSecret: 'a'.repeat(32) };
const refresh = { apiKey: 'refresh', apiSecret: 'r'.repeat(32) };
const generation = 'c6e909aa-9c88-4bb9-ab9b-c6bb215a5142';

test('direct admission checks current generation and authorization after verifying the refresh key', async () => {
	vi.spyOn(RoomServiceClient.prototype, 'listRooms').mockResolvedValue([{ name: 'chatRoom:room', maxParticipants: 10 }] as Awaited<ReturnType<RoomServiceClient['listRooms']>>);
 const runner = { connect: async () => {}, release: async () => {}, query: async (sql: string) => sql.startsWith('SELECT generation') ? [{ generation, pending: false }] : [] };
 const db = { driver: { master: { options: { max: 6 } } }, createQueryRunner: () => runner } as any;
 const relay = { isEnabled: false, hasRetainedCalls: false, storage: { pool: { options: { max: 6 } } }, rtc: async () => null } as any;
 const config = { url: 'https://local.test', voiceCall: { livekit: { internalUrl: 'http://127.0.0.1:1', ...active, verificationKeys: [refresh] } } } as any;
 const service = new VoiceBackendService(config, relay, db);
 const mint = async (key: typeof active, metadata = JSON.stringify({ userId: 'member', voiceSessionGeneration: generation })) => {
  const token = new AccessToken(key.apiKey, key.apiSecret, { identity: 'member', metadata }); token.addGrant({ room: 'chatRoom:room', roomJoin: true }); return token.toJwt();
 };
 const admit = (token: string, allowed = true) => service.withRtcAdmission(`/livekit/rtc?access_token=${encodeURIComponent(token)}`, async () => 'accepted', 'rotation', async (room, participant) => allowed && room === 'room' && participant.userId === 'member');
 expect(await admit(await mint(refresh))).toBe('accepted');
 await expect(admit(await mint(refresh), false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
 await expect(admit(await mint(refresh, JSON.stringify({ userId: 'member', voiceSessionGeneration: 'old' })))).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
