/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Redis from 'ioredis';
import type { Config } from '@/config.js';
import type { AvatarDecorationsRepository, InstancesRepository, MiAvatarDecoration, MiInstance, MiUser, UsersRepository } from '@/models/_.js';
import type { IdService } from '@/core/IdService.js';
import type { ModerationLogService } from '@/core/ModerationLogService.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import type { HttpRequestService } from '@/core/HttpRequestService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';

describe('AvatarDecorationService', () => {
	const user = { id: 'user1', username: 'alice', host: 'remote.example' } as MiUser;

	let instance: Partial<MiInstance>;
	let decorations: Partial<MiAvatarDecoration>[];
	let send: ReturnType<typeof vi.fn>;
	let updateUser: ReturnType<typeof vi.fn>;
	let service: AvatarDecorationService;

	function jsonResponse(body: unknown) {
		return { json: async () => body };
	}

	// What an instance serving the Misskey API answers for a user wearing one decoration
	function serveDecorations() {
		send.mockImplementation(async (url: string) => {
			if (url === 'https://remote.example/api/users/show') {
				return jsonResponse({ avatarDecorations: [{ id: 'remote1', url: 'https://remote.example/files/ears.png', angle: 0.1, flipH: true }] });
			}
			if (url === 'https://remote.example/api/get-avatar-decorations') {
				return jsonResponse([{ id: 'remote1', name: 'Ears', description: 'Cat ears', url: 'https://remote.example/files/ears.png' }]);
			}
			throw new Error(`unexpected request to ${url}`);
		});
	}

	beforeEach(() => {
		instance = { host: 'remote.example', softwareName: 'misskey', nodeinfoVersion: '2.1' };
		decorations = [];
		send = vi.fn();
		updateUser = vi.fn().mockResolvedValue({ affected: 1 });

		service = new AvatarDecorationService(
			{ mediaProxy: 'https://local.example/proxy' } as Config,
			{ on: vi.fn(), off: vi.fn() } as unknown as Redis.Redis,
			{
				findOneBy: async (where: Partial<MiAvatarDecoration>) => decorations.find(d => d.host === where.host && d.remoteId === where.remoteId) ?? null,
				insertOne: async (decoration: Partial<MiAvatarDecoration>) => {
					decorations.push(decoration);
					return decoration;
				},
			} as unknown as AvatarDecorationsRepository,
			{ findOneBy: async () => instance } as unknown as InstancesRepository,
			{ update: updateUser } as unknown as UsersRepository,
			{ gen: () => 'local1' } as unknown as IdService,
			{ log: vi.fn() } as unknown as ModerationLogService,
			{ publishInternalEvent: vi.fn() } as unknown as GlobalEventService,
			{ send } as unknown as HttpRequestService,
		);
	});

	describe('remoteUserUpdate', () => {
		test.each([
			['misskey', '2.1'],
			['cherrypick', '2.0'],
			// Mastodon itself only provides NodeInfo 2.0, so this is a compatible server or a fork that may serve the Misskey API
			['mastodon', '2.1'],
		])('applies the decorations of a user on %s providing NodeInfo %s', async (softwareName, nodeinfoVersion) => {
			instance = { ...instance, softwareName, nodeinfoVersion };
			serveDecorations();

			await service.remoteUserUpdate(user);

			expect(decorations).toEqual([expect.objectContaining({ id: 'local1', host: 'remote.example', remoteId: 'remote1', name: 'Ears' })]);
			expect(updateUser).toHaveBeenCalledWith({ id: 'user1', isDeleted: false }, {
				avatarDecorations: [expect.objectContaining({ id: 'local1', angle: 0.1, flipH: true })],
			});
		});

		test.each([
			['mastodon', '2.0'],
			['mastodon', null],
			['pleroma', '2.1'],
		])('does not ask %s providing NodeInfo %s', async (softwareName, nodeinfoVersion) => {
			instance = { ...instance, softwareName, nodeinfoVersion };
			serveDecorations();

			await service.remoteUserUpdate(user);

			expect(send).not.toHaveBeenCalled();
			expect(updateUser).not.toHaveBeenCalled();
		});

		test('leaves the user alone when a Mastodon providing NodeInfo 2.1 does not serve the Misskey API', async () => {
			instance = { ...instance, softwareName: 'mastodon', nodeinfoVersion: '2.1' };
			send.mockRejectedValue(new Error('404 Not Found'));

			await expect(service.remoteUserUpdate(user)).resolves.toBeUndefined();

			expect(updateUser).not.toHaveBeenCalled();
		});
	});
});
