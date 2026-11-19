/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type { MiUser, MiUserList, MiUserListMembership, UserListMembershipsRepository } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { IdService } from '@/core/IdService.js';
import type { QueueService } from '@/core/QueueService.js';
import type { RoleService } from '@/core/RoleService.js';
import type { SystemAccountService } from '@/core/SystemAccountService.js';
import { loadConfig } from '@/config.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { UserListService } from '@/core/UserListService.js';

describe('UserListService membership changes', () => {
	const config = loadConfig();
	const target = mock<MiUser>({ id: 'member', host: null });
	let list: MiUserList;
	let row: MiUserListMembership | null;
	let redis: Redis;
	let subscriber: Redis;
	let writer: UserListService;
	let reader: UserListService;
	let services: UserListService[];
	const repository = mock<UserListMembershipsRepository>();
	const userEntityService = mock<UserEntityService>();
	const events = mock<GlobalEventService>();
	const queue = mock<QueueService>();
	const systemAccounts = mock<SystemAccountService>();
	const roles = mock<RoleService>();

	function service() {
		const moduleRef = mock<ModuleRef>();
		moduleRef.get.mockReturnValue(roles);
		const instance = new UserListService(
			moduleRef, redis, subscriber, repository, userEntityService,
			mock<IdService>(), events, queue, systemAccounts,
		);
		void instance.onModuleInit();
		services.push(instance);
		return instance;
	}

	async function removeAndWaitForEvent() {
		const event = Promise.withResolvers<void>();
		subscriber.once('message', () => event.resolve());
		await writer.removeMember(target, list);
		await event.promise;
	}

	beforeEach(async () => {
		list = mock<MiUserList>({ id: randomUUID() });
		row = mock<MiUserListMembership>({ id: 'membership', userId: target.id });
		services = [];
		redis = new Redis(config.redis);
		subscriber = new Redis(config.redisForPubsub);
		await subscriber.subscribe(config.host);
		const globalEvents = new GlobalEventService(config, redis);
		events.publishInternalEvent.mockImplementation(globalEvents.publishInternalEvent);
		repository.find.mockImplementation(async () => row == null ? [] : [row]);
		repository.findOneBy.mockImplementation(async () => row);
		repository.countBy.mockImplementation(async () => row == null ? 0 : 1);
		repository.insert.mockImplementation(async () => {
			row = mock<MiUserListMembership>({ id: 'membership', userId: target.id });
			return { identifiers: [], generatedMaps: [], raw: [] };
		});
		repository.delete.mockImplementation(async () => {
			const affected = row == null ? 0 : 1;
			row = null;
			return { affected, raw: [] };
		});
		userEntityService.pack.mockResolvedValue({ id: target.id } as Awaited<ReturnType<UserEntityService['pack']>>);
		userEntityService.isRemoteUser.mockImplementation(user => user.host != null);
		systemAccounts.fetch.mockResolvedValue(mock<MiLocalUser>({ id: 'proxy' }));
		roles.getUserPolicies.mockResolvedValue({ userEachUserListsLimit: 10 } as Awaited<ReturnType<RoleService['getUserPolicies']>>);
		writer = service();
		reader = service();
	});

	afterEach(async () => {
		for (const instance of services) instance.dispose();
		vi.restoreAllMocks();
		await redis.del(`kvcache:userListMembers:v2:${list.id}`);
		await Promise.all([redis.quit(), subscriber.quit()]);
		events.publishInternalEvent.mockReset();
		events.publishUserListStream.mockReset();
		repository.delete.mockReset();
		queue.createFollowJob.mockReset();
	});

	test('evicts the shared Redis value and other workers’ memory values after removal', async () => {
		expect(await writer.isMember(list.id, target.id)).toBe(true);
		expect(await reader.isMember(list.id, target.id)).toBe(true);
		await removeAndWaitForEvent();

		expect(await reader.isMember(list.id, target.id)).toBe(false);
		expect(await service().isMember(list.id, target.id)).toBe(false);
	});

	test('does not cache a membership snapshot that completes after a removal', async () => {
		const started = Promise.withResolvers<void>();
		const snapshot = Promise.withResolvers<MiUserListMembership[]>();
		const oldRow = row!;
		repository.find.mockImplementationOnce(() => {
			started.resolve();
			return snapshot.promise;
		});
		const pending = reader.isMember(list.id, target.id);
		await started.promise;
		await removeAndWaitForEvent();
		snapshot.resolve([oldRow]);
		await pending;

		expect(await service().isMember(list.id, target.id)).toBe(false);
		expect(await reader.isMember(list.id, target.id)).toBe(false);
	});

	test('allows retry after packing fails and emits a single removal for concurrent requests', async () => {
		userEntityService.pack.mockRejectedValueOnce(new Error('Could not pack user'));
		await expect(writer.removeMember(target, list)).rejects.toThrow('Could not pack user');
		expect(repository.delete).not.toHaveBeenCalled();

		await Promise.all([writer.removeMember(target, list), reader.removeMember(target, list)]);
		expect(events.publishInternalEvent).toHaveBeenCalledExactlyOnceWith('userListMemberRemoved', { userListId: list.id, memberId: target.id });
		expect(events.publishUserListStream).toHaveBeenCalledExactlyOnceWith(list.id, 'userRemoved', { id: target.id });
	});

	test('completes removal and evicts stale values after Redis recovers', async () => {
		const key = `kvcache:userListMembers:v2:${list.id}`;
		expect(await reader.isMember(list.id, target.id)).toBe(true);
		const deletion = vi.spyOn(redis, 'del')
			.mockRejectedValueOnce(new Error('Could not invalidate members'))
			.mockRejectedValueOnce(new Error('Redis is still unavailable'));

		await writer.removeMember(target, list);
		await writer.removeMember(target, list);

		expect(row).toBeNull();
		expect(await redis.get(key)).toBe(JSON.stringify([target.id]));
		expect(await service().isMember(list.id, target.id)).toBe(true);
		expect(events.publishUserListStream).toHaveBeenCalledExactlyOnceWith(list.id, 'userRemoved', { id: target.id });

		await vi.waitFor(async () => {
			expect(deletion).toHaveBeenCalledTimes(3);
			expect(await reader.isMember(list.id, target.id)).toBe(false);
		}, { timeout: 5000 });
		expect(await service().isMember(list.id, target.id)).toBe(false);
		expect(events.publishInternalEvent).toHaveBeenCalledExactlyOnceWith('userListMemberRemoved', { userListId: list.id, memberId: target.id });
	});

	test('queues the proxy follow for a committed remote addition when Redis cache deletion fails', async () => {
		row = null;
		const remote = mock<MiUser>({ id: target.id, host: 'example.test' });
		const deletion = vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('Could not invalidate members'));
		expect(await reader.isMember(list.id, remote.id)).toBe(false);

		await writer.addMember(remote, list, target);

		expect(row).not.toBeNull();
		expect(queue.createFollowJob).toHaveBeenCalledExactlyOnceWith([{ from: { id: 'proxy' }, to: { id: remote.id } }]);
		expect(events.publishUserListStream).toHaveBeenCalledExactlyOnceWith(list.id, 'userAdded', { id: remote.id });
		await vi.waitFor(async () => {
			expect(deletion).toHaveBeenCalledTimes(2);
			expect(await reader.isMember(list.id, remote.id)).toBe(true);
		}, { timeout: 5000 });
		expect(events.publishInternalEvent).toHaveBeenCalledExactlyOnceWith('userListMemberAdded', { userListId: list.id, memberId: remote.id });
	});
});
