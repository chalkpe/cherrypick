/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NoteReactionEntityService } from '@/core/entities/NoteReactionEntityService.js';
import { MiNoteReaction } from '@/models/NoteReaction.js';
import type { Packed } from '@/misc/json-schema.js';

function reaction(id: string, userId: string) {
	return Object.assign(new MiNoteReaction(), { id, userId, noteId: 'note', reaction: '👍' });
}

function fixture() {
	const users = new Map(['alice', 'bob'].map(id => [id, Object.freeze({
		id,
		name: null,
		username: id,
		host: null,
		avatarUrl: 'https://example.com/avatar.png',
		avatarBlurhash: null,
		avatarDecorations: [],
		isLocked: false,
		emojis: {},
		onlineStatus: 'unknown',
		approved: true,
	}) satisfies Packed<'UserLite'>]));
	const fetchMutings = vi.fn(async (viewerId: string) => new Set(viewerId === 'viewer' ? ['alice'] : []));
	const packUser = vi.fn(async (id: string) => users.get(id));
	const packUsers = vi.fn(async (ids: string[]) => ids.map(id => users.get(id)));
	const dependencies = new Map<string, unknown>([
		['UserEntityService', { pack: packUser, packMany: packUsers }],
		['NoteEntityService', {}],
		['ReactionService', { convertLegacyReaction: (value: string) => value }],
		['IdService', { parse: () => ({ date: new Date('2026-01-01T00:00:00Z') }) }],
		['CacheService', { userMutingsCache: { fetch: fetchMutings } }],
	]);
	const repository = { findOneByOrFail: vi.fn(async ({ id }: { id: string }) => reaction(id, 'alice')) };
	const service = new NoteReactionEntityService({ get: (token: string) => dependencies.get(token) } as never, repository as never);
	service.onModuleInit();
	return { service, users, fetchMutings, packUser, packUsers, repository };
}

describe('NoteReactionEntityService mute indicators', () => {
	test('packs a reaction loaded by ID with the viewer mute status and preserves the cached user', async () => {
		const f = fixture();
		const result = await f.service.pack('reaction', { id: 'viewer' });

		expect(result).toMatchObject({ id: 'reaction', type: '👍', user: { id: 'alice', isMuted: true } });
		expect(f.repository.findOneByOrFail).toHaveBeenCalledExactlyOnceWith({ id: 'reaction' });
		expect(f.fetchMutings).toHaveBeenCalledExactlyOnceWith('viewer');
		expect(result.user).not.toBe(f.users.get('alice'));
		expect(f.users.get('alice')).not.toHaveProperty('isMuted');
	});

	test('fetches mutings once per batch, including when the viewer has no muted users', async () => {
		const f = fixture();
		const reactions = [reaction('first', 'alice'), reaction('second', 'bob'), reaction('third', 'alice')];
		const result = await f.service.packMany(reactions, { id: 'viewer' });

		expect(result.map(item => item.user)).toMatchObject([
			{ id: 'alice', isMuted: true },
			{ id: 'bob', isMuted: false },
			{ id: 'alice', isMuted: true },
		]);
		expect(f.fetchMutings).toHaveBeenCalledExactlyOnceWith('viewer');
		expect(f.packUser).not.toHaveBeenCalled();
		expect(f.packUsers).toHaveBeenCalledExactlyOnceWith(['alice', 'bob', 'alice'], { id: 'viewer' });

		f.fetchMutings.mockClear();
		const unmuted = await f.service.packMany(reactions, { id: 'other-viewer' });
		expect(unmuted.map(item => item.user)).toMatchObject([
			{ isMuted: false }, { isMuted: false }, { isMuted: false },
		]);
		expect(f.fetchMutings).toHaveBeenCalledExactlyOnceWith('other-viewer');
	});

	test('does not leak an authenticated viewer mute status into anonymous results', async () => {
		const f = fixture();
		const reactions = [reaction('reaction', 'alice')];
		await f.service.packMany(reactions, { id: 'viewer' });
		f.fetchMutings.mockClear();

		const anonymousBatch = await f.service.packMany(reactions);
		const anonymousSingle = await f.service.pack(reactions[0], null);

		expect(anonymousBatch[0].user).not.toHaveProperty('isMuted');
		expect(anonymousSingle.user).not.toHaveProperty('isMuted');
		expect(f.fetchMutings).not.toHaveBeenCalled();
		expect(f.users.get('alice')).not.toHaveProperty('isMuted');
	});
});
