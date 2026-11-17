/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { UserBlockingService } from '@/core/UserBlockingService.js';

const owner = { id: 'owner', host: null };
const remote = { id: 'remote', host: 'remote.test' };

type Invitation = { roomId: string; userId: string };
const invitationId = 'invite';

function fixture(linkInvitationId: string | null) {
	const invitations: Invitation[] = [{ roomId: 'room', userId: remote.id }];
	const remove = vi.fn(async (where: { id?: string; userId?: string }) => {
		if (where.userId === remote.id || where.id === invitationId) invitations.splice(0);
	});
	const service = Object.assign(Object.create(UserBlockingService.prototype), {
		followRequestsRepository: { findOneBy: vi.fn(async () => null) },
		userListsRepository: { findBy: vi.fn(async () => []) },
		userFollowingService: { unfollow: vi.fn() },
		apRendererService: { renderBlock: vi.fn(), addContext: vi.fn() },
		queueService: { deliver: vi.fn() },
		chatRoomsRepository: { find: vi.fn(async ({ where }: { where: { ownerId: string } }) => where.ownerId === owner.id ? [{ id: 'room' }] : []) },
		chatRoomInvitationsRepository: { delete: remove },
		db: { transaction: async (fn: (manager: unknown) => Promise<void>) => await fn({ findOne: async () => ({ id: 'room' }), findOneBy: async () => invitations.length ? { id: invitationId } : null, delete: async (_entity: unknown, where: { id: string }) => await remove(where) }) },
		redisClient: { get: vi.fn(async () => linkInvitationId == null ? null : JSON.stringify({ invitationId: linkInvitationId })) },
		blockingsRepository: { insert: vi.fn() },
		idService: { gen: () => 'block' },
		cacheService: { userBlockingCache: { refresh: vi.fn() }, userBlockedCache: { refresh: vi.fn() } },
		globalEventService: { publishInternalEvent: vi.fn() },
		userEntityService: { isLocalUser: (user: typeof owner) => user.host == null, isRemoteUser: (user: typeof owner) => user.host != null },
	}) as UserBlockingService;
	return { service, invitations };
}

describe('blocking while a link join is in flight', () => {
	test('the invitee blocking the owner does not cancel that link join', async () => {
		const f = fixture(invitationId);

		await f.service.block(remote as never, owner as never);

		expect(f.invitations).toEqual([{ roomId: 'room', userId: remote.id }]);
	});

	test('an ordinary invitation is still cancelled by a block', async () => {
		const f = fixture(null);

		await f.service.block(remote as never, owner as never);

		expect(f.invitations).toEqual([]);
	});

	test('an older link join does not keep a newer ordinary invitation', async () => {
		const f = fixture('old-invitation');

		await f.service.block(remote as never, owner as never);

		expect(f.invitations).toEqual([]);
	});

	test('the owner blocking the invitee still cancels a link join', async () => {
		const f = fixture(invitationId);

		await f.service.block(owner as never, remote as never);

		expect(f.invitations).toEqual([]);
	});
});
