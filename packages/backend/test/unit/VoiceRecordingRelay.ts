/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Ajv } from 'ajv';
import { expect, test, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import { VoiceBackendService } from '@/core/VoiceBackendService.js';
import { VoiceRelayConsumerService } from '@/core/VoiceRelayConsumerService.js';
import type { RelayCall } from '@/core/VoiceRelayConsumerService.js';
import type { VoiceRelayClient } from '@/core/VoiceRelayClient.js';
import type { VoiceRelayStorage } from '@/core/VoiceRelayStorage.js';
import { createFixture, KNOWN_USERS } from '../misc/chat-voice-fixture.js';

// 실제 HTTP 제공자가 아닌, 합의한 status 요청 경계의 엄격한 fixture다.
const validate = new Ajv().compile({
	type: 'object', additionalProperties: false,
	required: ['identity', 'sessionId', 'micMuted', 'deafened'],
	properties: {
		identity: { type: 'string' }, sessionId: { type: 'string' },
		micMuted: { type: 'boolean' }, deafened: { type: 'boolean' }, recording: { type: 'boolean' },
	},
});

test.each([true, false, undefined])('relay status preserves recording=%s without leaking the client recording ID', async recording => {
	const requests: unknown[] = [];
	const relay = {
		providers: [{}],
		participant: async (_roomId: string, _action: string, body: unknown) => {
			if (!validate(body)) throw new Error(JSON.stringify(validate.errors));
			requests.push(body);
			return true;
		},
	} as unknown as VoiceRelayConsumerService;
	const service = new VoiceBackendService({ url: 'https://consumer.test' } as Config, relay, {} as DataSource);
	const status = { micMuted: true, deafened: false, ...(recording != null ? { recording } : {}), recordingId: '12345678-1234-4123-8123-123456789abc' };

	await expect(service.setParticipantStatus('room', 'identity', 'PA_1', status)).resolves.toBe(true);

	expect(requests).toEqual([{ identity: 'identity', sessionId: 'PA_1', micMuted: true, deafened: false, ...(recording != null ? { recording } : {}) }]);
});

function consumerFixture(recordingStatus: boolean | undefined) {
	const provider = { id: 'relay', origin: 'https://relay.test', enabled: true, validated: true };
	const call: RelayCall = { roomId: 'r1', remoteId: 'allocation', generation: 'generation', state: 'active', slots: 10, provider };
	const requests: { method: string; path: string; body?: unknown }[] = [];
	const storage = {
		read: async (key: string) => key === 'allocation:r1' ? call : key === 'providers' ? [provider] : null,
	} as unknown as VoiceRelayStorage;
	const client = {
		request: async (_provider: unknown, method: string, path: string, body?: unknown) => {
			requests.push({ method, path, body });
			if (path.endsWith('/capacity')) return {
				protocolVersion: 1, enabled: true, accepting: true, maxSlots: 100, reservedSlots: 10, remainingSlots: 90, remainingRooms: 10,
				capabilities: { cancelPending: true, includeIceServers: true, ...(recordingStatus == null ? {} : { recordingStatus }) },
			};
			if (path.endsWith('/participants/status')) {
				if (!validate(body) || (recordingStatus !== true && Object.hasOwn(body as object, 'recording'))) throw new Error('INVALID_REQUEST');
				return { accepted: true };
			}
			throw new Error(`Unexpected request: ${method} ${path}`);
		},
	} as unknown as VoiceRelayClient;
	const config = { url: 'https://local.test' } as Config;
	const consumer = new VoiceRelayConsumerService(config, storage, client);
	consumer.providers = [provider];
	const backend = new VoiceBackendService(config, consumer, {} as DataSource);
	return { consumer, backend, requests };
}

test.each([true, false, undefined])('recordingStatus=%s gates capture while preserving ordinary relay status', async capability => {
	const { backend, requests } = consumerFixture(capability);
	expect(await backend.supportsRecording('r1')).toBe(capability === true);
	await expect(backend.setParticipantStatus('r1', 'identity', 'PA_1', { micMuted: false, deafened: false, recording: true })).resolves.toBe(capability === true);
	await expect(backend.setParticipantStatus('r1', 'identity', 'PA_1', { micMuted: true, deafened: false })).resolves.toBe(true);
	await expect(backend.setParticipantStatus('r1', 'identity', 'PA_1', { micMuted: true, deafened: false, recording: false })).resolves.toBe(true);

	const bodies = requests.filter(request => request.path.endsWith('/participants/status')).map(request => request.body);
	expect(bodies).toHaveLength(capability === true ? 3 : 2);
	if (capability !== true) expect(bodies.every(body => !Object.hasOwn(body as object, 'recording'))).toBe(true);
});

test('an older provider is refused before preparing or delivering a recording event', async () => {
	const { backend, requests } = consumerFixture(undefined);
	const fixture = createFixture();
	Object.assign(fixture.service, { liveKitService: backend });
	const room = { ...fixture.rooms.get('r1')!, allowRecording: true };
	fixture.rooms.set('r1', room);
	fixture.chatRoomsRepository.findOneBy.mockResolvedValue(room);
	Object.assign(fixture.usersRepository, { findOneBy: vi.fn().mockResolvedValue(KNOWN_USERS.find(user => user.id === 'owner')) });
	vi.spyOn(fixture.service, 'scheduleRefresh').mockImplementation(() => {});
	const recordingId = '12345678-1234-4123-8123-123456789abc';
	try {
		const result = await fixture.service.reportStatus(KNOWN_USERS.find(user => user.id === 'u1')! as any, 'r1', 'PA_1', { micMuted: false, deafened: false, recording: true, recordingId });

		expect(result).toBe(false);
		expect(await fixture.redis.get(`chatVoice:recording:${recordingId}`)).toBeNull();
		expect(fixture.queueService.deliver).not.toHaveBeenCalled();
		expect(requests.every(request => request.method === 'GET' && request.path.endsWith('/capacity'))).toBe(true);
	} finally {
		fixture.service.onApplicationShutdown();
	}
});
