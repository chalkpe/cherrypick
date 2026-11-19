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
import type { RoleService } from '@/core/RoleService.js';
import GetAvatarDecorationsEndpoint from '@/server/api/endpoints/get-avatar-decorations.js';

describe('AvatarDecorationService', () => {
	const user = { id: 'user1', username: 'alice', host: 'remote.example' } as MiUser;

	let instance: Partial<MiInstance>;
	let decorations: Partial<MiAvatarDecoration>[];
	let send: ReturnType<typeof vi.fn>;
	let find: ReturnType<typeof vi.fn>;
	let onMessage: (channel: string, data: string) => Promise<void>;
	let updateUser: ReturnType<typeof vi.fn>;
	let updateDecoration: ReturnType<typeof vi.fn>;
	let publish: ReturnType<typeof vi.fn>;
	let service: AvatarDecorationService;

	function jsonResponse(body: unknown) {
		return { json: async () => body };
	}

	// What an instance serving the Misskey API answers for a user wearing one decoration
	function serveDecorations(name = 'Ears') {
		send.mockImplementation(async (url: string) => {
			if (url === 'https://remote.example/api/users/show') {
				return jsonResponse({ avatarDecorations: [{ id: 'remote1', url: 'https://remote.example/files/ears.png', angle: 0.1, flipH: true }] });
			}
			if (url === 'https://remote.example/api/get-avatar-decorations') {
				return jsonResponse([{ id: 'remote1', name, description: 'Cat ears', url: 'https://remote.example/files/ears.png' }]);
			}
			throw new Error(`unexpected request to ${url}`);
		});
	}

	beforeEach(() => {
		instance = { host: 'remote.example', softwareName: 'misskey', supportsAvatarDecorations: false };
		decorations = [];
		send = vi.fn();
		find = vi.fn(async () => decorations);
		updateUser = vi.fn().mockResolvedValue({ affected: 1 });
		updateDecoration = vi.fn(async (id: string, params: Partial<MiAvatarDecoration>) => {
			Object.assign(decorations.find(d => d.id === id)!, params);
		});
		publish = vi.fn();

		service = new AvatarDecorationService(
			{ mediaProxy: 'https://local.example/proxy' } as Config,
			{ on: (_event: string, listener: typeof onMessage) => { onMessage = listener; }, off: vi.fn() } as unknown as Redis.Redis,
			{
				find,
				update: updateDecoration,
				findOneByOrFail: async ({ id }: { id: string }) => decorations.find(d => d.id === id),
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
			{ publishInternalEvent: publish } as unknown as GlobalEventService,
			{ send } as unknown as HttpRequestService,
		);
	});

	test('the public endpoint reuses the local decoration cache until a change is published', async () => {
		find.mockResolvedValueOnce([{
			id: 'local1',
			name: 'Frame',
			description: '',
			url: 'https://local.example/frame.png',
			roleIdsThatCanBeUsedThisDecoration: ['public', 'private'],
		}]).mockResolvedValueOnce([]);
		const endpoint = new GetAvatarDecorationsEndpoint(service, {
			getRoles: async () => [{ id: 'public', isPublic: true }, { id: 'private', isPublic: false }],
		} as unknown as RoleService);

		const first = await endpoint.exec({}, null, null, null);
		const second = await endpoint.exec({}, null, null, null);

		expect(first[0].roleIdsThatCanBeUsedThisDecoration).toEqual(['public']);
		expect(second).toEqual(first);
		expect(find).toHaveBeenCalledTimes(1);

		await onMessage('', JSON.stringify({
			channel: 'internal',
			message: { type: 'avatarDecorationDeleted', body: { id: 'local1' } },
		}));

		expect(await endpoint.exec({}, null, null, null)).toEqual([]);
		expect(find).toHaveBeenCalledTimes(2);
	});

	test.each([false, true])('does not cache an in-flight list after a change (withRemote: %s)', async withRemote => {
		const read = Promise.withResolvers<Partial<MiAvatarDecoration>[]>();
		find.mockReturnValueOnce(read.promise);
		const pending = service.getAll(false, withRemote);

		await onMessage('', JSON.stringify({
			channel: 'internal',
			message: { type: 'avatarDecorationDeleted', body: { id: 'local1' } },
		}));
		read.resolve([{ id: 'local1' }]);
		await pending;

		expect(await service.getAll(false, withRemote)).toEqual([]);
		expect(find).toHaveBeenCalledTimes(2);
	});

	describe('group decorations', () => {
		test.each([
			{ id: 'a'.repeat(33), url: 'https://remote.example/frame.png', name: 'frame' },
			{ id: 'remote1', url: `https://remote.example/${'a'.repeat(1200)}.png`, name: 'frame' },
			{ id: 'remote1', url: 'http://remote.example/frame.png', name: 'frame' },
			{ id: 'remote1', url: 'https://%', name: 'frame' },
			{ id: 'remote1', url: 'https://user:password@remote.example/frame.png', name: 'frame' },
			{ id: 'remote1', url: 'https://remote.example/frame.png', name: 'frame', angle: Number.NaN },
			{ id: 'remote\u00001', url: 'https://remote.example/frame.png', name: 'frame' },
			{ id: 'remote\ud800', url: 'https://remote.example/frame.png', name: 'frame' },
			{ id: 'remote1', url: 'https://remote.example/frame\u0000.png', name: 'frame' },
			{ id: 'remote1', url: 'https://remote.example/frame\udc00.png', name: 'frame' },
			{ id: 'remote1', url: 'https://remote.example/frame.png', name: 'fra\u0000me' },
			{ id: 'remote1', url: 'https://remote.example/frame.png', name: 'fra\ud800me' },
		])('discards an invalid or unrepresentable remote decoration: %j', async value => {
			vi.stubEnv('NODE_ENV', 'production');
			try {
				const result = await service.resolveChatDecorations('remote.example', [value]);

				expect(result).toEqual([]);
				expect(decorations).toEqual([]);
			} finally {
				vi.unstubAllEnvs();
			}
		});

		test('registers against the owner host and proxies the URL without importing permissions', async () => {
			const url = 'https://cdn.example/frame.png';

			const result = await service.resolveChatDecorations('remote.example', [{ id: 'remote1', url, name: 'frame', roleIdsThatCanBeUsedThisDecoration: ['admin'] }]);

			expect(result).toMatchObject([{ id: 'local1', angle: 0, scale: 1 }]);
			expect(decorations[0]).toMatchObject({ host: 'remote.example', remoteId: 'remote1', rawUrl: url, description: '' });
			expect(new URL(decorations[0].url!).origin).toBe('https://local.example');
			expect(new URL(decorations[0].url!).searchParams.get('url')).toBe(url);
			expect(decorations[0]).not.toHaveProperty('roleIdsThatCanBeUsedThisDecoration');
		});
	});

	describe('remoteUserUpdate', () => {
		test.each([
			// Misskey and its forks serve the API without saying so
			['misskey', false],
			['cherrypick', false],
			['mastodon', true],
			['pleroma', true],
		])('applies the decorations of a user on %s (advertising avatar decorations: %s)', async (softwareName, supportsAvatarDecorations) => {
			instance = { ...instance, softwareName, supportsAvatarDecorations };
			serveDecorations();

			await service.remoteUserUpdate(user);

			expect(decorations).toEqual([expect.objectContaining({ id: 'local1', host: 'remote.example', remoteId: 'remote1', name: 'Ears' })]);
			expect(updateUser).toHaveBeenCalledWith({ id: 'user1', isDeleted: false }, {
				avatarDecorations: [expect.objectContaining({ id: 'local1', angle: 0.1, flipH: true })],
			});
		});

		test.each([
			['mastodon'],
			[null],
		])('does not ask %s that does not advertise avatar decorations', async (softwareName) => {
			instance = { ...instance, softwareName, supportsAvatarDecorations: false };
			serveDecorations();

			await service.remoteUserUpdate(user);

			expect(send).not.toHaveBeenCalled();
			expect(updateUser).not.toHaveBeenCalled();
		});

		test.each([
			['angle', 9],
			['angle', 'abc'],
			['scale', 1e9],
			['offsetX', -3],
			['opacity', 0],
			['opacity', '1'],
		])('discards a remote decoration whose %s is %j', async (key, value) => {
			send.mockImplementation(async (url: string) => {
				if (url === 'https://remote.example/api/users/show') {
					return jsonResponse({ avatarDecorations: [
						{ id: 'remote1', url: 'https://remote.example/files/ears.png', [key]: value },
						{ id: 'remote2', url: 'https://remote.example/files/tail.png', angle: 0.1 },
					] });
				}
				return jsonResponse([
					{ id: 'remote1', name: 'Ears', description: '', url: 'https://remote.example/files/ears.png' },
					{ id: 'remote2', name: 'Tail', description: '', url: 'https://remote.example/files/tail.png' },
				]);
			});

			await service.remoteUserUpdate(user);

			expect(updateUser).toHaveBeenCalledTimes(1);
			const saved = updateUser.mock.calls[0][1].avatarDecorations;
			expect(saved).toHaveLength(1);
			expect(saved[0]).toMatchObject({ angle: 0.1 });
			expect(decorations.map(d => d.remoteId)).toEqual(['remote2']);
		});

		test('stores at most 16 decorations of a remote user', async () => {
			const ids = Array.from({ length: 300 }, (_, i) => `remote${i}`);
			send.mockImplementation(async (url: string) => {
				if (url === 'https://remote.example/api/users/show') {
					return jsonResponse({ avatarDecorations: ids.map(id => ({ id, url: `https://remote.example/files/${id}.png` })) });
				}
				return jsonResponse(ids.map(id => ({ id, name: id, description: '' })));
			});

			await service.remoteUserUpdate(user);

			expect(decorations.map(d => d.remoteId)).toEqual(ids.slice(0, 16));
			expect(updateUser.mock.calls[0][1].avatarDecorations).toHaveLength(16);
		});

		test('discards remote decorations whose fields are malformed', async () => {
			const valid = { id: 'remote1', url: 'https://remote.example/files/ears.png' };
			send.mockImplementation(async (url: string) => {
				if (url === 'https://remote.example/api/users/show') {
					return jsonResponse({ avatarDecorations: [
						{ id: 'a'.repeat(33), url: 'https://remote.example/files/a.png' },
						{ id: 'remote3', url: 'http://remote.example/files/b.png' },
						{ id: 'remote4', url: 42 },
						{ id: 'remote5', url: 'https://remote.example/files/c.png', flipH: 'yes' },
						{ id: 'remote6', url: 'https://remote.example/files/d.png' },
						valid,
					] });
				}
				return jsonResponse([
					{ id: 'remote1', name: 'Ears', description: '' },
					{ id: 'remote6', name: 'n'.repeat(257), description: '' },
				]);
			});

			await service.remoteUserUpdate(user);

			expect(decorations.map(d => d.remoteId)).toEqual(['remote1']);
			expect(updateUser.mock.calls[0][1].avatarDecorations).toHaveLength(1);
		});

		test('treats a decoration list that is not an array as empty', async () => {
			send.mockResolvedValue(jsonResponse({ avatarDecorations: { length: 3 } }));

			await service.remoteUserUpdate(user);

			expect(decorations).toEqual([]);
			expect(updateUser).toHaveBeenCalledWith({ id: 'user1', isDeleted: false }, { avatarDecorations: [] });
		});

		test('leaves the user alone when an instance advertising avatar decorations fails to serve them', async () => {
			instance = { ...instance, softwareName: 'mastodon', supportsAvatarDecorations: true };
			send.mockRejectedValue(new Error('404 Not Found'));

			await expect(service.remoteUserUpdate(user)).resolves.toBeUndefined();

			expect(updateUser).not.toHaveBeenCalled();
		});
	});

	describe('remote user update', () => {
		test('stored values that did not change neither update the decoration nor publish an event', async () => {
			serveDecorations();
			await service.remoteUserUpdate(user);
			expect(publish).toHaveBeenCalledTimes(1);
			publish.mockClear();

			await service.remoteUserUpdate(user);

			expect(updateDecoration).not.toHaveBeenCalled();
			expect(publish).not.toHaveBeenCalled();
		});

		test('a changed name updates the stored decoration once', async () => {
			serveDecorations();
			await service.remoteUserUpdate(user);
			publish.mockClear();
			serveDecorations('Renamed ears');

			await service.remoteUserUpdate(user);

			expect(updateDecoration).toHaveBeenCalledTimes(1);
			expect(publish).toHaveBeenCalledTimes(1);
			expect(publish).toHaveBeenCalledWith('avatarDecorationUpdated', expect.objectContaining({ name: 'Renamed ears' }));
		});
	});

	describe('findUrlsByIds', () => {
		beforeEach(() => {
			decorations = [{ id: 'd1', url: 'https://local.example/1.png' }, { id: 'd2', url: 'https://local.example/2.png' }, { id: 'd3', url: 'https://local.example/3.png' }];
			find.mockImplementation(async (options: { where: { id: { value: string[] } } }) => decorations.filter(d => options.where.id.value.includes(d.id!)));
		});

		test('reads only the requested ids and keeps them, including ids that do not exist', async () => {
			const found = await service.findUrlsByIds(['d1', 'd2', 'nope']);

			expect([...found.keys()]).toEqual(['d1', 'd2']);
			await service.findUrlsByIds(['d1', 'd2', 'nope']);
			expect(find).toHaveBeenCalledTimes(1);
			expect(find.mock.calls[0][0].where.id.value).toEqual(['d1', 'd2', 'nope']);
		});

		test('an edit drops only the cache of that id', async () => {
			await service.findUrlsByIds(['d1', 'd2']);

			await service.update('d1', { url: 'https://local.example/1b.png' });
			const found = await service.findUrlsByIds(['d1', 'd2']);

			expect(find).toHaveBeenCalledTimes(2);
			expect(find.mock.calls[1][0].where.id.value).toEqual(['d1']);
			expect(found.get('d1')?.url).toBe('https://local.example/1b.png');
		});

		test.each(['avatarDecorationCreated', 'avatarDecorationUpdated', 'avatarDecorationDeleted'])('%s from another process drops only the cache of that id', async type => {
			await service.findUrlsByIds(['d1', 'd2']);

			await onMessage('', JSON.stringify({ channel: 'internal', message: { type, body: { id: 'd2' } } }));
			await service.findUrlsByIds(['d1', 'd2']);

			expect(find).toHaveBeenCalledTimes(2);
			expect(find.mock.calls[1][0].where.id.value).toEqual(['d2']);
		});
	});

	describe('getAll', () => {
		const local = { id: 'local1', host: null };
		const remote = { id: 'remote1', host: 'remote.example' };

		test('clearing the cache on request leaves the cache that includes remote decorations alone', async () => {
			decorations = [local, remote];
			await service.getAll(false, true);
			decorations = [local];

			await service.getAll(true);

			expect(await service.getAll(false, true)).toEqual([local, remote]);
		});

		test.each(['avatarDecorationCreated', 'avatarDecorationUpdated', 'avatarDecorationDeleted'])('%s reaches the cache that includes remote decorations', async type => {
			decorations = [local];
			await service.getAll(false, true);
			decorations = [{ ...local, url: 'https://local.example/changed.png' }];

			await onMessage('', JSON.stringify({ channel: 'internal', message: { type, body: {} } }));

			expect(await service.getAll(false, true)).toEqual(decorations);
		});

		test('lists only remote decorations without reusing the cache of all decorations', async () => {
			decorations = [local, remote];
			await service.getAll(false, true);
			find.mockImplementationOnce(async () => [remote]);

			expect(await service.getAll(true, false, true)).toEqual([remote]);
			expect(await service.getAll(false, true)).toEqual([local, remote]);
		});
	});
});
