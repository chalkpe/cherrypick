/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';

describe('ApDbResolverService.getAuthUserFromApId', () => {
	test('returns null for a deleted remote user', async () => {
		const user = { id: 'remote1', host: 'remote.example', isDeleted: true };
		const service = new ApDbResolverService(
			{ host: 'local.example' } as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{ resolvePerson: async () => user } as any,
			{} as any,
		);

		const result = await service.getAuthUserFromApId('https://remote.example/users/remote1');

		expect(result).toBeNull();
	});
});
