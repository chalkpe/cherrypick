/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import type { IAdd, IRemove } from '@/core/activitypub/type.js';
import type { MiRemoteUser } from '@/models/User.js';

describe('concurrent remote room membership changes', () => {
	test('a newer removal wins when an older addition is paused after its ordering claim', async () => {
		const owner = { id: 'owner', host: 'remote.test', uri: 'https://remote.test/users/owner', isSuspended: false } as MiRemoteUser;
		const member = { id: 'member', host: 'member.test', uri: 'https://member.test/users/member', isSuspended: false } as MiRemoteUser;
		const room = { id: 'room', ownerId: owner.id, uri: 'https://remote.test/chat/rooms/room' };
		const rows: { id: string; roomId: string; userId: string }[] = [];
		let releaseAdd!: () => void;
		let signalAdd!: () => void;
		let signalRemove!: () => void;
		const addPaused = new Promise<void>(resolve => { signalAdd = resolve; });
		const removeQueued = new Promise<void>(resolve => { signalRemove = resolve; });
		const gate = new Promise<void>(resolve => { releaseAdd = resolve; });
		let lastChange = 0;
		const memberships = {
			findBy: async () => [...rows],
			findOneBy: async () => rows[0] ?? null,
			insertOne: async (row: { id: string; roomId: string; userId: string }) => {
				signalAdd();
				await gate;
				rows.push(row);
				return row;
			},
			delete: async ({ userId }: { userId: string }) => {
				const before = rows.length;
				for (let index = rows.length - 1; index >= 0; index--) if (rows[index].userId === userId) rows.splice(index, 1);
				return { affected: before - rows.length };
			},
		};
		const forget = vi.fn<(userId: string, roomId: string) => Promise<void>>(async () => {});
		const chatService = Object.assign(Object.create(ChatService.prototype), {
			chatRoomMembershipsRepository: memberships,
			chatRoomNotificationService: { forget },
			userEntityService: { isLocalUser: () => false },
			globalEventService: { publishChatRoomStream: vi.fn() },
			redisClient: { pipeline: () => {
				const pipeline = { del: () => pipeline, srem: () => pipeline, exec: async () => [] };
				return pipeline;
			} },
		}) as ChatService;
		let transactionQueue = Promise.resolve();
		let transactions = 0;
		const db = {
			transaction: async <T>(callback: (manager: unknown) => Promise<T>): Promise<T> => {
				const previous = transactionQueue;
				let release!: () => void;
				transactionQueue = new Promise<void>(resolve => { release = resolve; });
				if (++transactions === 2) signalRemove();
				await previous;
				try {
					return await callback({
						findOne: async () => room,
						findOneBy: async () => memberships.findOneBy(),
						countBy: async () => rows.length,
						insert: async (_entity: unknown, row: { id: string; roomId: string; userId: string }) => memberships.insertOne(row),
						delete: async (_entity: unknown, where: { userId: string }) => memberships.delete(where),
					});
				} finally {
					release();
				}
			},
		};
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			db,
			logger: { info: vi.fn(), warn: vi.fn() },
			chatRoomsRepository: { findOneBy: async () => room },
			usersRepository: { findOneBy: async () => owner },
			chatRoomMembershipsRepository: memberships,
			apDbResolverService: { getUserFromApId: async () => member },
			userEntityService: { isLocalUser: () => false },
			chatRosterService: {
				claimAdd: async (_roomId: string, _userId: string, at: Date, manager: unknown) => {
					if (manager == null) throw new Error('claim needs transaction');
					if (at.getTime() <= lastChange) return false;
					lastChange = at.getTime();
					return true;
				},
				claimRemove: async (_roomId: string, _userId: string, at: Date, manager: unknown) => {
					if (manager == null) throw new Error('claim needs transaction');
					if (at.getTime() < lastChange) return false;
					lastChange = at.getTime();
					return true;
				},
			},
			chatService,
			idService: { gen: () => 'membership' },
			globalEventService: { publishChatRoomStream: vi.fn() },
		}) as ApInboxService;
		const older = new Date(Date.now() - 2000).toISOString();
		const newer = new Date(Date.now() - 1000).toISOString();
		const add: IAdd = { type: 'Add', actor: owner.uri, object: member.uri, target: room.uri, published: older };
		const remove: IRemove = { type: 'Remove', actor: owner.uri, object: member.uri, target: room.uri, published: newer };

		const adding = inbox.performOneActivity(owner, add);
		await addPaused;
		const removing = inbox.performOneActivity(owner, remove);
		await removeQueued;
		releaseAdd();
		await Promise.all([adding, removing]);

		expect(rows).toEqual([]);
		expect(forget).toHaveBeenCalledWith(member.id, room.id);
	});

	test('an Add can be retried after its membership insertion fails', async () => {
		const owner = { id: 'owner', host: 'remote.test', uri: 'https://remote.test/users/owner', isSuspended: false } as MiRemoteUser;
		const member = { id: 'member', host: 'member.test', uri: 'https://member.test/users/member' };
		const room = { id: 'room', ownerId: owner.id, uri: 'https://remote.test/chat/rooms/room' };
		const rows: { id: string; roomId: string; userId: string }[] = [];
		let lastChange = 0;
		let failInsert = true;
		const db = {
			transaction: async <T>(callback: (manager: unknown) => Promise<T>): Promise<T> => {
				const previous = lastChange;
				try {
					return await callback({
						findOne: async () => room,
						countBy: async () => rows.length,
						findOneBy: async () => rows[0] ?? null,
						insert: async (_entity: unknown, row: { id: string; roomId: string; userId: string }) => {
							if (failInsert) { failInsert = false; throw new Error('storage unavailable'); }
							rows.push(row);
						},
					});
				} catch (error) {
					lastChange = previous;
					throw error;
				}
			},
		};
		const inbox = Object.assign(Object.create(ApInboxService.prototype), {
			db,
			chatRoomsRepository: { findOneBy: async () => room },
			chatRoomMembershipsRepository: { findBy: async () => [...rows] },
			apDbResolverService: { getUserFromApId: async () => member },
			userEntityService: { isLocalUser: () => false },
			chatRosterService: { claimAdd: async (_roomId: string, _userId: string, at: Date, manager: unknown) => {
				if (manager == null) throw new Error('claim needs transaction');
				if (at.getTime() <= lastChange) return false;
				lastChange = at.getTime();
				return true;
			} },
			idService: { gen: () => 'membership' },
			globalEventService: { publishChatRoomStream: vi.fn() },
		}) as ApInboxService;
		const activity: IAdd = { type: 'Add', actor: owner.uri, object: member.uri, target: room.uri, published: new Date().toISOString() };

		await expect(inbox.performOneActivity(owner, activity)).rejects.toThrow('storage unavailable');
		await expect(inbox.performOneActivity(owner, activity)).resolves.toBe('ok: chat room member added');
		expect(rows).toEqual([{ id: 'membership', roomId: room.id, userId: member.id }]);
	});
});
