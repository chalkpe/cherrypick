/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import UserTranslateEndpoint from '@/server/api/endpoints/users/translate.js';

const NO_SUCH_USER_ID = '15348ddd-432d-49c2-8a5a-8069753becff';

function fixture(opts: { user?: Record<string, unknown> | null; moderator?: boolean } = {}) {
	const { user = { id: 'target', isSuspended: false, isDeleted: false }, moderator = false } = opts;
	const noSuchUser = () => Object.assign(new Error('No such user.'), { id: NO_SUCH_USER_ID });
	const getterService = {
		getUser: vi.fn().mockImplementation(async () => {
			if (user == null) throw noSuchUser();
			return user;
		}),
		getUserProfiles: vi.fn().mockImplementation(async () => {
			if (user == null) throw noSuchUser();
			return { userId: 'target', description: 'hello' };
		}),
	};
	const send = vi.fn().mockResolvedValue({ json: async () => ({ translations: [{ text: 'x', detected_source_language: 'EN' }] }) });
	const roleService = {
		getUserPolicies: vi.fn().mockResolvedValue({ canUseTranslator: true }),
		isModerator: vi.fn().mockResolvedValue(moderator),
	};
	const endpoint = new UserTranslateEndpoint(
		{ translatorType: 'deepl', deeplAuthKey: 'key', deeplIsPro: false } as any,
		getterService as any,
		{ send } as any,
		roleService as any,
	);
	return { endpoint, send };
}

const call = (endpoint: UserTranslateEndpoint) => endpoint.exec({ userId: 'target', targetLang: 'ko' }, { id: 'me' } as any, null, null);

describe('users/translate', () => {
	test('translates the description of an active user', async () => {
		const { endpoint, send } = fixture();
		await expect(call(endpoint)).resolves.toMatchObject({ text: 'x' });
		expect(send).toHaveBeenCalled();
	});

	test('does not return the description of a suspended user to a non-moderator', async () => {
		const { endpoint, send } = fixture({ user: { id: 'target', isSuspended: true, isDeleted: false } });
		await expect(call(endpoint)).rejects.toMatchObject({ code: 'NO_SUCH_DESCRIPTION' });
		expect(send).not.toHaveBeenCalled();
	});

	test('returns the description of a suspended user to a moderator', async () => {
		const { endpoint } = fixture({ user: { id: 'target', isSuspended: true, isDeleted: false }, moderator: true });
		await expect(call(endpoint)).resolves.toMatchObject({ text: 'x' });
	});

	test('does not return the description of a deleted user', async () => {
		const { endpoint, send } = fixture({ user: { id: 'target', isSuspended: false, isDeleted: true }, moderator: true });
		await expect(call(endpoint)).rejects.toMatchObject({ code: 'NO_SUCH_DESCRIPTION' });
		expect(send).not.toHaveBeenCalled();
	});

	test('reports a missing user as no such description', async () => {
		const { endpoint } = fixture({ user: null });
		await expect(call(endpoint)).rejects.toMatchObject({ code: 'NO_SUCH_DESCRIPTION' });
	});
});
