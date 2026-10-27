/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// ChatVoiceService の単体テスト (test/unit/ChatVoiceService.ts と test/unit/ChatVoiceService.admission.ts) が共有する偽物と道具

import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { FindOperator } from 'typeorm';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { HostPolicyService } from '@/core/HostPolicyService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';

export function fakeRedis() {
	const store = new Map<string, string>();
	const sets = new Map<string, Set<string>>();
	// EX / PX の寿命は Date.now() で数えるので、偽のタイマーで時間を進めると切れる。
	// 本物の Redis と同じく、寿命の時刻ちょうどにはまだ残っていて、それを過ぎると切れる
	const expiresAt = new Map<string, number>();
	const live = (key: string) => {
		const at = expiresAt.get(key);
		if (at != null && Date.now() > at) {
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
		// ミラーの現況を保存するスクリプトと同じ動きをする。他のサーバーの通話を止めた回数 (KEYS[3]) が読んだときのまま (ARGV[5]) で、
		// 保存済みの現況 (KEYS[1]) と、最後に受け入れた時刻 (KEYS[2]) のどちらよりも新しいときだけ書き、書いたらその時刻も残す。
		// 本物の Redis と同じく、比べてから書くまでのあいだに他の呼び出しが割り込まない
		// 他のサーバーに送った記録 (chatVoice:federated:*) は、保存済みの記録の updatedAt より新しく、送るかを決めた現況の時刻 (KEYS[2]) より
		// 前でもないときだけ書く。
		// ルームの時刻の列 (送るかを決めた時刻 chatVoice:federateDecided:* と、このサーバーの現況の時刻 chatVoice:localStamp:*) は、
		// この時計の時刻 (ARGV[1]) と、二つの列 (KEYS[1] と KEYS[2]) それぞれの最後の時刻の 1 ミリ秒後のうち、最も遅いものを KEYS[1] に残して返す。
		// 送る順番の鍵 (chatVoice:federateLock:*) は、自分が取ったもの (ARGV[1]) のときだけ外す
		eval: vi.fn(async (_script: string, numKeys: number, ...args: (string | number)[]) => {
			const [key, lastSeenKey, generationKey] = args.slice(0, numKeys) as string[];
			if (key.startsWith('chatVoice:federateDecided:') || key.startsWith('chatVoice:localStamp:')) {
				const [now, stampTtlSeconds] = args.slice(numKeys);
				let stamp = Number(now);
				for (const sequenceKey of [key, lastSeenKey]) {
					if (sequenceKey != null && live(sequenceKey)) stamp = Math.max(stamp, Number(store.get(sequenceKey)) + 1);
				}
				store.set(key, String(stamp));
				expiresAt.set(key, Date.now() + Number(stampTtlSeconds) * 1000);
				return stamp;
			}
			// このサーバーが持つルームの現況 (KEYS[2] が通話中のルームの一覧) は、保存済みのものより新しいときだけ書き、一覧も変える
			if (lastSeenKey === 'chatVoice:active') {
				const [snapshot, snapshotUpdatedAt, snapshotTtlSeconds, roomId, empty] = args.slice(numKeys);
				if (live(key) && (JSON.parse(store.get(key)!) as { updatedAt: number }).updatedAt >= Number(snapshotUpdatedAt)) return 0;
				store.set(key, String(snapshot));
				expiresAt.set(key, Date.now() + Number(snapshotTtlSeconds) * 1000);
				if (!sets.has(lastSeenKey)) sets.set(lastSeenKey, new Set());
				if (String(empty) === '1') sets.get(lastSeenKey)!.delete(String(roomId));
				else sets.get(lastSeenKey)!.add(String(roomId));
				return 1;
			}
			if (key.startsWith('chatVoice:federated:')) {
				const [record, recordUpdatedAt, recordTtlSeconds] = args.slice(numKeys);
				const decidedKey = lastSeenKey;
				if (decidedKey != null && live(decidedKey) && Number(store.get(decidedKey)) > Number(recordUpdatedAt)) return 0;
				if (live(key)) {
					const stored = JSON.parse(store.get(key)!) as { updatedAt?: unknown };
					if (typeof stored.updatedAt === 'number' && stored.updatedAt >= Number(recordUpdatedAt)) return 0;
				}
				store.set(key, String(record));
				expiresAt.set(key, Date.now() + Number(recordTtlSeconds) * 1000);
				return 1;
			}
			// 続けて確かめられなかった回数 (chatVoice:unverified:*) は、一つ増やして寿命 (ARGV[1] 秒) を延ばし、増やした後の回数を返す
			if (key.startsWith('chatVoice:unverified:')) {
				const [ttlSeconds] = args.slice(numKeys);
				const count = Number(live(key) ? store.get(key) : 0) + 1;
				store.set(key, String(count));
				expiresAt.set(key, Date.now() + Number(ttlSeconds) * 1000);
				return count;
			}
			if (key.startsWith('chatVoice:federateLock:')) {
				if (!live(key) || store.get(key) !== String(args[numKeys])) return 0;
				store.delete(key);
				expiresAt.delete(key);
				return 1;
			}
			const [value, updatedAt, ttlSeconds, lastSeenTtlSeconds, generation] = args.slice(numKeys);
			if (generationKey != null && (live(generationKey) ? store.get(generationKey)! : '0') !== String(generation)) return 2;
			if (live(key) && (JSON.parse(store.get(key)!) as { updatedAt: number }).updatedAt >= Number(updatedAt)) return 0;
			if (lastSeenKey != null && live(lastSeenKey) && Number(store.get(lastSeenKey)) >= Number(updatedAt)) return 0;
			store.set(key, String(value));
			expiresAt.set(key, Date.now() + Number(ttlSeconds) * 1000);
			if (lastSeenKey != null) {
				store.set(lastSeenKey, String(updatedAt));
				expiresAt.set(lastSeenKey, Date.now() + Number(lastSeenTtlSeconds) * 1000);
			}
			return 1;
		}),
		mget: vi.fn(async (...keys: string[]) => keys.map(key => (live(key) ? store.get(key)! : null))),
		incr: vi.fn(async (key: string) => {
			const next = Number(live(key) ? store.get(key) : 0) + 1;
			store.set(key, String(next));
			return next;
		}),
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
export const KNOWN_USERS = [
	{ id: 'u1', host: null, uri: null, isDeleted: false },
	{ id: 'u2', host: null, uri: null, isDeleted: false },
	// メンバーを引く既定の結果 (chatRoomMembershipsRepository.findBy) にいるユーザー
	{ id: 'm1', host: null, uri: null, isDeleted: false },
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
export function matchesWhere(user: Record<string, unknown>, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (condition instanceof FindOperator) {
			if (condition.type === 'in') return (condition.value as unknown[]).includes(user[key]);
			if (condition.type === 'isNull') return user[key] == null;
			throw new Error(`unsupported operator: ${condition.type}`);
		}
		return user[key] === condition;
	});
}

export type InstanceRow = { id?: string; host: string; suspensionState: string; quarantineLimited?: boolean };

export function createFixture(redis = fakeRedis(), instances: InstanceRow[] = []) {
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
		getUserPolicies: vi.fn(async (_userId: string) => ({ canVoiceCall: true, canScreenShare: true, chatAvailability: 'available' })),
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
	// 他のサーバーを断るかの判定は実物を使う
	const hostPolicyService = new HostPolicyService(meta as any, instancesRepository as any, utilityService, loggerService as any);
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
		liveKitService as any,
		userEntityService as any,
		globalEventService as any,
		roleService as any,
		hostPolicyService,
		apRendererService,
		queueService as any,
		loggerService as any,
		cloudflareTurnService as any,
	);
	return { service, redis, redisForSub, meta, liveKitService, rooms, chatRoomsRepository, chatRoomMembershipsRepository, usersRepository, instancesRepository, userEntityService, globalEventService, roleService, utilityService, queueService, cloudflareTurnService, logger, nonMembers };
}

// テストの時計。ミラーの現況は古いと捨てる (参加者のいる現況は寿命の 10 分に時計のずれの 5 分を足した分、空の現況は 2 日から 5 分を引いた分) ので、
// テストで使う現況の時刻 (2000 など) をその内に収める。時計だけを止め、タイマーは本物のまま動かす
export const TEST_CLOCK = 600_000;

export function remoteUser(overrides: Record<string, unknown> = {}) {
	return { id: 'ru1', host: 'remote.test', uri: 'https://remote.test/users/ru1', isSuspended: false, ...overrides } as any;
}

export function localRoom(overrides: Record<string, unknown> = {}) {
	return { id: 'r1', ownerId: 'owner', owner: { id: 'owner', host: null }, isArchived: false, ...overrides } as any;
}

export function mirrorRoom() {
	return { id: 'r1', ownerId: 'remoteOwner', owner: { id: 'remoteOwner', host: 'remote.test', uri: 'https://remote.test/users/remoteOwner' }, isArchived: false } as any;
}

/**
 * 次に fn が呼ばれたところで止める。reached は止まったときに解決し、resume() で元の動きのまま続ける。
 * 二つの処理が交互に進む順番を、テストの中で決めるために使う
 */
export function pauseNextCall(fn: { getMockImplementation(): unknown; mockImplementationOnce(impl: (...args: any[]) => unknown): unknown }) {
	const original = fn.getMockImplementation() as (...args: unknown[]) => unknown;
	let resume!: () => void;
	const resumed = new Promise<void>(resolve => {
		resume = resolve;
	});
	let markReached!: () => void;
	const reached = new Promise<void>(resolve => {
		markReached = resolve;
	});
	fn.mockImplementationOnce(async (...args: unknown[]) => {
		markReached();
		await resumed;
		return await original(...args);
	});
	return { reached, resume };
}

export type Fixture = ReturnType<typeof createFixture>;
