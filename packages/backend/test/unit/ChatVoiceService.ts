/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindOperator, IsNull } from 'typeorm';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';

function fakeRedis() {
	const store = new Map<string, string>();
	const sets = new Map<string, Set<string>>();
	// EX / PX の寿命は Date.now() で数えるので、偽のタイマーで時間を進めると切れる
	const expiresAt = new Map<string, number>();
	const live = (key: string) => {
		const at = expiresAt.get(key);
		if (at != null && Date.now() >= at) {
			store.delete(key);
			expiresAt.delete(key);
		}
		return store.has(key);
	};
	return {
		store,
		sets,
		get: vi.fn(async (key: string) => (live(key) ? store.get(key)! : null)),
		set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
			if (args.includes('NX') && live(key)) return null;
			store.set(key, value);
			expiresAt.delete(key);
			const ex = args.indexOf('EX');
			if (ex !== -1) expiresAt.set(key, Date.now() + Number(args[ex + 1]) * 1000);
			const px = args.indexOf('PX');
			if (px !== -1) expiresAt.set(key, Date.now() + Number(args[px + 1]));
			return 'OK';
		}),
		pttl: vi.fn(async (key: string) => {
			if (!live(key)) return -2;
			const at = expiresAt.get(key);
			return at == null ? -1 : at - Date.now();
		}),
		del: vi.fn(async (key: string) => {
			expiresAt.delete(key);
			return store.delete(key) ? 1 : 0;
		}),
		mget: vi.fn(async (...keys: string[]) => keys.map(key => (live(key) ? store.get(key)! : null))),
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
	{ id: 'owner', host: null, uri: null, isDeleted: false },
	// 同じサーバーの二人は共有 inbox を持ち、もう一人のサーバーには共有 inbox が無い
	{ id: 'rm1', host: 'remote.test', uri: 'https://remote.test/users/rm1', isDeleted: false, inbox: 'https://remote.test/users/rm1/inbox', sharedInbox: 'https://remote.test/inbox' },
	{ id: 'rm2', host: 'remote.test', uri: 'https://remote.test/users/rm2', isDeleted: false, inbox: 'https://remote.test/users/rm2/inbox', sharedInbox: 'https://remote.test/inbox' },
	{ id: 'rm3', host: 'far.test', uri: 'https://far.test/users/rm3', isDeleted: false, inbox: 'https://far.test/users/rm3/inbox', sharedInbox: null },
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
		genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
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
	const meta = { enableRemoteVoiceCall: true, federation: 'all' };
	// 届けるアクティビティの形はそのまま確かめたいので、本物の ApRendererService を使う
	const apRendererService = Object.assign(Object.create(ApRendererService.prototype), {
		config: { url: 'https://local.test' },
		userEntityService: { genLocalUserUri: (id: string) => `https://local.test/users/${id}` },
	});
	const queueService = {
		deliver: vi.fn(),
	};
	const service = new ChatVoiceService(
		{ url: 'https://local.test' } as any,
		redis as any,
		meta as any,
		chatRoomsRepository as any,
		chatRoomMembershipsRepository as any,
		usersRepository as any,
		liveKitService as any,
		userEntityService as any,
		globalEventService as any,
		roleService as any,
		utilityService as any,
		federatedInstanceService as any,
		apRendererService,
		queueService as any,
	);
	return { service, redis, meta, liveKitService, chatRoomsRepository, chatRoomMembershipsRepository, usersRepository, userEntityService, globalEventService, roleService, utilityService, federatedInstanceService, queueService };
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

	describe('federating the participants', () => {
		const ROOM_URI = 'https://local.test/chat/rooms/r1';
		const u1 = { identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false, micTrackSid: null };

		function withRemoteMembers(fixture = f) {
			fixture.chatRoomMembershipsRepository.findBy.mockResolvedValue([{ userId: 'u1' }, { userId: 'rm1' }, { userId: 'rm2' }, { userId: 'rm3' }]);
		}

		/** 共有 inbox を持たない、別々のサーバーの count 人のメンバー */
		function withManyRemoteMembers(count: number) {
			const members = Array.from({ length: count }, (_, i) => ({
				id: `many${i}`,
				host: `s${i}.test`,
				uri: `https://s${i}.test/users/many${i}`,
				isDeleted: false,
				inbox: `https://s${i}.test/users/many${i}/inbox`,
				sharedInbox: null,
			}));
			f.chatRoomMembershipsRepository.findBy.mockResolvedValue(members.map(member => ({ userId: member.id })));
			f.usersRepository.findBy.mockImplementation(async (where: Record<string, unknown>) => [...KNOWN_USERS, ...members].filter(user => matchesWhere(user, where)));
		}

		function deliveredObjects(fixture = f) {
			return fixture.queueService.deliver.mock.calls.map(([, activity]) => activity.object);
		}

		/** inbox ごとの、送った時刻と参加者 */
		function recordDeliveries() {
			const sent = new Map<string, { at: number; participants: unknown[] }[]>();
			f.queueService.deliver.mockImplementation((_user: unknown, activity: { object: { participants: unknown[] } }, to: string) => {
				if (!sent.has(to)) sent.set(to, []);
				sent.get(to)!.push({ at: Date.now(), participants: activity.object.participants });
			});
			return sent;
		}

		/** 参加者の現況を変えて webhook を受ける (LiveKit からは 600 ミリ秒ごとに届く) */
		async function changeEvery600ms(states: (typeof u1)[][], event: string) {
			for (const participants of states) {
				f.liveKitService.listParticipants.mockResolvedValue(participants);
				f.service.handleWebhook({ event, room: { name: 'chatRoom:r1' } } as any);
				await vi.advanceTimersByTimeAsync(600);
			}
		}

		test('delivers one Update per remote server, from the room owner', async () => {
			withRemoteMembers();

			await f.service.federateSnapshot(localRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: true }], Date.parse('2026-10-27T00:00:00.000Z'));

			expect(f.queueService.deliver.mock.calls.map(([, , to, isSharedInbox]) => [to, isSharedInbox]).sort()).toEqual([
				['https://far.test/users/rm3/inbox', false],
				['https://remote.test/inbox', true],
			]);
			for (const [user, activity] of f.queueService.deliver.mock.calls) {
				expect(user).toEqual(expect.objectContaining({ id: 'owner', host: null }));
				expect(activity).toEqual(expect.objectContaining({
					'@context': expect.arrayContaining([expect.objectContaining({ ChatRoomVoiceState: 'cherrypick:ChatRoomVoiceState' })]),
					type: 'Update',
					actor: 'https://local.test/users/owner',
					object: {
						id: `${ROOM_URI}/voice`,
						type: 'ChatRoomVoiceState',
						room: ROOM_URI,
						participants: [{ id: 'https://local.test/users/u1', screenSharing: true }],
						updated: '2026-10-27T00:00:00.000Z',
					},
				}));
				// 通話の参加者はルームのメンバーにだけ知らせるもので、公開の情報ではない
				expect(activity.to).toBeUndefined();
			}
		});

		test('delivers nothing when every member is local', async () => {
			f.chatRoomMembershipsRepository.findBy.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);

			await f.service.federateSnapshot(localRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 1000);

			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});

		test('delivers nothing for a room owned on another server', async () => {
			withRemoteMembers();

			await f.service.federateSnapshot(localRoom({ ownerId: 'x1', owner: { id: 'x1', host: 'other.test' } }), [], 1000);

			expect(f.queueService.deliver).not.toHaveBeenCalled();
		});

		test('does not resend an unchanged snapshot within 240 seconds', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');
			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);

			f.queueService.deliver.mockClear();
			vi.setSystemTime(1_000_000 + 239_000);
			await f.service.refresh('r1');
			expect(f.queueService.deliver).not.toHaveBeenCalled();

			vi.setSystemTime(1_000_000 + 240_000);
			await f.service.refresh('r1');
			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);

			// 前に送ってから 10 秒経っていれば、参加者の変化は間を置かずに送る
			f.queueService.deliver.mockClear();
			vi.setSystemTime(1_000_000 + 250_000);
			f.liveKitService.listParticipants.mockResolvedValue([{ ...u1, screenSharing: true }]);
			await f.service.refresh('r1');
			expect(deliveredObjects().map(object => object.participants)).toEqual([
				[{ id: 'https://local.test/users/u1', screenSharing: true }],
				[{ id: 'https://local.test/users/u1', screenSharing: true }],
			]);
		});

		test('always sends the empty snapshot that ends a call', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.liveKitService.listParticipants.mockResolvedValue([u1]);
			await f.service.refresh('r1');
			f.queueService.deliver.mockClear();

			// 参加者を送ったばかりでも、通話の終わりは待たずに送る
			vi.setSystemTime(1_001_000);
			f.liveKitService.listParticipants.mockResolvedValue([]);
			await f.service.refresh('r1');

			expect(deliveredObjects().map(object => object.participants)).toEqual([[], []]);
		});

		test('sends only the first of repeated empty snapshots within 10 seconds', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			f.liveKitService.listParticipants.mockResolvedValue([]);

			await f.service.refresh('r1');
			vi.setSystemTime(1_005_000);
			await f.service.refresh('r1');
			expect(f.queueService.deliver).toHaveBeenCalledTimes(2);

			vi.setSystemTime(1_010_000);
			await f.service.refresh('r1');
			expect(f.queueService.deliver).toHaveBeenCalledTimes(4);
		});

		test('federates rapid changes at most once every 10 seconds, ending with the latest state', async () => {
			withManyRemoteMembers(50);
			vi.useFakeTimers({ now: 1_000_000 });
			const sent = recordDeliveries();

			// 60 秒のあいだ、画面共有を 600 ミリ秒ごとに切り替える
			await changeEvery600ms(Array.from({ length: 100 }, (_, i) => [{ ...u1, screenSharing: i % 2 === 1 }]), 'track_published');
			await vi.advanceTimersByTimeAsync(20_000);

			expect(sent.size).toBe(50);
			for (const deliveries of sent.values()) {
				expect(deliveries.length).toBeLessThanOrEqual(7);
				expect(deliveries.at(-1)!.participants).toEqual([{ id: 'https://local.test/users/u1', screenSharing: true }]);
			}
		});

		test('sends one empty snapshot per 10 seconds while people keep joining and leaving', async () => {
			withRemoteMembers();
			vi.useFakeTimers({ now: 1_000_000 });
			const sent = recordDeliveries();

			await changeEvery600ms(Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? [u1] : [])), 'participant_left');
			await vi.advanceTimersByTimeAsync(20_000);

			expect(sent.size).toBe(2);
			for (const deliveries of sent.values()) {
				const empties = deliveries.filter(delivery => delivery.participants.length === 0);
				expect(empties.length).toBeGreaterThan(1);
				for (let i = 1; i < empties.length; i++) {
					expect(empties[i].at - empties[i - 1].at).toBeGreaterThanOrEqual(10_000);
				}
				// 通話は空で終わったので、最後に送ったものも空
				expect(deliveries.at(-1)!.participants).toEqual([]);
			}
		});

		test('shares the 10 second budget between workers', async () => {
			const sharedRedis = fakeRedis();
			const workerA = createFixture(sharedRedis);
			const workerB = createFixture(sharedRedis);
			withRemoteMembers(workerA);
			withRemoteMembers(workerB);
			vi.useFakeTimers({ now: 1_000_000 });

			try {
				workerA.liveKitService.listParticipants.mockResolvedValue([u1]);
				await workerA.service.refresh('r1');
				workerB.liveKitService.listParticipants.mockResolvedValue([{ ...u1, screenSharing: true }]);
				await workerB.service.refresh('r1');

				expect(workerA.queueService.deliver).toHaveBeenCalledTimes(2);
				expect(workerB.queueService.deliver).not.toHaveBeenCalled();

				// 送れなかった変化は、間隔が空いたときに最新の現況を読み直して送る
				await vi.advanceTimersByTimeAsync(10_000);
				expect(deliveredObjects(workerB).map(object => object.participants)).toEqual([
					[{ id: 'https://local.test/users/u1', screenSharing: true }],
					[{ id: 'https://local.test/users/u1', screenSharing: true }],
				]);
			} finally {
				workerA.service.onApplicationShutdown();
				workerB.service.onApplicationShutdown();
			}
		});

		test('sends after notifying this server\'s members', async () => {
			withRemoteMembers();
			f.liveKitService.listParticipants.mockResolvedValue([u1]);

			await f.service.refresh('r1');

			const notifiedAt = Math.max(...f.globalEventService.publishMainStream.mock.invocationCallOrder);
			expect(Math.min(...f.queueService.deliver.mock.invocationCallOrder)).toBeGreaterThan(notifiedAt);
		});
	});

	describe('receiving the participants of a mirror room', () => {
		const ROOM_URI = 'https://remote.test/chat/rooms/r1';
		const owner = { id: 'remoteOwner', host: 'remote.test', uri: 'https://remote.test/users/remoteOwner' } as any;

		function voiceState(overrides: Record<string, unknown> = {}) {
			return {
				id: `${ROOM_URI}/voice`,
				type: 'ChatRoomVoiceState',
				room: ROOM_URI,
				participants: [{ id: 'https://local.test/users/u1', screenSharing: true }],
				updated: new Date(2000).toISOString(),
				...overrides,
			} as any;
		}

		beforeEach(() => {
			f.chatRoomsRepository.findOneBy.mockImplementation(async ({ id }: { id: string }) => (id === 'r1' ? { id: 'r1', ownerId: 'remoteOwner' } : null) as any);
		});

		test('accepts a voice state from the owner of the mirror room', async () => {
			const result = await f.service.receiveRemoteSnapshot(owner, voiceState());

			expect(result).toMatch(/^ok/);
			expect(f.chatRoomsRepository.findOneBy).toHaveBeenCalledWith({ id: 'r1' });
			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!)).toEqual({
				participants: [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: true }],
				updatedAt: 2000,
			});
			expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('m1', 'chatRoomVoiceState', expect.objectContaining({ roomId: 'r1' }));
		});

		test('ignores a voice state from someone who does not own the room', async () => {
			const someoneElse = { id: 'someoneElse', host: 'remote.test', uri: 'https://remote.test/users/someoneElse' } as any;

			const result = await f.service.receiveRemoteSnapshot(someoneElse, voiceState());

			expect(result).toMatch(/^skip:/);
			expect(f.redis.store.has('chatVoice:r1')).toBe(false);
		});

		test('ignores a voice state whose room lives on another server', async () => {
			const cases = [
				{ actor: owner, state: voiceState({ room: 'https://other.test/chat/rooms/r1', id: 'https://other.test/chat/rooms/r1/voice' }) },
				{ actor: owner, state: voiceState({ room: 'https://other.test/chat/rooms/r1' }) },
				{ actor: owner, state: voiceState({ id: 'https://other.test/chat/rooms/r1/voice' }) },
				{ actor: owner, state: voiceState({ room: 'http://remote.test/chat/rooms/r1', id: 'http://remote.test/chat/rooms/r1/voice' }) },
				{ actor: owner, state: voiceState({ room: 'https://remote.test:8443/chat/rooms/r1', id: 'https://remote.test:8443/chat/rooms/r1/voice' }) },
				// ポート付きのホストどうしも、別のサーバーとして扱う
				{
					actor: { ...owner, host: 'remote.test:8443', uri: 'https://remote.test:8443/users/remoteOwner' },
					state: voiceState({ room: 'https://other.test:8443/chat/rooms/r1', id: 'https://other.test:8443/chat/rooms/r1/voice' }),
				},
			];
			for (const { actor, state } of cases) {
				expect(await f.service.receiveRemoteSnapshot(actor, state), state.room).toMatch(/^skip:/);
			}
			expect(f.redis.store.has('chatVoice:r1')).toBe(false);
		});

		test('accepts a voice state from an owner on a server with a port', async () => {
			const portOwner = { ...owner, host: 'remote.test:8443', uri: 'https://remote.test:8443/users/remoteOwner' };

			const result = await f.service.receiveRemoteSnapshot(portOwner, voiceState({ room: 'https://remote.test:8443/chat/rooms/r1', id: 'https://remote.test:8443/chat/rooms/r1/voice' }));

			expect(result).toMatch(/^ok/);
			expect(f.redis.store.has('chatVoice:r1')).toBe(true);
		});

		test('ignores a voice state for a room this server does not mirror', async () => {
			const result = await f.service.receiveRemoteSnapshot(owner, voiceState({ room: 'https://remote.test/chat/rooms/r9', id: 'https://remote.test/chat/rooms/r9/voice' }));

			expect(result).toMatch(/^skip:/);
			expect(f.redis.set).not.toHaveBeenCalled();
		});

		test('ignores a malformed voice state', async () => {
			const store = vi.spyOn(f.service, 'storeRemoteSnapshot');
			const malformed = [
				{ id: undefined },
				{ room: undefined },
				{ room: `${ROOM_URI}?x=1` },
				{ room: `${ROOM_URI}#x` },
				{ room: `${ROOM_URI}/extra` },
				{ room: 'https://remote.test/chat/rooms/' },
				{ room: 'https://remote.test/chat/rooms/r-1' },
				{ room: 'not a url' },
				{ participants: undefined },
				{ participants: 'https://local.test/users/u1' },
				{ participants: Array.from({ length: 52 }, (_, i) => ({ id: `https://far.test/users/${i}`, screenSharing: false })) },
				{ participants: [null] },
				{ participants: [{ id: 1, screenSharing: false }] },
				{ participants: [{ id: 'https://local.test/users/u1' }] },
				{ participants: [{ id: 'https://local.test/users/u1', screenSharing: 'yes' }] },
				{ updated: undefined },
				{ updated: 2000 },
				{ updated: 'yesterday' },
			];
			for (const overrides of malformed) {
				expect(await f.service.receiveRemoteSnapshot(owner, voiceState(overrides)), JSON.stringify(overrides)).toMatch(/^skip:/);
			}
			expect(store).not.toHaveBeenCalled();
		});

		test('accepts as many participants as a room can hold', async () => {
			const participants = Array.from({ length: 51 }, (_, i) => ({ id: `https://far.test/users/${i}`, screenSharing: false }));

			expect(await f.service.receiveRemoteSnapshot(owner, voiceState({ participants }))).toMatch(/^ok/);
		});

		test('ignores voice states while this server does not join calls on other servers', async () => {
			for (const meta of [{ enableRemoteVoiceCall: false, federation: 'all' }, { enableRemoteVoiceCall: true, federation: 'none' }]) {
				Object.assign(f.meta, meta);

				expect(await f.service.receiveRemoteSnapshot(owner, voiceState()), JSON.stringify(meta)).toMatch(/^skip:/);
			}
			expect(f.redis.set).not.toHaveBeenCalled();
		});

		test('keeps the newer snapshot when an older one arrives late', async () => {
			await f.service.receiveRemoteSnapshot(owner, voiceState({ updated: new Date(3000).toISOString() }));
			await f.service.receiveRemoteSnapshot(owner, voiceState({
				updated: new Date(2000).toISOString(),
				participants: [{ id: 'https://local.test/users/u2', screenSharing: false }],
			}));

			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!)).toEqual({
				participants: [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: true }],
				updatedAt: 3000,
			});
		});

		test('expires a mirror snapshot after ten minutes', async () => {
			await f.service.receiveRemoteSnapshot(owner, voiceState());

			expect(f.redis.set).toHaveBeenCalledWith('chatVoice:r1', expect.any(String), 'EX', 600);
			expect(f.redis.sadd).not.toHaveBeenCalled();
		});
	});
});
