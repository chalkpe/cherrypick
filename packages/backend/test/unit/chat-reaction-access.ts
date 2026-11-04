/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';

describe('a reaction from a user of this server', () => {
	function createService(blockedPairs: [string, string][], message: object) {
		const execute = vi.fn().mockResolvedValue({ affected: 1 });
		const checkBlocked = vi.fn(async (blocker: string, blockee: string) => blockedPairs.some(pair => pair[0] === blocker && pair[1] === blockee));
		const builder = { update() { return this; }, set() { return this; }, where() { return this; }, andWhere() { return this; }, setParameter() { return this; }, execute };
		const service = Object.assign(Object.create(ChatService.prototype), {
			chatMessagesRepository: { findOneBy: vi.fn().mockResolvedValue(message), createQueryBuilder: () => builder },
			chatRoomsRepository: { findOneBy: vi.fn().mockResolvedValue({ id: 'r1', isArchived: false, ownerId: 'bob' }) },
			chatRoomMembershipsRepository: { findOneBy: vi.fn().mockResolvedValue({ id: 'membership' }), findBy: vi.fn().mockResolvedValue([]) },
			userBlockingService: { checkBlocked },
			globalEventService: { publishChatUserStream: vi.fn(), publishChatRoomStream: vi.fn() },
			userEntityService: { pack: vi.fn().mockResolvedValue({ id: 'bob' }), isRemoteUser: () => false },
			usersRepository: { findOneByOrFail: vi.fn().mockResolvedValue({ id: 'bob', host: null }), findBy: vi.fn().mockResolvedValue([]) },
		}) as ChatService;
		return { service, execute, checkBlocked };
	}

	const direct = { id: 'm1', fromUserId: 'alice', toUserId: 'bob', toRoomId: null, deletedAt: null, reactions: [] };
	const inRoom = { id: 'm1', fromUserId: 'alice', toUserId: null, toRoomId: 'r1', deletedAt: null, reactions: [] };

	test('is refused on a direct message from someone who blocks them', async () => {
		const f = createService([['alice', 'bob']], direct);

		await expect(f.service.react('m1', 'bob', '👍')).rejects.toThrow('blocked');

		expect(f.execute).not.toHaveBeenCalled();
	});

	test('is not refused for a block the other way round', async () => {
		const f = createService([['bob', 'alice']], direct);

		await f.service.react('m1', 'bob', '👍');

		expect(f.execute).toHaveBeenCalledOnce();
	});

	test('is applied on a direct message without a block', async () => {
		const f = createService([], direct);

		await f.service.react('m1', 'bob', '👍');

		expect(f.execute).toHaveBeenCalledOnce();
	});

	test('in a room follows membership, as sending a message there does', async () => {
		const f = createService([['alice', 'bob']], inRoom);

		await f.service.react('m1', 'bob', '👍');

		expect(f.execute).toHaveBeenCalledOnce();
	});
});

describe('deferred reactions when the message arrives', () => {
	function createService(actor: object) {
		const entries = [
			JSON.stringify({ actorId: 'carol', reaction: '👍', undo: false }),
			JSON.stringify({ actorId: 'carol', reaction: '👎', undo: true }),
		];
		const transaction = { lrange() { return this; }, del() { return this; }, exec: async () => [[null, entries], [null, 1]] };
		const service = Object.assign(Object.create(ChatService.prototype), {
			redisClient: { multi: () => transaction },
			usersRepository: { findOneBy: vi.fn().mockResolvedValue(actor) },
		}) as ChatService;
		// These are getters on the prototype, which Object.assign cannot replace.
		Object.defineProperty(service, 'reactRemote', { value: vi.fn() });
		Object.defineProperty(service, 'unreactRemote', { value: vi.fn() });
		return service;
	}

	const message = { id: 'm1', uri: 'https://remote.test/chat/messages/m1' } as never;

	test('are applied for an active account', async () => {
		const service = createService({ id: 'carol', host: 'other.test', isSuspended: false });

		await service.applyPendingChatReactions(message);

		expect(service.reactRemote).toHaveBeenCalledOnce();
		expect(service.unreactRemote).toHaveBeenCalledOnce();
	});

	test('are dropped for an account suspended since they were stored', async () => {
		const service = createService({ id: 'carol', host: 'other.test', isSuspended: true });

		await service.applyPendingChatReactions(message);

		expect(service.reactRemote).not.toHaveBeenCalled();
		expect(service.unreactRemote).not.toHaveBeenCalled();
	});
});
