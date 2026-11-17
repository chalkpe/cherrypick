/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import RevokeTokenEndpoint from '@/server/api/endpoints/i/revoke-token.js';

function fixture() {
	const accessTokensRepository = {
		findOneBy: vi.fn().mockResolvedValue({ id: 'token1', userId: 'me' }),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	const endpoint = new RevokeTokenEndpoint(accessTokensRepository as any);
	return { endpoint, accessTokensRepository };
}

describe('i/revoke-token', () => {
	test('revokes a token for a session request', async () => {
		const { endpoint, accessTokensRepository } = fixture();
		await endpoint.exec({ tokenId: 'token1' }, { id: 'me' } as any, null, null);
		expect(accessTokensRepository.delete).toHaveBeenCalledWith({ id: 'token1' });
	});

	test('rejects a request made with a Play token', async () => {
		const { endpoint, accessTokensRepository } = fixture();
		await expect(endpoint.exec({ tokenId: 'token1' }, { id: 'me' } as any, null, { permissions: [] } as any))
			.rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
		expect(accessTokensRepository.delete).not.toHaveBeenCalled();
	});
});
