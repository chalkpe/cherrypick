/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { DeleteAccountService } from '@/core/DeleteAccountService.js';

test('an account is not marked deleted if its deletion job cannot be queued', async () => {
	const update = vi.fn();
	const service = Object.assign(Object.create(DeleteAccountService.prototype), {
		meta: { rootUserId: 'root' },
		usersRepository: { findOneByOrFail: async () => ({ id: 'owner', username: 'owner' }), update },
		userEntityService: { isLocalUser: () => true },
		queueService: { createDeleteAccountJob: vi.fn().mockRejectedValue(new Error('queue refused')) },
		globalEventService: { publishInternalEvent: vi.fn() },
	}) as DeleteAccountService;

	await expect(service.deleteAccount({ id: 'owner', host: null })).rejects.toThrow('queue refused');

	expect(update).not.toHaveBeenCalled();
});

test('a partial failure to queue the account Delete fails the job', async () => {
	const deliver = vi.fn((_user: unknown, _content: unknown, inbox: string) => inbox === 'https://one.test/inbox'
		? Promise.resolve({ id: 'queued' })
		: Promise.reject(new Error('queue refused')));
	const service = Object.assign(Object.create(DeleteAccountService.prototype), {
		userEntityService: { genLocalUserUri: () => 'https://local.test/users/owner' },
		apRendererService: { renderDelete: () => ({ type: 'Delete' }), addContext: (activity: unknown) => activity },
		followingsRepository: { find: async () => [
			{ followerSharedInbox: 'https://one.test/inbox', followeeSharedInbox: null },
			{ followerSharedInbox: 'https://two.test/inbox', followeeSharedInbox: null },
		] },
		queueService: { deliver },
	}) as DeleteAccountService;

	await expect(service.queueAccountDelete({ id: 'owner', host: null })).rejects.toThrow();

	expect(deliver).toHaveBeenCalledTimes(2);
});
