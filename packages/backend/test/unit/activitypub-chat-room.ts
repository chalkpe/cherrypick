/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { TwirpError } from 'livekit-server-sdk';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ChatService } from '@/core/ChatService.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { JsonLdService } from '@/core/activitypub/JsonLdService.js';
import { parseChatRoomVoiceState } from '@/core/activitypub/misc/chat-room-voice-state.js';
import { UtilityService } from '@/core/UtilityService.js';
import { chatRosterOver } from '../misc/chat-roster-stub.js';
import { memoryRedis } from '../misc/chat-unread-redis.js';

type Row = { id: string; [key: string]: unknown };

const LOCAL = 'https://local.test';

function matches(row: Row, where: Record<string, unknown>) {
	return Object.entries(where).every(([key, value]) => row[key] === value);
}

function fakeRepository(rows: Row[] = [], hooks: { beforeDelete?: () => void | Promise<void>; beforeInsert?: () => void | Promise<void> } = {}) {
	return {
		rows,
		findOneBy: async (where: Record<string, unknown>) => rows.find(row => matches(row, where)) ?? null,
		insertOne: async (row: Row) => {
			await hooks.beforeInsert?.();
			rows.push(row);
			return row;
		},
		update: async (id: string, patch: Record<string, unknown>) => {
			const row = rows.find(row => row.id === id);
			if (row) Object.assign(row, patch);
			return { affected: row ? 1 : 0 };
		},
		delete: async (where: string | Record<string, unknown>) => {
			await hooks.beforeDelete?.();
			const before = rows.length;
			const keep = rows.filter(row => !(typeof where === 'string' ? row.id === where : matches(row, where)));
			rows.splice(0, rows.length, ...keep);
			return { affected: before - rows.length };
		},
		countBy: async (where: Record<string, unknown>) => rows.filter(row => matches(row, where)).length,
	};
}

type FakeManager = {
	findOne: (entity: unknown, options: { where: Record<string, unknown> }) => Promise<Row | null>;
	withRepository: (repository: unknown) => unknown;
	update: (entity: unknown, where: { id: string }, patch: Record<string, unknown>) => Promise<{ affected: number }>;
	delete: (entity: unknown, where: Record<string, unknown>) => Promise<{ affected: number }>;
	findOneBy: (entity: unknown, where: Record<string, unknown>) => Promise<Row | null>;
	insert: (entity: unknown, row: Row) => Promise<Row>;
	countBy: (entity: unknown, where: Record<string, unknown>) => Promise<number>;
};

/**
 * Minimal in-memory stand-in for a DataSource. Transactions are serialized like
 * a real database row lock and rolled back to the snapshot they started from.
 */
function fakeDataSource(tables: Map<string, ReturnType<typeof fakeRepository>>) {
	let queue: Promise<unknown> = Promise.resolve();

	function tableFor(entity: unknown) {
		const name = typeof entity === 'function' ? (entity as { name: string }).name : String(entity);
		const table = tables.get(name);
		if (table == null) throw new Error(`Unexpected entity: ${name}`);
		return table;
	}

	const manager: FakeManager = {
		findOne: (entity, options) => tableFor(entity).findOneBy(options.where),
		withRepository: repository => repository,
		update: (entity, where, patch) => tableFor(entity).update(where.id, patch),
		delete: (entity, where) => tableFor(entity).delete(where),
		findOneBy: (entity, where) => tableFor(entity).findOneBy(where),
		insert: (entity, row) => tableFor(entity).insertOne(row),
		countBy: (entity, where) => tableFor(entity).countBy(where),
	};

	return {
		transaction: async <T>(callback: (manager: FakeManager) => Promise<T>): Promise<T> => {
			const run = queue.then(async () => {
				const snapshot = [...tables.values()].map(table => table.rows.map(row => ({ ...row })));
				try {
					return await callback(manager);
				} catch (error) {
					[...tables.values()].forEach((table, index) => {
						table.rows.splice(0, table.rows.length, ...snapshot[index]);
					});
					throw error;
				}
			});
			queue = run.then(() => undefined, () => undefined);
			return run;
		},
	};
}

const localOwner = { id: 'localOwner', host: null, uri: null };
const alice = { id: 'alice', host: null, uri: null };
const remoteOwner = { id: 'bob', host: 'remote.test', uri: 'https://remote.test/users/bob' };
const invitedRemote = { id: 'carol', host: 'remote.test', uri: 'https://remote.test/users/carol', inbox: 'https://remote.test/users/carol/inbox' };
const dave = { id: 'dave', host: 'other.test', uri: 'https://other.test/users/dave', inbox: 'https://other.test/users/dave/inbox' };

function fixture(options: {
	invitations?: Row[];
	rooms?: Row[];
	memberships?: Row[];
	hooks?: { beforeInvitationDelete?: () => void | Promise<void>; failMembershipInsert?: boolean };
} = {}) {
	const rooms = fakeRepository([
		{ id: 'localroom', name: 'secret', ownerId: localOwner.id, description: '', isArchived: false },
		...(options.rooms ?? []),
	]);
	const invitations = fakeRepository(options.invitations ?? [], {
		beforeDelete: options.hooks?.beforeInvitationDelete,
	});
	const memberships = fakeRepository(options.memberships ?? [], {
		beforeInsert: options.hooks?.failMembershipInsert === true
			? () => {
				throw new Error('membership insert failed');
			}
			: undefined,
	});
	const db = fakeDataSource(new Map([
		['MiChatRoom', rooms],
		['MiChatRoomInvitation', invitations],
		['MiChatRoomMembership', memberships],
	]));
	const usersByUri = new Map<string, unknown>([
		[`${LOCAL}/users/${localOwner.id}`, localOwner],
		[`${LOCAL}/users/${alice.id}`, alice],
		[remoteOwner.uri, remoteOwner],
		[invitedRemote.uri, invitedRemote],
		[dave.uri, dave],
	]);
	let seq = 0;
	const notificationService = { createNotification: vi.fn() };
	const chatVoiceService = { receiveRemoteSnapshot: vi.fn(async () => 'ok: voice state stored') };
	const usersById = new Map([localOwner, alice, remoteOwner, invitedRemote, dave].map(user => [user.id, user]));
	const liveKitService = {
		identityOf: (user: { id: string; host: string | null; uri: string | null }) => user.host == null ? `${LOCAL}/users/${user.id}` : user.uri,
		removeParticipant: vi.fn(async (_roomId: string, _identity: string) => {}),
		deleteRoom: vi.fn(async (_roomId: string) => {}),
	};
	const unread = memoryRedis();
	const globalEventService = { publishChatRoomStream: vi.fn(), publishMainStream: vi.fn() };
	const resolver = { resolve: vi.fn() };
	const apResolverService = { createResolver: vi.fn(async () => resolver) };
	const pendingRoomIndex = new Map<string, Set<string>>();
	const pendingRoomActivities = new Map<string, string[]>();
	const roomTombstones = new Map<string, string>();
	const redisClient = {
		get: vi.fn(async (key: string) => roomTombstones.get(key) ?? null),
		setex: vi.fn(async (key: string, _ttl: number, value: string) => {
			roomTombstones.set(key, value);
			return 'OK';
		}),
		scard: vi.fn(async (key: string) => pendingRoomIndex.get(key)?.size ?? 0),
		sadd: vi.fn(async (key: string, value: string) => {
			const set = pendingRoomIndex.get(key) ?? new Set<string>();
			set.add(value);
			pendingRoomIndex.set(key, set);
			return 1;
		}),
		expire: vi.fn().mockResolvedValue(1),
		llen: vi.fn(async (key: string) => pendingRoomActivities.get(key)?.length ?? 0),
		del: vi.fn(async (key: string) => Number(pendingRoomActivities.delete(key))),
		multi: () => {
			const commands: (() => unknown)[] = [];
			const transaction = {
				rpush: (key: string, ...values: string[]) => {
					commands.push(() => {
						const list = pendingRoomActivities.get(key) ?? [];
						pendingRoomActivities.set(key, list);
						return list.push(...values);
					});
					return transaction;
				},
				expire: () => {
					commands.push(() => 1);
					return transaction;
				},
				lrange: (key: string) => {
					commands.push(() => [...(pendingRoomActivities.get(key) ?? [])]);
					return transaction;
				},
				del: (key: string) => {
					commands.push(() => Number(pendingRoomActivities.delete(key)));
					return transaction;
				},
				exec: async () => commands.map(command => [null, command()]),
			};
			return transaction;
		},
	};
	const chatRosterService = chatRosterOver(redisClient);
	const inbox = Object.assign(Object.create(ApInboxService.prototype), {
		logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		db,
		redisClient,
		chatRosterService,
		globalEventService,
		chatRoomsRepository: rooms,
		chatRoomInvitationsRepository: invitations,
		chatRoomMembershipsRepository: {
			...memberships,
			findBy: async (where: Record<string, unknown>) => memberships.rows.filter(row => matches(row, where)),
		},
		usersRepository: {
			findOneBy: async ({ id }: { id: string }) => usersById.get(id) ?? null,
			findBy: async () => [...usersById.values()],
		},
		liveKitService,
		chatService: {
			isRoomMember: async (room: Row, userId: string) => room.ownerId === userId || memberships.rows.some(m => m.roomId === room.id && m.userId === userId),
			findMessageByUri: async () => null,
			notifyRoomListChanged: vi.fn(),
			deleteRemoteMessage: vi.fn(),
			updateRoom: vi.fn(async (room: Row, patch: Record<string, unknown>) => {
				Object.assign(room, patch);
				return room;
			}),
			deleteRoom: vi.fn(async (room: Row) => {
				await rooms.delete(room.id);
			}),
		},
		apDbResolverService: {
			getUserFromApId: async (uri: string) => usersByUri.get(uri) ?? null,
		},
		apPersonService: {
			resolvePerson: async (uri: string) => usersByUri.get(uri) ?? null,
		},
		userEntityService: {
			isLocalUser: (user: { host: string | null }) => user.host == null,
			isRemoteUser: (user: { host: string | null }) => user.host != null,
			genLocalUserUri: (id: string) => `${LOCAL}/users/${id}`,
		},
		apRendererService: {
			genLocalChatRoomUri: (id: string) => `${LOCAL}/chat/rooms/${id}`,
			renderAdd: vi.fn((_owner: unknown, _target: string, object: string) => ({ type: 'Add', object })),
			renderRemove: vi.fn((owner: { id: string }, target: string, object: string) => ({ type: 'Remove', actor: `${LOCAL}/users/${owner.id}`, target, object })),
			renderChatRoomDelete: vi.fn(() => ({ type: 'Delete' })),
			addContext: vi.fn((activity: unknown) => activity),
		},
		queueService: { deliver: vi.fn() },
		utilityService: new UtilityService({ host: 'local.test', url: LOCAL } as any, {} as any),
		idService: { gen: () => `gen${++seq}` },
		notificationService,
		chatVoiceService,
		apResolverService,
		userBlockingService: { checkBlocked: vi.fn(async (_blockerId: string, _blockeeId: string) => false) },
	});
	const chatService = Object.assign(Object.create(ChatService.prototype), {
		chatRoomsRepository: rooms,
		chatRoomMembershipsRepository: inbox.chatRoomMembershipsRepository,
		chatRoomInvitationsRepository: { findBy: async (where: Record<string, unknown>) => invitations.rows.filter(row => matches(row, where)) },
		usersRepository: inbox.usersRepository,
		userEntityService: inbox.userEntityService,
		apRendererService: inbox.apRendererService,
		queueService: inbox.queueService,
		redisClient: unread,
		chatRosterService: chatRosterOver({ ...redisClient, pipeline: () => ({ setex: vi.fn(), exec: vi.fn().mockResolvedValue([]) }) }),
		globalEventService,
		liveKitService,
	});
	inbox.chatService.deleteRoom = chatService.deleteRoom;
	inbox.chatService.removeRoomMember = chatService.removeRoomMember;
	inbox.chatService.finishRoomMemberRemoval = chatService.finishRoomMemberRemoval;
	return { inbox, rooms, invitations, memberships, notificationService, chatVoiceService, liveKitService, apResolverService, resolver, unread, globalEventService, redisClient };
}

function inviteActivity(actor: { uri: string }, roomUri: string, invitee: string, attributedTo: string | undefined = actor.uri) {
	return {
		type: 'Invite',
		actor: actor.uri,
		object: { type: 'Group', id: roomUri, name: 'room', attributedTo },
		target: invitee,
	};
}

describe('Chat room federation: Accept(Invite)', () => {
	test('requires a pending invitation to join a local room', async () => {
		const f = fixture();
		const accepted = inviteActivity({ uri: `${LOCAL}/users/${localOwner.id}` }, 'https://other.test/chat/rooms/localroom', dave.uri);

		await f.inbox.acceptInvite(dave, accepted);

		expect(f.memberships.rows).toEqual([]);
	});

	test('adds an invited remote actor and consumes the invitation', async () => {
		const f = fixture({ invitations: [{ id: 'inv', roomId: 'localroom', userId: invitedRemote.id }] });
		// The invitee's server renders the room URI on its own host, so the host is not checked here.
		const accepted = inviteActivity({ uri: remoteOwner.uri }, 'https://remote.test/chat/rooms/localroom', invitedRemote.uri);

		await f.inbox.acceptInvite(invitedRemote, accepted);

		expect(f.memberships.rows).toEqual([expect.objectContaining({ roomId: 'localroom', userId: invitedRemote.id })]);
		expect(f.invitations.rows).toEqual([]);
	});

	test('announces the new member to everyone but a member suspended on this server', async () => {
		const member = { id: 'erin', host: 'third.test', uri: 'https://third.test/users/erin', inbox: 'https://third.test/users/erin/inbox' };
		const f = fixture({
			invitations: [{ id: 'inv', roomId: 'localroom', userId: invitedRemote.id }],
			memberships: [{ id: 'm1', roomId: 'localroom', userId: member.id }, { id: 'm2', roomId: 'localroom', userId: dave.id }],
		});
		f.inbox.usersRepository.findBy = async () => [localOwner, invitedRemote, member, { ...dave, isSuspended: true }];
		const accepted = inviteActivity({ uri: remoteOwner.uri }, 'https://remote.test/chat/rooms/localroom', invitedRemote.uri);

		await f.inbox.acceptInvite(invitedRemote, accepted);

		const inboxes = f.inbox.queueService.deliver.mock.calls.map((call: unknown[]) => call[2]);
		expect(inboxes).toContain(member.inbox);
		expect(inboxes).not.toContain(dave.inbox);
	});

	test('does not add a membership when the invitation is cancelled before it is consumed', async () => {
		const f = fixture({
			invitations: [{ id: 'inv', roomId: 'localroom', userId: invitedRemote.id }],
			hooks: {
				// Simulate Undo(Invite) landing between the read and the delete.
				beforeInvitationDelete: () => {
					f.invitations.rows.splice(0, f.invitations.rows.length);
				},
			},
		});
		const accepted = inviteActivity({ uri: remoteOwner.uri }, 'https://remote.test/chat/rooms/localroom', invitedRemote.uri);

		const result = await f.inbox.acceptInvite(invitedRemote, accepted);

		expect(result).toMatch(/^skip:/);
		expect(f.memberships.rows).toEqual([]);
	});

	test('keeps the invitation when the membership insert fails', async () => {
		const f = fixture({
			invitations: [{ id: 'inv', roomId: 'localroom', userId: invitedRemote.id }],
			hooks: { failMembershipInsert: true },
		});
		const accepted = inviteActivity({ uri: remoteOwner.uri }, 'https://remote.test/chat/rooms/localroom', invitedRemote.uri);

		await expect(f.inbox.acceptInvite(invitedRemote, accepted)).rejects.toThrow('membership insert failed');

		expect(f.memberships.rows).toEqual([]);
		expect(f.invitations.rows).toEqual([expect.objectContaining({ id: 'inv' })]);
	});

	test('tells the invitee to leave when the room filled up before their Accept arrived', async () => {
		const f = fixture({
			invitations: [{ id: 'inv', roomId: 'localroom', userId: invitedRemote.id }],
			memberships: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, roomId: 'localroom', userId: `user${i}` })),
		});
		const accepted = inviteActivity({ uri: remoteOwner.uri }, 'https://remote.test/chat/rooms/localroom', invitedRemote.uri);

		const result = await f.inbox.acceptInvite(invitedRemote, accepted);

		expect(result).toBe('skip: room is full');
		expect(f.memberships.rows).toHaveLength(50);
		// The invitee's server consumed its copy, so keeping ours would only block a new invitation.
		expect(f.invitations.rows).toEqual([]);
		expect(f.inbox.queueService.deliver).toHaveBeenCalledExactlyOnceWith(
			localOwner,
			expect.objectContaining({ type: 'Remove', target: `${LOCAL}/chat/rooms/localroom`, object: invitedRemote.uri }),
			invitedRemote.inbox,
			false,
		);
	});

	test('tells the invitee to leave when the room was archived before their Accept arrived', async () => {
		const f = fixture({ invitations: [{ id: 'inv', roomId: 'localroom', userId: invitedRemote.id }] });
		f.rooms.rows[0].isArchived = true;
		const accepted = inviteActivity({ uri: remoteOwner.uri }, 'https://remote.test/chat/rooms/localroom', invitedRemote.uri);

		const result = await f.inbox.acceptInvite(invitedRemote, accepted);

		expect(result).toBe('skip: room is archived');
		expect(f.memberships.rows).toEqual([]);
		expect(f.invitations.rows).toEqual([]);
		expect(f.inbox.queueService.deliver).toHaveBeenCalledExactlyOnceWith(
			localOwner,
			expect.objectContaining({ type: 'Remove', target: `${LOCAL}/chat/rooms/localroom`, object: invitedRemote.uri }),
			invitedRemote.inbox,
			false,
		);
	});

	test('accepts two concurrent requests exactly once', async () => {
		const f = fixture({ invitations: [{ id: 'inv', roomId: 'localroom', userId: invitedRemote.id }] });
		const accepted = inviteActivity({ uri: remoteOwner.uri }, 'https://remote.test/chat/rooms/localroom', invitedRemote.uri);

		const results = await Promise.all([
			f.inbox.acceptInvite(invitedRemote, accepted),
			f.inbox.acceptInvite(invitedRemote, accepted),
		]);

		expect(f.memberships.rows).toHaveLength(1);
		expect(f.invitations.rows).toEqual([]);
		expect(results.filter(result => result === 'ok')).toHaveLength(1);
		expect(results.filter(result => result.startsWith('skip:'))).toHaveLength(1);
	});

	test('consumes the invitation without duplicating an existing membership', async () => {
		const f = fixture({
			invitations: [{ id: 'inv', roomId: 'localroom', userId: invitedRemote.id }],
			memberships: [{ id: 'membership', roomId: 'localroom', userId: invitedRemote.id }],
		});
		const accepted = inviteActivity({ uri: remoteOwner.uri }, 'https://remote.test/chat/rooms/localroom', invitedRemote.uri);

		const result = await f.inbox.acceptInvite(invitedRemote, accepted);

		expect(result).toBe('ok');
		expect(f.invitations.rows).toEqual([]);
		expect(f.memberships.rows).toHaveLength(1);
	});
});

describe('Chat room federation: Accept(Invite) edge cases', () => {
	const otherroom = { id: 'otherroom', name: 'other', ownerId: localOwner.id, description: '', isArchived: false };

	test('does not let an actor accept an invitation addressed to someone else', async () => {
		const f = fixture({ invitations: [{ id: 'inv', roomId: 'localroom', userId: invitedRemote.id }] });

		await f.inbox.acceptInvite(dave, inviteActivity({ uri: remoteOwner.uri }, 'https://other.test/chat/rooms/localroom', invitedRemote.uri));

		expect(f.memberships.rows).toEqual([]);
		expect(f.invitations.rows).toHaveLength(1);
	});

	test('does not let an invitation to one room open another room', async () => {
		const f = fixture({ rooms: [otherroom], invitations: [{ id: 'inv', roomId: 'otherroom', userId: invitedRemote.id }] });

		await f.inbox.acceptInvite(invitedRemote, inviteActivity({ uri: remoteOwner.uri }, 'https://remote.test/chat/rooms/localroom', invitedRemote.uri));

		expect(f.memberships.rows).toEqual([]);
		expect(f.invitations.rows).toEqual([expect.objectContaining({ roomId: 'otherroom' })]);
	});

	test('keeps the invitation when the accepted room does not exist', async () => {
		const f = fixture({ invitations: [{ id: 'inv', roomId: 'localroom', userId: invitedRemote.id }] });

		await f.inbox.acceptInvite(invitedRemote, inviteActivity({ uri: remoteOwner.uri }, 'https://remote.test/chat/rooms/missingroom', invitedRemote.uri));

		expect(f.memberships.rows).toEqual([]);
		expect(f.invitations.rows).toHaveLength(1);
	});

	test('does not let a replayed Accept rejoin after the invitation was used', async () => {
		const f = fixture({ invitations: [{ id: 'inv', roomId: 'localroom', userId: invitedRemote.id }] });
		const accepted = inviteActivity({ uri: remoteOwner.uri }, 'https://remote.test/chat/rooms/localroom', invitedRemote.uri);

		await f.inbox.acceptInvite(invitedRemote, accepted);
		// The member leaves or is kicked, then the same Accept is delivered again.
		f.memberships.rows.splice(0);
		await f.inbox.acceptInvite(invitedRemote, accepted);

		expect(f.memberships.rows).toEqual([]);
	});
});

describe('Chat room federation: Invite', () => {
	test('ignores an invitation to a room the sender does not own', async () => {
		const f = fixture();

		await f.inbox.invite(dave, inviteActivity(dave, 'https://other.test/chat/rooms/localroom', `${LOCAL}/users/${alice.id}`));

		expect(f.invitations.rows).toEqual([]);
		expect(f.notificationService.createNotification).not.toHaveBeenCalled();
	});

	test('ignores a room hosted on a different server than the sender', async () => {
		const f = fixture();

		await f.inbox.invite(dave, inviteActivity(dave, 'https://remote.test/chat/rooms/newroom', `${LOCAL}/users/${alice.id}`));

		expect(f.rooms.rows.map(room => room.id)).toEqual(['localroom']);
		expect(f.invitations.rows).toEqual([]);
	});

	test('ignores a room attributed to someone other than the sender', async () => {
		const f = fixture();

		await f.inbox.invite(dave, inviteActivity(dave, 'https://other.test/chat/rooms/newroom', `${LOCAL}/users/${alice.id}`, `${LOCAL}/users/${localOwner.id}`));

		expect(f.rooms.rows.map(room => room.id)).toEqual(['localroom']);
		expect(f.invitations.rows).toEqual([]);
	});

	test('ignores an invitation to a known room owned by another user', async () => {
		const f = fixture({ rooms: [{ id: 'bobroom', uri: 'https://other.test/chat/rooms/bobroom', name: 'bob', ownerId: remoteOwner.id, description: '', isArchived: false }] });

		await f.inbox.invite(dave, inviteActivity(dave, 'https://other.test/chat/rooms/bobroom', `${LOCAL}/users/${alice.id}`));

		expect(f.invitations.rows).toEqual([]);
	});

	test('ignores a room URI that is not a URL', async () => {
		const f = fixture();

		await expect(f.inbox.invite(dave, inviteActivity(dave, 'other/chat/rooms/newroom', `${LOCAL}/users/${alice.id}`))).resolves.toMatch(/^skip:/);

		expect(f.rooms.rows.map(room => room.id)).toEqual(['localroom']);
		expect(f.invitations.rows).toEqual([]);
	});

	test('mirrors a room owned by the inviter and invites the local user', async () => {
		const f = fixture();

		await f.inbox.invite(remoteOwner, inviteActivity(remoteOwner, 'https://remote.test/chat/rooms/newroom', `${LOCAL}/users/${alice.id}`));

		const mirror = f.rooms.rows.find(room => room.uri === 'https://remote.test/chat/rooms/newroom');
		expect(mirror).toMatchObject({ ownerId: remoteOwner.id });
		expect(mirror?.id).not.toBe('newroom');
		expect(f.invitations.rows).toEqual([expect.objectContaining({ roomId: mirror?.id, userId: alice.id })]);
		expect(f.notificationService.createNotification).toHaveBeenCalledOnce();
	});

	test('an Invite brings an out-of-date mirror up to date, so it can be accepted', async () => {
		const f = fixture({ rooms: [{ id: 'bobroom', name: 'old', ownerId: remoteOwner.id, description: 'old', isArchived: true }] });

		await f.inbox.invite(remoteOwner, {
			type: 'Invite',
			actor: remoteOwner.uri,
			object: { id: 'https://remote.test/chat/rooms/bobroom', type: 'Group', name: 'new', summary: 'new', attributedTo: remoteOwner.uri, _misskey_chatArchived: false },
			target: `${LOCAL}/users/${alice.id}`,
		});

		expect(f.rooms.rows.find(room => room.id === 'bobroom')).toMatchObject({ name: 'new', description: 'new', isArchived: false });
		expect(f.invitations.rows).toEqual([expect.objectContaining({ roomId: 'bobroom', userId: alice.id })]);
	});

	test('an Invite from someone the invitee has blocked creates nothing', async () => {
		const f = fixture();
		f.inbox.userBlockingService.checkBlocked.mockImplementation(async (blockerId: string, blockeeId: string) => blockerId === alice.id && blockeeId === remoteOwner.id);

		await expect(f.inbox.invite(remoteOwner, inviteActivity(remoteOwner, 'https://remote.test/chat/rooms/newroom', `${LOCAL}/users/${alice.id}`))).resolves.toMatch(/^skip:/);

		expect(f.rooms.rows.find(room => room.id === 'newroom')).toBeUndefined();
		expect(f.invitations.rows).toEqual([]);
		expect(f.notificationService.createNotification).not.toHaveBeenCalled();
	});

	test('invites into an existing mirror room when the inviter owns it', async () => {
		const f = fixture({ rooms: [{ id: 'bobroom', name: 'bob', ownerId: remoteOwner.id, description: '', isArchived: false }] });

		await f.inbox.invite(remoteOwner, inviteActivity(remoteOwner, 'https://remote.test/chat/rooms/bobroom', `${LOCAL}/users/${alice.id}`));

		expect(f.invitations.rows).toEqual([expect.objectContaining({ roomId: 'bobroom', userId: alice.id })]);
	});
});

describe('Chat room federation: Invite edge cases', () => {
	test('ignores a room URI that hides the inviter\'s host in its userinfo', async () => {
		const f = fixture();

		await f.inbox.invite(dave, inviteActivity(dave, 'https://other.test@remote.test/chat/rooms/newroom', `${LOCAL}/users/${alice.id}`));

		expect(f.rooms.rows.map(room => room.id)).toEqual(['localroom']);
		expect(f.invitations.rows).toEqual([]);
	});

	test('ignores a room on a lookalike subdomain of the inviter\'s host', async () => {
		const f = fixture();

		await f.inbox.invite(dave, inviteActivity(dave, 'https://other.test.remote.test/chat/rooms/newroom', `${LOCAL}/users/${alice.id}`));

		expect(f.rooms.rows.map(room => room.id)).toEqual(['localroom']);
		expect(f.invitations.rows).toEqual([]);
	});

	test('ignores a room whose first attributedTo is someone else', async () => {
		const f = fixture();

		await f.inbox.invite(dave, {
			...inviteActivity(dave, 'https://other.test/chat/rooms/newroom', `${LOCAL}/users/${alice.id}`),
			object: { type: 'Group', id: 'https://other.test/chat/rooms/newroom', name: 'room', attributedTo: [`${LOCAL}/users/${localOwner.id}`, dave.uri] },
		});

		expect(f.rooms.rows.map(room => room.id)).toEqual(['localroom']);
		expect(f.invitations.rows).toEqual([]);
	});

	test('records the inviter as owner of an unattributed mirror room', async () => {
		const f = fixture();

		await f.inbox.invite(dave, {
			...inviteActivity(dave, 'https://other.test/chat/rooms/newroom', `${LOCAL}/users/${alice.id}`),
			object: { type: 'Group', id: 'https://other.test/chat/rooms/newroom', name: 'room' },
		});

		expect(f.rooms.rows).toContainEqual(expect.objectContaining({ uri: 'https://other.test/chat/rooms/newroom', ownerId: dave.id }));
	});

	test('does not invite a remote user', async () => {
		const f = fixture();

		await f.inbox.invite(remoteOwner, inviteActivity(remoteOwner, 'https://remote.test/chat/rooms/newroom', dave.uri));

		expect(f.invitations.rows).toEqual([]);
	});
});

describe('Chat room federation: Undo(Invite)', () => {
	const bobroom = { id: 'bobroom', name: 'bob', ownerId: remoteOwner.id, description: '', isArchived: false };

	test('keeps the invitation when the sender does not own the room', async () => {
		const f = fixture({ rooms: [bobroom], invitations: [{ id: 'inv', roomId: 'bobroom', userId: alice.id }] });

		await f.inbox.undoInvite(dave, inviteActivity(dave, 'https://other.test/chat/rooms/bobroom', `${LOCAL}/users/${alice.id}`));

		expect(f.invitations.rows).toHaveLength(1);
	});

	test('does not let a remote actor cancel an invitation to a local room', async () => {
		const f = fixture({ invitations: [{ id: 'inv', roomId: 'localroom', userId: alice.id }] });

		await f.inbox.undoInvite(dave, inviteActivity(dave, 'https://other.test/chat/rooms/localroom', `${LOCAL}/users/${alice.id}`));

		expect(f.invitations.rows).toHaveLength(1);
	});

	test('keeps invitations when the room is unknown', async () => {
		const f = fixture({ invitations: [{ id: 'inv', roomId: 'ghostroom', userId: alice.id }] });

		await f.inbox.undoInvite(dave, inviteActivity(dave, 'https://other.test/chat/rooms/ghostroom', `${LOCAL}/users/${alice.id}`));

		expect(f.invitations.rows).toHaveLength(1);
	});

	test('lets the room owner cancel an invitation', async () => {
		const f = fixture({ rooms: [bobroom], invitations: [{ id: 'inv', roomId: 'bobroom', userId: alice.id }] });

		await f.inbox.undoInvite(remoteOwner, inviteActivity(remoteOwner, 'https://remote.test/chat/rooms/bobroom', `${LOCAL}/users/${alice.id}`));

		expect(f.invitations.rows).toEqual([]);
	});
});

describe('Chat room federation: voice call state', () => {
	const voiceState = {
		id: 'https://remote.test/chat/rooms/bobroom/voice',
		type: 'ChatRoomVoiceState',
		room: 'https://remote.test/chat/rooms/bobroom',
		participants: [{ id: 'https://remote.test/users/carol', screenSharing: false }],
		updated: '2026-10-27T00:00:00.000Z',
	};

	function voiceUpdate(object: unknown) {
		return { type: 'Update', actor: remoteOwner.uri, object };
	}

	test('the inbox routes ChatRoomVoiceState updates to the voice service', async () => {
		const f = fixture();

		const result = await f.inbox.update(remoteOwner, voiceUpdate(voiceState));

		expect(result).toBe('ok: voice state stored');
		expect(f.chatVoiceService.receiveRemoteSnapshot).toHaveBeenCalledWith(remoteOwner, voiceState);
		// 中身ごと届いた現況を読むだけで、何も取りに行かない
		expect(f.apResolverService.createResolver).not.toHaveBeenCalled();
		expect(f.resolver.resolve).not.toHaveBeenCalled();
	});

	test('the inbox accepts voice states only when they arrive inline', async () => {
		const f = fixture();
		f.resolver.resolve.mockResolvedValue(voiceState);

		const result = await f.inbox.update(remoteOwner, voiceUpdate(voiceState.id));

		expect(result).toMatch(/^skip/);
		expect(f.chatVoiceService.receiveRemoteSnapshot).not.toHaveBeenCalled();
	});

	// JSON-LD として読む相手にも、ルーム・参加者・画面共有が CherryPick の語彙として伝わる
	test('the archived state survives JSON-LD compaction of a forwarded activity', async () => {
		// 相手のサーバーが送ってくる文脈のまま処理する
		const activity = {
			'@context': [
				'https://www.w3.org/ns/activitystreams',
				{ misskey: 'https://misskey-hub.net/ns#', _misskey_chatArchived: 'misskey:_misskey_chatArchived' },
			],
			id: 'https://remote.test/chat/rooms/bobroom#update',
			type: 'Update',
			actor: remoteOwner.uri,
			object: { id: 'https://remote.test/chat/rooms/bobroom', type: 'Group', name: 'room', _misskey_chatArchived: true },
		};
		const jsonLd = new JsonLdService({} as any).use();
		jsonLd.freeze();

		const compacted = await jsonLd.compact(activity) as { object: Record<string, unknown> };

		expect(compacted.object._misskey_chatArchived).toBe(true);
	});

	test('the voice state keeps its CherryPick terms through JSON-LD processing', async () => {
		const renderer = Object.assign(Object.create(ApRendererService.prototype), { config: { url: LOCAL } }) as ApRendererService;
		const activity = renderer.addContext({
			type: 'Update',
			actor: `${LOCAL}/users/${localOwner.id}`,
			object: renderer.renderChatRoomVoiceState({ id: 'localroom' } as any, [
				{ identity: `${LOCAL}/users/${alice.id}`, screenSharing: true },
				{ identity: remoteOwner.uri, screenSharing: false },
			], Date.parse('2026-10-27T00:00:00.000Z')),
		});
		const jsonLd = new JsonLdService({} as any).use();
		// 文脈はすべて手元にあるので、何も取りに行かない
		jsonLd.freeze();

		const nquads = await jsonLd.normalize(activity);

		const state = `<${LOCAL}/chat/rooms/localroom/voice>`;
		expect(nquads).toContain(`${state} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://kokonect.link/ns#ChatRoomVoiceState> .`);
		expect(nquads).toContain(`${state} <https://kokonect.link/ns#room> <${LOCAL}/chat/rooms/localroom> .`);
		expect(nquads).toContain(`${state} <https://kokonect.link/ns#participants> <${LOCAL}/users/${alice.id}> .`);
		expect(nquads).toContain(`${state} <https://kokonect.link/ns#participants> <${remoteOwner.uri}> .`);
		expect(nquads).toContain(`<${LOCAL}/users/${alice.id}> <https://kokonect.link/ns#screenSharing> "true"^^<http://www.w3.org/2001/XMLSchema#boolean> .`);
		expect(nquads).toContain(`<${remoteOwner.uri}> <https://kokonect.link/ns#screenSharing> "false"^^<http://www.w3.org/2001/XMLSchema#boolean> .`);
	});
});

describe('Chat room federation: checking voice states', () => {
	const ROOM = 'https://remote.test/chat/rooms/bobroom';
	const UPDATED = '2026-10-27T00:00:00.000Z';

	function voiceState(overrides: Record<string, unknown> = {}) {
		return {
			id: `${ROOM}/voice`,
			type: 'ChatRoomVoiceState',
			room: ROOM,
			participants: [{ id: invitedRemote.uri, screenSharing: true }],
			updated: UPDATED,
			...overrides,
		} as any;
	}

	test('reads a voice state that a server sends about its own room', () => {
		expect(parseChatRoomVoiceState(remoteOwner.uri, voiceState(), 51)).toEqual({
			ok: true,
			state: { roomUri: 'https://remote.test/chat/rooms/bobroom', roomId: 'bobroom', participants: [{ identity: invitedRemote.uri, screenSharing: true }], updatedAt: Date.parse(UPDATED) },
		});
	});

	test('relays reported mute flags while tolerating older or malformed optional flags', () => {
		const object = voiceState({ participants: [{ id: invitedRemote.uri, screenSharing: false, micMuted: true, deafened: false }] });
		expect(parseChatRoomVoiceState(remoteOwner.uri, object, 51)).toMatchObject({
			ok: true, state: { participants: [{ micMuted: true, deafened: false }] },
		});
		const malformed = voiceState({ participants: [{ id: invitedRemote.uri, screenSharing: false, micMuted: 'true' }] });
		expect(parseChatRoomVoiceState(remoteOwner.uri, malformed, 51)).toMatchObject({
			ok: true, state: { participants: [{ identity: invitedRemote.uri, screenSharing: false }] },
		});
	});

	test('reads the voice state this server renders', () => {
		const renderer = Object.assign(Object.create(ApRendererService.prototype), { config: { url: LOCAL } }) as ApRendererService;
		const rendered = renderer.renderChatRoomVoiceState({ id: 'localroom' } as any, [{ identity: `${LOCAL}/users/${alice.id}`, screenSharing: false }], Date.parse(UPDATED));

		expect(parseChatRoomVoiceState(`${LOCAL}/users/${localOwner.id}`, rendered, 51)).toEqual({
			ok: true,
			state: { roomUri: `${LOCAL}/chat/rooms/localroom`, roomId: 'localroom', participants: [{ identity: `${LOCAL}/users/${alice.id}`, screenSharing: false }], updatedAt: Date.parse(UPDATED) },
		});
	});

	test.each([
		['a missing id', remoteOwner.uri, { id: undefined }],
		['a room that is not a string', remoteOwner.uri, { room: { id: ROOM } }],
		['a sender that is not a URL', 'remote.test', {}],
		['a room on another server', remoteOwner.uri, { room: 'https://other.test/chat/rooms/bobroom', id: 'https://other.test/chat/rooms/bobroom/voice' }],
		['a room on another port of the same host', remoteOwner.uri, { room: 'https://remote.test:8443/chat/rooms/bobroom', id: 'https://remote.test:8443/chat/rooms/bobroom/voice' }],
		['a room over another scheme', remoteOwner.uri, { room: 'http://remote.test/chat/rooms/bobroom', id: 'http://remote.test/chat/rooms/bobroom/voice' }],
		['an empty query on the room', remoteOwner.uri, { room: `${ROOM}?`, id: `${ROOM}?/voice` }],
		['an empty fragment on the room', remoteOwner.uri, { room: `${ROOM}#`, id: `${ROOM}#/voice` }],
		['a query on the room', remoteOwner.uri, { room: `${ROOM}?x=1`, id: `${ROOM}?x=1/voice` }],
		['userinfo on the room', remoteOwner.uri, { room: 'https://user@remote.test/chat/rooms/bobroom', id: 'https://user@remote.test/chat/rooms/bobroom/voice' }],
		['empty userinfo on the room', remoteOwner.uri, { room: 'https://@remote.test/chat/rooms/bobroom', id: 'https://@remote.test/chat/rooms/bobroom/voice' }],
		['dot segments in the room', remoteOwner.uri, { room: 'https://remote.test/chat/rooms/x/../bobroom', id: 'https://remote.test/chat/rooms/x/../bobroom/voice' }],
		['the default port written out in the room', remoteOwner.uri, { room: 'https://remote.test:443/chat/rooms/bobroom', id: 'https://remote.test:443/chat/rooms/bobroom/voice' }],
		['an upper-case host in the room', remoteOwner.uri, { room: 'https://REMOTE.test/chat/rooms/bobroom', id: 'https://REMOTE.test/chat/rooms/bobroom/voice' }],
		['a room path of another shape', remoteOwner.uri, { room: `${ROOM}/extra`, id: `${ROOM}/extra/voice` }],
		['an id that is not the room\'s voice state', remoteOwner.uri, { id: `${ROOM}/other` }],
		['the voice state of another room', remoteOwner.uri, { id: 'https://remote.test/chat/rooms/other/voice' }],
		['too many participants', remoteOwner.uri, { participants: [{ id: invitedRemote.uri, screenSharing: false }, { id: dave.uri, screenSharing: false }] }],
		['a participant without screenSharing', remoteOwner.uri, { participants: [{ id: invitedRemote.uri }] }],
		['an unreadable time', remoteOwner.uri, { updated: 'yesterday' }],
	])('refuses %s', (_label, actorUri, overrides) => {
		const result = parseChatRoomVoiceState(actorUri, voiceState(overrides), 1);

		expect(result.ok).toBe(false);
		expect(result).toEqual({ ok: false, reason: expect.any(String) });
	});
});

describe('Chat room federation: Remove by the room owner', () => {
	const mirrorRoom = { id: 'bobroom', name: 'mirror', ownerId: remoteOwner.id, description: '', isArchived: false };
	const mirrorUri = 'https://remote.test/chat/rooms/bobroom';
	const kick = (actor: { uri: string }, member: string, target = mirrorUri) => ({ type: 'Remove', actor: actor.uri, object: member, target });

	test('removes the named member, not the owner, from a mirror room', async () => {
		const f = fixture({
			rooms: [mirrorRoom],
			memberships: [{ id: 'm1', roomId: 'bobroom', userId: dave.id }, { id: 'm2', roomId: 'bobroom', userId: invitedRemote.id }],
		});

		await expect(f.inbox.remove(remoteOwner, kick(remoteOwner, dave.uri))).resolves.toBe('ok: removed from chat room');

		expect(f.memberships.rows.map(row => row.userId)).toEqual([invitedRemote.id]);
	});

	test('ends a removed local member\'s subscription and unread state', async () => {
		const f = fixture({ rooms: [mirrorRoom], memberships: [{ id: 'm1', roomId: 'bobroom', userId: alice.id }] });
		await f.unread.set(`newRoomChatMessageExists:${alice.id}:bobroom`, 'message1');
		await f.unread.set(`newRoomChatMessageExists:${alice.id}:bobroom:first`, 'message1');
		await f.unread.sadd(`newChatMessagesExists:${alice.id}`, 'room:bobroom');

		await f.inbox.remove(remoteOwner, kick(remoteOwner, `${LOCAL}/users/${alice.id}`));

		expect(f.memberships.rows).toEqual([]);
		expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith('bobroom', 'membershipEnded', { userId: alice.id });
		expect(await f.unread.get(`newRoomChatMessageExists:${alice.id}:bobroom`)).toBeNull();
		expect(await f.unread.get(`newRoomChatMessageExists:${alice.id}:bobroom:first`)).toBeNull();
		expect(await f.unread.smembers(`newChatMessagesExists:${alice.id}`)).toEqual([]);
	});

	test('a member cannot remove someone else', async () => {
		const f = fixture({
			rooms: [mirrorRoom],
			memberships: [{ id: 'm1', roomId: 'bobroom', userId: dave.id }, { id: 'm2', roomId: 'bobroom', userId: invitedRemote.id }],
		});

		const result = await f.inbox.remove(dave, kick(dave, invitedRemote.uri));

		expect(result).toContain('skip');
		expect(f.memberships.rows).toHaveLength(2);
	});

	test('an unknown user is skipped without touching the memberships', async () => {
		const f = fixture({ rooms: [mirrorRoom], memberships: [{ id: 'm1', roomId: 'bobroom', userId: dave.id }] });

		const result = await f.inbox.remove(remoteOwner, kick(remoteOwner, 'https://remote.test/users/nobody'));

		expect(result).toContain('skip');
		expect(f.memberships.rows).toHaveLength(1);
	});

	test('a remote member leaving a local room is relayed by the owner to the remaining remote members', async () => {
		const f = fixture({ memberships: [
			{ id: 'm1', roomId: 'localroom', userId: dave.id },
			{ id: 'm2', roomId: 'localroom', userId: invitedRemote.id },
			{ id: 'm3', roomId: 'localroom', userId: alice.id },
		] });

		await f.inbox.remove(dave, { type: 'Remove', actor: dave.uri, object: dave.uri, target: `${LOCAL}/chat/rooms/localroom` });

		expect(f.inbox.queueService.deliver).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ id: localOwner.id }),
			expect.objectContaining({ type: 'Remove', actor: `${LOCAL}/users/${localOwner.id}`, object: dave.uri, target: `${LOCAL}/chat/rooms/localroom` }),
			invitedRemote.inbox,
			false,
		);
	});

	test('a remote member leaving a mirror room is not relayed from here', async () => {
		const f = fixture({ rooms: [mirrorRoom], memberships: [{ id: 'm1', roomId: 'bobroom', userId: dave.id }, { id: 'm2', roomId: 'bobroom', userId: invitedRemote.id }] });

		await f.inbox.remove(dave, { type: 'Remove', actor: dave.uri, object: dave.uri, target: mirrorUri });

		expect(f.inbox.queueService.deliver).not.toHaveBeenCalled();
	});
});

describe('Chat room federation: Remove', () => {
	const bobroom = { id: 'bobroom', name: 'bob', ownerId: remoteOwner.id, description: '', isArchived: false };

	function leave(actor: { uri: string }, roomUri: string) {
		return { type: 'Remove', actor: actor.uri, object: actor.uri, target: roomUri };
	}

	test('a remote member leaving the room is removed from its call', async () => {
		const f = fixture({ memberships: [{ id: 'm1', roomId: 'localroom', userId: dave.id }] });

		await f.inbox.remove(dave, leave(dave, `${LOCAL}/chat/rooms/localroom`));

		expect(f.memberships.rows).toEqual([]);
		expect(f.liveKitService.removeParticipant).toHaveBeenCalledWith('localroom', dave.uri);
	});

	test('makes no LiveKit call when the Remove deleted no membership', async () => {
		const f = fixture();

		await f.inbox.remove(dave, leave(dave, `${LOCAL}/chat/rooms/localroom`));

		expect(f.liveKitService.removeParticipant).not.toHaveBeenCalled();
	});

	test('logs a LiveKit error instead of failing the inbox job', async () => {
		// 外せなかった参加者は、通話の定期的な読み直し (ChatVoiceService.sweep) がメンバーでないとして外す
		const f = fixture({ memberships: [{ id: 'm1', roomId: 'localroom', userId: dave.id }] });
		f.liveKitService.removeParticipant.mockRejectedValueOnce(new Error('LiveKit is down'));

		await expect(f.inbox.remove(dave, leave(dave, `${LOCAL}/chat/rooms/localroom`))).resolves.toBe('ok: removed from chat room');
		expect(f.memberships.rows).toEqual([]);
		expect(f.inbox.logger.warn).toHaveBeenCalled();
	});

	// LiveKitService は 404 (もう通話にいない) だけを成功として扱い、ほかの失敗は投げ直す。
	// inbox のジョブを失敗させるとやり直しを使い切るまで繰り返すので、記録だけしてジョブは終える
	test.each([
		['unavailable', 503],
		['internal', 500],
		['permission_denied', 403],
	])('finishes the inbox job when LiveKit answers %s (%i) to the removal', async (code, status) => {
		const f = fixture({ memberships: [{ id: 'm1', roomId: 'localroom', userId: dave.id }] });
		const liveKitService = new LiveKitService({
			url: LOCAL,
			voiceCall: { livekit: { internalUrl: 'http://livekit:7880', apiKey: 'key', apiSecret: 'a'.repeat(32) } },
		} as ConstructorParameters<typeof LiveKitService>[0]);
		const roomService = { removeParticipant: vi.fn(async () => {
			throw new TwirpError('TwirpError', 'LiveKit could not remove the participant', status, code);
		}) };
		Object.assign(liveKitService, { roomService });
		Object.assign(f.inbox, { liveKitService });

		await expect(f.inbox.remove(dave, leave(dave, `${LOCAL}/chat/rooms/localroom`))).resolves.toBe('ok: removed from chat room');

		expect(roomService.removeParticipant).toHaveBeenCalledTimes(1);
		expect(f.memberships.rows).toEqual([]);
		expect(f.inbox.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to remove'), expect.anything());
	});

	test('leaves calls alone for a room hosted on another server', async () => {
		const f = fixture({ rooms: [bobroom], memberships: [{ id: 'm1', roomId: 'bobroom', userId: dave.id }] });

		await f.inbox.remove(dave, leave(dave, 'https://remote.test/chat/rooms/bobroom'));

		expect(f.memberships.rows).toEqual([]);
		expect(f.liveKitService.removeParticipant).not.toHaveBeenCalled();
	});
});

describe('Chat room federation: deferred room activities', () => {
	const remoteRoomUri = 'https://remote.test/chat/rooms/remoteroom';

	test.each([false, true])('does not resurrect a deleted room when Invite is retried (known room: %s)', async (knownRoom) => {
		const f = fixture({ rooms: knownRoom ? [{ id: 'remoteroom', ownerId: remoteOwner.id, uri: remoteRoomUri }] : [] });
		const invitation = inviteActivity(remoteOwner, remoteRoomUri, `${LOCAL}/users/${alice.id}`);

		await f.inbox.delete(remoteOwner, {
			type: 'Delete',
			actor: remoteOwner.uri,
			object: { id: remoteRoomUri, type: 'Tombstone', formerType: 'Group' },
		});
		await f.inbox.invite(remoteOwner, invitation);
		await f.inbox.invite(remoteOwner, invitation);

		expect(f.rooms.rows.find(room => room.uri === remoteRoomUri)).toBeUndefined();
		expect(f.invitations.rows).toEqual([]);
		expect(f.notificationService.createNotification).not.toHaveBeenCalled();
	});

	test('a mirror room created by an Invite remembers when its state was current', async () => {
		const f = fixture();

		await f.inbox.invite(remoteOwner, {
			type: 'Invite',
			actor: remoteOwner.uri,
			object: { id: remoteRoomUri, type: 'Group', name: 'room', attributedTo: remoteOwner.uri, updated: '2026-11-03T00:00:00.000Z' },
			target: `${LOCAL}/users/${alice.id}`,
		});

		expect(f.rooms.rows.find(room => room.uri === remoteRoomUri)).toMatchObject({ lastRemoteUpdatedAt: new Date('2026-11-03T00:00:00.000Z') });
	});

	test('truncates oversized mirror room metadata from an Invite', async () => {
		const f = fixture();

		await f.inbox.invite(remoteOwner, {
			type: 'Invite',
			actor: remoteOwner.uri,
			object: {
				id: 'https://remote.test/chat/rooms/oversized',
				type: 'Group',
				name: 'x'.repeat(300),
				summary: 'y'.repeat(2000),
				attributedTo: remoteOwner.uri,
			},
			target: `${LOCAL}/users/${alice.id}`,
		});

		const room = f.rooms.rows.find(room => room.uri === 'https://remote.test/chat/rooms/oversized');
		expect(room?.name).toHaveLength(256);
		expect(room?.description).toHaveLength(1024);
	});

	test.each([
		['Add', (inbox: ReturnType<typeof fixture>['inbox']) => inbox.add(dave, { type: 'Add', actor: dave.uri, target: remoteRoomUri, object: dave.uri })],
		['Update', (inbox: ReturnType<typeof fixture>['inbox']) => inbox.update(dave, { type: 'Update', actor: dave.uri, object: { id: remoteRoomUri, type: 'Group', name: 'forged', attributedTo: dave.uri } })],
		['Delete', (inbox: ReturnType<typeof fixture>['inbox']) => inbox.delete(dave, { type: 'Delete', actor: dave.uri, object: { id: remoteRoomUri, type: 'Tombstone', formerType: 'Group' } })],
	])('does not let another server occupy deferred %s slots of a room', async (_type, send) => {
		const f = fixture();
		f.resolver.resolve.mockImplementation(async (value: unknown) => value);

		expect(await send(f.inbox)).toMatch(/^skip:/);

		expect(f.redisClient.sadd).not.toHaveBeenCalled();
	});

	test('the cap on deferred rooms is a fixed window that a busy actor cannot keep extending', async () => {
		const f = fixture();

		await f.inbox.add(remoteOwner, { type: 'Add', actor: remoteOwner.uri, target: remoteRoomUri, object: invitedRemote.uri });

		expect(f.redisClient.expire).toHaveBeenCalledWith(`chat_pending_room_activities_index:${remoteOwner.id}`, expect.any(Number), 'NX');
	});

	test('caps the rooms an actor can defer activities for', async () => {
		const f = fixture();
		f.redisClient.scard.mockImplementation(async (key: string) => key.startsWith('chat_pending_room_activities_index:') ? 100 : 0);

		const result = await f.inbox.add(remoteOwner, { type: 'Add', actor: remoteOwner.uri, target: remoteRoomUri, object: invitedRemote.uri });

		expect(result).toMatch(/^skip:/);
		expect(f.redisClient.sadd).not.toHaveBeenCalled();
	});

	test('applies a pending Update after Invite creates the mirror room', async () => {
		const f = fixture();
		f.resolver.resolve.mockImplementation(async (value: unknown) => value);

		await f.inbox.update(remoteOwner, {
			type: 'Update',
			actor: remoteOwner.uri,
			object: { id: remoteRoomUri, type: 'Group', name: 'renamed', summary: 'description', attributedTo: remoteOwner.uri },
		});
		await f.inbox.invite(remoteOwner, {
			type: 'Invite',
			actor: remoteOwner.uri,
			object: { id: remoteRoomUri, type: 'Group', name: 'original', attributedTo: remoteOwner.uri },
			target: `${LOCAL}/users/${alice.id}`,
		});

		expect(f.rooms.rows.find(room => room.uri === remoteRoomUri)).toMatchObject({ name: 'renamed', description: 'description' });
	});

	describe('replay', () => {
		const update = (name: string) => ({
			type: 'Update',
			actor: remoteOwner.uri,
			object: { id: remoteRoomUri, type: 'Group', name, attributedTo: remoteOwner.uri },
		});
		const invitation = () => inviteActivity(remoteOwner, remoteRoomUri, `${LOCAL}/users/${alice.id}`);

		test('replays Updates that overtook the Invite in their arrival order', async () => {
			const f = fixture();
			f.resolver.resolve.mockImplementation(async (value: unknown) => value);
			for (const name of ['first', 'second', 'third']) await f.inbox.update(remoteOwner, update(name));

			await f.inbox.invite(remoteOwner, invitation());

			expect(f.inbox.chatService.updateRoom.mock.calls.map((call: unknown[]) => (call[1] as { name: string }).name)).toEqual(['first', 'second', 'third']);
		});

		test('keeps an activity that failed transiently and retries it with the Invite', async () => {
			const f = fixture();
			f.resolver.resolve.mockImplementation(async (value: unknown) => value);
			await f.inbox.update(remoteOwner, update('renamed'));
			f.inbox.chatService.updateRoom.mockRejectedValueOnce(new Error('database restarting'));

			await expect(f.inbox.invite(remoteOwner, invitation())).rejects.toThrow('deferred');
			expect(f.invitations.rows).toEqual([]);
			await f.inbox.invite(remoteOwner, invitation());

			const mirror = f.rooms.rows.find(room => room.uri === remoteRoomUri);
			expect(mirror).toMatchObject({ name: 'renamed' });
			expect(f.invitations.rows).toEqual([expect.objectContaining({ roomId: mirror?.id, userId: alice.id })]);
		});

		test('gives up on an activity that keeps failing, so it cannot block the invitation', async () => {
			const f = fixture();
			f.resolver.resolve.mockImplementation(async (value: unknown) => value);
			await f.inbox.update(remoteOwner, update('renamed'));
			f.inbox.chatService.updateRoom.mockRejectedValue(new Error('always fails'));

			await expect(f.inbox.invite(remoteOwner, invitation())).rejects.toThrow('deferred');
			await expect(f.inbox.invite(remoteOwner, invitation())).rejects.toThrow('deferred');
			await f.inbox.invite(remoteOwner, invitation());

			expect(f.inbox.chatService.updateRoom.mock.calls.filter((call: unknown[]) => (call[1] as { name: string }).name === 'renamed')).toHaveLength(3);
			expect(f.invitations.rows).toEqual([expect.objectContaining({ roomId: f.rooms.rows.find(room => room.uri === remoteRoomUri)?.id, userId: alice.id })]);
		});
	});

	test('applies a pending Add after Invite creates the mirror room', async () => {
		const f = fixture();

		await f.inbox.add(remoteOwner, { type: 'Add', actor: remoteOwner.uri, target: remoteRoomUri, object: invitedRemote.uri });
		await f.inbox.invite(remoteOwner, {
			type: 'Invite',
			actor: remoteOwner.uri,
			object: { id: remoteRoomUri, type: 'Group', name: 'original', attributedTo: remoteOwner.uri },
			target: `${LOCAL}/users/${alice.id}`,
		});

		expect(f.memberships.rows).toEqual([expect.objectContaining({ roomId: f.rooms.rows.find(room => room.uri === remoteRoomUri)?.id, userId: invitedRemote.id })]);
	});

	test('applies a pending Delete after Invite creates the mirror room', async () => {
		const f = fixture();

		await f.inbox.delete(remoteOwner, {
			type: 'Delete',
			actor: remoteOwner.uri,
			object: { id: remoteRoomUri, type: 'Tombstone', formerType: 'Group' },
		});
		await f.inbox.invite(remoteOwner, {
			type: 'Invite',
			actor: remoteOwner.uri,
			object: { id: remoteRoomUri, type: 'Group', name: 'original', attributedTo: remoteOwner.uri },
			target: `${LOCAL}/users/${alice.id}`,
		});

		expect(f.rooms.rows.find(room => room.uri === remoteRoomUri)).toBeUndefined();
		expect(f.invitations.rows).toEqual([]);
	});
});

describe('Chat room federation: Add/Update/Delete', () => {
	const ownerActor = { ...localOwner, uri: `${LOCAL}/users/${localOwner.id}` };
	const roomUri = `${LOCAL}/chat/rooms/localroom`;

	test('Add inserts a member idempotently', async () => {
		const f = fixture();

		await f.inbox.add(ownerActor, { type: 'Add', actor: ownerActor.uri, target: roomUri, object: invitedRemote.uri });
		await f.inbox.add(ownerActor, { type: 'Add', actor: ownerActor.uri, target: roomUri, object: invitedRemote.uri });

		expect(f.memberships.rows).toEqual([expect.objectContaining({ roomId: 'localroom', userId: invitedRemote.id })]);
		expect(f.inbox.globalEventService.publishChatRoomStream).toHaveBeenCalledWith('localroom', 'membershipStarted', { userId: invitedRemote.id });
	});

	test('Add is rejected for a non-owner', async () => {
		const f = fixture();

		const result = await f.inbox.add(remoteOwner, { type: 'Add', actor: remoteOwner.uri, target: roomUri, object: invitedRemote.uri });

		expect(result).toContain('skip');
		expect(f.memberships.rows).toEqual([]);
	});

	test('Add does not exceed the room member limit', async () => {
		const bobroom = { id: 'bobroom', name: 'bob', ownerId: remoteOwner.id, description: '', isArchived: false };
		const f = fixture({
			rooms: [bobroom],
			memberships: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, roomId: 'bobroom', userId: dave.id })),
		});

		const result = await f.inbox.add(remoteOwner, { type: 'Add', actor: remoteOwner.uri, target: 'https://remote.test/chat/rooms/bobroom', object: invitedRemote.uri });

		expect(result).toContain('full');
		expect(f.memberships.rows).toHaveLength(50);
	});

	test('Update changes the mirror room name and description', async () => {
		const f = fixture();
		f.resolver.resolve.mockImplementation(async (value: unknown) => value);

		await f.inbox.update(ownerActor, {
			type: 'Update',
			actor: ownerActor.uri,
			object: { id: roomUri, type: 'Group', name: 'new name', summary: 'new description', attributedTo: ownerActor.uri },
		});

		expect(f.rooms.rows[0]).toMatchObject({ name: 'new name', description: 'new description' });
	});

	test('Update passes the time the owner stated to the room update', async () => {
		const f = fixture();
		f.resolver.resolve.mockImplementation(async (value: unknown) => value);

		await f.inbox.update(ownerActor, {
			type: 'Update',
			actor: ownerActor.uri,
			object: { id: roomUri, type: 'Group', name: 'new name', attributedTo: ownerActor.uri, updated: '2026-11-03T00:00:00.000Z' },
		});

		expect(f.inbox.chatService.updateRoom).toHaveBeenCalledWith(f.rooms.rows[0], expect.anything(), { federate: false, remoteUpdatedAt: new Date('2026-11-03T00:00:00.000Z') });
	});

	test.each([undefined, 'not a date'])('Update with the unusable time %s falls back to arrival order', async (updated) => {
		const f = fixture();
		f.resolver.resolve.mockImplementation(async (value: unknown) => value);

		await f.inbox.update(ownerActor, {
			type: 'Update',
			actor: ownerActor.uri,
			object: { id: roomUri, type: 'Group', name: 'new name', attributedTo: ownerActor.uri, updated },
		});

		expect(f.inbox.chatService.updateRoom).toHaveBeenCalledWith(f.rooms.rows[0], expect.anything(), { federate: false, remoteUpdatedAt: undefined });
	});

	test.each([true, false])('Update applies the archived state %s from the room owner', async (archived) => {
		const f = fixture();
		f.resolver.resolve.mockImplementation(async (value: unknown) => value);
		f.rooms.rows[0].isArchived = !archived;

		await f.inbox.update(ownerActor, {
			type: 'Update',
			actor: ownerActor.uri,
			object: { id: roomUri, type: 'Group', name: 'new name', attributedTo: ownerActor.uri, _misskey_chatArchived: archived },
		});

		expect(f.rooms.rows[0]).toMatchObject({ name: 'new name', isArchived: archived });
	});

	test.each([[undefined], ['true'], [null]])('Update keeps the archived state when the field is %s', async (value) => {
		const f = fixture();
		f.resolver.resolve.mockImplementation(async (resolved: unknown) => resolved);
		f.rooms.rows[0].isArchived = true;

		await f.inbox.update(ownerActor, {
			type: 'Update',
			actor: ownerActor.uri,
			object: { id: roomUri, type: 'Group', name: 'new name', attributedTo: ownerActor.uri, _misskey_chatArchived: value },
		});

		expect(f.rooms.rows[0]).toMatchObject({ name: 'new name', isArchived: true });
	});

	test('Update ignores the archived state from anyone but the room owner', async () => {
		const f = fixture();
		f.resolver.resolve.mockImplementation(async (value: unknown) => value);
		const stranger = { id: 'stranger', host: 'remote.test', uri: 'https://remote.test/users/stranger', inbox: 'https://remote.test/users/stranger/inbox' };

		await f.inbox.update(stranger, {
			type: 'Update',
			actor: stranger.uri,
			object: { id: roomUri, type: 'Group', name: 'hijacked', attributedTo: stranger.uri, _misskey_chatArchived: true },
		});

		expect(f.rooms.rows[0].isArchived).toBeFalsy();
	});

	test('Update clips a mirror room name and description to the column sizes', async () => {
		const f = fixture();
		f.resolver.resolve.mockImplementation(async (value: unknown) => value);

		await f.inbox.update(ownerActor, {
			type: 'Update',
			actor: ownerActor.uri,
			object: { id: roomUri, type: 'Group', name: 'n'.repeat(300), summary: 's'.repeat(3000), attributedTo: ownerActor.uri },
		});

		expect(f.rooms.rows[0].name).toHaveLength(256);
		expect(f.rooms.rows[0].description).toHaveLength(2048);
	});

	test('Delete removes the mirror room for the owner', async () => {
		const f = fixture();

		const result = await f.inbox.delete(ownerActor, {
			type: 'Delete',
			actor: ownerActor.uri,
			object: { id: roomUri, type: 'Tombstone', formerType: 'Group' },
		});

		expect(result).toBe('ok: chat room deleted');
		expect(f.rooms.rows).toEqual([]);
	});

	test('remote room deletion clears unread state, notifies clients and ends the call without forwarding', async () => {
		const f = fixture({ rooms: [{ id: 'bobroom', ownerId: remoteOwner.id }], memberships: [{ id: 'm1', roomId: 'bobroom', userId: alice.id }] });
		await f.unread.set('newRoomChatMessageExists:alice:bobroom', 'message1');
		await f.unread.set('newRoomChatMessageExists:alice:bobroom:first', 'message1');
		await f.unread.sadd('newChatMessagesExists:alice', 'room:bobroom');
		await f.inbox.delete(remoteOwner, {
			type: 'Delete', actor: remoteOwner.uri,
			object: { id: 'https://remote.test/chat/rooms/bobroom', type: 'Tombstone', formerType: 'Group' },
		});

		expect(f.rooms.rows.some(room => room.id === 'bobroom')).toBe(false);
		expect(await f.unread.get('newRoomChatMessageExists:alice:bobroom')).toBeNull();
		expect(await f.unread.get('newRoomChatMessageExists:alice:bobroom:first')).toBeNull();
		expect(await f.unread.smembers('newChatMessagesExists:alice')).toEqual([]);
		expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith('bobroom', 'roomDeleted');
		expect(f.liveKitService.deleteRoom).toHaveBeenCalledWith('bobroom');
		expect(f.inbox.queueService.deliver).not.toHaveBeenCalled();
	});
});
