/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import InviteEndpoint, { meta } from '@/server/api/endpoints/users/groups/invite.js';

function fixture(blocked: boolean) {
	const userGroupsRepository = { findOneBy: vi.fn().mockResolvedValue({ id: 'group', userId: 'me' }) };
	const userGroupInvitationsRepository = {
		findOneBy: vi.fn().mockResolvedValue(null),
		insertOne: vi.fn().mockResolvedValue({ id: 'invitation' }),
	};
	const userGroupJoiningsRepository = { findOneBy: vi.fn().mockResolvedValue(null) };
	const notificationService = { createNotification: vi.fn() };
	const userBlockingService = { checkBlocked: vi.fn().mockResolvedValue(blocked) };
	const endpoint = new InviteEndpoint(
		userGroupsRepository as any, userGroupInvitationsRepository as any, userGroupJoiningsRepository as any,
		{ gen: () => 'id' } as any,
		{ getUser: vi.fn().mockResolvedValue({ id: 'target' }) } as any,
		notificationService as any,
		userBlockingService as any,
	);
	return { endpoint, userGroupInvitationsRepository, notificationService, userBlockingService };
}

describe('users/groups/invite', () => {
	test('invites a user who has not blocked the requester', async () => {
		const { endpoint, userGroupInvitationsRepository, notificationService } = fixture(false);
		await endpoint.exec({ groupId: 'group', userId: 'target' }, { id: 'me' } as any, null, null);
		expect(userGroupInvitationsRepository.insertOne).toHaveBeenCalledOnce();
		expect(notificationService.createNotification).toHaveBeenCalledOnce();
	});

	test('rejects an invitation to a user who blocked the requester', async () => {
		const { endpoint, userGroupInvitationsRepository, notificationService, userBlockingService } = fixture(true);
		await expect(endpoint.exec({ groupId: 'group', userId: 'target' }, { id: 'me' } as any, null, null)).rejects.toMatchObject({ code: 'YOU_HAVE_BEEN_BLOCKED' });
		expect(userBlockingService.checkBlocked).toHaveBeenCalledWith('target', 'me');
		expect(userGroupInvitationsRepository.insertOne).not.toHaveBeenCalled();
		expect(notificationService.createNotification).not.toHaveBeenCalled();
	});

	test('has a rate limit', () => {
		expect((meta as any).limit).toMatchObject({ duration: expect.any(Number), max: expect.any(Number) });
	});
});
