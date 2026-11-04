/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { parseRemoteChatDate } from '@/core/activitypub/misc/chat-remote-date.js';
import { ChatRoomRosterSyncProcessorService } from '@/queue/processors/ChatRoomRosterSyncProcessorService.js';
import { StatusError } from '@/misc/status-error.js';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';
import ShowEndpoint from '@/server/api/endpoints/chat/rooms/show.js';

const NOW = Date.parse('2026-11-04T00:00:00.000Z');

describe('parseRemoteChatDate', () => {
	test.each([
		['a past time', '2026-11-03T23:59:59.123Z'],
		['a time just inside the allowance for clocks that run ahead', '2026-11-04T00:05:00.000Z'],
		['the first year PostgreSQL can be trusted with', '0000-01-01T00:00:00.000Z'],
	])('accepts %s', (_label, value) => {
		expect(parseRemoteChatDate(value, NOW)?.toISOString()).toBe(new Date(value).toISOString());
	});

	test.each([
		['more than five minutes ahead', '2026-11-04T00:05:00.001Z'],
		['a date far ahead', '9999-12-31T23:59:59.999Z'],
		['before the year 0', '-000001-12-31T23:59:59.999Z'],
		['after the year 9999', '+010000-01-01T00:00:00.000Z'],
		['not a date', 'yesterday-ish'],
		['a number', 1793000000000],
		['nothing', undefined],
	])('counts %s as not stated', (_label, value) => {
		expect(parseRemoteChatDate(value, NOW)).toBeNull();
	});
});

/** The statements are checked against PostgreSQL separately. This follows what they ask for. */
function fakeStates(initial: [string, Date][] = []) {
	const rows = new Map(initial);
	const key = (params: unknown[]) => `${params[0]}/${params[1]}`;
	return {
		rows,
		repository: {
			findOneBy: async ({ roomId, userId }: { roomId: string; userId: string }) => {
				const at = rows.get(`${roomId}/${userId}`);
				return at == null ? null : { roomId, userId, lastRosterAt: at };
			},
			query: async (sql: string, params: [string, string, Date]) => {
				const id = key(params);
				const at = params[2];
				const current = rows.get(id);
				if (current == null) {
					rows.set(id, at);
					return [{ lastRosterAt: at }];
				}
				if (sql.includes('DO NOTHING')) return [];
				if (sql.includes('GREATEST')) {
					if (current < at) rows.set(id, at);
					return [{ lastRosterAt: rows.get(id) }];
				}
				const applies = sql.includes('"lastRosterAt" <= EXCLUDED') ? current <= at : current < at;
				if (!applies) return [];
				rows.set(id, at);
				return [{ lastRosterAt: at }];
			},
		},
	};
}

function fakeRedis() {
	const values = new Map<string, string>();
	return {
		values,
		ttls: new Map<string, number>(),
		async set(key: string, value: string, _ex: string, ttl: number, _nx: string) {
			if (values.has(key)) return null;
			values.set(key, value);
			this.ttls.set(key, ttl);
			return 'OK';
		},
		async setex(key: string, ttl: number, value: string) {
			values.set(key, value);
			this.ttls.set(key, ttl);
			return 'OK';
		},
		async get(key: string) {
			return values.get(key) ?? null;
		},
		async del(key: string) {
			values.delete(key);
			return 1;
		},
		pipeline() {
			const operations: (() => Promise<unknown>)[] = [];
			const pipeline = {
				setex: (key: string, ttl: number, value: string) => {
					operations.push(() => this.setex(key, ttl, value));
					return pipeline;
				},
				exec: async () => Promise.all(operations.map(operation => operation())),
			};
			return pipeline;
		},
	};
}

function rosterService(options: { states?: [string, Date][]; queueFails?: boolean } = {}) {
	const states = fakeStates(options.states);
	const redis = fakeRedis();
	const createChatRoomRosterSyncJob = vi.fn(async () => {
		if (options.queueFails) throw new Error('queue is down');
	});
	const service = Object.assign(Object.create(ChatRosterService.prototype), {
		chatRoomRosterStatesRepository: states.repository,
		redisClient: redis,
		queueService: { createChatRoomRosterSyncJob },
		logger: { warn: vi.fn() },
	}) as ChatRosterService;
	return { service, states, redis, createChatRoomRosterSyncJob };
}

const T1 = new Date('2026-11-01T00:00:00.001Z');
const T2 = new Date('2026-11-01T00:00:00.002Z');
const T3 = new Date('2026-11-01T00:00:00.003Z');

describe('the order of membership changes', () => {
	test('an Add applies only when it is newer than the last change', async () => {
		const { service } = rosterService({ states: [['room/bob', T2]] });

		expect(await service.claimAdd('room', 'bob', T1)).toBe(false);
		expect(await service.claimAdd('room', 'bob', T2)).toBe(false);
		expect(await service.claimAdd('room', 'bob', T3)).toBe(true);
	});

	test('a Remove wins a tie with the last change', async () => {
		const { service } = rosterService({ states: [['room/bob', T2]] });

		expect(await service.claimRemove('room', 'bob', T1)).toBe(false);
		expect(await service.claimRemove('room', 'bob', T2)).toBe(true);
	});

	test('the first change for a member applies and is remembered', async () => {
		const { service, states } = rosterService();

		expect(await service.claimRemove('room', 'bob', T2)).toBe(true);
		expect(states.rows.get('room/bob')).toEqual(T2);
		expect(await service.claimAdd('room', 'bob', T1)).toBe(false);
	});

	test('a change without a time applies in arrival order and leaves the record alone', async () => {
		const { service, states } = rosterService({ states: [['room/bob', T2]] });

		expect(await service.claimAdd('room', 'bob', null)).toBe(true);
		expect(await service.claimRemove('room', 'bob', null)).toBe(true);
		expect(states.rows.get('room/bob')).toEqual(T2);
	});

	test('advancing never moves the record back', async () => {
		const { service, states } = rosterService({ states: [['room/bob', T2]] });

		await service.advance('room', 'bob', T1);
		expect(states.rows.get('room/bob')).toEqual(T2);
		await service.advance('room', 'bob', T3);
		expect(states.rows.get('room/bob')).toEqual(T3);
		await service.advance('room', 'carol', T1);
		expect(states.rows.get('room/carol')).toEqual(T1);
	});

	test('reads what was last applied', async () => {
		const { service } = rosterService({ states: [['room/bob', T2]] });

		expect(await service.lastRosterAt('room', 'bob')).toEqual(T2);
		expect(await service.lastRosterAt('room', 'carol')).toBeNull();
	});

	test('the roster removes only a member whose last change it is newer than', async () => {
		const { service, states } = rosterService({ states: [['room/bob', T2]] });

		expect(await service.claimRosterRemove('room', 'bob', T1)).toBe(false);
		expect(await service.claimRosterRemove('room', 'bob', T2)).toBe(false);
		expect(await service.claimRosterRemove('room', 'bob', T3)).toBe(true);
		expect(states.rows.get('room/bob')).toEqual(T3);
	});

	test('a membership with no record counts as older than the roster', async () => {
		const { service, states } = rosterService();

		expect(await service.claimRosterRemove('room', 'carol', T3)).toBe(true);
		expect(states.rows.get('room/carol')).toEqual(T3);
	});

	test('recording a new membership does not replace what is known', async () => {
		const { service, states } = rosterService({ states: [['room/bob', T1]] });

		await service.recordIfMissing('room', 'bob', T3);
		await service.recordIfMissing('room', 'carol', T3);

		expect(states.rows.get('room/bob')).toEqual(T1);
		expect(states.rows.get('room/carol')).toEqual(T3);
	});
});

describe('asking for the roster again', () => {
	test('asks once a minute for each room and member', async () => {
		const { service, redis, createChatRoomRosterSyncJob } = rosterService();

		await service.requestSync({ id: 'room' }, 'bob');
		await service.requestSync({ id: 'room' }, 'bob');
		await service.requestSync({ id: 'room' }, 'carol');
		await service.requestSync({ id: 'other' }, 'bob');

		expect(createChatRoomRosterSyncJob.mock.calls).toEqual([['room'], ['room'], ['other']]);
		expect(redis.ttls.get('chat_room_roster_sync:room:bob')).toBe(60);
	});

	test('a queue that is down does not fail what asked', async () => {
		const { service } = rosterService({ queueFails: true });

		await expect(service.requestSync({ id: 'room' }, 'bob')).resolves.toBeUndefined();
	});
});

describe('rooms that are gone', () => {
	const ROOM = 'https://remote.example/chat/rooms/room1';
	const THIRTY_DAYS = 30 * 24 * 60 * 60;

	test('remembers for at least thirty days that the owner deleted a room, and when', async () => {
		const { service, redis } = rosterService();

		expect(await service.isRoomDeletedByOwner(ROOM)).toBe(false);
		await service.markRoomDeletedByOwner(ROOM);

		expect(await service.isRoomDeletedByOwner(ROOM)).toBe(true);
		expect(await service.isRoomGone(ROOM)).toBe(true);
		const key = `chat_room_deleted:${ROOM}`;
		expect(redis.ttls.get(key)).toBeGreaterThanOrEqual(THIRTY_DAYS);
		expect(Number.isNaN(Date.parse(redis.values.get(key)!))).toBe(false);
	});

	test('a copy removed here is gone without blocking a new invitation', async () => {
		const { service } = rosterService();

		await service.markRoomClosedHere(ROOM);
		expect(await service.isRoomGone(ROOM)).toBe(true);
		expect(await service.isRoomDeletedByOwner(ROOM)).toBe(false);

		await service.forgetRoomClosedHere(ROOM);
		expect(await service.isRoomGone(ROOM)).toBe(false);
	});

	test('tells only the people who were in the room that it was deleted', async () => {
		const { service, redis } = rosterService();

		await service.markRoomDeletedFor(['alice', 'bob'], 'room1');

		expect(await service.wasRoomDeletedFor('alice', 'room1')).toBe(true);
		expect(await service.wasRoomDeletedFor('bob', 'room1')).toBe(true);
		expect(await service.wasRoomDeletedFor('carol', 'room1')).toBe(false);
		expect(redis.ttls.get('chat_room_deleted_for:alice:room1')).toBeGreaterThanOrEqual(THIRTY_DAYS);
	});
});

describe('applying the roster the owner publishes', () => {
	const ROOM_URI = 'https://remote.example/chat/rooms/room1';
	const ROSTER_AT = new Date(Date.now() - 1000);
	const owner = { id: 'owner', host: 'remote.example', uri: 'https://remote.example/users/owner', isSuspended: false };
	const alice = { id: 'alice', host: null, uri: null, isSuspended: false };
	const bob = { id: 'bob', host: 'other.example', uri: 'https://other.example/users/bob', isSuspended: false };
	const carol = { id: 'carol', host: 'other.example', uri: 'https://other.example/users/carol', isSuspended: false };
	const dave = { id: 'dave', host: null, uri: null, isSuspended: false };
	const aliceUri = 'https://local.example/users/alice';
	const daveUri = 'https://local.example/users/dave';

	function setup(options: {
		members?: { id: string; userId: string; createdAt?: Date }[];
		group?: Record<string, unknown> | null;
		fetch?: (member: { id: string }) => Promise<unknown>;
		states?: [string, Date][];
		room?: Record<string, unknown> | null;
		refused?: boolean;
	} = {}) {
		const memberships = options.members ?? [{ id: 'm1', userId: 'alice' }];
		const users = new Map<string, typeof owner | typeof alice>([owner, alice, bob, carol, dave].map(user => [user.id, user]));
		const states = fakeStates(options.states);
		const created = new Map(memberships.map(membership => [membership.id, membership.createdAt ?? new Date(ROSTER_AT.getTime() - 60_000)]));
		const group = options.group === undefined
			? {
				id: ROOM_URI,
				type: 'Group',
				attributedTo: owner.uri,
				_misskey_chatRoomMembers: [owner.uri, aliceUri],
				_misskey_chatRoomRosterAt: ROSTER_AT.toISOString(),
			}
			: options.group;
		const signers: string[] = [];
		const removeRoomMember = vi.fn(async (_room: unknown, user: { id: string }) => {
			const index = memberships.findIndex(membership => membership.userId === user.id);
			if (index === -1) return false;
			memberships.splice(index, 1);
			return true;
		});
		const insertOne = vi.fn(async (row: { id: string; roomId: string; userId: string }) => {
			memberships.push({ id: row.id, userId: row.userId });
			return row;
		});
		const publishChatRoomStream = vi.fn();
		const resolvePerson = vi.fn(async (uri: string) => [...users.values()].find(user => user.uri === uri) ?? null);
		const room = options.room === undefined ? { id: 'room1', uri: ROOM_URI, ownerId: owner.id } : options.room;

		const processor = Object.assign(Object.create(ChatRoomRosterSyncProcessorService.prototype), {
			config: { url: 'https://local.example' },
			chatRoomsRepository: { findOneBy: async () => room },
			chatRoomMembershipsRepository: {
				findBy: async () => [...memberships],
				insertOne,
				countBy: async () => memberships.length,
			},
			usersRepository: {
				findOneBy: async ({ id }: { id: string }) => users.get(id) ?? null,
				findBy: async () => memberships.map(membership => users.get(membership.userId)).filter(user => user != null),
			},
			chatService: { removeRoomMember },
			chatRosterService: Object.assign(Object.create(ChatRosterService.prototype), {
				chatRoomRosterStatesRepository: states.repository,
			}),
			apResolverService: {
				createResolver: async () => {
					let signer: { id: string } | null = null;
					return {
						signAs: (member: { id: string }) => {
							signer = member;
						},
						resolve: async () => {
							if (signer != null) signers.push(signer.id);
							if (options.fetch != null && signer != null) return await options.fetch(signer);
							if (group == null) throw new StatusError('Not Found', 404);
							return group;
						},
					};
				},
			},
			apDbResolverService: {
				getUserFromApId: async (uri: string) => {
					if (uri === aliceUri) return alice;
					if (uri === daveUri) return dave;
					return uri === bob.uri ? bob : null;
				},
			},
			apPersonService: { resolvePerson },
			userEntityService: {
				isLocalUser: (user: { host: string | null }) => user.host == null,
				isRemoteUser: (user: { host: string | null }) => user.host != null,
			},
			idService: {
				gen: () => `new-${insertOne.mock.calls.length}`,
				parse: (id: string) => ({ date: created.get(id) ?? new Date(0) }),
			},
			utilityService: {
				isUriLocal: (uri: string) => uri.startsWith('https://local.example/'),
				isFederationAllowedUri: (uri: string) => !uri.startsWith('https://blocked.example/'),
			},
			hostPolicyService: { isRefusedRemoteHost: async () => options.refused ?? false },
			globalEventService: { publishChatRoomStream },
			logger: { warn: vi.fn(), info: vi.fn() },
		}) as ChatRoomRosterSyncProcessorService;

		const run = () => processor.process({ data: { roomId: 'room1' } } as never);
		return { run, memberships, states, signers, removeRoomMember, insertOne, publishChatRoomStream, resolvePerson };
	}

	function roster(members: (string | null)[], extra: Record<string, unknown> = {}) {
		return {
			id: ROOM_URI,
			type: 'Group',
			attributedTo: owner.uri,
			_misskey_chatRoomMembers: members,
			_misskey_chatRoomRosterAt: ROSTER_AT.toISOString(),
			...extra,
		};
	}

	test('adds a listed member this server had not heard of', async () => {
		const { run, memberships, states, publishChatRoomStream } = setup({ group: roster([owner.uri, aliceUri, bob.uri]) });

		await run();

		expect(memberships.map(membership => membership.userId)).toEqual(['alice', 'bob']);
		expect(states.rows.get('room1/bob')).toEqual(ROSTER_AT);
		expect(publishChatRoomStream).toHaveBeenCalledWith('room1', 'membershipStarted', { userId: 'bob' });
	});

	test('fetches the actor of a listed member not stored here yet', async () => {
		const { run, memberships, resolvePerson } = setup({ group: roster([owner.uri, aliceUri, carol.uri]) });

		await run();

		expect(resolvePerson).toHaveBeenCalledWith(carol.uri, expect.anything());
		expect(memberships.map(membership => membership.userId)).toEqual(['alice', 'carol']);
	});

	test('does not add a listed member over a newer change', async () => {
		const { run, memberships } = setup({
			group: roster([owner.uri, aliceUri, bob.uri]),
			states: [['room1/bob', new Date(ROSTER_AT.getTime() + 1)]],
		});

		await run();

		expect(memberships.map(membership => membership.userId)).toEqual(['alice']);
	});

	test('removes a member the list has dropped when their last change is older', async () => {
		const { run, removeRoomMember, states } = setup({
			members: [{ id: 'm1', userId: 'alice' }, { id: 'm2', userId: 'bob' }],
			states: [['room1/bob', T1]],
		});

		await run();

		expect(removeRoomMember).toHaveBeenCalledTimes(1);
		expect(removeRoomMember).toHaveBeenCalledWith(expect.anything(), bob);
		expect(states.rows.get('room1/bob')).toEqual(ROSTER_AT);
	});

	test('keeps a dropped member whose last change is newer than the list', async () => {
		const { run, removeRoomMember } = setup({
			members: [{ id: 'm1', userId: 'alice' }, { id: 'm2', userId: 'bob' }],
			states: [['room1/bob', new Date(ROSTER_AT.getTime() + 1)]],
		});

		await run();

		expect(removeRoomMember).not.toHaveBeenCalled();
	});

	test('removes a dropped member with no recorded change: their membership is older than the record', async () => {
		const { run, removeRoomMember } = setup({ members: [{ id: 'm1', userId: 'alice' }, { id: 'm2', userId: 'bob' }] });

		await run();

		expect(removeRoomMember).toHaveBeenCalledWith(expect.anything(), bob);
	});

	test('keeps a local member who joined after the list was read, whose Accept is still on its way', async () => {
		const { run, removeRoomMember } = setup({
			members: [{ id: 'm1', userId: 'alice' }, { id: 'm2', userId: 'dave', createdAt: new Date(ROSTER_AT.getTime() + 1) }],
			states: [['room1/dave', T1]],
		});

		await run();

		expect(removeRoomMember).not.toHaveBeenCalled();
	});

	test('removes a local member the owner no longer counts when they joined before the list', async () => {
		const { run, removeRoomMember } = setup({
			members: [{ id: 'm1', userId: 'alice' }, { id: 'm2', userId: 'dave', createdAt: new Date(ROSTER_AT.getTime() - 1) }],
			states: [['room1/dave', T1]],
		});

		await run();

		expect(removeRoomMember).toHaveBeenCalledWith(expect.anything(), dave);
	});

	test('never adds a local user: only their own acceptance makes them a member', async () => {
		const { run, memberships } = setup({ group: roster([owner.uri, aliceUri, daveUri]) });

		await run();

		expect(memberships.map(membership => membership.userId)).toEqual(['alice']);
	});

	test('does not take the owner for a member whether or not the list names them', async () => {
		const named = setup({ group: roster([owner.uri, aliceUri]) });
		await named.run();
		expect(named.insertOne).not.toHaveBeenCalled();

		const unnamed = setup({ group: roster([aliceUri]) });
		await unnamed.run();
		expect(unnamed.insertOne).not.toHaveBeenCalled();
		expect(unnamed.removeRoomMember).not.toHaveBeenCalled();
	});

	test('a later change older than the list does not undo what the list says', async () => {
		const { run, states } = setup({
			members: [{ id: 'm1', userId: 'alice' }, { id: 'm2', userId: 'bob' }],
			group: roster([owner.uri, aliceUri, bob.uri]),
			states: [['room1/bob', T1]],
		});

		await run();

		expect(states.rows.get('room1/bob')).toEqual(ROSTER_AT);
	});

	test('skips a member from a host this server does not federate with', async () => {
		const blocked = 'https://blocked.example/users/mallory';
		const { run, resolvePerson, insertOne } = setup({ group: roster([owner.uri, aliceUri, blocked]) });

		await run();

		expect(resolvePerson).not.toHaveBeenCalled();
		expect(insertOne).not.toHaveBeenCalled();
	});

	test('one actor that cannot be fetched does not stop the rest', async () => {
		const missing = 'https://gone.example/users/nobody';
		const { run, memberships, resolvePerson } = setup({ group: roster([owner.uri, aliceUri, missing, bob.uri]) });
		resolvePerson.mockRejectedValueOnce(new Error('unreachable'));

		await run();

		expect(memberships.map(membership => membership.userId)).toEqual(['alice', 'bob']);
	});

	test('asks as a local member, and tries another when the owner does not count that one', async () => {
		const { run, signers, memberships } = setup({
			members: [{ id: 'm1', userId: 'alice' }, { id: 'm2', userId: 'dave' }],
			fetch: async (member) => {
				if (member.id === 'alice') throw new StatusError('Not Found', 404);
				return roster([owner.uri, daveUri, aliceUri]);
			},
		});

		await run();

		expect(signers).toEqual(['alice', 'dave']);
		expect(memberships).toHaveLength(2);
	});

	test('retries when the owner cannot be reached', async () => {
		const { run } = setup({ fetch: async () => {
			throw new StatusError('Bad Gateway', 502);
		} });

		await expect(run()).rejects.toThrow();
	});

	test.each<[string, Record<string, unknown> | null]>([
		['an owner that does not publish a roster', { id: ROOM_URI, type: 'Group', attributedTo: owner.uri }],
		['a roster without a time', roster([aliceUri], { _misskey_chatRoomRosterAt: undefined })],
		['a roster dated too far ahead', roster([aliceUri], { _misskey_chatRoomRosterAt: new Date(Date.now() + 3_600_000).toISOString() })],
		['a roster that is not a list', roster([], { _misskey_chatRoomMembers: aliceUri })],
		['a roster with something other than URIs', roster([aliceUri, null])],
		['a roster over the size limit', roster(Array.from({ length: 52 }, (_, i) => `https://other.example/users/${i}`))],
		['another object', roster([aliceUri], { type: 'Note' })],
		['another room', roster([aliceUri], { id: 'https://remote.example/chat/rooms/other' })],
		['a room attributed to someone else', roster([aliceUri], { attributedTo: bob.uri })],
		['a room nobody here can read', null],
	])('changes nothing for %s', async (_label, group) => {
		const { run, removeRoomMember, insertOne } = setup({
			members: [{ id: 'm1', userId: 'alice' }, { id: 'm2', userId: 'bob' }],
			states: [['room1/bob', T1]],
			group,
		});

		await run();

		expect(removeRoomMember).not.toHaveBeenCalled();
		expect(insertOne).not.toHaveBeenCalled();
	});

	test.each<[string, Parameters<typeof setup>[0]]>([
		['a room that is gone', { room: null }],
		['a room without a URI', { room: { id: 'room1', uri: null, ownerId: owner.id } }],
		['a room owned here', { room: { id: 'room1', uri: ROOM_URI, ownerId: alice.id } }],
		['a server this one refuses', { refused: true }],
		['no local member to ask as', { members: [{ id: 'm2', userId: 'bob' }] }],
	])('does not ask for %s', async (_label, options) => {
		const { run, signers } = setup(options);

		await run();

		expect(signers).toEqual([]);
	});
});

describe('the roster in a Group the owner serves', () => {
	const LOCAL = 'https://local.example';
	const ownerHere = { id: 'alice', host: null, uri: null };
	const member = { id: 'bob', host: 'other.example', uri: 'https://other.example/users/bob' };
	const localMember = { id: 'dave', host: null, uri: null };
	const invitee = { id: 'carol', host: 'other.example', uri: 'https://other.example/users/carol' };
	const stranger = { id: 'erin', host: 'other.example', uri: 'https://other.example/users/erin' };
	const remoteOwner = { id: 'owner', host: 'remote.example', uri: 'https://remote.example/users/owner' };

	async function startRoute(options: { actor: { id: string } | null; owner?: { id: string; host: string | null; uri: string | null }; message?: Record<string, unknown> }) {
		const owner = options.owner ?? ownerHere;
		const requestSync = vi.fn(async () => {});
		const room = { id: 'room1', ownerId: owner.id, owner, name: 'room', description: '', uri: owner.host == null ? null : 'https://remote.example/chat/rooms/room1' };
		const service = Object.assign(Object.create(ActivityPubServerService.prototype), {
			config: { host: 'local.example', url: LOCAL },
			meta: { federation: 'all' },
			chatRosterService: { requestSync },
			chatMessagesRepository: { findOneBy: async () => options.message ?? null },
			chatRoomsRepository: { findOne: async () => room },
			chatRoomMembershipsRepository: {
				findOneBy: async ({ userId }: { userId: string }) => (userId === member.id || userId === localMember.id ? { roomId: 'room1', userId } : null),
				findBy: async () => [{ roomId: 'room1', userId: member.id }, { roomId: 'room1', userId: localMember.id }],
			},
			chatRoomInvitationsRepository: { findOneBy: async ({ userId }: { userId: string }) => (userId === invitee.id ? { roomId: 'room1', userId } : null) },
			usersRepository: {
				findOneBy: async ({ id }: { id: string }) => [ownerHere, member, localMember, remoteOwner].find(user => user.id === id) ?? null,
				findBy: async () => [owner, member, localMember],
			},
			apRendererService: {
				addContext: (object: unknown) => object,
				renderChatRoom: () => ({ id: `${LOCAL}/chat/rooms/room1`, type: 'Group', name: 'room' }),
			},
		}) as ActivityPubServerService;
		// These read the signature and the access rules, which are tested with the fetch of a message.
		Object.defineProperties(service, {
			applyAccessControl: { value: async () => false },
			getSignedRequestActor: { value: async () => options.actor },
		});
		const app = Fastify();
		await app.register((instance, _options, done) => {
			service.createServer(instance, {}, done);
		});
		await app.ready();
		return { app, requestSync };
	}

	const get = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url, headers: { accept: 'application/activity+json' } });

	test('shows the members to a member, with the time read before them', async () => {
		const { app } = await startRoute({ actor: member });
		const before = Date.now();

		const body = (await get(app, '/chat/rooms/room1')).json();

		expect(body._misskey_chatRoomMembers).toEqual([`${LOCAL}/users/alice`, member.uri, `${LOCAL}/users/dave`]);
		expect(body._misskey_chatRoomRosterAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(Date.parse(body._misskey_chatRoomRosterAt)).toBeGreaterThanOrEqual(before);
		await app.close();
	});

	test('does not show the members to someone who is only invited', async () => {
		const { app } = await startRoute({ actor: invitee });

		const response = await get(app, '/chat/rooms/room1');

		expect(response.statusCode).toBe(200);
		expect(response.json()).not.toHaveProperty('_misskey_chatRoomMembers');
		expect(response.json()).not.toHaveProperty('_misskey_chatRoomRosterAt');
		await app.close();
	});

	test('a copy of another server\'s room does not speak for its members', async () => {
		const { app } = await startRoute({ actor: member, owner: remoteOwner });

		const body = (await get(app, '/chat/rooms/room1')).json();

		expect(body).not.toHaveProperty('_misskey_chatRoomMembers');
		await app.close();
	});

	test('someone asking for a message of another server\'s room who is not a member here gets 404, and the roster is read again', async () => {
		const { app, requestSync } = await startRoute({
			actor: stranger,
			owner: remoteOwner,
			message: { id: 'message1', fromUserId: localMember.id, toRoomId: 'room1', deletedAt: null },
		});

		const response = await get(app, '/chat/messages/message1');

		expect(response.statusCode).toBe(404);
		expect(requestSync).toHaveBeenCalledWith(expect.objectContaining({ id: 'room1' }), stranger.id);
		await app.close();
	});

	test('a room owned here knows its members, so a stranger gets 404 and nothing is read', async () => {
		const { app, requestSync } = await startRoute({
			actor: stranger,
			message: { id: 'message1', fromUserId: localMember.id, toRoomId: 'room1', deletedAt: null },
		});

		const response = await get(app, '/chat/messages/message1');

		expect(response.statusCode).toBe(404);
		expect(requestSync).not.toHaveBeenCalled();
		await app.close();
	});
});

describe('chat/rooms/show for a room that is gone', () => {
	const me = { id: 'me', host: null, uri: null } as never;

	function endpoint(options: { room: { id: string } | null; canView?: boolean; deletedForMe?: boolean }) {
		const chatService = {
			checkChatAvailability: vi.fn().mockResolvedValue(undefined),
			findRoomById: vi.fn().mockResolvedValue(options.room),
			hasPermissionToViewRoomInfo: vi.fn().mockResolvedValue(options.canView ?? false),
		};
		const wasRoomDeletedFor = vi.fn().mockResolvedValue(options.deletedForMe ?? false);
		const packRoom = vi.fn().mockResolvedValue({ id: 'room1' });
		const show = new (ShowEndpoint as never as new (...args: unknown[]) => { exec: (...args: unknown[]) => Promise<unknown> })(chatService, { packRoom }, { wasRoomDeletedFor });
		return { show, wasRoomDeletedFor };
	}

	test('tells someone who was in the room that it was deleted', async () => {
		const { show, wasRoomDeletedFor } = endpoint({ room: null, deletedForMe: true });

		await expect(show.exec({ roomId: 'room1' }, me, null, null)).rejects.toMatchObject({ code: 'ROOM_DELETED' });
		expect(wasRoomDeletedFor).toHaveBeenCalledWith('me', 'room1');
	});

	test('tells anyone else only that there is no such room', async () => {
		const { show } = endpoint({ room: null });

		await expect(show.exec({ roomId: 'room1' }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_ROOM' });
	});

	test('someone removed from a room that still exists hears that there is no such room', async () => {
		const { show, wasRoomDeletedFor } = endpoint({ room: { id: 'room1' } });

		await expect(show.exec({ roomId: 'room1' }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_ROOM' });
		expect(wasRoomDeletedFor).not.toHaveBeenCalled();
	});
});
