/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RemoteVoiceCallService } from '@/core/RemoteVoiceCallService.js';
import { HostPolicyService } from '@/core/HostPolicyService.js';
import { TEST_CLOCK, createFixture, mirrorRoom } from '../misc/chat-voice-fixture.js';

// 他のサーバーのルームの通話に入る要求から、応答に載っていた参加者の現況の保存までを、実物の二つのサービスでつなげて確かめる
describe('join to a room of another server', () => {
	let f: ReturnType<typeof createFixture>;
	let service: RemoteVoiceCallService;
	let signedPostJson: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers({ now: TEST_CLOCK, toFake: ['Date'] });
		f = createFixture();
		f.rooms.set('r1', mirrorRoom());
		signedPostJson = vi.fn();
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const hostPolicyService = new HostPolicyService(f.meta as any, f.instancesRepository as any, f.utilityService, { getLogger: () => logger } as any);
		service = new RemoteVoiceCallService(
			{
				...f.redis,
				// 参加の記録の書き込みは少し遅れて届く。記録を待たずに現況の保存を始めると、保存が先に記録を読んで自分が外れる
				set: async (key: string, ...args: unknown[]) => {
					if (key.startsWith('chatVoice:remoteJoin:')) await new Promise(resolve => setImmediate(resolve));
					return (f.redis.set as any)(key, ...args);
				},
				exists: async (key: string) => (f.redis.store.has(key) ? 1 : 0),
			} as any,
			f.meta as any,
			{ signedPostJson, signedGetJson: vi.fn() } as any,
			f.service,
			hostPolicyService,
			f.cloudflareTurnService as any,
			{ getLogger: () => logger } as any,
		);
	});

	afterEach(() => {
		f.service.onApplicationShutdown();
		vi.useRealTimers();
	});

	const owner = { id: 'remoteOwner', host: 'remote.test', uri: 'https://remote.test/users/remoteOwner', isSuspended: false, isDeleted: false } as any;
	const hostResponse = (participants: { identity: string; screenSharing: boolean }[]) => ({ url: 'https://remote.test/livekit', token: 'jwt', participants, updatedAt: TEST_CLOCK, iceServers: [] });
	const storedUserIds = () => (JSON.parse(f.redis.store.get('chatVoice:state:r1') ?? '{"participants":[]}').participants as { userId: string }[]).map(p => p.userId);

	test('the first snapshot in the response keeps the user who asked to join', async () => {
		signedPostJson.mockResolvedValue(hostResponse([
			{ identity: 'https://local.test/users/u3', screenSharing: false },
		]));
		const requester = { id: 'u3', host: null, uri: null } as any;

		await service.requestJoin(requester, mirrorRoom(), owner, false);
		await vi.waitFor(() => expect(f.redis.store.has('chatVoice:state:r1')).toBe(true));

		expect(storedUserIds()).toEqual(['u3']);
	});

	test('a member who only appears in the list sent by the host is not shown', async () => {
		signedPostJson.mockResolvedValue(hostResponse([
			{ identity: 'https://local.test/users/u3', screenSharing: false },
			{ identity: 'https://local.test/users/u2', screenSharing: false },
		]));
		f.redis.store.delete('chatVoice:remoteJoin:r1:u2');
		f.redis.store.delete('chatVoice:remoteJoin:r1:u3');
		const requester = { id: 'u3', host: null, uri: null } as any;

		await service.requestJoin(requester, mirrorRoom(), owner, false);
		await vi.waitFor(() => expect(f.redis.store.has('chatVoice:state:r1')).toBe(true));

		expect(storedUserIds()).toEqual(['u3']);
	});

	test('status reports sent every six hours keep the user in the snapshots of the host for as long as the call lasts', async () => {
		signedPostJson.mockResolvedValue(hostResponse([{ identity: 'https://local.test/users/u3', screenSharing: false }]));
		const requester = { id: 'u3', host: null, uri: null } as any;
		await service.requestJoin(requester, mirrorRoom(), owner, false);
		await vi.waitFor(() => expect(f.redis.store.has('chatVoice:state:r1')).toBe(true));

		for (let i = 0; i < 16; i++) {
			await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
			await service.reportStatus(requester, mirrorRoom(), owner, 'PA_1', { micMuted: true, deafened: false });
		}
		await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u3', screenSharing: false }], Date.now());

		expect(storedUserIds()).toEqual(['u3']);
	});

	test('a user who stopped reporting is dropped from the snapshots of the host after the record ends', async () => {
		signedPostJson.mockResolvedValue(hostResponse([{ identity: 'https://local.test/users/u3', screenSharing: false }]));
		const requester = { id: 'u3', host: null, uri: null } as any;
		await service.requestJoin(requester, mirrorRoom(), owner, false);
		await vi.waitFor(() => expect(f.redis.store.has('chatVoice:state:r1')).toBe(true));

		await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
		await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u3', screenSharing: false }], Date.now());

		expect(storedUserIds()).toEqual([]);
	});
});
