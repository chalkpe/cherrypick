/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, IsNull, In, MoreThan, Not } from 'typeorm';

import { bindThis } from '@/decorators.js';
import { DI } from '@/di-symbols.js';
import { MiUser } from '@/models/User.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import type { BlockingsRepository, FollowingsRepository, InstancesRepository, MiMeta, MutingsRepository, UserListMembershipsRepository, UsersRepository } from '@/models/_.js';
import type { RelationshipJobData, ThinUser } from '@/queue/types.js';

import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { QueueService } from '@/core/QueueService.js';
import { RelayService } from '@/core/RelayService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import PerUserFollowingChart from '@/core/chart/charts/per-user-following.js';
import { SystemAccountService } from '@/core/SystemAccountService.js';
import { RoleService } from '@/core/RoleService.js';
import { AntennaService } from '@/core/AntennaService.js';
import { ChatRoomBanService } from '@/core/ChatRoomBanService.js';
import type { VerifiedMove } from '@/core/ChatRoomBanService.js';

@Injectable()
export class AccountMoveService {
	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.blockingsRepository)
		private blockingsRepository: BlockingsRepository,

		@Inject(DI.mutingsRepository)
		private mutingsRepository: MutingsRepository,

		@Inject(DI.userListMembershipsRepository)
		private userListMembershipsRepository: UserListMembershipsRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private userEntityService: UserEntityService,
		private idService: IdService,
		private apPersonService: ApPersonService,
		private apRendererService: ApRendererService,
		private apDeliverManagerService: ApDeliverManagerService,
		private globalEventService: GlobalEventService,
		private perUserFollowingChart: PerUserFollowingChart,
		private federatedInstanceService: FederatedInstanceService,
		private instanceChart: InstanceChart,
		private relayService: RelayService,
		private queueService: QueueService,
		private systemAccountService: SystemAccountService,
		private roleService: RoleService,
		private antennaService: AntennaService,
		private chatRoomBanService: ChatRoomBanService,
	) {
	}

	/**
	 * Move a local account to a new account.
	 *
	 * After delivering Move activity, its local followers unfollow the old account and then follow the new one.
	 */
	@bindThis
	public async moveFromLocal(src: MiLocalUser, dst: MiLocalUser | MiRemoteUser): Promise<unknown> {
		const _srcUri = this.userEntityService.getUserUri(src);
		const dstUri = this.userEntityService.getUserUri(dst);

		// add movedToUri to indicate that the user has moved
		const update = {} as Partial<MiLocalUser>;
		update.alsoKnownAs = src.alsoKnownAs?.includes(dstUri) ? src.alsoKnownAs : src.alsoKnownAs?.concat([dstUri]) ?? [dstUri];
		update.movedToUri = dstUri;
		update.movedAt = new Date();
		// 이전 표시와 재참여 금지 승계를 함께 저장한다. 승계가 실패하면 이전도 확정되지 않아 같은 요청을 다시 보낼 수 있다.
		await this.usersRepository.manager.transaction(async manager => {
			await manager.update(MiUser, src.id, update);
			await this.chatRoomBanService.carryOnMove([{ src, dst }], manager);
		});
		Object.assign(src, update);

		// Update cache
		this.globalEventService.publishInternalEvent('localUserUpdated', src);

		const srcPerson = await this.apRendererService.renderPerson(src);
		const updateAct = this.apRendererService.addContext(this.apRendererService.renderUpdate(srcPerson, src));
		await this.apDeliverManagerService.deliverToFollowers(src, updateAct);
		this.relayService.deliverToRelays(src, updateAct);

		// Deliver Move activity to the followers of the old account
		const moveAct = this.apRendererService.addContext(this.apRendererService.renderMove(src, dst));
		await this.apDeliverManagerService.deliverToFollowers(src, moveAct);

		// Publish meUpdated event
		const iObj = await this.userEntityService.pack(src.id, src, { schema: 'MeDetailed', includeSecrets: true });
		this.globalEventService.publishMainStream(src.id, 'meUpdated', iObj);

		// Unfollow after 24 hours
		const followings = await this.followingsRepository.findBy({
			followerId: src.id,
		});
		this.queueService.createDelayedUnfollowJob(followings.map(following => ({
			from: { id: src.id },
			to: { id: following.followeeId },
		})), process.env.NODE_ENV === 'test' ? 10000 : 1000 * 60 * 60 * 24);

		await this.carryRelations(src, dst);

		return iObj;
	}

	/** 다른 서버에서 확인한 계정 이전의 후속 처리. */
	@bindThis
	public async postMoveProcess(src: MiRemoteUser, dst: MiLocalUser | MiRemoteUser, movePreventUris: string[] = []): Promise<void> {
		await this.carryRelations(src, dst);
		// 차단처럼 옛 계정이 내보내진 그룹의 재참여 금지도 새 계정에 잇는다. 저장 실패를 성공한 이전으로 숨기지 않고 호출자에게 전한다.
		await this.carryBans(src, dst, movePreventUris);
	}

	/**
	 * 확인된 원격 이전 하나의 재참여 금지만 잇는다. 팔로·차단 등 다른 관계는 옮기지 않으므로 같은 이전에 여러 번 불러도 된다.
	 *
	 * 옛 계정에 금지가 있으면 새 계정이 그 뒤로 이전한 사슬도 따라간다. 이 서버가 기록하지 않은 뒤쪽 이전
	 * (처음 보는 중간 계정이 이미 이전한 경우 등)은 원격 이전과 같은 확인을 거쳐 함께 기록해, 처리 순서와 관계없이 금지가 끝까지 닿게 한다.
	 * 네트워크 조회는 모두 승계 트랜잭션 전에 한다. 뒤쪽 확인이 실패해도 확인된 앞쪽 이전은 기록하고 오류를 호출자에게 전한다.
	 */
	@bindThis
	public async carryBans(src: MiRemoteUser, dst: MiLocalUser | MiRemoteUser, movePreventUris: string[] = []): Promise<void> {
		const moves: VerifiedMove[] = [{ src, dst }];
		let failure: unknown = null;
		if (await this.chatRoomBanService.hasBans(src.id)) {
			try {
				await this.collectLaterMoves(dst, [...movePreventUris, src.uri], moves);
			} catch (err) {
				failure = err;
			}
		}

		await this.chatRoomBanService.carryOnMove(moves);
		if (failure != null) throw failure;
	}

	/**
	 * 이 서버가 확인한 이전 가운데 아직 재참여 금지를 잇지 못한 것이 남았는지. 금지가 있는 옛 계정만 해당한다.
	 * 기록된 이전을 따라가며 기록되지 않은 다음 이전이 있는지 본다. 캐시나 복제본이 아니라 주 DB로 판단해 미완료 승계를 놓치지 않는다.
	 */
	@bindThis
	public async needsBanCarry(src: MiUser): Promise<boolean> {
		if (src.movedToUri == null) return false;
		if (!await this.chatRoomBanService.hasBans(src.id)) return false;

		const seen = new Set([src.id]);
		let current: MiUser | null = src;
		while (current?.movedToUri != null) {
			const next = await this.apPersonService.fetchPerson(current.movedToUri);
			if (next == null || !await this.chatRoomBanService.isMoveRecorded(current.id, next.id)) return true;
			if (seen.has(next.id)) return false;
			seen.add(next.id);
			current = await this.findOnPrimary(next.id);
		}
		return false;
	}

	/**
	 * from 뒤로 이어진 이전을 따라가며, 기록되지 않은 이전을 moves에 더한다.
	 * 기록된 이전은 승계 트랜잭션이 따라가므로 지나가기만 한다. 로컬 계정의 이전은 이 서버의 i/move가 확인한 것이므로 그대로 잇고,
	 * 원격 계정의 이전은 처음 처리할 때와 같은 확인(별칭·순환·대상·이전 횟수)을 통과해야 잇는다. 확인되지 않는 이전에서 멈춘다.
	 */
	private async collectLaterMoves(from: MiLocalUser | MiRemoteUser, preventUris: string[], moves: VerifiedMove[]): Promise<void> {
		const seen = new Set(moves.flatMap(move => [move.src.id, move.dst.id]));
		let current: MiLocalUser | MiRemoteUser = from;
		while (current.movedToUri != null) {
			const next = await this.apPersonService.fetchPerson(current.movedToUri);
			const recorded = next != null && await this.chatRoomBanService.isMoveRecorded(current.id, next.id);
			const dst = recorded || this.userEntityService.isLocalUser(current)
				? next
				: await this.apPersonService.resolveVerifiedMoveTarget(current as MiRemoteUser, preventUris);
			if (dst == null || typeof dst === 'string' || seen.has(dst.id)) return;
			if (!recorded) moves.push({ src: current, dst });

			seen.add(dst.id);
			preventUris.push(this.userEntityService.getUserUri(current));
			current = await this.findOnPrimary(dst.id) ?? dst;
		}
	}

	/** 이전 사슬의 다음 계정은 캐시나 복제본이 아닌 주 DB에서 읽어, 갓 기록된 이전 표시를 놓치지 않는다. */
	private async findOnPrimary(id: MiUser['id']): Promise<MiLocalUser | MiRemoteUser | null> {
		const runner = this.db.createQueryRunner('master');
		try {
			return await runner.manager.findOneBy(MiUser, { id, isDeleted: false }) as MiLocalUser | MiRemoteUser | null;
		} finally {
			await runner.release();
		}
	}

	@bindThis
	private async carryRelations(src: MiUser, dst: MiUser): Promise<void> {
		// Copy blockings and mutings, and update lists
		try {
			await Promise.all([
				this.copyBlocking(src, dst),
				this.copyMutings(src, dst),
				this.copyRoles(src, dst),
				this.updateLists(src, dst),
				this.antennaService.onMoveAccount(src, dst),
			]);
		} catch {
			/* skip if any error happens */
		}

		// follow the new account
		const proxy = await this.systemAccountService.fetch('proxy');
		const followings = await this.followingsRepository.findBy({
			followeeId: src.id,
			followerHost: IsNull(), // follower is local
			followerId: Not(proxy.id),
		});
		const followJobs = followings.map(following => ({
			from: { id: following.followerId },
			to: { id: dst.id },
		})) as RelationshipJobData[];

		// Decrease following count instead of unfollowing.
		try {
			await this.adjustFollowingCounts(followJobs.map(job => job.from.id), src);
		} catch {
			/* skip if any error happens */
		}

		// Should be queued because this can cause a number of follow per one move.
		this.queueService.createFollowJob(followJobs);
	}

	@bindThis
	public async copyBlocking(src: ThinUser, dst: ThinUser): Promise<void> {
		// Followers shouldn't overlap with blockers, but the destination account, different from the blockee (i.e., old account), may have followed the local user before moving.
		// So block the destination account here.
		const srcBlockings = await this.blockingsRepository.findBy({ blockeeId: src.id });
		const dstBlockings = await this.blockingsRepository.findBy({ blockeeId: dst.id });
		const blockerIds = dstBlockings.map(blocking => blocking.blockerId);
		// reblock the destination account
		const blockJobs: RelationshipJobData[] = [];
		for (const blocking of srcBlockings) {
			if (blockerIds.includes(blocking.blockerId)) continue; // skip if already blocked
			blockJobs.push({ from: { id: blocking.blockerId }, to: { id: dst.id } });
		}
		// no need to unblock the old account because it may be still functional
		this.queueService.createBlockJob(blockJobs);
	}

	@bindThis
	public async copyMutings(src: ThinUser, dst: ThinUser): Promise<void> {
		// Insert new mutings with the same values except mutee
		const oldMutings = await this.mutingsRepository.findBy([
			{ muteeId: src.id, expiresAt: IsNull() },
			{ muteeId: src.id, expiresAt: MoreThan(new Date()) },
		]);
		if (oldMutings.length === 0) return;

		// Check if the destination account is already indefinitely muted by the muter
		const existingMutingsMuterUserIds = await this.mutingsRepository.findBy(
			{ muteeId: dst.id, expiresAt: IsNull() },
		).then(mutings => mutings.map(muting => muting.muterId));

		const newMutings: Map<string, { muterId: string; muteeId: string; expiresAt: Date | null; }> = new Map();

		// 重複しないようにIDを生成
		const genId = (): string => {
			let id: string;
			do {
				id = this.idService.gen();
			} while (newMutings.has(id));
			return id;
		};
		for (const muting of oldMutings) {
			if (existingMutingsMuterUserIds.includes(muting.muterId)) continue; // skip if already muted indefinitely
			newMutings.set(genId(), {
				...muting,
				muteeId: dst.id,
			});
		}

		const arrayToInsert = Array.from(newMutings.entries()).map(entry => ({ ...entry[1], id: entry[0] }));
		await this.mutingsRepository.insert(arrayToInsert);
	}

	@bindThis
	public async copyRoles(src: ThinUser, dst: ThinUser): Promise<void> {
		// Insert new roles with the same values except userId
		// role service may have cache for roles so retrieve roles from service
		const [oldRoleAssignments, roles] = await Promise.all([
			this.roleService.getUserAssigns(src.id),
			this.roleService.getRoles(),
		]);

		if (oldRoleAssignments.length === 0) return;

		// No promise all since the only async operation is writing to the database
		for (const oldRoleAssignment of oldRoleAssignments) {
			const role = roles.find(x => x.id === oldRoleAssignment.roleId);
			if (role == null) continue; // Very unlikely however removing role may cause this case
			if (!role.preserveAssignmentOnMoveAccount) continue;

			try {
				await this.roleService.assign(dst.id, role.id, oldRoleAssignment.expiresAt);
			} catch (e) {
				if (e instanceof RoleService.AlreadyAssignedError) continue;
				throw e;
			}
		}
	}

	/**
	 * Update lists while moving accounts.
	 *   - No removal of the old account from the lists
	 *   - Users number limit is not checked
	 *
	 * @param src ThinUser (old account)
	 * @param dst User (new account)
	 * @returns Promise<void>
	 */
	@bindThis
	public async updateLists(src: ThinUser, dst: MiUser): Promise<void> {
		// Return if there is no list to be updated.
		const oldMemberships = await this.userListMembershipsRepository.find({
			where: {
				userId: src.id,
			},
		});
		if (oldMemberships.length === 0) return;

		const existingUserListIds = await this.userListMembershipsRepository.find({
			where: {
				userId: dst.id,
			},
		}).then(memberships => memberships.map(membership => membership.userListId));

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
			if (existingUserListIds.includes(membership.userListId)) continue; // skip if dst exists in this user's list
			newMemberships.set(genId(), {
				userId: dst.id,
				userListId: membership.userListId,
				userListUserId: membership.userListUserId,
			});
		}

		const arrayToInsert = Array.from(newMemberships.entries()).map(entry => ({ ...entry[1], id: entry[0] }));
		await this.userListMembershipsRepository.insert(arrayToInsert);

		// Have the proxy account follow the new account in the same way as UserListService.push
		if (this.userEntityService.isRemoteUser(dst)) {
			const proxy = await this.systemAccountService.fetch('proxy');
			this.queueService.createFollowJob([{ from: { id: proxy.id }, to: { id: dst.id } }]);
		}
	}

	@bindThis
	private async adjustFollowingCounts(localFollowerIds: string[], oldAccount: MiUser): Promise<void> {
		if (localFollowerIds.length === 0) return;

		// Set the old account's following and followers counts to 0.
		await this.usersRepository.update({ id: oldAccount.id }, { followersCount: 0, followingCount: 0 });

		// Decrease following counts of local followers by 1.
		await this.usersRepository.decrement({ id: In(localFollowerIds) }, 'followingCount', 1);

		// Decrease follower counts of local followees by 1.
		const oldFollowings = await this.followingsRepository.findBy({ followerId: oldAccount.id });
		if (oldFollowings.length > 0) {
			await this.usersRepository.decrement({ id: In(oldFollowings.map(following => following.followeeId)) }, 'followersCount', 1);
		}

		// Update instance stats by decreasing remote followers count by the number of local followers who were following the old account.
		if (this.meta.enableStatsForFederatedInstances) {
			if (this.userEntityService.isRemoteUser(oldAccount)) {
				this.federatedInstanceService.fetchOrRegister(oldAccount.host).then(async i => {
					this.instancesRepository.decrement({ id: i.id }, 'followersCount', localFollowerIds.length);
					if (this.meta.enableChartsForFederatedInstances) {
						this.instanceChart.updateFollowers(i.host, false);
					}
				});
			}
		}

		// FIXME: expensive?
		for (const followerId of localFollowerIds) {
			this.perUserFollowingChart.update({ id: followerId, host: null }, oldAccount, false);
		}
	}

	/**
	 * dstユーザーのalsoKnownAsをfetchPersonしていき、本当にmovedToUrlをdstに指定するユーザーが存在するのかを調べる
	 *
	 * @param dst movedToUrlを指定するユーザー
	 * @param check
	 * @param instant checkがtrueであるユーザーが最初に見つかったら即座にreturnするかどうか
	 * @returns Promise<LocalUser | RemoteUser | null>
	 */
	@bindThis
	public async validateAlsoKnownAs(
		dst: MiLocalUser | MiRemoteUser,
		check: (oldUser: MiLocalUser | MiRemoteUser | null, newUser: MiLocalUser | MiRemoteUser) => boolean | Promise<boolean> = () => true,
		instant = false,
	): Promise<MiLocalUser | MiRemoteUser | null> {
		let resultUser: MiLocalUser | MiRemoteUser | null = null;

		if (this.userEntityService.isRemoteUser(dst)) {
			if (Date.now() - (dst.lastFetchedAt?.getTime() ?? 0) > 10 * 1000) {
				await this.apPersonService.updatePerson(dst.uri);
			}
			dst = await this.apPersonService.fetchPerson(dst.uri) ?? dst;
		}

		if (!dst.alsoKnownAs || dst.alsoKnownAs.length === 0) return null;

		const dstUri = this.userEntityService.getUserUri(dst);

		for (const srcUri of dst.alsoKnownAs) {
			try {
				let src = await this.apPersonService.fetchPerson(srcUri);
				if (!src) continue; // oldAccountを探してもこのサーバーに存在しない場合はフォロー関係もないということなのでスルー

				if (this.userEntityService.isRemoteUser(dst)) {
					if (Date.now() - (src.lastFetchedAt?.getTime() ?? 0) > 10 * 1000) {
						await this.apPersonService.updatePerson(srcUri);
					}

					src = await this.apPersonService.fetchPerson(srcUri) ?? src;
				}

				if (src.movedToUri === dstUri) {
					if (await check(resultUser, src)) {
						resultUser = src;
					}
					if (instant && resultUser) return resultUser;
				}
			} catch {
				/* skip if any error happens */
			}
		}

		return resultUser;
	}
}
