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
		getParticipant: vi.fn(),
		updateParticipant: vi.fn(),
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

	test.each([
		[true, [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE], true],
		[true, [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE_AUDIO], true],
		[true, [], true], [true, [TrackSource.MICROPHONE], false], [false, [], false],
	] as const)('reads actual LiveKit publish grants (%s / %s)', async (canPublish, sources, expected) => {
		roomService.listParticipants.mockResolvedValue([{
			identity: 'i1', metadata: '{"userId":"u1"}', tracks: [], joinedAt: 1n,
			permission: { canPublish, canPublishSources: sources },
		}]);
		expect((await service.listParticipants('r1'))[0].canScreenShare).toBe(expected);
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
		await expect(service.listParticipants('r1')).resolves.toEqual([{ identity: 'i1', userId: 'u1', screenSharing: true, canScreenShare: false, micTrackSid: 'TR_mic' }]);
		expect(roomService.listParticipants).toHaveBeenCalledWith('chatRoom:r1');
	});

	test('reads reported settings without deriving mute from media tracks', async () => {
		roomService.listParticipants.mockResolvedValue([{
			identity: 'i1', metadata: '{"userId":"u1"}',
			attributes: { 'cherrypick.micMuted': 'false', 'cherrypick.deafened': 'true' },
			tracks: [],
		}]);
		expect((await service.listParticipants('r1'))[0]).toMatchObject({ micMuted: false, deafened: true });
	});

	test('does not let a reported mute hide a microphone that is still sending', async () => {
		roomService.listParticipants.mockResolvedValue([
			{ identity: 'live', metadata: '{"userId":"u1"}', attributes: { 'cherrypick.micMuted': 'true' }, tracks: [{ sid: 'TR_1', source: TrackSource.MICROPHONE, muted: false }] },
			{ identity: 'muted', metadata: '{"userId":"u2"}', attributes: { 'cherrypick.micMuted': 'true' }, tracks: [{ sid: 'TR_2', source: TrackSource.MICROPHONE, muted: true }] },
		]);
		const [live, muted] = await service.listParticipants('r1');
		expect(live).toMatchObject({ identity: 'live', micMuted: false });
		expect(muted).toMatchObject({ identity: 'muted', micMuted: true });
	});

	test('writes only reported settings for the authenticated participant session', async () => {
		roomService.getParticipant.mockResolvedValue({ identity: 'i1', sid: 'PA_1' });
		await expect(service.setParticipantStatus('r1', 'i1', 'PA_1', { micMuted: true, deafened: false })).resolves.toBe(true);
		expect(roomService.updateParticipant).toHaveBeenCalledWith('chatRoom:r1', 'i1', {
			attributes: { 'cherrypick.micMuted': 'true', 'cherrypick.deafened': 'false' },
		});
		roomService.updateParticipant.mockClear();
		await expect(service.setParticipantStatus('r1', 'i1', 'PA_old', { micMuted: false, deafened: false })).resolves.toBe(false);
		expect(roomService.updateParticipant).not.toHaveBeenCalled();
	});

	test('keeps participant order by joinedAt then identity when LiveKit reorders its list', async () => {
		const participants = [
			{ identity: 'z', joinedAt: 1n, metadata: '{"userId":"u1"}', tracks: [] },
			{ identity: 'b', joinedAt: 2n, metadata: '{"userId":"u2"}', tracks: [] },
			{ identity: 'a', joinedAt: 2n, metadata: '{"userId":"u3"}', tracks: [] },
		];
		roomService.listParticipants.mockResolvedValueOnce(participants).mockResolvedValueOnce([...participants].reverse());
		for (let i = 0; i < 2; i++) {
			expect((await service.listParticipants('r1')).map(p => p.identity)).toEqual(['z', 'a', 'b']);
		}
	});

	test('skips participants without our metadata', async () => {
		roomService.listParticipants.mockResolvedValue([
			{ identity: 'stranger', metadata: '', tracks: [] },
			{ identity: 'i2', metadata: '{"userId":"u2"}', tracks: [] },
		]);
		await expect(service.listParticipants('r1')).resolves.toEqual([{ identity: 'i2', userId: 'u2', screenSharing: false, canScreenShare: false, micTrackSid: null }]);
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
