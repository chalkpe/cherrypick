/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { ModuleRef } from '@nestjs/core';
import { In } from 'typeorm';
import type { UserListMembershipsRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import type { MiUserList } from '@/models/UserList.js';
import type { MiUserListMembership } from '@/models/UserListMembership.js';
import { IdService } from '@/core/IdService.js';
import type { GlobalEvents, UserListEventTypes } from '@/core/GlobalEventService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { DI } from '@/di-symbols.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { bindThis } from '@/decorators.js';
import { QueueService } from '@/core/QueueService.js';
import { MemoryKVCache } from '@/misc/cache.js';
import { RoleService } from '@/core/RoleService.js';
import { SystemAccountService } from '@/core/SystemAccountService.js';

const MEMBERS_CACHE_TTL = 30 * 60;
const MEMBERS_CACHE_RETRY_DELAY = 1000;
// 조회 중 무효화가 일어났으면 그 조회에서 읽은 멤버십을 Redis에 저장하지 않는다.
const STORE_MEMBERS_IF_CURRENT = `
	if redis.call('GET', KEYS[1]) == ARGV[1] then
		redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
		return 1
	end
	return 0
`;

function membersCacheKey(listId: string): string {
	return `kvcache:userListMembers:v2:${listId}`;
}

@Injectable()
export class UserListService implements OnApplicationShutdown, OnModuleInit {
	public static TooManyUsersError = class extends Error {};

	private readonly logger = new Logger(UserListService.name);
	private readonly membersCache = new MemoryKVCache<Set<string>>(60 * 1000);
	private readonly pendingMembers = new Map<string, Promise<Set<string>>>();
	private readonly membersCacheRetries = new Map<string, Promise<boolean>>();
	private readonly stopMembersCacheRetries = new AbortController();
	private roleService: RoleService;

	constructor(
		private moduleRef: ModuleRef,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		@Inject(DI.userListMembershipsRepository)
		private userListMembershipsRepository: UserListMembershipsRepository,

		private userEntityService: UserEntityService,
		private idService: IdService,
		private globalEventService: GlobalEventService,
		private queueService: QueueService,
		private systemAccountService: SystemAccountService,
	) {
		this.redisForSub.on('message', this.onMessage);
	}

	async onModuleInit() {
		this.roleService = this.moduleRef.get(RoleService.name);
	}

	@bindThis
	private onMessage(_: string, data: string): void {
		const obj = JSON.parse(data);

		if (obj.channel === 'internal') {
			const { type, body } = obj.message as GlobalEvents['internal']['payload'];
			switch (type) {
				case 'userListMemberAdded':
				case 'userListMemberRemoved': {
					this.invalidateLocalMembers(body.userListId);
					break;
				}
				default:
					break;
			}
		}
	}

	private invalidateLocalMembers(listId: string): void {
		this.membersCache.delete(listId);
		this.pendingMembers.delete(listId);
	}

	private async loadMembers(listId: string): Promise<{ members: Set<string>; cacheable: boolean }> {
		const key = membersCacheKey(listId);
		let cached = await this.redisClient.get(key);
		if (cached == null) {
			const generation = randomUUID();
			cached = await this.redisClient.set(key, generation, 'EX', MEMBERS_CACHE_TTL, 'NX') === 'OK'
				? generation
				: await this.redisClient.get(key);
		}
		if (cached?.startsWith('[')) {
			return { members: new Set<string>(JSON.parse(cached)), cacheable: true };
		}

		const rows = await this.userListMembershipsRepository.find({ where: { userListId: listId }, select: { userId: true } });
		const memberIds = rows.map(row => row.userId);
		const cacheable = cached != null && await this.redisClient.eval(
			STORE_MEMBERS_IF_CURRENT, 1, key, cached, JSON.stringify(memberIds), MEMBERS_CACHE_TTL,
		) === 1;
		return { members: new Set(memberIds), cacheable };
	}

	@bindThis
	public async isMember(listId: string, userId: string): Promise<boolean> {
		const cached = this.membersCache.get(listId);
		if (cached !== undefined) return cached.has(userId);
		let pending = this.pendingMembers.get(listId);
		if (pending == null) {
			const read = this.loadMembers(listId).then(({ members, cacheable }) => {
				if (cacheable && this.pendingMembers.get(listId) === read) this.membersCache.set(listId, members);
				return members;
			}).finally(() => {
				if (this.pendingMembers.get(listId) === read) this.pendingMembers.delete(listId);
			});
			this.pendingMembers.set(listId, read);
			pending = read;
		}
		return (await pending).has(userId);
	}

	private async deleteSharedMembers(listId: string): Promise<boolean> {
		try {
			await this.redisClient.del(membersCacheKey(listId));
			return true;
		} catch {
			return false;
		}
	}

	private async retrySharedMembersDeletion(listId: string): Promise<boolean> {
		const signal = this.stopMembersCacheRetries.signal;
		while (!signal.aborted) {
			try {
				await delay(MEMBERS_CACHE_RETRY_DELAY, undefined, { signal, ref: false });
			} catch (err) {
				if (signal.aborted) return false;
				throw err;
			}
			if (!signal.aborted && await this.deleteSharedMembers(listId)) return !signal.aborted;
		}
		return false;
	}

	private async publishMemberChange(listId: string, type: 'userAdded' | 'userRemoved', member: UserListEventTypes[typeof type] | { id: MiUser['id'] }, notifyClients = true): Promise<void> {
		const memberId = member.id;
		const publishInvalidation = () => {
			this.invalidateLocalMembers(listId);
			this.globalEventService.publishInternalEvent(type === 'userAdded' ? 'userListMemberAdded' : 'userListMemberRemoved', {
				userListId: listId,
				memberId,
			});
		};

		if (await this.deleteSharedMembers(listId)) {
			publishInvalidation();
		} else {
			this.invalidateLocalMembers(listId);
			let retry = this.membersCacheRetries.get(listId);
			if (retry == null) {
				this.logger.warn(`Retrying shared membership cache invalidation for list ${listId}`);
				retry = this.retrySharedMembersDeletion(listId).finally(() => this.membersCacheRetries.delete(listId));
				this.membersCacheRetries.set(listId, retry);
			}
			// Redis 삭제 뒤에 다른 프로세스가 장애 중에 읽은 값도 무효화한다.
			void retry.then(recovered => {
				if (recovered) publishInvalidation();
			});
		}
		if (notifyClients) {
			this.globalEventService.publishUserListStream(listId, type, member as UserListEventTypes[typeof type]);
		}
	}

	@bindThis
	public async addMember(target: MiUser, list: MiUserList, me: MiUser, options: { withReplies?: boolean } = {}) {
		const currentCount = await this.userListMembershipsRepository.countBy({
			userListId: list.id,
		});
		if (currentCount >= (await this.roleService.getUserPolicies(me.id)).userEachUserListsLimit) {
			throw new UserListService.TooManyUsersError();
		}

		const packed = await this.userEntityService.pack(target);
		await this.userListMembershipsRepository.insert({
			id: this.idService.gen(),
			userId: target.id,
			userListId: list.id,
			userListUserId: list.userId,
			withReplies: options.withReplies ?? false,
		} as MiUserListMembership);

		await this.publishMemberChange(list.id, 'userAdded', packed);
		this.globalEventService.publishUserListStream(list.id, 'internalMembershipUpdated', { userId: target.id });

		// このインスタンス内にこのリモートユーザーをフォローしているユーザーがいなくても投稿を受け取るためにダミーのユーザーがフォローしたということにする
		if (this.userEntityService.isRemoteUser(target)) {
			const proxy = await this.systemAccountService.fetch('proxy');
			this.queueService.createFollowJob([{ from: { id: proxy.id }, to: { id: target.id } }]);
		}
	}

	@bindThis
	public async removeMember(target: MiUser, list: MiUserList) {
		const membership = await this.userListMembershipsRepository.findOneBy({
			userId: target.id,
			userListId: list.id,
		});
		if (membership == null) return;
		const packed = await this.userEntityService.pack(target);
		const result = await this.userListMembershipsRepository.delete({ id: membership.id });
		if (!result.affected) return;

		await this.publishMemberChange(list.id, 'userRemoved', packed);
		this.globalEventService.publishUserListStream(list.id, 'internalMembershipUpdated', { userId: target.id });
	}

	@bindThis
	public async updateMembership(target: MiUser, list: MiUserList, options: { withReplies?: boolean }) {
		const membership = await this.userListMembershipsRepository.findOneBy({
			userId: target.id,
			userListId: list.id,
		});

		if (membership == null) {
			throw new Error('User is not a member of the list');
		}

		await this.userListMembershipsRepository.update({
			id: membership.id,
		}, {
			withReplies: options.withReplies,
		});

		this.globalEventService.publishUserListStream(list.id, 'internalMembershipUpdated', { userId: target.id });
	}

	@bindThis
	public async removeMemberFromAllLists(listOwner: { id: MiUser['id'] }, target: MiUser, options: { notifyClients?: boolean } = {}) {
		const removed = await this.userListMembershipsRepository.createQueryBuilder()
			.delete()
			.where({
				userId: target.id,
				userListUserId: listOwner.id,
			})
			.returning(['userListId'])
			.execute()
			.then(result => result.raw as Pick<MiUserListMembership, 'userListId'>[]);

		if (removed.length === 0) return;

		const packedTarget = (options.notifyClients ?? true) ? await this.userEntityService.pack(target) : null;
		for (const { userListId } of removed) {
			await this.publishMemberChange(userListId, 'userRemoved', packedTarget ?? { id: target.id }, packedTarget != null);
			this.globalEventService.publishUserListStream(userListId, 'internalMembershipUpdated', { userId: target.id });
		}
	}

	/**
	 * src が入っているリストに dst を追加する (アカウント移行用)
	 * - src はリストから外さない
	 * - リストのメンバー数の上限は確認しない
	 */
	@bindThis
	public async copyMemberships(src: { id: MiUser['id'] }, dst: MiUser) {
		// Return if there is no list to be updated.
		const oldMemberships = await this.userListMembershipsRepository.find({
			where: {
				userId: src.id,
			},
			select: { userListId: true, userListUserId: true },
		});
		if (oldMemberships.length === 0) return;

		const existingUserListIds = await this.userListMembershipsRepository.find({
			where: {
				userId: dst.id,
				userListId: In(oldMemberships.map(membership => membership.userListId)),
			},
			select: { userListId: true },
		}).then(memberships => new Set(memberships.map(membership => membership.userListId)));

		const newMemberships: Map<string, { userId: string; userListId: string; userListUserId: string; }> = new Map();

		// 重複しないようにIDを生成
		const genId = (): string => {
			let id: string;
			do {
				id = this.idService.gen();
			} while (newMemberships.has(id));
			return id;
		};
		for (const membership of oldMemberships) {
			if (existingUserListIds.has(membership.userListId)) continue; // skip if dst exists in this user's list
			newMemberships.set(genId(), {
				userId: dst.id,
				userListId: membership.userListId,
				userListUserId: membership.userListUserId,
			});
		}

		const arrayToInsert = Array.from(newMemberships.entries()).map(entry => ({ ...entry[1], id: entry[0] }));
		if (arrayToInsert.length > 0) {
			await this.userListMembershipsRepository.insert(arrayToInsert);

			for (const { userListId } of arrayToInsert) {
				this.globalEventService.publishInternalEvent('userListMemberAdded', { userListId, memberId: dst.id });
				this.globalEventService.publishUserListStream(userListId, 'internalMembershipUpdated', { userId: dst.id });
			}
		}

		// クライアントへの通知とプロキシのフォローは、一方が失敗しても他方を行う
		const results = await Promise.allSettled([
			(async () => {
				if (arrayToInsert.length === 0) return;
				const packedDst = await this.userEntityService.pack(dst);
				for (const { userListId } of arrayToInsert) {
					this.globalEventService.publishUserListStream(userListId, 'userAdded', packedDst);
				}
			})(),
			(async () => {
				// Have the proxy account follow the new account in the same way as addMember
				if (!this.userEntityService.isRemoteUser(dst)) return;
				const proxy = await this.systemAccountService.fetch('proxy');
				await this.queueService.createFollowJob([{ from: { id: proxy.id }, to: { id: dst.id } }]);
			})(),
		]);
		for (const result of results) {
			if (result.status === 'rejected') throw result.reason;
		}
	}

	@bindThis
	public dispose(): void {
		this.redisForSub.off('message', this.onMessage);
		this.stopMembersCacheRetries.abort();
		this.pendingMembers.clear();
		this.membersCache.dispose();
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
