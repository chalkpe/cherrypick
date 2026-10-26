/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';

function fakeRedis() {
	const store = new Map<string, string>();
	const sets = new Map<string, Set<string>>();
	return {
		store,
		sets,
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
			if (args.includes('NX') && store.has(key)) return null;
			store.set(key, value);
			return 'OK';
		}),
		del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
		mget: vi.fn(async (...keys: string[]) => keys.map(key => store.get(key) ?? null)),
		sadd: vi.fn(async (key: string, member: string) => {
			if (!sets.has(key)) sets.set(key, new Set());
			sets.get(key)!.add(member);
			return 1;
		}),
		srem: vi.fn(async (key: string, member: string) => (sets.get(key)?.delete(member) ? 1 : 0)),
		smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
	};
}

function createFixture(redis = fakeRedis()) {
	const liveKitService = {
		getPublicUrl: () => 'https://local.test/livekit',
		identityOf: (user: { id: string; host: string | null; uri: string | null }) => user.host == null ? `https://local.test/users/${user.id}` : user.uri,
		roomIdOf: (name: string) => name.startsWith('chatRoom:') ? name.slice('chatRoom:'.length) : null,
		listParticipants: vi.fn(),
		ensureRoom: vi.fn(),
		createJoinToken: vi.fn().mockResolvedValue('jwt'),
	};
	const chatRoomsRepository = {
		findOneBy: vi.fn(async ({ id }: { id: string }) => ({ id, ownerId: 'owner' })),
	};
	const chatRoomMembershipsRepository = {
		findBy: vi.fn(async () => [{ userId: 'm1' }]),
	};
	const userEntityService = {
		packMany: vi.fn(async (ids: string[]) => ids.map(id => ({ id, username: id }))),
	};
	const globalEventService = {
		publishChatRoomStream: vi.fn(),
		publishMainStream: vi.fn(),
	};
	const service = new ChatVoiceService(
		redis as any,
		chatRoomsRepository as any,
		chatRoomMembershipsRepository as any,
		liveKitService as any,
		userEntityService as any,
		globalEventService as any,
	);
	return { service, redis, liveKitService, chatRoomsRepository, chatRoomMembershipsRepository, userEntityService, globalEventService };
}

describe('ChatVoiceService', () => {
	let f: ReturnType<typeof createFixture>;

	beforeEach(() => {
		f = createFixture();
	});

	afterEach(() => {
		f.service.onApplicationShutdown();
		vi.useRealTimers();
	});

	test('stores the participant snapshot and announces it to the room and its members', async () => {
		f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: true, micTrackSid: 'TR' }]);

		await f.service.refresh('r1');

		expect(JSON.parse(f.redis.store.get('chatVoice:r1')!).participants).toEqual([{ identity: 'i1', userId: 'u1', screenSharing: true }]);
		expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith('r1', 'voiceState', {
			roomId: 'r1',
			participants: [{ identity: 'i1', user: expect.objectContaining({ id: 'u1' }), screenSharing: true }],
		});
		expect(f.globalEventService.publishMainStream.mock.calls.map(call => call[0]).sort()).toEqual(['m1', 'owner']);
		expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('owner', 'chatRoomVoiceState', expect.objectContaining({ roomId: 'r1' }));
	});

	test('clears the snapshot when the call becomes empty', async () => {
		f.redis.store.set('chatVoice:r1', JSON.stringify({ participants: [{ identity: 'i1', userId: 'u1', screenSharing: false }], updatedAt: 1 }));
		f.liveKitService.listParticipants.mockResolvedValue([]);

		await f.service.refresh('r1');

		expect(f.redis.store.has('chatVoice:r1')).toBe(false);
		expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith('r1', 'voiceState', { roomId: 'r1', participants: [] });
	});

	test('leaves out participants whose user no longer exists', async () => {
		f.liveKitService.listParticipants.mockResolvedValue([
			{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null },
			{ identity: 'gone', userId: 'deleted', screenSharing: false, micTrackSid: null },
		]);
		f.userEntityService.packMany.mockImplementation(async (ids: string[]) => ids.filter(id => id !== 'deleted').map(id => ({ id, username: id })));

		await f.service.refresh('r1');

		expect(f.globalEventService.publishChatRoomStream.mock.calls[0][2].participants.map((p: { identity: string }) => p.identity)).toEqual(['i1']);
	});

	test('expires snapshots so a lost LiveKit cannot leave phantom calls', async () => {
		f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null }]);

		await f.service.refresh('r1');

		expect(f.redis.set).toHaveBeenCalledWith('chatVoice:r1', expect.any(String), 'EX', 120);
	});

	test('tracks rooms with an active call', async () => {
		f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null }]);
		await f.service.refresh('r1');
		expect([...f.redis.sets.get('chatVoice:active') ?? []]).toEqual(['r1']);

		f.liveKitService.listParticipants.mockResolvedValue([]);
		await f.service.refresh('r1');
		expect([...f.redis.sets.get('chatVoice:active') ?? []]).toEqual([]);
	});

	test('re-reads active rooms periodically, one worker per room', async () => {
		const sharedRedis = fakeRedis();
		sharedRedis.sets.set('chatVoice:active', new Set(['r1', 'r2']));
		const workerA = createFixture(sharedRedis);
		const workerB = createFixture(sharedRedis);
		const refreshA = vi.spyOn(workerA.service, 'refresh').mockResolvedValue();
		const refreshB = vi.spyOn(workerB.service, 'refresh').mockResolvedValue();

		await Promise.all([workerA.service.sweep(), workerB.service.sweep()]);

		const refreshed = [...refreshA.mock.calls, ...refreshB.mock.calls].map(call => call[0]).sort();
		expect(refreshed).toEqual(['r1', 'r2']);
		workerA.service.onApplicationShutdown();
		workerB.service.onApplicationShutdown();
	});

	test('coalesces bursts of webhooks into one refresh per room', async () => {
		vi.useFakeTimers();
		const refresh = vi.spyOn(f.service, 'refresh').mockResolvedValue();

		f.service.handleWebhook({ event: 'participant_joined', room: { name: 'chatRoom:r1' } } as any);
		f.service.handleWebhook({ event: 'track_published', room: { name: 'chatRoom:r1' } } as any);
		await vi.advanceTimersByTimeAsync(500);

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledWith('r1');
	});

	test('ignores webhooks for rooms that are not chat rooms', async () => {
		vi.useFakeTimers();
		const refresh = vi.spyOn(f.service, 'refresh').mockResolvedValue();

		f.service.handleWebhook({ event: 'participant_joined', room: { name: 'other:x' } } as any);
		await vi.advanceTimersByTimeAsync(500);

		expect(refresh).not.toHaveBeenCalled();
	});

	test('ignores webhook events that do not change who is in the call', async () => {
		vi.useFakeTimers();
		const refresh = vi.spyOn(f.service, 'refresh').mockResolvedValue();

		f.service.handleWebhook({ event: 'egress_started', room: { name: 'chatRoom:r1' } } as any);
		await vi.advanceTimersByTimeAsync(500);

		expect(refresh).not.toHaveBeenCalled();
	});

	test('returns only rooms that have participants', async () => {
		f.redis.store.set('chatVoice:r1', JSON.stringify({ participants: [{ identity: 'i1', userId: 'u1', screenSharing: false }], updatedAt: 1 }));

		const states = await f.service.getStates({ id: 'me' }, ['r1', 'r2']);

		expect(states.map(state => state.roomId)).toEqual(['r1']);
		expect(f.userEntityService.packMany).toHaveBeenCalledWith(['u1'], { id: 'me' });
	});

	test('issues a join token for the room after making sure it exists', async () => {
		const result = await f.service.issueJoinToken({ id: 'u1', host: null, uri: null } as any, { id: 'r1' } as any, false);

		expect(f.liveKitService.ensureRoom).toHaveBeenCalledWith('r1', 51);
		expect(f.liveKitService.createJoinToken).toHaveBeenCalledWith({ roomId: 'r1', identity: 'https://local.test/users/u1', userId: 'u1', canScreenShare: false });
		expect(result).toEqual({ url: 'https://local.test/livekit', token: 'jwt' });
	});
});
