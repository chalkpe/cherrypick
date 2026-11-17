/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import DeclineUserEndpoint from '@/server/api/endpoints/admin/decline-user.js';

function fixture(user: Record<string, unknown>, moderator = false) {
	const target = { id: 'target', username: 'Target', host: null, isDeleted: false, approved: false, signupReason: 'reason', ...user };
	const usersRepository = { findOneBy: vi.fn().mockResolvedValue(target) };
	const userProfilesRepository = { findOneBy: vi.fn().mockResolvedValue({ email: 'target@example.com' }) };
	const usedUsernamesRepository = { delete: vi.fn().mockResolvedValue(undefined) };
	const moderationLogService = { log: vi.fn() };
	const emailService = { sendEmail: vi.fn() };
	const deleteAccountService = { deleteAccount: vi.fn().mockResolvedValue(undefined) };
	const roleService = { isModerator: vi.fn().mockResolvedValue(moderator) };
	const endpoint = new DeclineUserEndpoint(
		usersRepository as any, userProfilesRepository as any, usedUsernamesRepository as any,
		moderationLogService as any, emailService as any, deleteAccountService as any, roleService as any,
	);
	return { endpoint, deleteAccountService, usedUsernamesRepository, emailService, moderationLogService };
}

describe('admin/decline-user', () => {
	test('declines an account waiting for approval', async () => {
		const { endpoint, deleteAccountService, moderationLogService } = fixture({ signupReason: 'please let me in' });
		await endpoint.exec({ userId: 'target' }, { id: 'moderator' } as any, null, null);
		expect(deleteAccountService.deleteAccount).toHaveBeenCalledOnce();
		expect(moderationLogService.log).toHaveBeenCalledOnce();
	});

	test('declines an account whose signup reason is empty', async () => {
		const { endpoint, deleteAccountService } = fixture({ signupReason: '' });
		await endpoint.exec({ userId: 'target' }, { id: 'moderator' } as any, null, null);
		expect(deleteAccountService.deleteAccount).toHaveBeenCalledOnce();
	});

	test('rejects an account that did not go through the approval flow', async () => {
		const { endpoint, deleteAccountService, usedUsernamesRepository, emailService } = fixture({ signupReason: null });
		await expect(endpoint.exec({ userId: 'target' }, { id: 'moderator' } as any, null, null)).rejects.toMatchObject({ code: 'NOT_APPROVAL_SIGNUP', httpStatusCode: 400 });
		expect(deleteAccountService.deleteAccount).not.toHaveBeenCalled();
		expect(usedUsernamesRepository.delete).not.toHaveBeenCalled();
		expect(emailService.sendEmail).not.toHaveBeenCalled();
	});

	test('rejects a moderator or administrator account', async () => {
		const { endpoint, deleteAccountService, usedUsernamesRepository } = fixture({ signupReason: 'reason' }, true);
		await expect(endpoint.exec({ userId: 'target' }, { id: 'moderator' } as any, null, null)).rejects.toMatchObject({ code: 'TARGET_IS_MODERATOR', httpStatusCode: 400 });
		expect(deleteAccountService.deleteAccount).not.toHaveBeenCalled();
		expect(usedUsernamesRepository.delete).not.toHaveBeenCalled();
	});
});
