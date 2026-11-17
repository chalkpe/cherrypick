/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import UpdateEndpoint from '@/server/api/endpoints/notes/update.js';

type Visibility = 'public' | 'home' | 'followers' | 'specified';

function fixture(current: Visibility) {
	const note = { id: 'note', userId: 'author', visibility: current, channelId: null };
	const roleService = {
		isModerator: vi.fn().mockResolvedValue(true),
		isAdministrator: vi.fn().mockResolvedValue(false),
		getUserPolicies: vi.fn().mockResolvedValue({ canEditNote: true }),
	};
	const service = { updateVisibility: vi.fn().mockResolvedValue(note) };
	const endpoint = new UpdateEndpoint(
		{} as any, { getNote: vi.fn().mockResolvedValue(note) } as any,
		roleService as any, { pack: vi.fn().mockResolvedValue(note) } as any, service as any,
	);
	return { endpoint, service };
}

const call = (endpoint: UpdateEndpoint, visibility: Visibility) =>
	endpoint.exec({ noteId: 'note', visibility }, { id: 'moderator' } as any, null, null);

describe('notes/update moderator visibility change', () => {
	test.each([
		['public', 'home'], ['public', 'followers'], ['public', 'specified'],
		['home', 'followers'], ['home', 'specified'], ['followers', 'specified'],
		['public', 'public'], ['specified', 'specified'],
	] as const)('allows narrowing from %s to %s', async (current, next) => {
		const { endpoint, service } = fixture(current);
		await call(endpoint, next);
		expect(service.updateVisibility).toHaveBeenCalledOnce();
	});

	test.each([
		['home', 'public'], ['followers', 'public'], ['specified', 'public'],
		['followers', 'home'], ['specified', 'home'], ['specified', 'followers'],
	] as const)('rejects widening from %s to %s', async (current, next) => {
		const { endpoint, service } = fixture(current);
		await expect(call(endpoint, next)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		expect(service.updateVisibility).not.toHaveBeenCalled();
	});
});
