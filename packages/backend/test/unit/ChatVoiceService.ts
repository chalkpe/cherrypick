/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindOperator, IsNull } from 'typeorm';
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

// このサーバーの DB にいるユーザー
const KNOWN_USERS = [
	{ id: 'u1', host: null, uri: null, isDeleted: false },
	{ id: 'u2', host: null, uri: null, isDeleted: false },
	{ id: 'deletedLocal', host: null, uri: null, isDeleted: true },
	{ id: 'x1', host: 'other.test', uri: 'https://other.test/users/x', isDeleted: false },
	{ id: 'deletedRemote', host: 'other.test', uri: 'https://other.test/users/deleted', isDeleted: true },
];

/** usersRepository.findBy の where (等値・In・IsNull) を KNOWN_USERS に当てる */
function matchesWhere(user: Record<string, unknown>, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (condition instanceof FindOperator) {
			if (condition.type === 'in') return (condition.value as unknown[]).includes(user[key]);
			if (condition.type === 'isNull') return user[key] == null;
			throw new Error(`unsupported operator: ${condition.type}`);
		}
		return user[key] === condition;
	});
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
		exists: vi.fn(async () => true),
	};
	const userEntityService = {
		packMany: vi.fn(async (ids: string[]) => ids.map(id => ({ id, username: id }))),
	};
	const globalEventService = {
		publishChatRoomStream: vi.fn(),
		publishMainStream: vi.fn(),
	};
	const roleService = {
		getUserPolicies: vi.fn(async () => ({ canVoiceCall: true, canScreenShare: true, chatAvailability: 'available' })),
	};
	const utilityService = {
		isFederationAllowedHost: vi.fn((_host: string) => true),
	};
	const federatedInstanceService = {
		fetch: vi.fn(async (host: string) => ({ host, suspensionState: 'none' })),
	};
	const usersRepository = {
		findBy: vi.fn(async (where: Record<string, unknown>) => KNOWN_USERS.filter(user => matchesWhere(user, where))),
	};
	const service = new ChatVoiceService(
		{ url: 'https://local.test' } as any,
		redis as any,
		chatRoomsRepository as any,
		chatRoomMembershipsRepository as any,
		usersRepository as any,
		liveKitService as any,
		userEntityService as any,
		globalEventService as any,
		roleService as any,
		utilityService as any,
		federatedInstanceService as any,
	);
	return { service, redis, liveKitService, chatRoomsRepository, chatRoomMembershipsRepository, usersRepository, userEntityService, globalEventService, roleService, utilityService, federatedInstanceService };
}

function remoteUser(overrides: Record<string, unknown> = {}) {
	return { id: 'ru1', host: 'remote.test', uri: 'https://remote.test/users/ru1', isSuspended: false, ...overrides } as any;
}

function localRoom(overrides: Record<string, unknown> = {}) {
	return { id: 'r1', ownerId: 'owner', owner: { id: 'owner', host: null }, isArchived: false, ...overrides } as any;
}

function mirrorRoom() {
	return { id: 'r1', ownerId: 'remoteOwner', owner: { id: 'remoteOwner', host: 'remote.test', uri: 'https://remote.test/users/remoteOwner' }, isArchived: false } as any;
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

	describe('remote members', () => {
		test('issues a join token to a remote room member and includes the current participants', async () => {
			f.redis.store.set('chatVoice:r1', JSON.stringify({ participants: [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: true }], updatedAt: 1234 }));

			const result = await f.service.issueRemoteJoinToken(remoteUser(), localRoom(), false);

			expect(f.chatRoomMembershipsRepository.exists).toHaveBeenCalledWith({ where: { roomId: 'r1', userId: 'ru1' } });
			expect(f.liveKitService.ensureRoom).toHaveBeenCalledWith('r1', 51);
			expect(f.liveKitService.createJoinToken).toHaveBeenCalledWith({ roomId: 'r1', identity: 'https://remote.test/users/ru1', userId: 'ru1', canScreenShare: false });
			expect(result).toEqual({
				url: 'https://local.test/livekit',
				token: 'jwt',
				participants: [{ identity: 'https://local.test/users/u1', screenSharing: true }],
				updatedAt: 1234,
			});
		});

		test('refuses a remote user who is not a member', async () => {
			f.chatRoomMembershipsRepository.exists.mockResolvedValue(false);

			const result = await f.service.issueRemoteJoinToken(remoteUser(), localRoom(), false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user whose server is blocked or suspended', async () => {
			f.utilityService.isFederationAllowedHost.mockReturnValueOnce(false);
			expect(await f.service.issueRemoteJoinToken(remoteUser(), localRoom(), false)).toBe('forbidden');
			expect(f.utilityService.isFederationAllowedHost).toHaveBeenCalledWith('remote.test');

			f.federatedInstanceService.fetch.mockResolvedValueOnce({ host: 'remote.test', suspensionState: 'manuallySuspended' });
			expect(await f.service.issueRemoteJoinToken(remoteUser(), localRoom(), false)).toBe('forbidden');
			expect(f.federatedInstanceService.fetch).toHaveBeenCalledWith('remote.test');

			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('allows screen sharing only when both servers allow it', async () => {
			const cases = [
				{ requested: true, hostAllows: true, expected: true },
				{ requested: true, hostAllows: false, expected: false },
				{ requested: false, hostAllows: true, expected: false },
			];
			for (const { requested, hostAllows, expected } of cases) {
				f.liveKitService.createJoinToken.mockClear();
				f.roleService.getUserPolicies.mockResolvedValueOnce({ canVoiceCall: true, canScreenShare: hostAllows, chatAvailability: 'available' });

				await f.service.issueRemoteJoinToken(remoteUser(), localRoom(), requested);

				expect(f.liveKitService.createJoinToken).toHaveBeenCalledWith(expect.objectContaining({ canScreenShare: expected }));
			}
			expect(f.roleService.getUserPolicies).toHaveBeenCalledWith('ru1');
		});

		test('refuses a room this server does not own', async () => {
			const mirror = localRoom({ ownerId: 'remoteOwner', owner: { id: 'remoteOwner', host: 'other.test' } });

			const result = await f.service.issueRemoteJoinToken(remoteUser(), mirror, false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a suspended remote user', async () => {
			const result = await f.service.issueRemoteJoinToken(remoteUser({ isSuspended: true }), localRoom(), false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user whose role here cannot join voice calls', async () => {
			f.roleService.getUserPolicies.mockResolvedValueOnce({ canVoiceCall: false, canScreenShare: true, chatAvailability: 'available' });

			const result = await f.service.issueRemoteJoinToken(remoteUser(), localRoom(), false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user who may not write in chats here, as for local members', async () => {
			for (const chatAvailability of ['readonly', 'unavailable']) {
				f.roleService.getUserPolicies.mockResolvedValueOnce({ canVoiceCall: true, canScreenShare: true, chatAvailability });

				const result = await f.service.issueRemoteJoinToken(remoteUser(), localRoom(), false);

				expect(result, chatAvailability).toBe('forbidden');
			}
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses an archived room, as for local members', async () => {
			const result = await f.service.issueRemoteJoinToken(remoteUser(), localRoom({ isArchived: true }), false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('reports an empty call stamped with the current time when nothing is stored', async () => {
			vi.useFakeTimers({ now: 5000 });

			expect(await f.service.snapshotOf('r1')).toEqual({ participants: [], updatedAt: 5000 });
		});
	});

	describe('mirror rooms', () => {
		test('storeRemoteSnapshot resolves identities to local users and ignores older snapshots', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://local.test/users/u1', screenSharing: true },
				{ identity: 'https://other.test/users/x', screenSharing: false },
				{ identity: 'https://gone.test/users/y', screenSharing: false },
			], 2000);

			expect(f.redis.set).toHaveBeenCalledWith('chatVoice:r1', expect.any(String), 'EX', 600);
			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!)).toEqual({
				participants: [
					{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: true },
					{ identity: 'https://other.test/users/x', userId: 'x1', screenSharing: false },
				],
				updatedAt: 2000,
			});

			const stored = f.redis.store.get('chatVoice:r1');
			f.globalEventService.publishChatRoomStream.mockClear();
			for (const updatedAt of [1000, 2000]) {
				await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://other.test/users/x', screenSharing: true }], updatedAt);
			}
			expect(f.redis.store.get('chatVoice:r1')).toBe(stored);
			expect(f.globalEventService.publishChatRoomStream).not.toHaveBeenCalled();

			await f.service.storeRemoteSnapshot(mirrorRoom(), [], 3000);
			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!)).toEqual({ participants: [], updatedAt: 3000 });
		});

		test('storeRemoteSnapshot announces to the room and its local members, not the remote owner', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000);

			expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith('r1', 'voiceState', {
				roomId: 'r1',
				participants: [{ identity: 'https://local.test/users/u1', user: expect.objectContaining({ id: 'u1' }), screenSharing: false }],
			});
			expect(f.chatRoomMembershipsRepository.findBy).toHaveBeenCalledWith({ roomId: 'r1', user: { host: IsNull() } });
			expect(f.globalEventService.publishMainStream.mock.calls.map(call => call[0])).toEqual(['m1']);
			expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('m1', 'chatRoomVoiceState', expect.objectContaining({ roomId: 'r1' }));
		});

		test('storeRemoteSnapshot keeps mirror rooms out of the periodic LiveKit re-read', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000);

			expect(f.redis.sets.get('chatVoice:active') ?? new Set()).not.toContain('r1');
			expect(f.redis.sadd).not.toHaveBeenCalled();
		});

		test('storeRemoteSnapshot looks up at most as many identities as a room can hold', async () => {
			const participants = Array.from({ length: 60 }, (_, i) => ({ identity: `https://far.test/users/${i}`, screenSharing: false }));

			await f.service.storeRemoteSnapshot(mirrorRoom(), participants, 2000);

			const lookedUp = f.usersRepository.findBy.mock.calls.flatMap(([where]) => (where.uri as FindOperator<string[]>).value);
			expect(lookedUp).toHaveLength(51);
		});

		test('storeRemoteSnapshot drops identities this server does not know, without fetching them', async () => {
			const fetchSpy = vi.spyOn(globalThis, 'fetch');
			try {
				await f.service.storeRemoteSnapshot(mirrorRoom(), [
					{ identity: 'https://other.test/users/x', screenSharing: false },
					{ identity: 'https://evil.test/users/fresh', screenSharing: false },
				], 2000);
			} finally {
				fetchSpy.mockRestore();
			}

			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!).participants).toEqual([
				{ identity: 'https://other.test/users/x', userId: 'x1', screenSharing: false },
			]);
			expect(fetchSpy).not.toHaveBeenCalled();
			// 他のサーバーのユーザーは uri の完全一致で探す
			expect(f.usersRepository.findBy).toHaveBeenCalledWith({ uri: expect.any(FindOperator), isDeleted: false });
		});

		test('storeRemoteSnapshot drops a local-looking identity that is not a local user of this server', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://local.test/users/x1', screenSharing: false },
				{ identity: 'https://local.test/users/nobody', screenSharing: false },
				{ identity: 'https://local.test/users/u2', screenSharing: false },
			], 2000);

			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!).participants).toEqual([
				{ identity: 'https://local.test/users/u2', userId: 'u2', screenSharing: false },
			]);
		});

		test('storeRemoteSnapshot drops deleted users', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://local.test/users/deletedLocal', screenSharing: false },
				{ identity: 'https://other.test/users/deleted', screenSharing: false },
			], 2000);

			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!).participants).toEqual([]);
		});

		test('storeRemoteSnapshot ignores local identities that are not plain user ids', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://local.test/users/u1/followers', screenSharing: false },
				{ identity: 'https://local.test/users/', screenSharing: false },
			], 2000);

			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!).participants).toEqual([]);
			expect(f.usersRepository.findBy).not.toHaveBeenCalled();
		});
	});
});
