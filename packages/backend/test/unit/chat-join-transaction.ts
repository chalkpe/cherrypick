/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatRoomFullError, ChatService, MAX_ROOM_MEMBERS } from '@/core/ChatService.js';

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
		findOneBy: vi.fn(async () => {
			const current = state.invitations.get(invitation.id);
			if (current == null) return null;

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
		delete: vi.fn(async () => ({ affected: 1 })),
	};

	const usersRepository = {
		findOneBy: vi.fn(async ({ id }: { id: string }) => id === owner.id ? owner : joiningUser),
		findOneByOrFail: vi.fn(async ({ id }: { id: string }) => {
			if (id === joiningUser.id) return joiningUser;
			if (id === owner.id) return owner;
			throw new Error('user not found');
		}),
		findBy: vi.fn(async (): Promise<{ id: string; host: string | null; uri: string | null; inbox: string | null }[]> => [owner]),
	};

	const deliver = vi.fn();

	const service = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		db,
		hostPolicyService: { isRefusedRemoteHost: vi.fn().mockResolvedValue(false) },
		idService: {
			gen: () => 'membership1',
			parse: () => ({ date: new Date('2026-01-01T00:00:00.000Z') }),
		},
		chatRoomInvitationsRepository,
		chatRoomMembershipsRepository,
		chatRoomsRepository: {
			findOneBy: vi.fn(async () => room),
		},
		usersRepository,
		userEntityService: {
			isLocalUser: (user: { host: string | null }) => user.host == null,
			isRemoteUser: (user: { host: string | null }) => user.host != null,
			genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
		},
		apRendererService: {
			renderChatRoom: vi.fn(() => ({})),
			renderAccept: vi.fn(() => ({})),
			renderAdd: vi.fn(() => ({})),
			genLocalChatRoomUri: (id: string) => `https://local.test/chat/rooms/${id}`,
			addContext: vi.fn((activity: unknown) => activity),
		},
		globalEventService: {
			publishChatRoomStream: vi.fn(),
		},
		queueService: { deliver },
	}) as ChatService;

	return { service, state, manager, deliver, usersRepository, chatRoomMembershipsRepository };
}

describe('ChatService.joinToRoom invitation consumption', () => {
	test('joins normally and consumes the invitation', async () => {
		const f = createFixture();

		await f.service.joinToRoom('user1', 'room1');

		expect(f.state.invitations.size).toBe(0);
		expect(f.state.memberships).toEqual([{ id: 'membership1', roomId: 'room1', userId: 'user1' }]);
		expect(f.deliver).toHaveBeenCalled();
	});

	test('announces the new member to everyone but a member suspended on this server', async () => {
		const f = createFixture();
		const localOwner = { ...owner, host: null };
		const member = { id: 'member1', host: 'active.test', uri: 'https://active.test/users/member1', inbox: 'https://active.test/inbox' };
		const suspendedMember = { id: 'member2', host: 'suspended.test', uri: 'https://suspended.test/users/member2', inbox: 'https://suspended.test/inbox', isSuspended: true };
		f.usersRepository.findOneByOrFail.mockImplementation(async ({ id }: { id: string }) => id === owner.id ? localOwner as never : joiningUser as never);
		f.usersRepository.findBy.mockResolvedValue([localOwner, member, suspendedMember]);

		await f.service.joinToRoom('user1', 'room1');

		expect(f.deliver.mock.calls.map(call => call[2])).toEqual([member.inbox]);
	});

	describe('the roster a mirror kept from before', () => {
		const leftMember = { id: 'left1', host: 'other.test', uri: 'https://other.test/users/left1', inbox: 'https://other.test/inbox' };

		test('is dropped before the Accept when nobody here took part, so a removed member stops receiving messages', async () => {
			const f = createFixture();
			f.state.memberships = [{ id: 'old1', roomId: 'room1', userId: leftMember.id }];
			f.usersRepository.findBy.mockResolvedValue([owner, leftMember]);

			await f.service.joinToRoom('user1', 'room1');

			const [where] = f.chatRoomMembershipsRepository.delete.mock.calls[0] as unknown as [{ roomId: string; userId: { value: string[] } }];
			expect(where.roomId).toBe('room1');
			expect(where.userId.value).toEqual([leftMember.id]);
			expect(f.chatRoomMembershipsRepository.delete.mock.invocationCallOrder[0]).toBeLessThan(f.deliver.mock.invocationCallOrder[0]);
		});

		test('is kept while someone here is a member, because the owner has kept this server up to date', async () => {
			const f = createFixture();
			f.state.memberships = [{ id: 'old1', roomId: 'room1', userId: leftMember.id }, { id: 'old2', roomId: 'room1', userId: 'neighbor' }];
			f.usersRepository.findBy.mockResolvedValue([owner, leftMember, { id: 'neighbor', host: null, uri: null, inbox: null }]);

			await f.service.joinToRoom('user1', 'room1');

			expect(f.chatRoomMembershipsRepository.delete).not.toHaveBeenCalled();
		});
	});

	test('does not join when the invitation was cancelled before consumption', async () => {
		const f = createFixture({ cancelBeforeDelete: true });

		await expect(f.service.joinToRoom('user1', 'room1')).rejects.toThrow('invitation not found');

		expect(f.state.memberships).toEqual([]);
		expect(f.manager.insert).not.toHaveBeenCalled();
	});

	test('a full room refuses the join and keeps the invitation', async () => {
		const f = createFixture();
		f.state.memberships = Array.from({ length: MAX_ROOM_MEMBERS }, (_, i) => ({ id: `m${i}`, roomId: 'room1', userId: `other${i}` }));

		await expect(f.service.joinToRoom('user1', 'room1')).rejects.toBeInstanceOf(ChatRoomFullError);

		expect(f.state.invitations.size).toBe(1);
		expect(f.state.memberships).toHaveLength(MAX_ROOM_MEMBERS);
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
