/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { MiUserPublickey } from '@/models/UserPublickey.js';

const user = { id: 'remote1', host: 'remote.example', isDeleted: false };
const actorUri = 'https://remote.example/users/remote1';
const oldKey = { userId: user.id, keyId: `${actorUri}#main-key`, keyPem: 'old key' };

function createFixture(actor = user) {
	const findOneBy = vi.fn();
	const release = vi.fn();
	const createQueryRunner = vi.fn(() => ({ manager: { findOneBy }, release }));
	const service = new ApDbResolverService(
		{ host: 'local.example' } as any,
		{} as any,
		{} as any,
		{ createQueryRunner } as any,
		{ findUserById: async (id: string) => ({ ...user, id }) } as any,
		{ resolvePerson: async () => actor } as any,
		{} as any,
	);
	return { service, createQueryRunner, findOneBy, release };
}

describe('ApDbResolverService', () => {
	test('returns null for a deleted remote user', async () => {
		const { service, createQueryRunner } = createFixture({ ...user, isDeleted: true });

		expect(await service.getAuthUserFromApId(actorUri)).toBeNull();
		expect(createQueryRunner).not.toHaveBeenCalled();
	});

	test('reads a replacement PEM by key ID and actor ID without a notification', async () => {
		const { service, createQueryRunner, findOneBy, release } = createFixture();
		findOneBy.mockResolvedValue(oldKey);
		expect((await service.getAuthUserFromKeyId(oldKey.keyId))?.key).toEqual(oldKey);
		expect((await service.getAuthUserFromApId(actorUri))?.key).toEqual(oldKey);
		createQueryRunner.mockClear();
		findOneBy.mockClear();
		release.mockClear();

		const replacement = { ...oldKey, keyPem: 'new key' };
		findOneBy.mockResolvedValue(replacement);

		expect((await service.getAuthUserFromKeyId(oldKey.keyId))?.key).toEqual(replacement);
		expect((await service.getAuthUserFromApId(actorUri))?.key).toEqual(replacement);
		expect(createQueryRunner.mock.calls).toEqual([['master'], ['master']]);
		expect(findOneBy.mock.calls).toEqual([
			[MiUserPublickey, { keyId: oldKey.keyId }],
			[MiUserPublickey, { userId: user.id }],
		]);
		expect(release).toHaveBeenCalledTimes(2);
	});

	test('releases the primary connection if a key lookup fails', async () => {
		const { service, findOneBy, release } = createFixture();
		const error = new Error('key lookup failed');
		findOneBy.mockRejectedValue(error);

		await expect(service.getAuthUserFromKeyId(oldKey.keyId)).rejects.toBe(error);

		expect(release).toHaveBeenCalledOnce();
	});
});
