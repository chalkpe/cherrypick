/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { vi } from 'vitest';
import { FindOperator } from 'typeorm';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { ChatService } from '@/core/ChatService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { memoryRedis } from './chat-unread-redis.js';

export const LOCAL = 'https://local.test';
export const MIRROR_URI = 'https://remote.test/chat/rooms/mirror';
export const LOCAL_ROOM_URI = `${LOCAL}/chat/rooms/localroom`;

export type TestUser = { id: string; host: string | null; uri: string | null; inbox?: string | null; sharedInbox?: string | null; isSuspended?: boolean };

const remote = (id: string, host: string): TestUser => ({ id, host, uri: `https://${host}/users/${id}`, inbox: `https://${host}/users/${id}/inbox`, sharedInbox: null, isSuspended: false });
const local = (id: string): TestUser => ({ id, host: null, uri: null, inbox: null, sharedInbox: null, isSuspended: false });

/** alice and dave are here. bob owns the mirror room. */
export const alice = local('alice');
export const dave = local('dave');
export const bob = remote('bob', 'remote.test');
export const carol = remote('carol', 'other.test');
export const erin = remote('erin', 'third.test');
export const mallory = remote('mallory', 'evil.test');
/** On carol's server, so that server has someone in a room carol has left. */
export const frank = remote('frank', 'other.test');

type Row = { id: string; [key: string]: unknown };

function matches(row: Row, where: Record<string, unknown>) {
	return Object.entries(where).every(([key, value]) => {
		if (value instanceof FindOperator && value.type === 'isNull') return row[key] == null;
		if (value != null && typeof value === 'object' && '_value' in value) return ((value as { _value: unknown[] })._value).includes(row[key]);
		return row[key] === value;
	});
}

function fakeRepository(rows: Row[] = []) {
	return {
		rows,
		findOneBy: async (where: Record<string, unknown>) => rows.find(row => matches(row, where)) ?? null,
		findOne: async ({ where }: { where: Record<string, unknown> }) => rows.find(row => matches(row, where)) ?? null,
		findBy: async (where: Record<string, unknown>) => rows.filter(row => matches(row, where)),
		countBy: async (where: Record<string, unknown>) => rows.filter(row => matches(row, where)).length,
		existsBy: async (where: Record<string, unknown> | Record<string, unknown>[]) => [where].flat().some(condition => rows.some(row => matches(row, condition))),
		insertOne: async (row: Row) => {
			if (rows.some(existing => existing.roomId === row.roomId && existing.userId === row.userId && row.userId != null)) throw Object.assign(new Error('duplicate'), { code: '23505' });
			rows.push(row);
			return row;
		},
		insert: async (row: Row) => {
			rows.push(row);
		},
		update: async (where: string | Record<string, unknown>, patch: Record<string, unknown>) => {
			const found = rows.filter(row => (typeof where === 'string' ? row.id === where : matches(row, where)));
			found.forEach(row => Object.assign(row, patch));
			return { affected: found.length };
		},
		delete: async (where: string | Record<string, unknown>) => {
			const before = rows.length;
			const keep = rows.filter(row => !(typeof where === 'string' ? row.id === where : matches(row, where)));
			rows.splice(0, rows.length, ...keep);
			return { affected: before - rows.length };
		},
	};
}

function fakeStates(initial: [string, string, string][]) {
	const rows = new Map(initial.map(([roomId, userId, at]) => [`${roomId}/${userId}`, new Date(at)]));
	const acceptedAt = new Map<string, Date>();
	const memberAt = new Map<string, Date>();
	return {
		rows,
		acceptedAt,
		memberAt,
		findOneBy: async ({ roomId, userId }: { roomId: string; userId: string }) => {
			const key = `${roomId}/${userId}`;
			const lastRosterAt = rows.get(key);
			return lastRosterAt == null ? null : { roomId, userId, lastRosterAt, acceptedAt: acceptedAt.get(key) ?? null, lastMemberAt: memberAt.get(key) ?? null };
		},
		update: async ({ roomId, userId }: { roomId: string; userId: string }) => {
			acceptedAt.delete(`${roomId}/${userId}`);
			return { affected: 1 };
		},
		query: async (sql: string, [roomId, userId, at, accepted]: [string, string, Date, Date | undefined]) => {
			const key = `${roomId}/${userId}`;
			const current = rows.get(key);
			if (sql.includes('"lastMemberAt"')) {
				const stated = memberAt.get(key);
				if (sql.includes('IS NULL')) {
					if (stated != null && !(stated <= accepted!)) return [];
					if (current == null) rows.set(key, at);
					memberAt.set(key, accepted!);
					return [{ lastMemberAt: accepted }];
				}
				if (current == null || current < at) rows.set(key, at);
				if (accepted != null && (stated == null || stated < accepted)) memberAt.set(key, accepted);
				return [];
			}
			if (sql.includes('"acceptedAt"')) {
				if (current == null) rows.set(key, at);
				acceptedAt.set(key, accepted!);
				return [];
			}
			if (current == null) {
				rows.set(key, at);
				return [{ lastRosterAt: at }];
			}
			if (sql.includes('DO NOTHING')) return [];
			if (sql.includes('GREATEST')) {
				if (current < at) rows.set(key, at);
				return [{ lastRosterAt: rows.get(key) }];
			}
			if (!(sql.includes('"lastRosterAt" <= EXCLUDED') ? current <= at : current < at)) return [];
			rows.set(key, at);
			return [{ lastRosterAt: at }];
		},
	};
}

function fakeRedis() {
	const values = new Map<string, string>();
	const lists = new Map<string, string[]>();
	const sets = new Map<string, Set<string>>();
	const counts = new Map<string, number>();
	const client = {
		values,
		lists,
		eval: memoryRedis({ strings: values, sets }).eval,
		ttl: new Map<string, number>(),
		get: async (key: string) => values.get(key) ?? null,
		set: async (key: string, value: string, _ex: string, ttl: number, _nx: string) => {
			if (values.has(key)) return null;
			values.set(key, value);
			client.ttl.set(key, ttl);
			return 'OK';
		},
		setex: async (key: string, ttl: number, value: string) => {
			values.set(key, value);
			client.ttl.set(key, ttl);
			return 'OK';
		},
		del: async (key: string) => {
			const had = values.delete(key) || lists.delete(key);
			return had ? 1 : 0;
		},
		scard: async (key: string) => sets.get(key)?.size ?? 0,
		sismember: async (key: string, value: string) => Number(sets.get(key)?.has(value) ?? false),
		smembers: async (key: string) => [...(sets.get(key) ?? [])],
		sadd: async (key: string, value: string) => {
			const set = sets.get(key) ?? new Set<string>();
			set.add(value);
			sets.set(key, set);
			return 1;
		},
		expire: async () => 1,
		llen: async (key: string) => lists.get(key)?.length ?? 0,
		multi: () => {
			const commands: (() => unknown)[] = [];
			const transaction = {
				rpush: (key: string, ...items: string[]) => {
					commands.push(() => {
						const list = lists.get(key) ?? [];
						lists.set(key, list);
						return list.push(...items);
					});
					return transaction;
				},
				ltrim: (key: string, start: number, stop: number) => {
					commands.push(() => lists.set(key, (lists.get(key) ?? []).slice(start, stop + 1)));
					return transaction;
				},
				expire: () => {
					commands.push(() => 1);
					return transaction;
				},
				incr: (key: string) => {
					commands.push(() => {
						const count = (counts.get(key) ?? 0) + 1;
						counts.set(key, count);
						return count;
					});
					return transaction;
				},
				lrange: (key: string) => {
					commands.push(() => [...(lists.get(key) ?? [])]);
					return transaction;
				},
				del: (key: string) => {
					commands.push(() => lists.delete(key));
					return transaction;
				},
				exec: async () => commands.map(command => [null, command()]),
			};
			return transaction;
		},
		pipeline: () => {
			const commands: (() => unknown)[] = [];
			const pipeline = {
				del: (key: string) => {
					commands.push(() => values.delete(key));
					return pipeline;
				},
				srem: () => pipeline,
				sadd: () => pipeline,
				set: (key: string, value: string) => {
					commands.push(() => values.set(key, value));
					return pipeline;
				},
				get: (key: string) => {
					commands.push(() => values.get(key) ?? null);
					return pipeline;
				},
				setex: (key: string, ttl: number, value: string) => {
					commands.push(() => {
						values.set(key, value);
						client.ttl.set(key, ttl);
					});
					return pipeline;
				},
				exec: async () => commands.map(command => [null, command()]),
			};
			return pipeline;
		},
	};
	return client;
}

/** The two reaction updates the service runs, on the rows they would touch. */
function fakeMessageRepository(rows: Row[]) {
	const base = fakeRepository(rows);
	// The database hands out a copy, and the service goes on to keep its copy up to date.
	const copy = (row: Row | null) => row == null ? null : { ...row, reactions: [...row.reactions as string[]] };
	return {
		...base,
		findOneBy: async (where: Record<string, unknown>) => copy(await base.findOneBy(where)),
		update: async (where: string | Record<string, unknown> | Record<string, unknown>[], patch: Record<string, unknown>) => {
			const conditions = Array.isArray(where) ? where : [where];
			const id = typeof conditions[0] === 'string' ? conditions[0] : (conditions[0] as { id: string }).id;
			const row = rows.find(candidate => candidate.id === id);
			if (row == null) return { affected: 0 };
			Object.assign(row, patch);
			return { affected: 1 };
		},
		createQueryBuilder: () => {
			let id: string | undefined;
			let pair: string | undefined;
			let appending = false;
			const builder = {
				update: () => builder,
				set: (values: { reactions: () => string }) => {
					appending = values.reactions().includes('array_append');
					return builder;
				},
				where: (_sql: string, parameters: { id: string }) => {
					id = parameters.id;
					return builder;
				},
				andWhere: () => builder,
				setParameter: (_name: string, value: string) => {
					pair = value;
					return builder;
				},
				execute: async () => {
					const row = rows.find(candidate => candidate.id === id);
					if (row == null) return { affected: 0 };
					const reactions = row.reactions as string[];
					if (appending === reactions.includes(pair!)) return { affected: 0 };
					row.reactions = appending ? [...reactions, pair] : reactions.filter(value => value !== pair);
					return { affected: 1 };
				},
			};
			return builder;
		},
	};
}

export type FixtureOptions = {
	/** [roomId, userId] */
	memberships?: [string, string][];
	/** [roomId, userId] */
	invitations?: [string, string][];
	/** [roomId, userId, ISO date] */
	states?: [string, string, string][];
	messages?: Row[];
	/** What a signed or unsigned fetch of this URI answers */
	fetched?: Record<string, unknown>;
	refusedHosts?: string[];
};

export function chatRosterFixture(options: FixtureOptions = {}) {
	const users = new Map([alice, dave, bob, carol, erin, mallory, frank].map(user => [user.id, user]));
	const uriOf = (user: TestUser) => user.host == null ? `${LOCAL}/users/${user.id}` : user.uri!;
	const usersByUri = new Map([...users.values()].map(user => [uriOf(user), user]));
	const usersRepository = {
		findOneBy: async ({ id }: { id: string }) => users.get(id) ?? null,
		findOneByOrFail: async ({ id }: { id: string }) => users.get(id)!,
		findBy: async ({ id }: { id: { _value: string[] } }) => id._value.map(value => users.get(value)).filter(user => user != null),
	};

	const roomRows: Row[] = [
		{ id: 'mirror', name: 'mirror', description: '', ownerId: bob.id, uri: MIRROR_URI, isArchived: false },
		{ id: 'localroom', name: 'local', description: '', ownerId: alice.id, uri: null, isArchived: false },
	];
	const rooms = {
		...fakeRepository(roomRows),
		// The statement updateRoom runs, and the one looking for a room named by a member on an older server.
		createQueryBuilder: () => {
			let patch: Record<string, unknown> = {};
			let id: string | undefined;
			let number: string | undefined;
			let memberId: string | undefined;
			const builder = {
				innerJoin: (_entity: unknown, _alias: string, _condition: string, parameters: { userId: string }) => {
					memberId = parameters.userId;
					return builder;
				},
				getMany: async () => roomRows.filter(row => (row.id === number || (row.uri as string | null)?.endsWith(`/chat/rooms/${number}`)) &&
					memberships.rows.some(membership => membership.roomId === row.id && membership.userId === memberId)),
				update: () => builder,
				set: (values: Record<string, unknown>) => {
					patch = values;
					return builder;
				},
				where: (_sql: string, parameters: { id?: string; number?: string }) => {
					id = parameters.id;
					number = parameters.number;
					return builder;
				},
				andWhere: () => builder,
				returning: () => builder,
				execute: async () => {
					const row = roomRows.find(candidate => candidate.id === id);
					if (row != null) Object.assign(row, patch);
					return { raw: row != null ? [row] : [] };
				},
			};
			return builder;
		},
	};
	let sequence = 0;
	const generatedIds = () => `gen${++sequence}`;
	const memberships = fakeRepository((options.memberships ?? []).map(([roomId, userId]) => ({ id: generatedIds(), roomId, userId, isMuted: false })));
	const invitations = fakeRepository((options.invitations ?? []).map(([roomId, userId]) => ({ id: generatedIds(), roomId, userId, ignored: false })));
	const messages = fakeMessageRepository(options.messages ?? []);
	const states = fakeStates(options.states ?? []);
	const redisClient = fakeRedis();
	const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
	const deliver = vi.fn();
	const queueService = { deliver, createChatRoomRosterSyncJob: vi.fn(async () => {}) };
	const globalEventService = { publishChatRoomStream: vi.fn(), publishChatUserStream: vi.fn(), publishMainStream: vi.fn() };
	const liveKitService = {
		identityOf: uriOf,
		removeParticipant: vi.fn(async () => {}),
		deleteRoom: vi.fn(async () => {}),
	};
	const userEntityService = {
		isLocalUser: (user: { host: string | null }) => user.host == null,
		isRemoteUser: (user: { host: string | null }) => user.host != null,
		genLocalUserUri: (id: string) => `${LOCAL}/users/${id}`,
		pack: async (id: string) => users.get(id),
	};
	const idDates = new Map<string, Date>();
	const idService = {
		gen: generatedIds,
		// An ID stands for the moment it was made, so it reads the same every time.
		parse: (id: string) => {
			if (!idDates.has(id)) idDates.set(id, new Date(Date.now() - 60_000));
			return { date: idDates.get(id)! };
		},
	};
	const config = { url: LOCAL, host: 'local.test' };
	const utilityService = new UtilityService(config as never, { federation: 'all', blockedHosts: [], silencedHosts: [], sensitiveMediaHosts: [] } as never);

	const apRendererService = Object.assign(Object.create(ApRendererService.prototype), {
		config,
		userEntityService,
		idService,
		utilityService,
		customEmojiService: { localEmojisCache: { fetch: async () => new Map() } },
		driveFilesRepository: { findBy: async () => [], findOneBy: async () => null },
	}) as ApRendererService;

	const chatRosterService = Object.assign(Object.create(ChatRosterService.prototype), {
		redisClient,
		chatRoomRosterStatesRepository: states,
		queueService,
		logger,
	}) as ChatRosterService;

	const db = {
		transaction: async <T>(callback: (manager: unknown) => Promise<T>): Promise<T> => {
			const table = (entity: { name: string }) => entity.name === 'MiChatRoomInvitation' ? invitations : memberships;
			return await callback({
				query: async (sql: string) => {
					if (!sql.includes('pg_advisory_xact_lock')) throw new Error(`query not supported in this test: ${sql}`);
					return [];
				},
				findOne: (_entity: unknown, options: { where: Record<string, unknown> }) => rooms.findOneBy(options.where),
				find: async (_entity: unknown, options: { where: Record<string, unknown> }) => (await memberships.findBy(options.where)).map(membership => ({ ...membership, user: users.get(membership.userId as string) ?? null })),
				withRepository: (repository: unknown) => repository,
				delete: (entity: { name: string }, where: Record<string, unknown>) => table(entity).delete(where),
				findOneBy: (entity: { name: string }, where: Record<string, unknown>) => table(entity).findOneBy(where),
				update: (entity: { name: string }, where: Record<string, unknown>, patch: Record<string, unknown>) => table(entity).update(where, patch),
				countBy: (entity: { name: string }, where: Record<string, unknown>) => table(entity).countBy(where),
				insert: (entity: { name: string }, row: Row) => table(entity).insertOne(row),
			});
		},
	};

	const roleService = { isModerator: async () => false, getUserPolicies: async () => ({ chatAvailability: 'available' }) };

	const chatService = Object.assign(Object.create(ChatService.prototype), {
		logger,
		config,
		db,
		redisClient,
		usersRepository,
		chatMessagesRepository: messages,
		chatRoomsRepository: rooms,
		chatRoomInvitationsRepository: invitations,
		chatRoomMembershipsRepository: memberships,
		userEntityService,
		idService,
		globalEventService,
		apRendererService,
		queueService,
		roleService,
		userBlockingService: { checkBlocked: async () => false },
		customEmojiService: { localEmojisCache: { fetch: async () => new Map() }, populateEmojis: async () => ({}) },
		moderationLogService: { log: vi.fn() },
		notificationService: { createNotification: vi.fn() },
		liveKitService,
		chatRosterService,
		hostPolicyService: { isRefusedRemoteHost: async (host: string) => (options.refusedHosts ?? []).includes(host) },
	}) as ChatService;

	const signers: (string | null)[] = [];
	const fetched = new Map(Object.entries(options.fetched ?? {}));
	const createResolver = vi.fn(async () => {
		let signer: string | null = null;
		return {
			signAs: (user: { id: string }) => {
				signer = user.id;
			},
			resolve: async (value: unknown) => {
				if (typeof value !== 'string') return value;
				signers.push(signer);
				if (!fetched.has(value)) throw new Error(`nothing at ${value}`);
				const answer = fetched.get(value);
				if (answer instanceof Error) throw answer;
				return answer;
			},
		};
	});
	const resolver = { resolve: async (value: unknown) => value, signAs: () => {} };

	const inbox = Object.assign(Object.create(ApInboxService.prototype), {
		logger,
		config,
		db,
		redisClient,
		globalEventService,
		usersRepository,
		chatMessagesRepository: messages,
		chatRoomsRepository: rooms,
		chatRoomInvitationsRepository: invitations,
		chatRoomMembershipsRepository: memberships,
		chatService,
		chatRosterService,
		chatVoiceService: {},
		liveKitService,
		apRendererService,
		queueService,
		userEntityService,
		idService,
		roleService,
		notificationService: { createNotification: vi.fn() },
		userBlockingService: { checkBlocked: async () => false },
		utilityService,
		hostPolicyService: { isRefusedRemoteHost: async (host: string) => (options.refusedHosts ?? []).includes(host) },
		apResolverService: { createResolver },
		apDbResolverService: { getUserFromApId: async (uri: string) => usersByUri.get(uri) ?? null },
		apPersonService: { resolvePerson: async (uri: string) => usersByUri.get(uri) ?? null },
		apNoteService: { extractEmojis: async () => [], fetchNote: async () => null },
		apImageService: { resolveImage: vi.fn() },
		apMfmService: { htmlToMfm: (html: string) => html },
	}) as Record<string, any>;

	const delivered = () => deliver.mock.calls.map(([from, activity, to]) => ({ from: (from as TestUser).id, activity: activity as Record<string, any>, to: to as string }));

	return { inbox, chatService, chatRosterService, rooms, memberships, invitations, messages, states, redisClient, queueService, globalEventService, liveKitService, signers, fetched, resolver, createResolver, delivered, logger };
}

export const membersOf = (f: ReturnType<typeof chatRosterFixture>, roomId: string) => f.memberships.rows.filter(row => row.roomId === roomId).map(row => row.userId);
