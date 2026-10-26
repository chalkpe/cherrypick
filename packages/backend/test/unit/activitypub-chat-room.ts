/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { UtilityService } from '@/core/UtilityService.js';

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
		delete: async (where: string | Record<string, unknown>) => {
			await hooks.beforeDelete?.();
			const before = rows.length;
			const keep = rows.filter(row => !(typeof where === 'string' ? row.id === where : matches(row, where)));
			rows.splice(0, rows.length, ...keep);
			return { affected: before - rows.length };
		},
	};
}

type FakeManager = {
	delete: (entity: unknown, where: Record<string, unknown>) => Promise<{ affected: number }>;
	findOneBy: (entity: unknown, where: Record<string, unknown>) => Promise<Row | null>;
	insert: (entity: unknown, row: Row) => Promise<Row>;
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
		delete: (entity, where) => tableFor(entity).delete(where),
		findOneBy: (entity, where) => tableFor(entity).findOneBy(where),
		insert: (entity, row) => tableFor(entity).insertOne(row),
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
const invitedRemote = { id: 'carol', host: 'remote.test', uri: 'https://remote.test/users/carol' };
const dave = { id: 'dave', host: 'other.test', uri: 'https://other.test/users/dave' };

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
	};
	const resolver = { resolve: vi.fn() };
	const apResolverService = { createResolver: vi.fn(async () => resolver) };
	const inbox = Object.assign(Object.create(ApInboxService.prototype), {
		logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		db,
		chatRoomsRepository: rooms,
		chatRoomInvitationsRepository: invitations,
		chatRoomMembershipsRepository: memberships,
		usersRepository: {
			findOneBy: async ({ id }: { id: string }) => usersById.get(id) ?? null,
		},
		liveKitService,
		chatService: {
			isRoomMember: async (room: Row, userId: string) => room.ownerId === userId || memberships.rows.some(m => m.roomId === room.id && m.userId === userId),
		},
		apDbResolverService: {
			getUserFromApId: async (uri: string) => usersByUri.get(uri) ?? null,
		},
		userEntityService: {
			isLocalUser: (user: { host: string | null }) => user.host == null,
		},
		utilityService: new UtilityService({ host: 'local.test', url: LOCAL } as any, {} as any),
		idService: { gen: () => `gen${++seq}` },
		notificationService,
		chatVoiceService,
		apResolverService,
	});
	return { inbox, rooms, invitations, memberships, notificationService, chatVoiceService, liveKitService, apResolverService, resolver };
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
		const f = fixture({ rooms: [{ id: 'bobroom', name: 'bob', ownerId: remoteOwner.id, description: '', isArchived: false }] });

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

		expect(f.rooms.rows).toContainEqual(expect.objectContaining({ id: 'newroom', ownerId: remoteOwner.id }));
		expect(f.invitations.rows).toEqual([expect.objectContaining({ roomId: 'newroom', userId: alice.id })]);
		expect(f.notificationService.createNotification).toHaveBeenCalledOnce();
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

		expect(f.rooms.rows).toContainEqual(expect.objectContaining({ id: 'newroom', ownerId: dave.id }));
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
});

describe('Chat room federation: Remove', () => {
	const bobroom = { id: 'bobroom', name: 'bob', ownerId: remoteOwner.id, description: '', isArchived: false };

	function leave(actor: { uri: string }, roomUri: string) {
		return { type: 'Remove', actor: actor.uri, object: actor.uri, target: roomUri };
	}

	test('a remote member leaving the room is removed from its call', async () => {
		const f = fixture({ memberships: [{ id: 'm1', roomId: 'localroom', userId: dave.id }] });

		await f.inbox.remove(dave, leave(dave, 'https://other.test/chat/rooms/localroom'));

		expect(f.memberships.rows).toEqual([]);
		expect(f.liveKitService.removeParticipant).toHaveBeenCalledWith('localroom', dave.uri);
	});

	test('makes no LiveKit call when the Remove deleted no membership', async () => {
		const f = fixture();

		await f.inbox.remove(dave, leave(dave, 'https://other.test/chat/rooms/localroom'));

		expect(f.liveKitService.removeParticipant).not.toHaveBeenCalled();
	});

	test('logs a LiveKit error instead of failing the inbox job', async () => {
		// 外せなかった参加者は、通話の定期的な読み直し (ChatVoiceService.sweep) がメンバーでないとして外す
		const f = fixture({ memberships: [{ id: 'm1', roomId: 'localroom', userId: dave.id }] });
		f.liveKitService.removeParticipant.mockRejectedValueOnce(new Error('LiveKit is down'));

		await expect(f.inbox.remove(dave, leave(dave, 'https://other.test/chat/rooms/localroom'))).resolves.toBe('ok: removed from chat room');
		expect(f.memberships.rows).toEqual([]);
		expect(f.inbox.logger.warn).toHaveBeenCalled();
	});

	test('leaves calls alone for a room hosted on another server', async () => {
		const f = fixture({ rooms: [bobroom], memberships: [{ id: 'm1', roomId: 'bobroom', userId: dave.id }] });

		await f.inbox.remove(dave, leave(dave, 'https://remote.test/chat/rooms/bobroom'));

		expect(f.memberships.rows).toEqual([]);
		expect(f.liveKitService.removeParticipant).not.toHaveBeenCalled();
	});
});
