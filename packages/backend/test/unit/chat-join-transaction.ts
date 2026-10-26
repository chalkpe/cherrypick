/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';

const invitation = {
	id: 'invitation1',
	roomId: 'room1',
	userId: 'user1',
	ignored: false,
};

const joiningUser = { id: 'user1', host: null, uri: null, inbox: null };
const owner = { id: 'owner1', host: 'remote.test', uri: 'https://remote.test/users/owner1', inbox: 'https://remote.test/inbox' };
const room = { id: 'room1', ownerId: 'owner1' };

type FixtureOptions = {
	failInsert?: boolean;
	cancelBeforeDelete?: boolean;
	existingMembership?: boolean;
	waitForConcurrentReads?: boolean;
};

function createFixture(options: FixtureOptions = {}) {
	const state: {
		invitations: Map<string, typeof invitation>;
		memberships: Array<{ id: string; roomId: string; userId: string }>;
	} = {
		invitations: new Map([[invitation.id, { ...invitation }]]),
		memberships: options.existingMembership
			? [{ id: 'existing1', roomId: 'room1', userId: 'user1' }]
			: [],
	};

	let transactionQueue: Promise<unknown> = Promise.resolve();
	let reads = 0;
	let releaseReads!: () => void;
	const bothRead = options.waitForConcurrentReads
		? new Promise<void>(resolve => { releaseReads = resolve; })
		: null;

	const manager = {
		delete: vi.fn(async (_entity: unknown, where: { id: string; roomId: string; userId: string }) => {
			let affected = 0;
			for (const [id, current] of state.invitations) {
				if (current.id === where.id && current.roomId === where.roomId && current.userId === where.userId) {
					state.invitations.delete(id);
					affected++;
				}
			}
			return { affected };
		}),
		findOneBy: vi.fn(async (_entity: unknown, where: { roomId: string; userId: string }) => {
			return state.memberships.find(m => m.roomId === where.roomId && m.userId === where.userId) ?? null;
		}),
		countBy: vi.fn(async (_entity: unknown, where: { roomId: string }) => {
			return state.memberships.filter(m => m.roomId === where.roomId).length;
		}),
		insert: vi.fn(async (_entity: unknown, values: { id: string; roomId: string; userId: string }) => {
			if (options.failInsert) throw new Error('insert failed');
			state.memberships.push(values);
			return {};
		}),
	};

	const db = {
		transaction: async <T>(callback: (tx: typeof manager) => Promise<T>): Promise<T> => {
			const previous = transactionQueue;
			let release!: () => void;
			transactionQueue = new Promise<void>(resolve => { release = resolve; });
			await previous;

			const snapshot = {
				invitations: new Map(state.invitations),
				memberships: state.memberships.map(m => ({ ...m })),
			};

			try {
				return await callback(manager);
			} catch (err) {
				state.invitations = snapshot.invitations;
				state.memberships = snapshot.memberships;
				throw err;
			} finally {
				release();
			}
		},
	};

	const chatRoomInvitationsRepository = {
		findOneByOrFail: vi.fn(async () => {
			const current = state.invitations.get(invitation.id);
			if (current == null) throw new Error('invitation not found');

			reads++;
			if (bothRead != null && reads === 2) releaseReads();
			if (bothRead != null) await bothRead;

			if (options.cancelBeforeDelete) {
				state.invitations.delete(invitation.id);
			}

			return { ...current };
		}),
	};

	const chatRoomMembershipsRepository = {
		findBy: vi.fn(async () => state.memberships),
	};

	const usersRepository = {
		findOneByOrFail: vi.fn(async ({ id }: { id: string }) => {
			if (id === joiningUser.id) return joiningUser;
			if (id === owner.id) return owner;
			throw new Error('user not found');
		}),
		findBy: vi.fn(async () => [owner]),
	};

	const deliver = vi.fn();

	const service = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		db,
		idService: {
			gen: () => 'membership1',
			parse: () => ({ date: new Date('2026-01-01T00:00:00.000Z') }),
		},
		chatRoomInvitationsRepository,
		chatRoomMembershipsRepository,
		chatRoomsRepository: {
			findOneByOrFail: vi.fn(async () => room),
		},
		usersRepository,
		userEntityService: {
			isLocalUser: (user: { id: string }) => user.id === joiningUser.id,
			isRemoteUser: (user: { id: string }) => user.id === owner.id,
			genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
		},
		apRendererService: {
			renderChatRoom: vi.fn(() => ({})),
			renderAccept: vi.fn(() => ({})),
			renderAdd: vi.fn(() => ({})),
			addContext: vi.fn((activity: unknown) => activity),
		},
		queueService: { deliver },
	}) as ChatService;

	return { service, state, manager, deliver };
}

describe('ChatService.joinToRoom invitation consumption', () => {
	test('joins normally and consumes the invitation', async () => {
		const f = createFixture();

		await f.service.joinToRoom('user1', 'room1');

		expect(f.state.invitations.size).toBe(0);
		expect(f.state.memberships).toEqual([{ id: 'membership1', roomId: 'room1', userId: 'user1' }]);
		expect(f.deliver).toHaveBeenCalled();
	});

	test('does not join when the invitation was cancelled before consumption', async () => {
		const f = createFixture({ cancelBeforeDelete: true });

		await expect(f.service.joinToRoom('user1', 'room1')).rejects.toThrow('invitation not found');

		expect(f.state.memberships).toEqual([]);
		expect(f.manager.insert).not.toHaveBeenCalled();
	});

	test('restores the invitation when the membership insert fails', async () => {
		const f = createFixture({ failInsert: true });

		await expect(f.service.joinToRoom('user1', 'room1')).rejects.toThrow('insert failed');

		expect(f.state.invitations.size).toBe(1);
		expect(f.state.memberships).toEqual([]);
	});

	test('allows exactly one of two concurrent joins', async () => {
		const f = createFixture({ waitForConcurrentReads: true });

		const results = await Promise.allSettled([
			f.service.joinToRoom('user1', 'room1'),
			f.service.joinToRoom('user1', 'room1'),
		]);

		expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
		expect(f.state.invitations.size).toBe(0);
		expect(f.state.memberships).toEqual([{ id: 'membership1', roomId: 'room1', userId: 'user1' }]);
	});

	test('consumes the invitation without duplicating an existing membership', async () => {
		const f = createFixture({ existingMembership: true });

		await f.service.joinToRoom('user1', 'room1');

		expect(f.state.invitations.size).toBe(0);
		expect(f.state.memberships).toEqual([{ id: 'existing1', roomId: 'room1', userId: 'user1' }]);
		expect(f.deliver).not.toHaveBeenCalled();
	});
});
