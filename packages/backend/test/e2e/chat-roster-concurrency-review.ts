/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert';
import { afterAll, beforeAll, test, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { ChatService, MAX_ROOM_MEMBERS } from '@/core/ChatService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import type { IAdd, IRemove } from '@/core/activitypub/type.js';
import { MiChatRoom, MiChatRoomMembership, MiChatRoomRosterState, miRepository } from '@/models/_.js';
import type { MiRemoteUser } from '@/models/User.js';
import { api, initTestDb, signup } from '../utils.js';

let ownerId: string;
let memberId: string;
let roomId: string;
let db: Awaited<ReturnType<typeof initTestDb>>;

beforeAll(async () => {
	const owner = await signup();
	const member = await signup();
	ownerId = owner.id;
	memberId = member.id;
	const created = await api('chat/rooms/create', { name: 'ordered membership' }, owner);
	assert.strictEqual(created.status, 200);
	roomId = created.body.id;
	db = await initTestDb(true);
}, 120_000);

afterAll(async () => { await db?.destroy(); });

test('a newer Remove wins when an older Add is paused after its ordering claim', async () => {
	const owner = { id: ownerId, host: 'remote.test', uri: 'https://remote.test/users/owner', isSuspended: false } as MiRemoteUser;
	const member = { id: memberId, host: 'member.test', uri: 'https://member.test/users/member', isSuspended: false } as MiRemoteUser;
	const roomUri = `https://remote.test/chat/rooms/${roomId}`;
	const memberships = db.getRepository(MiChatRoomMembership).extend(miRepository);
	const states = db.getRepository(MiChatRoomRosterState).extend(miRepository);
	let releaseAdd!: () => void;
	let addPaused!: () => void;
	let removeQueued!: () => void;
	const gate = new Promise<void>(resolve => { releaseAdd = resolve; });
	const paused = new Promise<void>(resolve => { addPaused = resolve; });
	const queued = new Promise<void>(resolve => { removeQueued = resolve; });
	let transactions = 0;
	let pausedOnce = false;
	const pauseAdd = async () => {
		if (pausedOnce) return;
		pausedOnce = true;
		addPaused();
		await gate;
	};
	const wrappedDb = { transaction: async <T>(callback: (manager: EntityManager) => Promise<T>) => {
		const order = ++transactions;
		if (order === 2) removeQueued();
		return await db.transaction(async manager => callback(new Proxy(manager, {
			get(target, property) {
				if (property === 'insert' && order === 1) return async (entity: typeof MiChatRoomMembership, row: { id: string; roomId: string; userId: string }) => {
					if (entity === MiChatRoomMembership) await pauseAdd();
					return await target.insert(entity, row);
				};
				const value = Reflect.get(target, property);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		})));
	} };
	const membershipRepository = {
		findBy: memberships.findBy.bind(memberships),
		findOneBy: memberships.findOneBy.bind(memberships),
		insertOne: async (row: { id: string; roomId: string; userId: string }) => { await pauseAdd(); return await memberships.insertOne(row); },
		delete: memberships.delete.bind(memberships),
	};
	const pipeline = { del: () => pipeline, srem: () => pipeline, exec: async () => [] };
	const events = { publishChatRoomStream: vi.fn(), publishMainStream: vi.fn() };
	const userEntity = { isLocalUser: () => false };
	// 원격 제거를 마치면 그 멤버의 개인 미읽음·알림 설정도 정리한다
	const forget = vi.fn<(userId: string, roomId: string) => Promise<void>>(async () => {});
	const chatService = Object.assign(Object.create(ChatService.prototype), {
		db: wrappedDb, chatRoomMembershipsRepository: membershipRepository,
		globalEventService: events, userEntityService: userEntity, redisClient: { pipeline: () => pipeline },
		chatRoomNotificationService: { forget },
	}) as ChatService;
	const roster = Object.assign(Object.create(ChatRosterService.prototype), { chatRoomRosterStatesRepository: states }) as ChatRosterService;
	const inbox = Object.assign(Object.create(ApInboxService.prototype), {
		db: wrappedDb, chatService, chatRosterService: roster,
		chatRoomsRepository: db.getRepository(MiChatRoom), chatRoomMembershipsRepository: membershipRepository,
		usersRepository: { findOneBy: async () => owner },
		apDbResolverService: { getUserFromApId: async () => member },
		utilityService: { punyHost: (uri: string) => new URL(uri).hostname },
		userEntityService: userEntity, globalEventService: events,
		logger: { info: vi.fn(), warn: vi.fn() }, idService: { gen: () => 'raceMembership1' },
	}) as ApInboxService;
	const older = new Date(Date.now() - 2000).toISOString();
	const newer = new Date(Date.now() - 1000).toISOString();
	const add: IAdd = { type: 'Add', actor: owner.uri, object: member.uri, target: roomUri, published: older };
	const remove: IRemove = { type: 'Remove', actor: owner.uri, object: member.uri, target: roomUri, published: newer };

	const adding = inbox.performOneActivity(owner, add);
	await paused;
	const removing = inbox.performOneActivity(owner, remove);
	await Promise.race([removing, queued]);
	releaseAdd();
	await Promise.all([adding, removing]);
	assert.strictEqual(await memberships.findOneBy({ roomId, userId: memberId }), null);
	assert.deepStrictEqual(forget.mock.calls, [[memberId, roomId]]);
}, 30_000);

test('a failed Add insertion can be retried without losing the ordering claim', async () => {
	const joining = await signup();
	const owner = { id: ownerId, host: 'remote.test', uri: 'https://remote.test/users/owner', isSuspended: false } as MiRemoteUser;
	const member = { id: joining.id, host: 'member.test', uri: 'https://member.test/users/new-member', isSuspended: false } as MiRemoteUser;
	const roomUri = `https://remote.test/chat/rooms/${roomId}`;
	const memberships = db.getRepository(MiChatRoomMembership).extend(miRepository);
	const states = db.getRepository(MiChatRoomRosterState).extend(miRepository);
	let failInsert = true;
	const checkInsert = () => {
		if (failInsert) { failInsert = false; throw new Error('injected membership failure'); }
	};
	const wrappedDb = { transaction: async <T>(callback: (manager: EntityManager) => Promise<T>) => await db.transaction(async manager => callback(new Proxy(manager, {
		get(target, property) {
			if (property === 'insert') return async (entity: typeof MiChatRoomMembership, row: { id: string; roomId: string; userId: string }) => {
				if (entity === MiChatRoomMembership) checkInsert();
				return await target.insert(entity, row);
			};
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}))) };
	const membershipRepository = {
		findBy: memberships.findBy.bind(memberships),
		findOneBy: memberships.findOneBy.bind(memberships),
		insertOne: async (row: { id: string; roomId: string; userId: string }) => { checkInsert(); return await memberships.insertOne(row); },
	};
	const roster = Object.assign(Object.create(ChatRosterService.prototype), { chatRoomRosterStatesRepository: states }) as ChatRosterService;
	const inbox = Object.assign(Object.create(ApInboxService.prototype), {
		db: wrappedDb, chatRosterService: roster,
		chatRoomsRepository: db.getRepository(MiChatRoom), chatRoomMembershipsRepository: membershipRepository,
		usersRepository: { findOneBy: async () => owner },
		apDbResolverService: { getUserFromApId: async () => member },
		utilityService: { punyHost: (uri: string) => new URL(uri).hostname },
		userEntityService: { isLocalUser: () => false },
		globalEventService: { publishChatRoomStream: vi.fn() },
		logger: { info: vi.fn(), warn: vi.fn() }, idService: { gen: () => 'raceMembership2' },
	}) as ApInboxService;
	const add: IAdd = { type: 'Add', actor: owner.uri, object: member.uri, target: roomUri, published: new Date().toISOString() };

	await assert.rejects(inbox.performOneActivity(owner, add), /injected membership failure/);
	assert.strictEqual(await inbox.performOneActivity(owner, add), 'ok: chat room member added');
	assert.ok(await memberships.findOneBy({ roomId, userId: member.id }));
}, 30_000);

test('concurrent invitations cannot both fill the last room place', async () => {
	const owner = await signup();
	const created = await api('chat/rooms/create', { name: 'last room place' }, owner);
	assert.strictEqual(created.status, 200);
	const roomId = created.body.id;
	const invitees = [];
	for (let i = 0; i < MAX_ROOM_MEMBERS + 1; i++) {
		const user = await signup();
		assert.strictEqual((await api('i/update', { chatScope: 'everyone' }, user)).status, 200);
		assert.strictEqual((await api('chat/rooms/invitations/create', { roomId, userId: user.id }, owner)).status, 200);
		if (i < MAX_ROOM_MEMBERS - 1) {
			assert.strictEqual((await api('chat/rooms/join', { roomId }, user)).status, 204);
		} else {
			invitees.push(user);
		}
	}

	const results = await Promise.all(invitees.map(user => api('chat/rooms/join', { roomId }, user)));
	assert.deepStrictEqual(results.map(result => result.status).sort(), [204, 400]);
	const members = await api('chat/rooms/members', { roomId, limit: 100 }, owner);
	assert.strictEqual(members.status, 200);
	assert.strictEqual(members.body.length, MAX_ROOM_MEMBERS);
}, 180_000);
