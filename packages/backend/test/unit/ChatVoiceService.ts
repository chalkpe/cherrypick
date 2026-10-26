/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindOperator, IsNull } from 'typeorm';
import { Redis } from 'ioredis';
import { loadConfig } from '@/config.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import UpdateInstanceEndpoint from '@/server/api/endpoints/admin/federation/update-instance.js';

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
		del: vi.fn(async (...keys: string[]) => {
			let deleted = 0;
			for (const key of keys) {
				expiresAt.delete(key);
				if (store.delete(key)) deleted++;
			}
			return deleted;
		}),
		// ミラーの現況を保存するスクリプト (保存済みのものより新しいときだけ書く) と同じ動きをする。
		// 本物の Redis と同じく、比べてから書くまでのあいだに他の呼び出しが割り込まない
		eval: vi.fn(async (_script: string, _numKeys: number, key: string, value: string, updatedAt: number | string, ttlSeconds: number | string) => {
			if (live(key) && (JSON.parse(store.get(key)!) as { updatedAt: number }).updatedAt >= Number(updatedAt)) return 0;
			store.set(key, value);
			expiresAt.set(key, Date.now() + Number(ttlSeconds) * 1000);
			return 1;
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
	// ミラーのルーム (mirrorRoom) の持ち主
	{ id: 'remoteOwner', host: 'remote.test', uri: 'https://remote.test/users/remoteOwner', isDeleted: false },
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

type InstanceRow = { id?: string; host: string; suspensionState: string; quarantineLimited?: boolean };

function createFixture(redis = fakeRedis(), instances: InstanceRow[] = []) {
	const liveKitService = {
		isEnabled: true,
		getPublicUrl: () => 'https://local.test/livekit',
		identityOf: (user: { id: string; host: string | null; uri: string | null }) => user.host == null ? `https://local.test/users/${user.id}` : user.uri,
		roomIdOf: (name: string) => name.startsWith('chatRoom:') ? name.slice('chatRoom:'.length) : null,
		listParticipants: vi.fn(),
		ensureRoom: vi.fn(),
		createJoinToken: vi.fn().mockResolvedValue('jwt'),
		removeParticipant: vi.fn(async (_roomId: string, _identity: string) => {}),
	};
	// 他のサーバーのユーザーがトークンを求めるルーム (owner を読み込んだもの)。r1 だけがある
	const rooms = new Map<string, ReturnType<typeof localRoom>>([['r1', localRoom()]]);
	const chatRoomsRepository = {
		findOneBy: vi.fn(async ({ id }: { id: string }) => ({ id, ownerId: 'owner' })),
		findOne: vi.fn(async ({ where }: { where: { id: string } }) => rooms.get(where.id) ?? null),
		// 持ち主が他のサーバーのユーザーのルーム (ミラー) を id 順に引く。where は持ち主の host と、続きを引くときの id だけを当てる
		find: vi.fn(async ({ where, take }: { where: { id?: FindOperator<string>; owner: { host: FindOperator<unknown> } }; take: number }) => {
			const ownerHost = where.owner.host;
			if (ownerHost.type !== 'not' || ownerHost.child?.type !== 'isNull') throw new Error('unsupported condition');
			if (where.id != null && where.id.type !== 'moreThan') throw new Error('unsupported condition');
			return [...rooms.values()]
				.filter(room => room.owner?.host != null && (where.id == null || room.id > (where.id.value as string)))
				.sort((a, b) => (a.id < b.id ? -1 : 1))
				.slice(0, take)
				.map(room => ({ id: room.id }));
		}),
	};
	// 通話に残れるかを確かめるときは、ルームのメンバーを userId の In で引く。nonMembers に入れたユーザーはメンバーでない
	const nonMembers = new Set<string>();
	const chatRoomMembershipsRepository = {
		findBy: vi.fn(async (where: Record<string, unknown> = {}) => {
			const userIds = where.userId;
			if (userIds instanceof FindOperator) {
				return (userIds.value as string[]).filter(userId => !nonMembers.has(userId)).map(userId => ({ roomId: where.roomId, userId }));
			}
			return [{ userId: 'm1' }];
		}),
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
	const meta = { enableRemoteVoiceCall: true, federation: 'all', federationHosts: [] as string[], blockedHosts: [] as string[] };
	// 実物を使い、ブロックの判定 (ポート付きのホストを含む) と記録を引く host の正規化もそのまま確かめる
	const utilityService = new UtilityService({ host: 'local.test', url: 'https://local.test' } as any, meta as any);
	vi.spyOn(utilityService, 'isFederationAllowedHost');
	// instance.host は保存されたとおりの文字列で引かれる。正規化はサービスの側でする
	const instancesRepository = {
		rows: instances,
		findBy: vi.fn(async (where: Record<string, unknown>) => instances.filter(instance => matchesWhere(instance, where))),
	};
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const loggerService = { getLogger: () => logger };
	// 内部イベント (metaUpdated など) は Redis の購読から届く
	const redisForSub = new EventEmitter();
	const usersRepository = {
		findBy: vi.fn(async (where: Record<string, unknown>) => KNOWN_USERS.filter(user => matchesWhere(user, where))),
	};
	// 届けるアクティビティの形はそのまま確かめたいので、本物の ApRendererService を使う
	const apRendererService = Object.assign(Object.create(ApRendererService.prototype), {
		config: { url: 'https://local.test' },
		userEntityService: { genLocalUserUri: (id: string) => `https://local.test/users/${id}` },
	});
	const queueService = {
		deliver: vi.fn(),
	};
	// TURN が設定されていないときと同じ
	const cloudflareTurnService = {
		getIceServers: vi.fn(async (): Promise<{ urls: string[]; username?: string; credential?: string }[] | null> => null),
	};
	const service = new ChatVoiceService(
		{ url: 'https://local.test' } as any,
		redis as any,
		redisForSub as any,
		meta as any,
		chatRoomsRepository as any,
		chatRoomMembershipsRepository as any,
		usersRepository as any,
		instancesRepository as any,
		liveKitService as any,
		userEntityService as any,
		globalEventService as any,
		roleService as any,
		utilityService,
		apRendererService,
		queueService as any,
		loggerService as any,
		cloudflareTurnService as any,
	);
	return { service, redis, redisForSub, meta, liveKitService, rooms, chatRoomsRepository, chatRoomMembershipsRepository, usersRepository, instancesRepository, userEntityService, globalEventService, roleService, utilityService, queueService, cloudflareTurnService, logger, nonMembers };
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

	test('stores the participant snapshot and announces it to the room\'s members', async () => {
		f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: true, micTrackSid: 'TR' }]);

		await f.service.refresh('r1');

		expect(JSON.parse(f.redis.store.get('chatVoice:r1')!).participants).toEqual([{ identity: 'i1', userId: 'u1', screenSharing: true }]);
		expect(f.globalEventService.publishMainStream.mock.calls.map(call => call[0]).sort()).toEqual(['m1', 'owner']);
		expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('owner', 'chatRoomVoiceState', {
			roomId: 'r1',
			participants: [{ identity: 'i1', user: expect.objectContaining({ id: 'u1' }), screenSharing: true }],
		});
	});

	test('clears the snapshot when the call becomes empty', async () => {
		f.redis.store.set('chatVoice:r1', JSON.stringify({ participants: [{ identity: 'i1', userId: 'u1', screenSharing: false }], updatedAt: 1 }));
		f.liveKitService.listParticipants.mockResolvedValue([]);

		await f.service.refresh('r1');

		expect(f.redis.store.has('chatVoice:r1')).toBe(false);
		expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('owner', 'chatRoomVoiceState', { roomId: 'r1', participants: [] });
	});

	test('leaves out participants whose user no longer exists', async () => {
		f.liveKitService.listParticipants.mockResolvedValue([
			{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null },
			{ identity: 'gone', userId: 'deleted', screenSharing: false, micTrackSid: null },
		]);
		f.userEntityService.packMany.mockImplementation(async (ids: string[]) => ids.filter(id => id !== 'deleted').map(id => ({ id, username: id })));

		await f.service.refresh('r1');

		expect(f.globalEventService.publishMainStream.mock.calls[0][2].participants.map((p: { identity: string }) => p.identity)).toEqual(['i1']);
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
		const reconcileA = vi.spyOn(workerA.service, 'reconcileRoom').mockResolvedValue();
		const reconcileB = vi.spyOn(workerB.service, 'reconcileRoom').mockResolvedValue();

		await Promise.all([workerA.service.sweep(), workerB.service.sweep()]);

		const refreshed = [...refreshA.mock.calls, ...refreshB.mock.calls].map(call => call[0]).sort();
		expect(refreshed).toEqual(['r1', 'r2']);
		// 読み直すワーカーが、いまも入れるかも確かめ直す
		const reconciled = [...reconcileA.mock.calls, ...reconcileB.mock.calls].map(call => call[0]).sort();
		expect(reconciled).toEqual(['r1', 'r2']);
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
		expect(result).toEqual({ url: 'https://local.test/livekit', token: 'jwt', iceServers: null });
	});

	test('hands out the TURN servers with the join token when they are configured', async () => {
		const iceServers = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }];
		f.cloudflareTurnService.getIceServers.mockResolvedValue(iceServers);

		const result = await f.service.issueJoinToken({ id: 'u1', host: null, uri: null } as any, { id: 'r1' } as any, false);

		expect(result).toEqual({ url: 'https://local.test/livekit', token: 'jwt', iceServers });
	});

	describe('remote members', () => {
		test('issues a join token to a remote room member and includes the current participants', async () => {
			f.redis.store.set('chatVoice:r1', JSON.stringify({ participants: [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: true }], updatedAt: 1234 }));

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(f.chatRoomsRepository.findOne).toHaveBeenCalledWith({ where: { id: 'r1' }, relations: { owner: true } });
			expect(f.chatRoomMembershipsRepository.exists).toHaveBeenCalledWith({ where: { roomId: 'r1', userId: 'ru1' } });
			expect(f.liveKitService.ensureRoom).toHaveBeenCalledWith('r1', 51);
			expect(f.liveKitService.createJoinToken).toHaveBeenCalledWith({ roomId: 'r1', identity: 'https://remote.test/users/ru1', userId: 'ru1', canScreenShare: false });
			expect(result).toEqual({
				url: 'https://local.test/livekit',
				token: 'jwt',
				iceServers: null,
				participants: [{ identity: 'https://local.test/users/u1', screenSharing: true }],
				updatedAt: 1234,
			});
		});

		test('hands this server\'s TURN servers to remote members too', async () => {
			const iceServers = [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }];
			f.cloudflareTurnService.getIceServers.mockResolvedValue(iceServers);

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(result).toMatchObject({ token: 'jwt', iceServers });
		});

		test('refuses a room that does not exist', async () => {
			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'gone', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		// ルームがあるかどうかで、読んだものと、読めなかったときの結果が変わらないようにする
		test('reads the room, the membership, the server\'s records and the role policies before deciding', async () => {
			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'gone', false);

			expect(result).toBe('forbidden');
			expect(f.chatRoomsRepository.findOne).toHaveBeenCalledWith({ where: { id: 'gone' }, relations: { owner: true } });
			expect(f.chatRoomMembershipsRepository.exists).toHaveBeenCalledWith({ where: { roomId: 'gone', userId: 'ru1' } });
			expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(1);
			expect(f.roleService.getUserPolicies).toHaveBeenCalledWith('ru1');
		});

		test.each([
			['the room', (fixture: ReturnType<typeof createFixture>) => fixture.chatRoomsRepository.findOne.mockRejectedValue(new Error('db is down'))],
			['the membership', (fixture: ReturnType<typeof createFixture>) => fixture.chatRoomMembershipsRepository.exists.mockRejectedValue(new Error('db is down'))],
			['the server\'s records', (fixture: ReturnType<typeof createFixture>) => fixture.instancesRepository.findBy.mockRejectedValue(new Error('db is down'))],
			['the role policies', (fixture: ReturnType<typeof createFixture>) => fixture.roleService.getUserPolicies.mockRejectedValue(new Error('db is down'))],
		])('fails the same way for a missing room and a room it has when %s cannot be read', async (_label, breakLookup) => {
			breakLookup(f);

			await expect(f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).rejects.toThrow('db is down');
			await expect(f.service.issueRemoteJoinToken(remoteUser(), 'gone', false)).rejects.toThrow('db is down');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user who is not a member', async () => {
			f.chatRoomMembershipsRepository.exists.mockResolvedValue(false);

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user whose server is blocked or suspended', async () => {
			f.meta.blockedHosts = ['remote.test'];
			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).toBe('forbidden');
			expect(f.utilityService.isFederationAllowedHost).toHaveBeenCalledWith('remote.test');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();

			f = createFixture(undefined, [{ host: 'remote.test', suspensionState: 'manuallySuspended' }]);
			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		// inbox と同じく、ブロックはポート・末尾のドット・Unicode の違いを無視して当てる
		test.each([
			['a port', 'evil.example:8443', ['evil.example']],
			['a port and a trailing dot', 'evil.example.:8443', ['evil.example']],
			['a port, blocked by an entry with another port', 'evil.example:8443', ['evil.example:9999']],
			['a port, blocked by a Unicode entry', 'xn--vil-ima.example:8443', ['ëvil.example']],
		])('refuses a remote user on a host with %s whose domain is blocked', async (_label, host, blockedHosts) => {
			f.meta.blockedHosts = blockedHosts;

			const result = await f.service.issueRemoteJoinToken(remoteUser({ host, uri: `https://${host}/users/ru1` }), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test.each([
			// 管理画面で evil.example:8443 を停止すると、toPuny で '' になった記録が停止される (配送もこの記録で止まる)
			['the record the codebase keeps for hosts with a port', ''],
			['the record of the same domain', 'evil.example'],
			['the record kept with its port', 'evil.example:8443'],
			['the record of the same domain with a trailing dot', 'evil.example.'],
			['the record kept with its port and a trailing dot', 'evil.example.:8443'],
		])('refuses a remote user on a port whose server is suspended through %s', async (_label, storedHost) => {
			f = createFixture(undefined, [{ host: storedHost, suspensionState: 'manuallySuspended' }]);

			const result = await f.service.issueRemoteJoinToken(remoteUser({ host: 'evil.example:8443', uri: 'https://evil.example:8443/users/ru1' }), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user whose server is suspended through the record with a trailing dot', async () => {
			f = createFixture(undefined, [{ host: 'remote.test.', suspensionState: 'autoSuspendedForNotResponding' }]);

			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).toBe('forbidden');
		});

		test('refuses a dotted host listed only through a dotted entry under specified federation, as the inbox does', async () => {
			Object.assign(f.meta, { federation: 'specified', federationHosts: ['remote.test', 'evil.example.'] });
			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).not.toBe('forbidden');

			const result = await f.service.issueRemoteJoinToken(remoteUser({ host: 'evil.example.', uri: 'https://evil.example./users/ru1' }), 'r1', false);

			expect(result).toBe('forbidden');
		});

		test('refuses a remote user whose server is quarantined', async () => {
			f = createFixture(undefined, [{ host: 'remote.test', suspensionState: 'none', quarantineLimited: true }]);

			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('treats a server this server has no record of as not suspended', async () => {
			// 記録を引いたうえで、一つも無い
			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(f.instancesRepository.findBy).toHaveBeenCalledTimes(1);
			expect(await f.instancesRepository.findBy.mock.results[0].value).toEqual([]);
			expect(result).not.toBe('forbidden');
			expect(f.liveKitService.createJoinToken).toHaveBeenCalledTimes(1);
		});

		test('does not let the record shared by hosts with a port refuse a remote user without one', async () => {
			f = createFixture(undefined, [{ host: '', suspensionState: 'manuallySuspended' }, { host: 'remote.test', suspensionState: 'none' }]);

			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).not.toBe('forbidden');
		});

		test('reads suspensions as they are now, not from a cache', async () => {
			f = createFixture(undefined, [{ host: 'remote.test', suspensionState: 'none' }]);
			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).not.toBe('forbidden');

			f.instancesRepository.rows[0].suspensionState = 'manuallySuspended';

			expect(await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false)).toBe('forbidden');
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

				await f.service.issueRemoteJoinToken(remoteUser(), 'r1', requested);

				expect(f.liveKitService.createJoinToken).toHaveBeenCalledWith(expect.objectContaining({ canScreenShare: expected }));
			}
			expect(f.roleService.getUserPolicies).toHaveBeenCalledWith('ru1');
		});

		test('refuses a room this server does not own', async () => {
			f.rooms.set('r1', localRoom({ ownerId: 'remoteOwner', owner: { id: 'remoteOwner', host: 'other.test' } }));

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a suspended remote user', async () => {
			const result = await f.service.issueRemoteJoinToken(remoteUser({ isSuspended: true }), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user whose role here cannot join voice calls', async () => {
			f.roleService.getUserPolicies.mockResolvedValueOnce({ canVoiceCall: false, canScreenShare: true, chatAvailability: 'available' });

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses a remote user who may not write in chats here, as for local members', async () => {
			for (const chatAvailability of ['readonly', 'unavailable']) {
				f.roleService.getUserPolicies.mockResolvedValueOnce({ canVoiceCall: true, canScreenShare: true, chatAvailability });

				const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

				expect(result, chatAvailability).toBe('forbidden');
			}
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('refuses an archived room, as for local members', async () => {
			f.rooms.set('r1', localRoom({ isArchived: true }));

			const result = await f.service.issueRemoteJoinToken(remoteUser(), 'r1', false);

			expect(result).toBe('forbidden');
			expect(f.liveKitService.createJoinToken).not.toHaveBeenCalled();
		});

		test('reports an empty call stamped with the current time when nothing is stored', async () => {
			vi.useFakeTimers({ now: 5000 });

			expect(await f.service.snapshotOf('r1')).toEqual({ participants: [], updatedAt: 5000 });
		});
	});

	// 通話の参加者はルームの今のメンバーにだけ知らせる。ルームのストリーム (chatRoom) は、メンバーでないモデレーターも購読でき、
	// 抜けたメンバーの購読も続くので使わない
	describe('who hears about the participants', () => {
		/** ルームのメンバーを userIds にする。メンバーの引き方 (このサーバーのユーザーだけ・userId の In) はそのまま当てる */
		function withMembers(userIds: string[]) {
			f.chatRoomMembershipsRepository.findBy.mockImplementation(async (where: Record<string, unknown> = {}) => {
				const localOnly = (where.user as { host?: unknown } | undefined)?.host instanceof FindOperator;
				const userIdIn = where.userId instanceof FindOperator ? where.userId.value as string[] : null;
				return userIds
					.filter(userId => !localOnly || KNOWN_USERS.find(user => user.id === userId)?.host == null)
					.filter(userId => userIdIn == null || userIdIn.includes(userId))
					.map(userId => ({ roomId: 'r1', userId }));
			});
		}

		const recipients = () => f.globalEventService.publishMainStream.mock.calls.map(call => call[0]).sort();

		test('refresh sends nothing to the chat room stream', async () => {
			f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: true, micTrackSid: null }]);
			await f.service.refresh('r1');
			f.liveKitService.listParticipants.mockResolvedValue([]);
			await f.service.refresh('r1');

			expect(f.globalEventService.publishMainStream).toHaveBeenCalled();
			expect(f.globalEventService.publishChatRoomStream).not.toHaveBeenCalled();
		});

		test('storeRemoteSnapshot sends nothing to the chat room stream', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: true }], 2000);
			await f.service.storeRemoteSnapshot(mirrorRoom(), [], 3000);

			expect(f.globalEventService.publishMainStream).toHaveBeenCalled();
			expect(f.globalEventService.publishChatRoomStream).not.toHaveBeenCalled();
		});

		test('refresh tells exactly the local members and the local owner', async () => {
			withMembers(['u1', 'u2', 'rm1']);
			f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null }]);

			await f.service.refresh('r1');

			expect(recipients()).toEqual(['owner', 'u1', 'u2']);
		});

		test('refresh does not tell an owner on another server', async () => {
			withMembers(['u1', 'rm1']);
			f.chatRoomsRepository.findOneBy.mockResolvedValue({ id: 'r1', ownerId: 'rm3' });
			f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null }]);

			await f.service.refresh('r1');

			expect(recipients()).toEqual(['u1']);
		});

		test('refresh stops telling a member who left the room', async () => {
			withMembers(['u1', 'u2']);
			f.liveKitService.listParticipants.mockResolvedValue([{ identity: 'i1', userId: 'u1', screenSharing: false, micTrackSid: null }]);
			await f.service.refresh('r1');
			expect(recipients()).toEqual(['owner', 'u1', 'u2']);

			withMembers(['u1']);
			f.globalEventService.publishMainStream.mockClear();
			await f.service.refresh('r1');

			expect(recipients()).toEqual(['owner', 'u1']);
		});

		test('storeRemoteSnapshot tells exactly the local members', async () => {
			withMembers(['u1', 'u2', 'rm1']);

			await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000);

			expect(recipients()).toEqual(['u1', 'u2']);
		});
	});

	describe('mirror rooms', () => {
		test('storeRemoteSnapshot resolves identities to local users and ignores older snapshots', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://local.test/users/u1', screenSharing: true },
				{ identity: 'https://other.test/users/x', screenSharing: false },
				{ identity: 'https://gone.test/users/y', screenSharing: false },
			], 2000);

			expect(f.redis.eval).toHaveBeenCalledWith(expect.any(String), 1, 'chatVoice:r1', expect.any(String), 2000, 600);
			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!)).toEqual({
				participants: [
					{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: true },
					{ identity: 'https://other.test/users/x', userId: 'x1', screenSharing: false },
				],
				updatedAt: 2000,
			});

			const stored = f.redis.store.get('chatVoice:r1');
			f.globalEventService.publishMainStream.mockClear();
			for (const updatedAt of [1000, 2000]) {
				await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://other.test/users/x', screenSharing: true }], updatedAt);
			}
			expect(f.redis.store.get('chatVoice:r1')).toBe(stored);
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();

			await f.service.storeRemoteSnapshot(mirrorRoom(), [], 3000);
			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!)).toEqual({ participants: [], updatedAt: 3000 });
		});

		test('storeRemoteSnapshot announces to the room\'s local members, not the remote owner', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000);

			expect(f.chatRoomMembershipsRepository.findBy).toHaveBeenCalledWith({ roomId: 'r1', user: { host: IsNull() } });
			expect(f.globalEventService.publishMainStream.mock.calls.map(call => call[0])).toEqual(['m1']);
			expect(f.globalEventService.publishMainStream).toHaveBeenCalledWith('m1', 'chatRoomVoiceState', {
				roomId: 'r1',
				participants: [{ identity: 'https://local.test/users/u1', user: expect.objectContaining({ id: 'u1' }), screenSharing: false }],
			});
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

		// ホストが、このサーバーの知っているメンバーでないユーザーを参加者に見せかけられないようにする
		test('storeRemoteSnapshot keeps only the room\'s owner and its current members, checked in one query', async () => {
			f.nonMembers.add('u2');
			f.nonMembers.add('x1');
			// 持ち主はメンバーの行を持たない
			f.nonMembers.add('remoteOwner');

			const stored = await f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: 'https://remote.test/users/remoteOwner', screenSharing: true },
				{ identity: 'https://local.test/users/u1', screenSharing: false },
				{ identity: 'https://local.test/users/u2', screenSharing: false },
				{ identity: 'https://other.test/users/x', screenSharing: false },
			], 2000);

			expect(stored).toBe(true);
			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!).participants).toEqual([
				{ identity: 'https://remote.test/users/remoteOwner', userId: 'remoteOwner', screenSharing: true },
				{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false },
			]);
			const membershipChecks = f.chatRoomMembershipsRepository.findBy.mock.calls.filter(([where]) => where?.userId instanceof FindOperator);
			expect(membershipChecks).toHaveLength(1);
			expect(membershipChecks[0][0]).toEqual({ roomId: 'r1', userId: expect.any(FindOperator) });
		});

		test('storeRemoteSnapshot does not look up memberships when nobody is known', async () => {
			await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://evil.test/users/fresh', screenSharing: false }], 2000);

			expect(f.chatRoomMembershipsRepository.findBy.mock.calls.filter(([where]) => where?.userId instanceof FindOperator)).toHaveLength(0);
			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!).participants).toEqual([]);
		});

		// 他のサーバーの言う現況を、このサーバーが持つルームに書かせない
		test.each([
			['a room owned on this server', () => localRoom()],
			['a room whose owner was not loaded', () => ({ id: 'r1', ownerId: 'remoteOwner', isArchived: false }) as any],
		])('storeRemoteSnapshot refuses %s', async (_label, room) => {
			await expect(f.service.storeRemoteSnapshot(room(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000)).rejects.toThrow();

			expect(f.redis.store.has('chatVoice:r1')).toBe(false);
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();
		});

		// 比べてから書くまでを一つの操作にして、同時に届いた古い現況が新しい現況を上書きしないようにする
		test.each([
			['the newer one first', [3000, 2000]],
			['the older one first', [2000, 3000]],
		])('storeRemoteSnapshot keeps the newer of two snapshots stored at the same time (%s)', async (_label, times) => {
			const results = await Promise.all(times.map(updatedAt => f.service.storeRemoteSnapshot(mirrorRoom(), [
				{ identity: updatedAt === 3000 ? 'https://local.test/users/u1' : 'https://local.test/users/u2', screenSharing: false },
			], updatedAt)));

			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!)).toEqual({
				participants: [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false }],
				updatedAt: 3000,
			});
			expect(results).toEqual(times.map(updatedAt => updatedAt === 3000 || times[0] === 2000));
		});

		test('storeRemoteSnapshot tells whether it stored the snapshot, and only announces what it stored', async () => {
			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [], 2000)).toBe(true);
			f.globalEventService.publishMainStream.mockClear();

			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000)).toBe(false);
			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 1000)).toBe(false);
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();
		});

		test('storeRemoteSnapshot ignores a snapshot stamped more than five minutes ahead of this server\'s clock', async () => {
			vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });

			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 1_000_000 + 300_001)).toBe(false);
			expect(f.redis.store.has('chatVoice:r1')).toBe(false);
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();

			// ちょうど五分先までは時計のずれとして受け入れる
			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 1_000_000 + 300_000)).toBe(true);
			expect(JSON.parse(f.redis.store.get('chatVoice:r1')!).updatedAt).toBe(1_000_000 + 300_000);
		});

		// 他のサーバーの通話を止めた後で、止める前に始まった参加の応答が届いても保存しない
		test.each([
			['remote calls are turned off', { enableRemoteVoiceCall: false }],
			['federation is turned off', { federation: 'none' }],
		])('storeRemoteSnapshot stores nothing once %s', async (_label, changes) => {
			Object.assign(f.meta, changes);

			expect(await f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity: 'https://local.test/users/u1', screenSharing: false }], 2000)).toBe(false);
			expect(f.redis.store.has('chatVoice:r1')).toBe(false);
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();
		});
	});

	// 他のサーバーの通話を止めたら、ミラーの現況を寿命 (10 分) まで残さず消す
	describe('clearing mirror snapshots when calls on other servers are turned off', () => {
		function publishMetaUpdated(changes: Record<string, unknown>, options: { withoutBefore?: boolean } = {}) {
			const before = { ...f.meta };
			Object.assign(f.meta, changes);
			const body = options.withoutBefore ? { after: { ...f.meta } } : { before, after: { ...f.meta } };
			f.redisForSub.emit('message', 'local.test', JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body } }));
		}

		test('deletes the stored snapshot of every mirror room, and nothing else', async () => {
			// 一度に引くより多くのミラー
			for (let i = 0; i < 1200; i++) {
				const id = `m${String(i).padStart(4, '0')}`;
				f.rooms.set(id, { ...mirrorRoom(), id });
				f.redis.store.set(`chatVoice:${id}`, JSON.stringify({ participants: [], updatedAt: 1 }));
			}
			f.redis.store.set('chatVoice:r1', JSON.stringify({ participants: [], updatedAt: 1 }));
			f.redis.store.set('chatVoice:federated:r1', '{}');

			await f.service.clearMirrorSnapshots();

			expect([...f.redis.store.keys()].sort()).toEqual(['chatVoice:federated:r1', 'chatVoice:r1']);
			expect(f.chatRoomsRepository.find.mock.calls.length).toBeGreaterThan(1);
			// 何度消しても同じ (ほかのワーカーも同じように消す)
			await expect(f.service.clearMirrorSnapshots()).resolves.toBeUndefined();
		});

		test.each([
			['remote calls are turned off', { enableRemoteVoiceCall: false }],
			['federation is turned off', { federation: 'none' }],
		])('clears the mirror snapshots when %s', async (_label, changes) => {
			const clear = vi.spyOn(f.service, 'clearMirrorSnapshots').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated(changes);

			await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
		});

		test('clears the mirror snapshots when the previous settings are unknown and remote calls are off', async () => {
			const clear = vi.spyOn(f.service, 'clearMirrorSnapshots').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated({ enableRemoteVoiceCall: false }, { withoutBefore: true });

			await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
		});

		test.each([
			['the server name changes', { name: 'renamed' }],
			['the block list changes', { blockedHosts: ['remote.test'] }],
		])('does not clear the mirror snapshots when only %s', async (_label, changes) => {
			const clear = vi.spyOn(f.service, 'clearMirrorSnapshots').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated(changes);
			// 後から届いた変更でだけ消したことを確かめる
			publishMetaUpdated({ enableRemoteVoiceCall: false });

			await vi.waitFor(() => expect(clear).toHaveBeenCalled());
			expect(clear).toHaveBeenCalledTimes(1);
		});

		test('does not clear anything while remote calls stay off or are turned on', async () => {
			const clear = vi.spyOn(f.service, 'clearMirrorSnapshots').mockResolvedValue();
			f.meta.enableRemoteVoiceCall = false;
			f.service.onModuleInit();

			publishMetaUpdated({ name: 'renamed' });
			publishMetaUpdated({ enableRemoteVoiceCall: true });
			publishMetaUpdated({ enableRemoteVoiceCall: false });

			await vi.waitFor(() => expect(clear).toHaveBeenCalled());
			expect(clear).toHaveBeenCalledTimes(1);
		});

		// ミラーの現況は、このサーバーに LiveKit が無くても保存される
		test('clears the mirror snapshots on a server without its own LiveKit', async () => {
			f.liveKitService.isEnabled = false;
			const clear = vi.spyOn(f.service, 'clearMirrorSnapshots').mockResolvedValue();
			const recheck = vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated({ blockedHosts: ['remote.test'] });
			publishMetaUpdated({ enableRemoteVoiceCall: false });

			await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
			// 確かめ直す通話が無いので、参加者の確かめ直しはしない
			expect(recheck).not.toHaveBeenCalled();
		});

		test('logs a failed clear', async () => {
			vi.spyOn(f.service, 'clearMirrorSnapshots').mockRejectedValue(new Error('db is down'));
			f.service.onModuleInit();

			publishMetaUpdated({ enableRemoteVoiceCall: false });

			await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalled());
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
			f.rooms.set('r1', mirrorRoom());
		});

		test('accepts a voice state from the owner of the mirror room', async () => {
			const result = await f.service.receiveRemoteSnapshot(owner, voiceState());

			expect(result).toMatch(/^ok/);
			// 保存する前にミラーであることを確かめられるよう、持ち主ごと読む
			expect(f.chatRoomsRepository.findOne).toHaveBeenCalledWith({ where: { id: 'r1' }, relations: { owner: true } });
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
			expect(f.redis.eval).not.toHaveBeenCalled();
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
			expect(f.redis.eval).not.toHaveBeenCalled();
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

			expect(f.redis.eval).toHaveBeenCalledWith(expect.any(String), 1, 'chatVoice:r1', expect.any(String), 2000, 600);
			expect(f.redis.sadd).not.toHaveBeenCalled();
		});

		// 先の時刻を付けた現況を受け入れると、寿命が切れるまでホストが新しい現況で上書きできなくなる
		test('ignores a voice state stamped more than five minutes ahead of this server\'s clock', async () => {
			vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });

			const result = await f.service.receiveRemoteSnapshot(owner, voiceState({ updated: new Date(1_000_000 + 300_001).toISOString() }));

			expect(result).toMatch(/^skip:/);
			expect(f.redis.store.has('chatVoice:r1')).toBe(false);
			expect(f.globalEventService.publishMainStream).not.toHaveBeenCalled();
		});
	});

	describe('keeping calls in line with federation moderation', () => {
		function participant(user: { id: string; host: string | null; uri: string | null }) {
			const identity = user.host == null ? `https://local.test/users/${user.id}` : user.uri!;
			return { identity, userId: user.id, screenSharing: false, micTrackSid: null };
		}

		const u1 = KNOWN_USERS.find(user => user.id === 'u1')!;
		const rm1 = KNOWN_USERS.find(user => user.id === 'rm1')!;
		const rm2 = KNOWN_USERS.find(user => user.id === 'rm2')!;
		const rm3 = KNOWN_USERS.find(user => user.id === 'rm3')!;
		const x1 = KNOWN_USERS.find(user => user.id === 'x1')!;

		function startCall(roomId: string, users: { id: string; host: string | null; uri: string | null }[]) {
			if (!f.redis.sets.has('chatVoice:active')) f.redis.sets.set('chatVoice:active', new Set());
			f.redis.sets.get('chatVoice:active')!.add(roomId);
			const previous = f.liveKitService.listParticipants.getMockImplementation();
			f.liveKitService.listParticipants.mockImplementation(async (id: string) => {
				if (id === roomId) return users.map(participant);
				return previous != null ? await previous(id) : [];
			});
		}

		/** 管理画面での設定の変更。GlobalModule の購読が先に DI.meta を書き換えるので、届いた時点で meta は after と同じ */
		function publishMetaUpdated(changes: Record<string, unknown>, options: { withoutBefore?: boolean } = {}) {
			const before = { ...f.meta };
			Object.assign(f.meta, changes);
			const body = options.withoutBefore ? { after: { ...f.meta } } : { before, after: { ...f.meta } };
			f.redisForSub.emit('message', 'local.test', JSON.stringify({ channel: 'internal', message: { type: 'metaUpdated', body } }));
		}

		function removed() {
			return f.liveKitService.removeParticipant.mock.calls.map(([roomId, identity]) => `${roomId} ${identity}`).sort();
		}

		test('removes participants from a newly blocked server', async () => {
			startCall('r1', [u1, rm1, rm3]);
			f.service.onModuleInit();

			publishMetaUpdated({ blockedHosts: ['remote.test'] });

			await vi.waitFor(() => expect(f.liveKitService.removeParticipant).toHaveBeenCalledWith('r1', rm1.uri));
		});

		test('leaves participants from other servers alone', async () => {
			startCall('r1', [u1, rm1, rm3]);
			startCall('r2', [rm2, x1]);
			f.meta.blockedHosts = ['remote.test'];

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([`r1 ${rm1.uri}`, `r2 ${rm2.uri}`]);
		});

		test('removes participants when an admin suspends their server', async () => {
			f = createFixture(undefined, [{ id: 'i1', host: 'remote.test', suspensionState: 'none' }, { id: 'i2', host: 'far.test', suspensionState: 'none' }]);
			startCall('r1', [u1, rm1, rm3]);
			const federatedInstanceService = {
				update: vi.fn(async (id: string, data: { suspensionState?: string }) => {
					const row = f.instancesRepository.rows.find(instance => instance.id === id)!;
					if (data.suspensionState != null) row.suspensionState = data.suspensionState;
				}),
			};
			const endpoint = new (UpdateInstanceEndpoint as any)(
				{ findOneBy: async ({ host }: { host: string }) => f.instancesRepository.rows.find(instance => instance.host === host) ?? null },
				f.utilityService,
				federatedInstanceService,
				{ log: vi.fn() },
				f.service,
				{ logger: f.logger },
			);

			await endpoint.exec({ host: 'remote.test', isSuspended: true }, { id: 'admin' }, null, null);

			await vi.waitFor(() => expect(removed()).toEqual([`r1 ${rm1.uri}`]));
		});

		test.each([
			['a subdomain of a blocked domain', 'sub.remote.test', ['remote.test']],
			['a port on a blocked domain', 'remote.test:8443', ['remote.test']],
			['a trailing dot', 'remote.test.', ['remote.test']],
			['a block entry in another case', 'remote.test', ['Remote.TEST']],
			['a block entry with a port', 'remote.test', ['remote.test:8443']],
		])('removes a participant on %s', async (_label, host, blockedHosts) => {
			const p = { id: 'p', host, uri: `https://${host}/users/p` };
			f.usersRepository.findBy.mockResolvedValue([p, u1, rm3] as any);
			startCall('r1', [p, u1, rm3]);
			f.meta.blockedHosts = blockedHosts;

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([`r1 ${p.uri}`]);
		});

		test('does not take a lookalike domain for a blocked one', async () => {
			const p = { id: 'p', host: 'notremote.test', uri: 'https://notremote.test/users/p' };
			f.usersRepository.findBy.mockResolvedValue([p] as any);
			startCall('r1', [p]);
			f.meta.blockedHosts = ['remote.test'];

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([]);
		});

		test('removes every remote participant when federation is turned off', async () => {
			startCall('r1', [u1, rm1, rm3]);
			f.service.onModuleInit();

			publishMetaUpdated({ federation: 'none' });

			await vi.waitFor(() => expect(removed()).toEqual([`r1 ${rm3.uri}`, `r1 ${rm1.uri}`]));
		});

		test('removes participants from servers left off the federation list', async () => {
			startCall('r1', [u1, rm1, rm3]);
			f.service.onModuleInit();

			publishMetaUpdated({ federation: 'specified', federationHosts: ['far.test'] });

			await vi.waitFor(() => expect(removed()).toEqual([`r1 ${rm1.uri}`]));
		});

		test('removes participants from a server suspended through another record of it', async () => {
			f = createFixture(undefined, [{ host: 'remote.test.', suspensionState: 'manuallySuspended' }]);
			startCall('r1', [u1, rm1, rm3]);

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([`r1 ${rm1.uri}`]);
		});

		test('keeps going when one room cannot be read', async () => {
			startCall('r1', [rm1]);
			startCall('r2', [rm2]);
			const list = f.liveKitService.listParticipants.getMockImplementation()!;
			f.liveKitService.listParticipants.mockImplementation(async (roomId: string) => {
				if (roomId === 'r1') throw new Error('LiveKit is down');
				return await list(roomId);
			});
			f.meta.blockedHosts = ['remote.test'];

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([`r2 ${rm2.uri}`]);
			expect(f.logger.warn).toHaveBeenCalled();
		});

		test('keeps going when one participant cannot be removed', async () => {
			startCall('r1', [rm1, rm2]);
			f.liveKitService.removeParticipant.mockRejectedValueOnce(new Error('LiveKit is down'));
			f.meta.blockedHosts = ['remote.test'];

			await f.service.removeRefusedRemoteParticipants();

			expect(removed()).toEqual([`r1 ${rm1.uri}`, `r1 ${rm2.uri}`]);
			expect(f.logger.warn).toHaveBeenCalled();
		});

		test.each([
			['blockedHosts', { blockedHosts: ['remote.test'] }],
			['federation', { federation: 'specified' }],
			['federationHosts', { federationHosts: ['far.test'] }],
		])('re-checks the calls when %s changes', async (_label, changes) => {
			const sweep = vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated(changes);

			await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
		});

		test('re-checks the calls when the previous settings are unknown', async () => {
			const sweep = vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated({}, { withoutBefore: true });

			await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
		});

		test.each([
			['the server name', { name: 'renamed' }],
			['remote voice calls', { enableRemoteVoiceCall: false }],
			['silenced servers', { silencedHosts: ['remote.test'] }],
			['nothing', {}],
			['the block list, to an equal list', { blockedHosts: [] }],
		])('does not re-check the calls when only %s changes', async (_label, changes) => {
			const sweep = vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockResolvedValue();
			f.service.onModuleInit();

			publishMetaUpdated(changes);
			// 後から届いた変更でだけ読み直したことを確かめる
			publishMetaUpdated({ blockedHosts: ['remote.test'] });

			await vi.waitFor(() => expect(sweep).toHaveBeenCalled());
			expect(sweep).toHaveBeenCalledTimes(1);
		});

		test('stops listening for setting changes on shutdown', async () => {
			const sweep = vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockResolvedValue();
			f.service.onModuleInit();
			f.service.onApplicationShutdown();

			publishMetaUpdated({ blockedHosts: ['remote.test'] });

			expect(f.redisForSub.listenerCount('message')).toBe(0);
			expect(sweep).not.toHaveBeenCalled();
		});

		test('logs a failed sweep started by a setting change', async () => {
			vi.spyOn(f.service, 'removeRefusedRemoteParticipants').mockRejectedValue(new Error('redis is down'));
			f.service.onModuleInit();

			publishMetaUpdated({ blockedHosts: ['remote.test'] });

			await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalled());
		});

		describe('re-checking who may stay on every sweep', () => {
			test('removes a refused participant from a room that became active after the moderation sweep ran', async () => {
				// 入ったときの確認は通ったが、ルームが通話中として記録される (refresh) 前にブロックされた
				f.liveKitService.listParticipants.mockResolvedValue([participant(rm1)]);
				f.meta.blockedHosts = ['remote.test'];
				await f.service.removeRefusedRemoteParticipants();
				expect(removed()).toEqual([]);

				await f.service.refresh('r1');
				await f.service.sweep();

				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});

			test('retries a removal that failed on the next periodic sweep', async () => {
				startCall('r1', [u1, rm1]);
				f.meta.blockedHosts = ['remote.test'];
				f.liveKitService.removeParticipant.mockRejectedValueOnce(new Error('LiveKit is down'));

				await f.service.removeRefusedRemoteParticipants();
				expect(f.logger.warn).toHaveBeenCalled();

				await f.service.sweep();

				expect(f.liveKitService.removeParticipant.mock.calls).toEqual([['r1', rm1.uri], ['r1', rm1.uri]]);
			});

			test.each(['goneSuspended', 'autoSuspendedForNotResponding'])('removes participants of a server that became %s without any admin action', async (suspensionState) => {
				f = createFixture(undefined, [{ host: 'remote.test', suspensionState: 'none' }]);
				startCall('r1', [u1, rm1, rm3]);
				f.instancesRepository.rows[0].suspensionState = suspensionState;

				await f.service.sweep();

				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});

			test('removes participants of a quarantined server', async () => {
				f = createFixture(undefined, [{ host: 'remote.test', suspensionState: 'none', quarantineLimited: true }]);
				startCall('r1', [u1, rm1, rm3]);

				await f.service.sweep();

				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});

			test('removes participants who left the room or whose identity is not their user\'s', async () => {
				const mismatched = { identity: 'https://evil.test/users/x', userId: 'u2', screenSharing: false, micTrackSid: null };
				startCall('r1', [u1, rm1, rm3]);
				const list = f.liveKitService.listParticipants.getMockImplementation()!;
				f.liveKitService.listParticipants.mockImplementation(async (roomId: string) => [...await list(roomId), mismatched]);
				f.nonMembers.add('rm3');

				await f.service.sweep();

				expect(removed()).toEqual(['r1 https://evil.test/users/x', `r1 ${rm3.uri}`]);
			});

			test('keeps everyone who may stay', async () => {
				startCall('r1', [u1, rm1, rm3]);

				await f.service.sweep();

				expect(removed()).toEqual([]);
			});
		});

		describe('checking who joins', () => {
			function joined(user: { id: string; host: string | null; uri: string | null }, metadata = JSON.stringify({ userId: user.id })) {
				return { event: 'participant_joined', room: { name: 'chatRoom:r1' }, participant: { identity: participant(user).identity, metadata } } as any;
			}

			test('removes a participant who joins from a server this server now refuses', async () => {
				f.meta.blockedHosts = ['remote.test'];

				f.service.handleWebhook(joined(rm1));

				await vi.waitFor(() => expect(removed()).toEqual([`r1 ${rm1.uri}`]));
			});

			test('removes a participant from a server on a port of a blocked domain', async () => {
				const p = { id: 'p', host: 'remote.test:8443', uri: 'https://remote.test:8443/users/p' };
				f.usersRepository.findBy.mockResolvedValue([p] as any);
				f.meta.blockedHosts = ['remote.test'];

				await f.service.removeUnadmittedParticipant('r1', joined(p).participant);

				expect(removed()).toEqual([`r1 ${p.uri}`]);
			});

			test('removes a participant who is no longer a member of the room', async () => {
				f.nonMembers.add('rm1');
				f.nonMembers.add('u1');

				await f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);
				await f.service.removeUnadmittedParticipant('r1', joined(u1).participant);

				expect(removed()).toEqual(['r1 https://local.test/users/u1', `r1 ${rm1.uri}`]);
			});

			test('removes a participant whose identity is not the one of the user its token names', async () => {
				await f.service.removeUnadmittedParticipant('r1', { identity: 'https://evil.test/users/x', metadata: JSON.stringify({ userId: 'rm1' }) });
				await f.service.removeUnadmittedParticipant('r1', { identity: rm1.uri!, metadata: JSON.stringify({ userId: 'u1' }) });

				expect(removed()).toEqual(['r1 https://evil.test/users/x', `r1 ${rm1.uri}`]);
			});

			test('removes a participant whose token names no user of this server', async () => {
				// LiveKit はメタデータの無い参加者に空文字を渡す
				await f.service.removeUnadmittedParticipant('r1', joined(rm1, '').participant);
				await f.service.removeUnadmittedParticipant('r1', joined({ id: 'ghost', host: 'remote.test', uri: 'https://remote.test/users/ghost' }).participant);

				expect(removed()).toEqual(['r1 https://remote.test/users/ghost', `r1 ${rm1.uri}`]);
			});

			test('keeps members who join', async () => {
				const owner = KNOWN_USERS.find(user => user.id === 'owner')!;

				await f.service.removeUnadmittedParticipant('r1', joined(rm1).participant);
				await f.service.removeUnadmittedParticipant('r1', joined(u1).participant);
				// 持ち主はメンバーの記録が無くてもメンバー
				f.nonMembers.add('owner');
				await f.service.removeUnadmittedParticipant('r1', joined(owner).participant);

				expect(removed()).toEqual([]);
			});

			test('still re-reads the call after checking who joined', async () => {
				vi.useFakeTimers();
				const refresh = vi.spyOn(f.service, 'refresh').mockResolvedValue();
				f.meta.blockedHosts = ['remote.test'];

				f.service.handleWebhook(joined(rm1));
				await vi.advanceTimersByTimeAsync(500);

				expect(refresh).toHaveBeenCalledWith('r1');
				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});

			test('logs a failed check without removing anyone, and the next sweep removes the refused participant', async () => {
				startCall('r1', [rm1]);
				f.meta.blockedHosts = ['remote.test'];
				f.chatRoomsRepository.findOneBy.mockRejectedValueOnce(new Error('db is down'));

				f.service.handleWebhook(joined(rm1));

				await vi.waitFor(() => expect(f.logger.warn).toHaveBeenCalled());
				expect(removed()).toEqual([]);

				await f.service.sweep();

				expect(removed()).toEqual([`r1 ${rm1.uri}`]);
			});
		});
	});
});

// 保存のスクリプトそのもの (Lua) は本物の Redis で確かめる
describe('ChatVoiceService storing mirror snapshots in Redis', () => {
	const prefix = `test-chatVoice-${randomUUID()}:`;
	let redis: Redis;
	let raw: Redis;
	let f: ReturnType<typeof createFixture>;

	beforeAll(() => {
		const config = loadConfig();
		redis = new Redis({ ...config.redis, keyPrefix: prefix });
		raw = new Redis({ ...config.redis, keyPrefix: undefined });
	});

	beforeEach(async () => {
		f = createFixture(redis as any);
		await redis.del('chatVoice:r1');
	});

	afterEach(() => {
		f.service.onApplicationShutdown();
	});

	afterAll(async () => {
		await redis.del('chatVoice:r1');
		redis.disconnect();
		raw.disconnect();
	});

	const stored = async () => JSON.parse((await redis.get('chatVoice:r1'))!) as { participants: { identity: string }[]; updatedAt: number };
	const store = (updatedAt: number, identity = 'https://local.test/users/u1') => f.service.storeRemoteSnapshot(mirrorRoom(), [{ identity, screenSharing: false }], updatedAt);

	test('stores a snapshot under the configured prefix for ten minutes', async () => {
		expect(await store(2000)).toBe(true);

		expect(await stored()).toEqual({ participants: [{ identity: 'https://local.test/users/u1', userId: 'u1', screenSharing: false }], updatedAt: 2000 });
		expect(await raw.exists(`${prefix}chatVoice:r1`)).toBe(1);
		const ttl = await redis.ttl('chatVoice:r1');
		expect(ttl).toBeGreaterThan(590);
		expect(ttl).toBeLessThanOrEqual(600);
	});

	test('stores only a snapshot strictly newer than the stored one', async () => {
		expect(await store(2000)).toBe(true);
		expect(await store(2000, 'https://local.test/users/u2')).toBe(false);
		expect(await store(1999, 'https://local.test/users/u2')).toBe(false);
		expect((await stored()).participants.map(p => p.identity)).toEqual(['https://local.test/users/u1']);

		expect(await store(2000.5, 'https://local.test/users/u2')).toBe(true);
		expect(await stored()).toMatchObject({ participants: [{ identity: 'https://local.test/users/u2' }], updatedAt: 2000.5 });
	});

	test('keeps the newest of many snapshots stored at the same time', async () => {
		const times = [5, 3, 9, 1, 7, 2, 8, 4, 6].map(n => 1_700_000_000_000 + n);

		await Promise.all(times.map(updatedAt => store(updatedAt)));

		expect((await stored()).updatedAt).toBe(1_700_000_000_009);
	});

	test('replaces a stored value it cannot read', async () => {
		await redis.set('chatVoice:r1', 'not json', 'EX', 600);

		expect(await store(2000)).toBe(true);
		expect((await stored()).updatedAt).toBe(2000);
	});
});
