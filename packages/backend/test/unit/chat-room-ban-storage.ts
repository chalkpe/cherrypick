/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { DataSource, QueryRunner } from 'typeorm';
import type { ChatRoomBansRepository, ChatRoomInvitationsRepository, ChatRoomMembershipsRepository, ChatRoomsRepository, MiChatRoom, MiUser, UsersRepository } from '@/models/_.js';
import { ChatRoomBanService } from '@/core/ChatRoomBanService.js';
import { ChatRoomBannedError, ChatService } from '@/core/ChatService.js';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { IdService } from '@/core/IdService.js';
import { QueryService } from '@/core/QueryService.js';
import { notificationServiceOver } from '../misc/chat-room-notification-fixture.js';

// 여기서 확인하는 보장은 PostgreSQL의 행 잠금과 제약에서 나오므로 실제 DB를 쓴다.
describe('chat room bans in the database', () => {
	let app: TestingModule;
	let db: DataSource;
	let idService: IdService;
	let banService: ChatRoomBanService;
	let usersRepository: UsersRepository;
	let chatRoomsRepository: ChatRoomsRepository;
	let chatRoomMembershipsRepository: ChatRoomMembershipsRepository;
	let chatRoomInvitationsRepository: ChatRoomInvitationsRepository;
	let chatRoomBansRepository: ChatRoomBansRepository;
	let owner: MiUser;

	function createChatService(): ChatService {
		const pipeline = { del() { return this; }, srem() { return this; }, exec: async () => [] };
		const service = Object.assign(Object.create(ChatService.prototype), {
			config: { url: 'https://local.test' },
			db,
			idService,
			chatRoomBanService: banService,
			usersRepository,
			chatRoomsRepository,
			chatRoomMembershipsRepository,
			chatRoomInvitationsRepository,
			hostPolicyService: { isRefusedRemoteHost: async () => false },
			chatRosterService: { recordAccepted: async () => {}, forgetAccepted: async () => {} },
			redisClient: { pipeline: () => pipeline },
			queueService: { deliver: vi.fn() },
			globalEventService: { publishChatRoomStream: vi.fn(), publishMainStream: vi.fn() },
			liveKitService: { identityOf: (user: MiUser) => user.id, removeParticipant: async () => {} },
			userEntityService: {
				isLocalUser: (user: MiUser) => user.host == null,
				isRemoteUser: (user: MiUser) => user.host != null,
				genLocalUserUri: (id: string) => `https://local.test/users/${id}`,
			},
			apRendererService: {
				genLocalChatRoomUri: (id: string) => `https://local.test/chat/rooms/${id}`,
				renderRemove: () => ({ type: 'Remove' }),
				addContext: (activity: object) => activity,
			},
		}) as ChatService;
		Object.assign(service, { chatRoomNotificationService: notificationServiceOver(service) });
		return service;
	}

	async function createUser(data: Partial<MiUser> = {}): Promise<MiUser> {
		const id = idService.gen();
		await usersRepository.insert({ id, username: id, usernameLower: id, ...data });
		return usersRepository.findOneByOrFail({ id });
	}

	async function createRoom(): Promise<MiChatRoom> {
		const id = idService.gen();
		await chatRoomsRepository.insert({ id, name: id, ownerId: owner.id });
		return chatRoomsRepository.findOneByOrFail({ id });
	}

	async function addMember(room: MiChatRoom, user: MiUser): Promise<void> {
		await chatRoomMembershipsRepository.insert({ id: idService.gen(), roomId: room.id, userId: user.id });
	}

	async function invite(room: MiChatRoom, user: MiUser): Promise<void> {
		await chatRoomInvitationsRepository.insert({ id: idService.gen(), roomId: room.id, userId: user.id });
	}

	const isMember = (room: MiChatRoom, user: MiUser) => chatRoomMembershipsRepository.existsBy({ roomId: room.id, userId: user.id });

	/** 참여·내보내기와 같은 방식으로 그룹 행 잠금을 잡고 풀 때까지 유지한다. */
	async function holdRoomLock(room: MiChatRoom): Promise<QueryRunner> {
		const runner = db.createQueryRunner();
		await runner.connect();
		await runner.startTransaction();
		await runner.query('SELECT "id" FROM "chat_room" WHERE "id" = $1 FOR UPDATE', [room.id]);
		return runner;
	}

	/** 시험 대상 요청이 잠금을 기다리는 세션 수가 이만큼 되면 끝난다. 고정 대기 대신 쓰는 동기화 신호다. */
	async function lockWaiters(count: number): Promise<void> {
		await vi.waitFor(async () => {
			const [{ waiting }] = await db.query(`SELECT count(*)::int AS "waiting" FROM "pg_stat_activity" WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'`) as { waiting: number }[];
			if (waiting < count) throw new Error(`${waiting} of ${count} waiting`);
		}, { timeout: 10_000, interval: 20 });
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({ imports: [GlobalModule], providers: [IdService, QueryService, ChatRoomBanService] }).compile();
		await app.init();
		db = app.get(DI.db);
		idService = app.get(IdService);
		banService = app.get(ChatRoomBanService);
		usersRepository = app.get(DI.usersRepository);
		chatRoomsRepository = app.get(DI.chatRoomsRepository);
		chatRoomMembershipsRepository = app.get(DI.chatRoomMembershipsRepository);
		chatRoomInvitationsRepository = app.get(DI.chatRoomInvitationsRepository);
		chatRoomBansRepository = app.get(DI.chatRoomBansRepository);
	});

	beforeEach(async () => {
		owner = await createUser();
	});

	afterAll(async () => {
		await app.close();
	});

	describe('the owner removing a member', () => {
		test('a join waiting behind the removal finds the ban, not an empty seat', async () => {
			const service = createChatService();
			const room = await createRoom();
			const member = await createUser();
			await addMember(room, member);
			// 내보내기 전에 받아 둔 초대. 멤버는 이것으로 다시 참여하려 한다.
			await invite(room, member);
			const holder = await holdRoomLock(room);

			const removal = service.kickRoomMember(owner, room, member.id);
			await lockWaiters(1);
			const join = service.joinToRoom(member.id, room.id).then(() => null, err => err);
			await lockWaiters(2);
			await holder.rollbackTransaction();
			await holder.release();

			await expect(removal).resolves.toBe(true);
			await expect(join).resolves.toBeInstanceOf(ChatRoomBannedError);
			expect(await isMember(room, member)).toBe(false);
			expect(await banService.isBanned(room.id, member.id)).toBe(true);
			expect(await chatRoomInvitationsRepository.existsBy({ roomId: room.id, userId: member.id })).toBe(true);
		});

		test('a join that got the lock first is undone by the removal that follows', async () => {
			const service = createChatService();
			const room = await createRoom();
			const member = await createUser();
			await addMember(room, member);
			await invite(room, member);
			const holder = await holdRoomLock(room);

			const join = service.joinToRoom(member.id, room.id);
			await lockWaiters(1);
			const removal = service.kickRoomMember(owner, room, member.id);
			await lockWaiters(2);
			await holder.rollbackTransaction();
			await holder.release();

			await join;
			await expect(removal).resolves.toBe(true);
			expect(await isMember(room, member)).toBe(false);
			expect(await banService.isBanned(room.id, member.id)).toBe(true);
		});

		test('removing twice keeps one ban', async () => {
			const service = createChatService();
			const room = await createRoom();
			const member = await createUser();
			await addMember(room, member);

			await service.kickRoomMember(owner, room, member.id);
			await addMember(room, member);
			await service.kickRoomMember(owner, room, member.id);

			expect(await chatRoomBansRepository.countBy({ roomId: room.id, userId: member.id })).toBe(1);
		});

		test('the server removing a member by itself records nothing', async () => {
			const service = createChatService();
			const room = await createRoom();
			const member = await createUser({ host: 'remote.test', uri: `https://remote.test/users/${idService.gen()}`, inbox: 'https://remote.test/inbox' });
			await addMember(room, member);

			await expect(service.evictRoomMember(owner, room, member.id)).resolves.toBe(true);

			expect(await isMember(room, member)).toBe(false);
			expect(await chatRoomBansRepository.countBy({ roomId: room.id })).toBe(0);
		});
	});

	describe('pardons', () => {
		test('a pardon deletes the ban and leaves memberships and invitations as they are', async () => {
			const service = createChatService();
			const room = await createRoom();
			const member = await createUser();
			const other = await createUser();
			await addMember(room, member);
			await addMember(room, other);
			await service.kickRoomMember(owner, room, member.id);
			const before = { memberships: await chatRoomMembershipsRepository.countBy({ roomId: room.id }), invitations: await chatRoomInvitationsRepository.countBy({ roomId: room.id }) };

			await expect(banService.pardon(room.id, member.id)).resolves.toBe(true);

			expect(await banService.isBanned(room.id, member.id)).toBe(false);
			expect(await isMember(room, member)).toBe(false);
			expect({ memberships: await chatRoomMembershipsRepository.countBy({ roomId: room.id }), invitations: await chatRoomInvitationsRepository.countBy({ roomId: room.id }) }).toEqual(before);
			await expect(banService.pardon(room.id, member.id)).resolves.toBe(false);
		});

		test('the pardoned account can join with a new invitation', async () => {
			const service = createChatService();
			const room = await createRoom();
			const member = await createUser();
			await addMember(room, member);
			await service.kickRoomMember(owner, room, member.id);
			await banService.pardon(room.id, member.id);
			await invite(room, member);

			await service.joinToRoom(member.id, room.id);

			expect(await isMember(room, member)).toBe(true);
		});
	});

	describe('listing', () => {
		test('lists only the bans of the room, newest first, with the account', async () => {
			const service = createChatService();
			const room = await createRoom();
			const otherRoom = await createRoom();
			const first = await createUser();
			const second = await createUser();
			for (const user of [first, second]) await addMember(room, user);
			await addMember(otherRoom, first);
			await service.kickRoomMember(owner, room, first.id);
			await service.kickRoomMember(owner, room, second.id);
			await service.kickRoomMember(owner, otherRoom, first.id);

			const bans = await banService.list(room.id, 10, null, idService.gen(Date.now() + 1000));

			expect(bans.map(ban => ban.userId)).toEqual([second.id, first.id]);
			expect(bans.every(ban => ban.user?.id === ban.userId)).toBe(true);
		});

		test('a deleted room takes its bans with it', async () => {
			const service = createChatService();
			const room = await createRoom();
			const member = await createUser();
			await addMember(room, member);
			await service.kickRoomMember(owner, room, member.id);

			await chatRoomsRepository.delete(room.id);

			expect(await chatRoomBansRepository.countBy({ roomId: room.id })).toBe(0);
		});
	});

	describe('account moves', () => {
		test('the new account inherits every ban once, the old one keeps them, and memberships stay', async () => {
			const service = createChatService();
			const [roomA, roomB, roomC] = [await createRoom(), await createRoom(), await createRoom()];
			const oldAccount = await createUser();
			const newAccount = await createUser();
			for (const room of [roomA, roomB]) {
				await addMember(room, oldAccount);
				await service.kickRoomMember(owner, room, oldAccount.id);
			}
			// 새 계정은 B에서 이미 따로 내보내졌고 A의 멤버다.
			await addMember(roomB, newAccount);
			await service.kickRoomMember(owner, roomB, newAccount.id);
			await addMember(roomA, newAccount);

			await banService.inheritOnMove(oldAccount, newAccount);
			await banService.inheritOnMove(oldAccount, newAccount);

			expect(await chatRoomBansRepository.countBy({ userId: oldAccount.id })).toBe(2);
			expect(await chatRoomBansRepository.countBy({ userId: newAccount.id, roomId: roomA.id })).toBe(1);
			expect(await chatRoomBansRepository.countBy({ userId: newAccount.id, roomId: roomB.id })).toBe(1);
			expect(await chatRoomBansRepository.countBy({ userId: newAccount.id, roomId: roomC.id })).toBe(0);
			expect(await isMember(roomA, newAccount)).toBe(true);
		});

		test('the inherited ban refuses the next join of the new account', async () => {
			const service = createChatService();
			const room = await createRoom();
			const oldAccount = await createUser();
			const newAccount = await createUser();
			await addMember(room, oldAccount);
			await service.kickRoomMember(owner, room, oldAccount.id);
			await invite(room, newAccount);

			await banService.inheritOnMove(oldAccount, newAccount);

			await expect(service.joinToRoom(newAccount.id, room.id)).rejects.toBeInstanceOf(ChatRoomBannedError);
			expect(await isMember(room, newAccount)).toBe(false);
		});
	});
});
