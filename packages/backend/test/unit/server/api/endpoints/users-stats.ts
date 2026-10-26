/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mocked } from 'vitest';
import UsersStatsEndpoint, { meta } from '@/server/api/endpoints/users/stats.js';
import { ApiError } from '@/server/api/error.js';
import type { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import type { RoleService } from '@/core/RoleService.js';
import type { UsersRepository, NotesRepository, FollowingsRepository, DriveFilesRepository, NoteReactionsRepository, PageLikesRepository, NoteFavoritesRepository, PollVotesRepository } from '@/models/_.js';
import type { MiLocalUser, MiUser } from '@/models/User.js';

function queryBuilder(count: number) {
	const builder = {
		where: vi.fn(),
		andWhere: vi.fn(),
		innerJoin: vi.fn(),
		getCount: vi.fn(),
	};
	builder.where.mockReturnValue(builder);
	builder.andWhere.mockReturnValue(builder);
	builder.innerJoin.mockReturnValue(builder);
	builder.getCount.mockResolvedValue(count);
	return builder;
}

describe('users/stats endpoint', () => {
	const targetUser = { id: 'targetuser' } as MiUser;
	const self = { id: 'targetuser' } as MiLocalUser;
	const other = { id: 'otheruser' } as MiLocalUser;

	let usersRepository: Mocked<UsersRepository>;
	let notesRepository: Mocked<NotesRepository>;
	let followingsRepository: Mocked<FollowingsRepository>;
	let driveFilesRepository: Mocked<DriveFilesRepository>;
	let noteReactionsRepository: Mocked<NoteReactionsRepository>;
	let pageLikesRepository: Mocked<PageLikesRepository>;
	let noteFavoritesRepository: Mocked<NoteFavoritesRepository>;
	let pollVotesRepository: Mocked<PollVotesRepository>;
	let driveFileEntityService: Mocked<DriveFileEntityService>;
	let roleService: Mocked<RoleService>;
	let endpoint: UsersStatsEndpoint;

	beforeEach(() => {
		usersRepository = {
			findOneBy: vi.fn().mockResolvedValue(targetUser),
		} as unknown as Mocked<UsersRepository>;
		notesRepository = {
			createQueryBuilder: vi.fn(() => queryBuilder(5)),
		} as unknown as Mocked<NotesRepository>;
		followingsRepository = {
			createQueryBuilder: vi.fn(() => queryBuilder(5)),
		} as unknown as Mocked<FollowingsRepository>;
		driveFilesRepository = {
			createQueryBuilder: vi.fn(() => queryBuilder(5)),
		} as unknown as Mocked<DriveFilesRepository>;
		noteReactionsRepository = {
			createQueryBuilder: vi.fn(() => queryBuilder(5)),
		} as unknown as Mocked<NoteReactionsRepository>;
		pageLikesRepository = {
			createQueryBuilder: vi.fn(() => queryBuilder(5)),
		} as unknown as Mocked<PageLikesRepository>;
		noteFavoritesRepository = {
			createQueryBuilder: vi.fn(() => queryBuilder(5)),
		} as unknown as Mocked<NoteFavoritesRepository>;
		pollVotesRepository = {
			createQueryBuilder: vi.fn(() => queryBuilder(5)),
		} as unknown as Mocked<PollVotesRepository>;
		driveFileEntityService = {
			calcDriveUsageOf: vi.fn().mockResolvedValue(100),
		} as unknown as Mocked<DriveFileEntityService>;
		roleService = {
			isModerator: vi.fn().mockResolvedValue(false),
		} as unknown as Mocked<RoleService>;
		endpoint = new UsersStatsEndpoint(
			usersRepository,
			notesRepository,
			followingsRepository,
			driveFilesRepository,
			noteReactionsRepository,
			pageLikesRepository,
			noteFavoritesRepository,
			pollVotesRepository,
			driveFileEntityService,
			roleService,
		);
	});

	test('requires credential and the read:account permission', () => {
		expect(meta.requireCredential).toBe(true);
		expect(meta.kind).toBe('read:account');
	});

	test('declares accessDenied as a permission error', () => {
		expect(new ApiError(meta.errors.accessDenied)).toMatchObject({
			code: 'ACCESS_DENIED',
			kind: 'permission',
		});
	});

	test('denies statistics of another user', async () => {
		await expect(endpoint.exec({ userId: targetUser.id }, other, null, null)).rejects.toMatchObject({
			code: 'ACCESS_DENIED',
			kind: 'permission',
		});
		expect(roleService.isModerator).toHaveBeenCalledWith(other);
		expect(notesRepository.createQueryBuilder).not.toHaveBeenCalled();
		expect(driveFileEntityService.calcDriveUsageOf).not.toHaveBeenCalled();
	});

	test('allows statistics of the authenticated user', async () => {
		await expect(endpoint.exec({ userId: targetUser.id }, self, null, null)).resolves.toMatchObject({
			notesCount: 5,
			followingCount: 10,
			followersCount: 10,
			driveUsage: 100,
		});
		expect(roleService.isModerator).not.toHaveBeenCalled();
	});

	test('allows moderators to view statistics of another user', async () => {
		roleService.isModerator.mockResolvedValue(true);

		await expect(endpoint.exec({ userId: targetUser.id }, other, null, null)).resolves.toMatchObject({
			notesCount: 5,
			followingCount: 10,
			followersCount: 10,
			driveUsage: 100,
		});
		expect(roleService.isModerator).toHaveBeenCalledWith(other);
	});

	test('returns noSuchUser for a missing user', async () => {
		usersRepository.findOneBy.mockResolvedValue(null);

		await expect(endpoint.exec({ userId: targetUser.id }, self, null, null)).rejects.toMatchObject({
			code: 'NO_SUCH_USER',
		});
	});

	test('returns noSuchUser to another user for a missing user without computing statistics', async () => {
		usersRepository.findOneBy.mockResolvedValue(null);

		await expect(endpoint.exec({ userId: targetUser.id }, other, null, null)).rejects.toMatchObject({
			code: 'NO_SUCH_USER',
		});
		expect(notesRepository.createQueryBuilder).not.toHaveBeenCalled();
		expect(followingsRepository.createQueryBuilder).not.toHaveBeenCalled();
		expect(driveFileEntityService.calcDriveUsageOf).not.toHaveBeenCalled();
	});

	test('does not query follower or following counts before denying another user', async () => {
		await expect(endpoint.exec({ userId: targetUser.id }, other, null, null)).rejects.toMatchObject({
			code: 'ACCESS_DENIED',
		});
		expect(followingsRepository.createQueryBuilder).not.toHaveBeenCalled();
		expect(pollVotesRepository.createQueryBuilder).not.toHaveBeenCalled();
		expect(noteReactionsRepository.createQueryBuilder).not.toHaveBeenCalled();
		expect(noteFavoritesRepository.createQueryBuilder).not.toHaveBeenCalled();
	});

	test('returns every declared statistics field for the authenticated user', async () => {
		const result = await endpoint.exec({ userId: targetUser.id }, self, null, null);

		expect(Object.keys(result as object).sort()).toEqual(Object.keys(meta.res.properties).sort());
	});
});
