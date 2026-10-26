/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { TokenVerifier, TrackSource, TwirpError } from 'livekit-server-sdk';
import { LiveKitService } from '@/core/LiveKitService.js';

const SECRET = 'a'.repeat(32);

function createService() {
	const service = new LiveKitService({
		url: 'https://local.test',
		voiceCall: { livekit: { internalUrl: 'http://livekit:7880', apiKey: 'key', apiSecret: SECRET } },
	} as any);
	const roomService = {
		listParticipants: vi.fn(),
		createRoom: vi.fn(),
		removeParticipant: vi.fn(),
		mutePublishedTrack: vi.fn(),
		deleteRoom: vi.fn(),
	};
	Object.assign(service, { roomService });
	return { service, roomService };
}

describe('LiveKitService', () => {
	let service: LiveKitService;
	let roomService: ReturnType<typeof createService>['roomService'];

	beforeEach(() => {
		({ service, roomService } = createService());
	});

	test('is disabled without a voiceCall config', () => {
		expect(new LiveKitService({ url: 'https://local.test' } as any).isEnabled).toBe(false);
		expect(service.isEnabled).toBe(true);
	});

	test('issues a room-scoped token that cannot publish a camera', async () => {
		const token = await service.createJoinToken({ roomId: 'r1', identity: 'https://local.test/users/u1', userId: 'u1', canScreenShare: true });
		const claims = await new TokenVerifier('key', SECRET).verify(token);
		expect(claims.sub).toBe('https://local.test/users/u1');
		expect(claims.video).toMatchObject({ room: 'chatRoom:r1', roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: false, canUpdateOwnMetadata: false });
		expect(claims.video?.canPublishSources).toEqual(['microphone', 'screen_share', 'screen_share_audio']);
		expect(JSON.parse(claims.metadata as string)).toEqual({ userId: 'u1' });
	});

	test('drops screen share sources when screen sharing is not allowed', async () => {
		const token = await service.createJoinToken({ roomId: 'r1', identity: 'https://local.test/users/u1', userId: 'u1', canScreenShare: false });
		const claims = await new TokenVerifier('key', SECRET).verify(token);
		expect(claims.video?.canPublishSources).toEqual(['microphone']);
	});

	test('maps LiveKit participants to users and screen share state', async () => {
		roomService.listParticipants.mockResolvedValue([{
			identity: 'i1',
			metadata: '{"userId":"u1"}',
			tracks: [{ source: TrackSource.MICROPHONE, sid: 'TR_mic' }, { source: TrackSource.SCREEN_SHARE, sid: 'TR_ss' }],
		}]);
		await expect(service.listParticipants('r1')).resolves.toEqual([{ identity: 'i1', userId: 'u1', screenSharing: true, micTrackSid: 'TR_mic' }]);
		expect(roomService.listParticipants).toHaveBeenCalledWith('chatRoom:r1');
	});

	test('skips participants without our metadata', async () => {
		roomService.listParticipants.mockResolvedValue([
			{ identity: 'stranger', metadata: '', tracks: [] },
			{ identity: 'i2', metadata: '{"userId":"u2"}', tracks: [] },
		]);
		await expect(service.listParticipants('r1')).resolves.toEqual([{ identity: 'i2', userId: 'u2', screenSharing: false, micTrackSid: null }]);
	});

	test('treats a missing room as having no participants', async () => {
		roomService.listParticipants.mockRejectedValue(new TwirpError('TwirpError', 'requested room does not exist', 404, 'not_found'));
		await expect(service.listParticipants('r1')).resolves.toEqual([]);
	});

	test('builds identities for local and remote users', () => {
		expect(service.identityOf({ id: 'u1', host: null, uri: null })).toBe('https://local.test/users/u1');
		expect(service.identityOf({ id: 'u2', host: 'remote.test', uri: 'https://remote.test/users/x' })).toBe('https://remote.test/users/x');
	});

	test('round-trips room names', () => {
		expect(service.roomIdOf(service.roomNameOf('abc'))).toBe('abc');
		expect(service.roomIdOf('other:abc')).toBeNull();
	});
});
