/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { Config } from '@/config.js';
import { VoiceRelayConsumerService } from '@/core/VoiceRelayConsumerService.js';
import type { VoiceRelayClient } from '@/core/VoiceRelayClient.js';
import type { VoiceRelayStorage } from '@/core/VoiceRelayStorage.js';

const defaults = { maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrate: 8000000 };
const higher = { maxWidth: 3840, maxHeight: 2160, maxFrameRate: 120, maxBitrate: 16000000 };
const lower = { maxWidth: 1280, maxHeight: 720, maxFrameRate: 30, maxBitrate: 2000000 };
const provider = { id: 'relay', origin: 'https://relay.test', enabled: true, validated: true };

function fixture(limits: unknown, include = true) {
	const policy = include ? { screenShareLimits: limits } : {};
	const call = { roomId: 'room', generation: 'gen', remoteId: 'id', state: 'active', slots: 2, provider };
	const storage = { read: vi.fn(async (key: string) => key === 'providers' ? [provider] : call) } as unknown as VoiceRelayStorage;
	const request = vi.fn(async (_provider: unknown, _method: string, path: string) => path.endsWith('/capacity')
		? { protocolVersion: 1, enabled: true, accepting: true, maxSlots: 2, reservedSlots: 0, remainingSlots: 2, remainingRooms: 1, ...policy }
		: { allocationId: 'id', generation: 'gen', mediaProvider: provider.origin, token: 'token', iceServers: null, ...policy });
	const client = { request } as unknown as VoiceRelayClient;
	return { service: new VoiceRelayConsumerService({} as Config, storage, client), request };
}

describe('relay screen share limits', () => {
	test.each([[defaults], [lower], [higher]])('forwards an advertised policy from capacity and join', async limits => {
		const { service } = fixture(limits);
		expect((await service.capacity(provider)).screenShareLimits).toEqual(limits);
		expect((await service.join('room', { identity: 'user', userId: 'user', allowScreenShare: false })).screenShareLimits).toEqual(limits);
	});

	test('does not impose limits for an older relay response', async () => {
		const { service } = fixture(undefined, false);
		expect((await service.capacity(provider)).screenShareLimits).toBeUndefined();
		expect((await service.join('room', { identity: 'user', userId: 'user', allowScreenShare: true })).screenShareLimits).toBeUndefined();
	});

	test('uses each join response even when it differs from the earlier capacity response', async () => {
		const { service, request } = fixture(defaults);
		expect((await service.capacity(provider)).screenShareLimits).toEqual(defaults);
		request.mockResolvedValueOnce({ allocationId: 'id', generation: 'gen', mediaProvider: provider.origin, token: 'token', iceServers: null, screenShareLimits: lower });

		const joined = await service.join('room', { identity: 'user', userId: 'user', allowScreenShare: false });

		expect(joined.screenShareLimits).toEqual(lower);
		expect(request).toHaveBeenLastCalledWith(provider, 'POST', '/voice-relay/v1/allocations/id/join', { identity: 'user', userId: 'user', allowScreenShare: false });
	});

	test.each([null, {}, { ...lower, maxBitrate: 0 }, { ...lower, maxWidth: 1.5 }, { ...lower, maxHeight: '720' }, { ...lower, extra: 1 }])('rejects invalid policies from capacity and join: %o', async limits => {
		const { service } = fixture(limits);
		await expect(service.capacity(provider)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
		await expect(service.join('room', { identity: 'user', userId: 'user', allowScreenShare: true })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
	});
});
