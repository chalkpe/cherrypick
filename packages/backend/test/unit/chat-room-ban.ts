/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiLocalUser } from '@/models/User.js';
import { AccountMoveService } from '@/core/AccountMoveService.js';
import { ChatRoomBannedError, ChatRoomInvitationRefusedError, ChatService } from '@/core/ChatService.js';
import type { ChatRoomBanService } from '@/core/ChatRoomBanService.js';
import type { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import BanDeleteEndpoint from '@/server/api/endpoints/chat/rooms/bans/delete.js';
import BanListEndpoint from '@/server/api/endpoints/chat/rooms/bans/list.js';
import InvitationCreateEndpoint from '@/server/api/endpoints/chat/rooms/invitations/create.js';
import JoinEndpoint from '@/server/api/endpoints/chat/rooms/join.js';
import { notificationServiceOver } from '../misc/chat-room-notification-fixture.js';

const owner = { id: 'owner', host: null, uri: null, inbox: null, isSuspended: false };
const member = { id: 'member', host: 'remote.test', uri: 'https://remote.test/users/member', inbox: 'https://remote.test/inbox', isSuspended: false };
const other = { id: 'other', host: 'other.test', uri: 'https://other.test/users/other', inbox: 'https://other.test/inbox', isSuspended: false };
const localMember = { id: 'local-member', host: null, uri: null, inbox: null, isSuspended: false };
const room = { id: 'room', ownerId: owner.id, owner, name: 'room', isArchived: false, uri: null };

type Step = string;

/** 각 트랜잭션에서 일어난 일을 순서대로 기록해 어떤 단계가 같은 트랜잭션에 있었는지 확인한다. */
function removalFixture(memberIds: string[] = [member.id, other.id, localMember.id]) {
	const members = new Set(memberIds);
	const users = [owner, member, other, localMember];
	const steps: Step[] = [];
	let transactions = 0;
	const chatRoomBanService = {
		ban: vi.fn(async (manager: { tx: number }, roomId: string, userId: string) => {
			steps.push(`ban ${roomId}/${userId} in tx${manager.tx}`);
		}),
		isBanned: vi.fn(async () => false),
	};
	const queueService = { deliver: vi.fn() };
	const globalEventService = { publishChatRoomStream: vi.fn(), publishMainStream: vi.fn() };
	const liveKitService = { identityOf: (user: { id: string }) => user.id, removeParticipant: vi.fn().mockResolvedValue(undefined) };
	const service = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		db: {
			transaction: async <T>(callback: (manager: unknown) => Promise<T>) => {
				const tx = ++transactions;
				steps.push(`begin tx${tx}`);
				const result = await callback({
					tx,
					findOne: async () => {
						steps.push(`lock room in tx${tx}`);
						return room;
					},
					delete: async (_entity: unknown, where: { userId: string }) => {
						steps.push(`delete membership ${where.userId} in tx${tx}`);
						return { affected: Number(members.delete(where.userId)) };
					},
				});
				steps.push(`commit tx${tx}`);
				return result;
			},
		},
		idService: { gen: () => 'activity1' },
		chatRoomBanService,
		chatRoomMembershipsRepository: {
			findBy: async (where: { userId?: string; roomId?: string }) => where.userId != null
				? (members.has(where.userId) ? [{ roomId: room.id, userId: where.userId }] : [])
				: [...members].map(userId => ({ roomId: room.id, userId })),
		},
		chatRoomInvitationsRepository: { findBy: vi.fn().mockResolvedValue([]) },
		chatRoomsRepository: { find: vi.fn().mockResolvedValue([room]) },
		chatMessagesRepository: { createQueryBuilder: () => ({ select() { return this; }, where() { return this; }, andWhere() { return this; }, getRawMany: async () => [] }) },
		usersRepository: { findBy: async ({ id }: { id: { value: string[] } }) => users.filter(user => id.value.includes(user.id)) },
		userEntityService: {
			isRemoteUser: (user: { host: string | null }) => user.host != null,
			isLocalUser: (user: { host: string | null }) => user.host == null,
			genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
		},
		apRendererService: {
			genLocalChatRoomUri: (id: string) => `https://local.test/chat/rooms/${id}`,
			renderRemove: (actor: { id: string }, target: string, object: string) => ({ type: 'Remove', actor: `https://local.test/users/${actor.id}`, target, object }),
			addContext: (activity: object) => activity,
		},
		redisClient: { pipeline: () => ({ del: vi.fn().mockReturnThis(), srem: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) }) },
		queueService, globalEventService, liveKitService,
	}) as ChatService;
	Object.assign(service, { chatRoomNotificationService: notificationServiceOver(service) });
	return { service, members, steps, chatRoomBanService, queueService, globalEventService, liveKitService };
}

describe('the owner removing a member keeps them out', () => {
	test('records the ban in the transaction that ends the membership, under the room lock', async () => {
		const f = removalFixture();

		await expect(f.service.kickRoomMember(owner as never, room as never, member.id)).resolves.toBe(true);

		expect(f.steps).toEqual([
			'begin tx1',
			'lock room in tx1',
			`delete membership ${member.id} in tx1`,
			`ban ${room.id}/${member.id} in tx1`,
			'commit tx1',
		]);
	});

	test('keeps the existing clean-up: stream, voice call and the Remove to every server', async () => {
		const f = removalFixture();

		await f.service.kickRoomMember(owner as never, room as never, member.id);

		expect(f.globalEventService.publishChatRoomStream).toHaveBeenCalledWith(room.id, 'membershipEnded', { userId: member.id });
		expect(f.liveKitService.removeParticipant).toHaveBeenCalledWith(room.id, member.id);
		expect(f.queueService.deliver.mock.calls.map(call => call[2]).sort()).toEqual([member.inbox, other.inbox].sort());
		expect(f.queueService.deliver.mock.calls[0][1]).toMatchObject({ type: 'Remove', object: member.uri, target: 'https://local.test/chat/rooms/room' });
	});

	test('bans a member of this server the same way', async () => {
		const f = removalFixture();

		await expect(f.service.kickRoomMember(owner as never, room as never, localMember.id)).resolves.toBe(true);

		expect(f.chatRoomBanService.ban).toHaveBeenCalledWith(expect.anything(), room.id, localMember.id);
	});

	test('records nothing when there was no member to remove', async () => {
		const f = removalFixture([other.id]);

		await expect(f.service.kickRoomMember(owner as never, room as never, member.id)).resolves.toBe(false);

		expect(f.chatRoomBanService.ban).not.toHaveBeenCalled();
	});

	test('records nothing for a request from someone other than the local owner', async () => {
		const f = removalFixture();

		await expect(f.service.kickRoomMember(other as never, room as never, member.id)).resolves.toBe(false);
		await expect(f.service.kickRoomMember(owner as never, { ...room, ownerId: other.id } as never, member.id)).resolves.toBe(false);

		expect(f.chatRoomBanService.ban).not.toHaveBeenCalled();
		expect(f.members.has(member.id)).toBe(true);
	});
});

describe('the server removing a member by itself does not ban', () => {
	test('a remote account suspended here leaves the room with the usual clean-up and no ban', async () => {
		const f = removalFixture();

		await f.service.handleUserSuspended({ ...member, isSuspended: true } as never);

		expect(f.members.has(member.id)).toBe(false);
		expect(f.chatRoomBanService.ban).not.toHaveBeenCalled();
		expect(f.queueService.deliver).toHaveBeenCalledWith(owner, expect.objectContaining({ type: 'Remove', object: member.uri }), member.inbox, false);
	});

	test('the automatic removal has its own entry point', async () => {
		const f = removalFixture();

		await expect(f.service.evictRoomMember(owner as never, room as never, member.id)).resolves.toBe(true);

		expect(f.members.has(member.id)).toBe(false);
		expect(f.chatRoomBanService.ban).not.toHaveBeenCalled();
	});
});

function invitationFixture(options: { banned: boolean; banBeforeLock?: boolean }) {
	let banned = options.banned;
	const insertOne = vi.fn(async (row: object) => row);
	const deliver = vi.fn();
	const createNotification = vi.fn();
	const chatRoomBanService = { isBanned: vi.fn(async () => banned) };
	const manager = {
		findOne: async () => {
			if (options.banBeforeLock) banned = true;
			return room;
		},
		findOneBy: async () => null,
		countBy: async () => 1,
		withRepository: () => ({ insertOne }),
	};
	const service = Object.assign(Object.create(ChatService.prototype), {
		db: { transaction: async <T>(callback: (manager: unknown) => Promise<T>) => callback(manager) },
		chatRoomBanService,
		chatRoomsRepository: { findOneBy: vi.fn(async () => room) },
		usersRepository: {
			findOneBy: vi.fn(async ({ id }: { id: string }) => [owner, member, localMember].find(user => user.id === id) ?? null),
			findOneByOrFail: vi.fn(async ({ id }: { id: string }) => [owner, member, localMember].find(user => user.id === id)),
		},
		chatRoomMembershipsRepository: { findOneBy: vi.fn(async () => null), countBy: vi.fn(async () => 1) },
		chatRoomInvitationsRepository: { findOneBy: vi.fn(async () => null), insertOne },
		userBlockingService: { checkBlocked: vi.fn(async () => false) },
		idService: { gen: () => 'invitation1', parse: () => ({ date: new Date('2026-11-13T00:00:00Z') }) },
		userEntityService: {
			isLocalUser: (user: { host: string | null }) => user.host == null,
			isRemoteUser: (user: { host: string | null }) => user.host != null,
		},
		notificationService: { createNotification },
		globalEventService: { publishMainStream: vi.fn() },
		apRendererService: { renderChatRoom: () => ({}), renderInvite: () => ({}), addContext: (activity: object) => activity },
		queueService: { deliver },
	}) as ChatService;
	return { service, insertOne, deliver, createNotification, chatRoomBanService, manager };
}

describe('a new invitation', () => {
	test('refuses a ban committed while the invitation waits for the room lock', async () => {
		const f = invitationFixture({ banned: false, banBeforeLock: true });

		await expect(f.service.createRoomInvitation(owner.id, room.id, member.id)).rejects.toMatchObject({ reason: 'banned' });

		expect(f.insertOne).not.toHaveBeenCalled();
		expect(f.createNotification).not.toHaveBeenCalled();
		expect(f.deliver).not.toHaveBeenCalled();
	});

	test.each([localMember.id, member.id])('is refused for a banned account (%s), and nothing is sent', async inviteeId => {
		const f = invitationFixture({ banned: true });

		const error = await f.service.createRoomInvitation(owner.id, room.id, inviteeId).then(() => null, err => err);

		expect(error).toBeInstanceOf(ChatRoomInvitationRefusedError);
		expect(error.reason).toBe('banned');
		expect(f.chatRoomBanService.isBanned).toHaveBeenCalledWith(room.id, inviteeId, f.manager);
		expect(f.insertOne).not.toHaveBeenCalled();
		expect(f.createNotification).not.toHaveBeenCalled();
		expect(f.deliver).not.toHaveBeenCalled();
	});

	test('is sent to an account that is not banned', async () => {
		const f = invitationFixture({ banned: false });

		await f.service.createRoomInvitation(owner.id, room.id, member.id);

		expect(f.insertOne).toHaveBeenCalledWith({ id: 'invitation1', roomId: room.id, userId: member.id });
	});
});

function joinFixture(options: { banned: boolean; roomOwner?: typeof owner | typeof member }) {
	const roomOwner = options.roomOwner ?? owner;
	const joinRoom = { ...room, ownerId: roomOwner.id, owner: roomOwner };
	const invitations = [{ id: 'invitation1', roomId: room.id, userId: localMember.id, ignored: false, invitePublishedAt: null }];
	const memberships: { id: string; roomId: string; userId: string }[] = [];
	const deliver = vi.fn();
	const managers: unknown[] = [];
	const manager = {
		findOne: vi.fn(async () => joinRoom),
		find: vi.fn(async () => []),
		delete: vi.fn(async (_entity: unknown, where: { id: string }) => {
			const index = invitations.findIndex(invitation => invitation.id === where.id);
			if (index >= 0) invitations.splice(index, 1);
			return { affected: index >= 0 ? 1 : 0 };
		}),
		findOneBy: vi.fn(async () => null),
		countBy: vi.fn(async () => memberships.length),
		insert: vi.fn(async (_entity: unknown, row: { id: string; roomId: string; userId: string }) => {
			memberships.push(row);
		}),
	};
	const chatRoomBanService = {
		isBanned: vi.fn(async (_roomId: string, _userId: string, used?: unknown) => {
			managers.push(used);
			return options.banned;
		}),
	};
	const service = Object.assign(Object.create(ChatService.prototype), {
		config: { url: 'https://local.test' },
		db: {
			transaction: async <T>(callback: (tx: typeof manager) => Promise<T>) => {
				const snapshot = invitations.map(invitation => ({ ...invitation }));
				try {
					return await callback(manager);
				} catch (err) {
					invitations.splice(0, invitations.length, ...snapshot);
					throw err;
				}
			},
		},
		chatRoomBanService,
		chatRoomHistoryService: { requestImport: vi.fn(async () => {}) },
		hostPolicyService: { isRefusedRemoteHost: vi.fn(async () => false) },
		idService: { gen: () => 'membership1', parse: () => ({ date: new Date('2026-11-13T00:00:00Z') }) },
		chatRoomInvitationsRepository: { findOneBy: vi.fn(async () => invitations[0] ?? null) },
		chatRoomMembershipsRepository: { findBy: vi.fn(async () => memberships) },
		chatRoomsRepository: { findOneBy: vi.fn(async () => joinRoom) },
		usersRepository: {
			findOneBy: vi.fn(async ({ id }: { id: string }) => [owner, member, localMember].find(user => user.id === id) ?? null),
			findOneByOrFail: vi.fn(async ({ id }: { id: string }) => [owner, member, localMember].find(user => user.id === id)),
			findBy: vi.fn(async () => [roomOwner]),
		},
		userEntityService: {
			isLocalUser: (user: { host: string | null }) => user.host == null,
			isRemoteUser: (user: { host: string | null }) => user.host != null,
			genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
		},
		apRendererService: {
			renderChatRoom: () => ({}),
			renderAccept: () => ({ type: 'Accept' }),
			renderAdd: () => ({ type: 'Add' }),
			genLocalChatRoomUri: (id: string) => `https://local.test/chat/rooms/${id}`,
			addContext: (activity: object) => activity,
		},
		chatRosterService: { recordAccepted: vi.fn(async () => {}) },
		globalEventService: { publishChatRoomStream: vi.fn(), publishMainStream: vi.fn() },
		queueService: { deliver },
	}) as ChatService;
	return { service, invitations, memberships, deliver, manager, managers, chatRoomBanService };
}

describe('accepting an earlier invitation', () => {
	test('is refused for a banned account under the room lock, keeping the invitation', async () => {
		const f = joinFixture({ banned: true });

		await expect(f.service.joinToRoom(localMember.id, room.id)).rejects.toBeInstanceOf(ChatRoomBannedError);

		expect(f.managers).toEqual([f.manager]);
		expect(f.manager.findOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
		expect(f.memberships).toEqual([]);
		expect(f.invitations).toHaveLength(1);
		expect(f.deliver).not.toHaveBeenCalled();
	});

	test('still works for an account that is not banned', async () => {
		const f = joinFixture({ banned: false });

		await f.service.joinToRoom(localMember.id, room.id);

		expect(f.memberships).toEqual([{ id: 'membership1', roomId: room.id, userId: localMember.id }]);
	});

	test('leaves a room of another server to the ban list of its owner', async () => {
		const f = joinFixture({ banned: true, roomOwner: member });

		await f.service.joinToRoom(localMember.id, room.id);

		expect(f.chatRoomBanService.isBanned).not.toHaveBeenCalled();
		expect(f.memberships).toHaveLength(1);
	});
});

const me = { id: owner.id, host: null } as MiLocalUser;

describe('API refusals say the ban is the reason', () => {
	test('joining', async () => {
		const service = { checkChatAvailability: vi.fn(), joinToRoom: vi.fn().mockRejectedValue(new ChatRoomBannedError('banned')) } as unknown as ChatService;

		await expect(new JoinEndpoint(service).exec({ roomId: room.id }, me, null, null)).rejects.toMatchObject({ code: 'BANNED_FROM_ROOM' });
	});

	test('inviting', async () => {
		const service = {
			checkChatAvailability: vi.fn(),
			findMyRoomById: vi.fn().mockResolvedValue(room),
			createRoomInvitation: vi.fn().mockRejectedValue(new ChatRoomInvitationRefusedError('banned')),
		} as unknown as ChatService;

		await expect(new InvitationCreateEndpoint(service, {} as never).exec({ roomId: room.id, userId: member.id }, me, null, null)).rejects.toMatchObject({ code: 'USER_IS_BANNED' });
	});
});

/** 가짜 객체에 불린 메서드를 모두 기록해 다른 일이 없었음을 보인다. */
function recording<T extends object>(implementations: Partial<Record<string, (...args: never[]) => unknown>>): { proxy: T; calls: string[] } {
	const calls: string[] = [];
	const proxy = new Proxy({}, {
		get: (_target, property) => {
			if (typeof property !== 'string' || property === 'then') return undefined;
			return (...args: never[]) => {
				calls.push(property);
				return implementations[property]?.(...args);
			};
		},
	}) as T;
	return { proxy, calls };
}

describe('the list of removed people and pardons', () => {
	const ban = { id: 'ban1', roomId: room.id, userId: member.id };

	function endpoints(options: { isOwner: boolean; pardoned?: boolean }) {
		const chatService = recording<ChatService>({
			checkChatAvailability: async () => undefined,
			findMyRoomById: async (ownerId: string, roomId: string) => options.isOwner && ownerId === owner.id && roomId === room.id ? room : null,
		});
		const banService = recording<ChatRoomBanService>({
			list: async () => [ban],
			pardon: async () => options.pardoned ?? true,
		});
		const entityService = recording<ChatEntityService>({
			packRoomBans: async (bans: typeof ban[]) => bans.map(row => ({ ...row, createdAt: '2026-11-13T00:00:00.000Z', user: { id: row.userId } })),
		});
		return {
			list: new BanListEndpoint(chatService.proxy, banService.proxy, entityService.proxy),
			remove: new BanDeleteEndpoint(chatService.proxy, banService.proxy),
			chatService, banService,
		};
	}

	test('the owner reads it', async () => {
		const f = endpoints({ isOwner: true });

		await expect(f.list.exec({ roomId: room.id }, me, null, null)).resolves.toEqual([expect.objectContaining({ userId: member.id, user: { id: member.id } })]);
	});

	test.each(['list', 'remove'] as const)('nobody else can use %s, and the room is not revealed', async which => {
		const f = endpoints({ isOwner: false });
		const endpoint = which === 'list' ? f.list : f.remove;
		const params = which === 'list' ? { roomId: room.id } : { roomId: room.id, userId: member.id };

		await expect(endpoint.exec(params, { id: member.id } as MiLocalUser, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_ROOM' });

		expect(f.banService.calls).toEqual([]);
	});

	test('a pardon removes the ban and does nothing else', async () => {
		const f = endpoints({ isOwner: true });

		await f.remove.exec({ roomId: room.id, userId: member.id }, me, null, null);

		expect(f.banService.calls).toEqual(['pardon']);
		expect(f.chatService.calls).toEqual(['checkChatAvailability', 'findMyRoomById']);
	});

	test('pardoning someone who is not banned says so', async () => {
		const f = endpoints({ isOwner: true, pardoned: false });

		await expect(f.remove.exec({ roomId: room.id, userId: other.id }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_BAN' });
	});
});

describe('a verified account move', () => {
	const copyFailure = new Error('ban copy failed');

	function moveFixture({ banCopyFails = false } = {}) {
		const transactionManager = { tx: 'move' };
		const chatRoomBanService = {
			carryOnMove: vi.fn(async () => {
				if (banCopyFails) throw copyFailure;
			}),
			// 옛 계정에 금지가 없으면 뒤쪽 이전을 찾지 않고 이 이전만 기록한다.
			hasBans: vi.fn(async () => false),
		};
		const usersRepository = {
			update: vi.fn(async () => ({})),
			manager: { transaction: vi.fn(async (work: (manager: unknown) => Promise<unknown>) => work(transactionManager)) },
		};
		const transactionUpdate = vi.fn(async () => ({}));
		Object.assign(transactionManager, { update: transactionUpdate });
		const delivered: unknown[] = [];
		const relations = {
			copyBlocking: vi.fn(async () => {}),
			copyMutings: vi.fn(async () => {}),
			copyRoles: vi.fn(async () => {}),
			updateLists: vi.fn(async () => {}),
		};
		const queueService = { createFollowJob: vi.fn(), createDelayedUnfollowJob: vi.fn() };
		const service = Object.create(AccountMoveService.prototype) as AccountMoveService;
		// 서비스 메서드는 bindThis getter라 대입하지 않고 속성으로 덮는다.
		for (const [key, value] of Object.entries({
			chatRoomBanService,
			usersRepository,
			queueService,
			...relations,
			antennaService: { onMoveAccount: vi.fn(async () => {}) },
			systemAccountService: { fetch: vi.fn(async () => ({ id: 'proxy' })) },
			followingsRepository: { findBy: vi.fn(async () => []) },
			userEntityService: {
				getUserUri: (user: { id: string }) => `https://local.test/users/${user.id}`,
				pack: vi.fn(async () => ({ id: 'old' })),
			},
			globalEventService: { publishInternalEvent: vi.fn(), publishMainStream: vi.fn() },
			apRendererService: { renderPerson: vi.fn(async () => ({})), renderUpdate: vi.fn(() => ({})), renderMove: vi.fn(() => ({})), addContext: (activity: unknown) => activity },
			apDeliverManagerService: { deliverToFollowers: vi.fn(async (_user: unknown, activity: unknown) => { delivered.push(activity); }) },
			relayService: { deliverToRelays: vi.fn() },
		})) Object.defineProperty(service, key, { value });
		return { service, chatRoomBanService, usersRepository, transactionManager, transactionUpdate, relations, queueService, delivered };
	}

	test('carries the bans of the old account to the new one where blocks are carried', async () => {
		const f = moveFixture();
		const src = { id: 'old' };
		const dst = { id: 'new' };

		await f.service.postMoveProcess(src as never, dst as never);

		expect(f.chatRoomBanService.carryOnMove).toHaveBeenCalledWith([{ src, dst }]);
	});

	test('a remote move reports a failed ban copy instead of finishing as if it succeeded', async () => {
		const f = moveFixture({ banCopyFails: true });

		await expect(f.service.postMoveProcess({ id: 'old' } as never, { id: 'new' } as never)).rejects.toBe(copyFailure);

		// 다른 관계 이전은 이전처럼 끝까지 진행하고 금지 승계 실패만 호출자에게 전한다.
		expect(f.relations.copyBlocking).toHaveBeenCalled();
		expect(f.queueService.createFollowJob).toHaveBeenCalled();
	});

	test('a local move records the move together with the bans, so a failed ban copy leaves the account free to retry', async () => {
		const f = moveFixture({ banCopyFails: true });
		const src = { id: 'old', alsoKnownAs: null, movedToUri: null };
		const dst = { id: 'new' };

		await expect(f.service.moveFromLocal(src as never, dst as never)).rejects.toBe(copyFailure);

		// 이전 표시와 금지 승계가 같은 트랜잭션에 있어 승계 실패로 둘 다 확정되지 않는다.
		expect(f.transactionUpdate).toHaveBeenCalledWith(expect.anything(), 'old', expect.objectContaining({ movedToUri: 'https://local.test/users/new' }));
		expect(f.chatRoomBanService.carryOnMove).toHaveBeenCalledWith([{ src, dst }], f.transactionManager);
		expect(f.usersRepository.update).not.toHaveBeenCalled();
		expect(src.movedToUri).toBeNull();
		expect(f.delivered).toEqual([]);
	});

	test('a local move copies the bans once, inside the move transaction', async () => {
		const f = moveFixture();
		const src = { id: 'old', alsoKnownAs: null, movedToUri: null };
		const dst = { id: 'new' };

		await f.service.moveFromLocal(src as never, dst as never);

		expect(f.chatRoomBanService.carryOnMove).toHaveBeenCalledTimes(1);
		expect(f.chatRoomBanService.carryOnMove).toHaveBeenCalledWith([{ src, dst }], f.transactionManager);
		expect(src.movedToUri).toBe('https://local.test/users/new');
		expect(f.relations.copyBlocking).toHaveBeenCalled();
	});
});
