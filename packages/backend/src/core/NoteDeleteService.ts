/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Brackets, In, IsNull, Not } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { Injectable, Inject } from '@nestjs/common';
import type { MiUser, MiLocalUser, MiRemoteUser } from '@/models/User.js';
import type { MiNote, IMentionedRemoteUsers } from '@/models/Note.js';
import type { MiMeta, NotesRepository, UsersRepository } from '@/models/_.js';
import { RelayService } from '@/core/RelayService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { bindThis } from '@/decorators.js';
import { MiNoteDeleteReceipt } from '@/models/NoteDeleteReceipt.js';
import type { NoteDeleteNoteSnapshot, NoteDeleteAuditNoteSnapshot, NoteDeleteDeliveryPlan, NoteDeleteDeliveryTarget, NoteDeletePayload } from '@/models/NoteDeleteReceipt.js';
import { MiNoteDeleteDelivery } from '@/models/NoteDeleteDelivery.js';
import { MiFollowing } from '@/models/Following.js';
import { NoteDeleteDeliveryService } from '@/core/NoteDeleteDeliveryService.js';
import { NoteDeletePayloadService } from '@/core/NoteDeletePayloadService.js';
import { serializeActivityPub } from '@/misc/activitypub-payload.js';
import { NoteDeleteLocalRunnerService } from '@/core/NoteDeleteLocalRunnerService.js';
import Logger from '@/logger.js';
import { isQuote, isRenote } from '@/misc/is-renote.js';

@Injectable()
export class NoteDeleteService {
	private readonly logger = new Logger('note-delete');

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private userEntityService: UserEntityService,
		private relayService: RelayService,
		private apRendererService: ApRendererService,
		private apDeliverManagerService: ApDeliverManagerService,
		private noteDeleteLocalRunnerService: NoteDeleteLocalRunnerService,
		private utilityService: UtilityService,
		private noteDeletePayloadService: NoteDeletePayloadService,
		private noteDeleteDeliveryService: NoteDeleteDeliveryService,
	) {}

	/**
	 * 投稿を削除します。
	 * @param user 投稿者
	 * @param note 投稿
	 */
	async delete(user: { id: MiUser['id']; uri: MiUser['uri']; host: MiUser['host']; isBot: MiUser['isBot']; }, note: MiNote, quiet = false, deleter?: MiUser) {
		if (note.userId !== user.id) return false;
		const deletedAt = new Date();
		const federate = !quiet && this.userEntityService.isLocalUser(user) && !note.localOnly;
		const relayTargets = federate ? await this.relayService.snapshotDeliveryTargets() : [];

		// 일반 삭제와 정리는 같은 DB 삭제 확정 경계를 공유한다.
		// 수신 대상과 Undo 원본은 행 삭제에 따른 관계 정리 전에 보존한다.
		const deletion = await this.notesRepository.manager.transaction(async manager => {
			const notes = manager.getRepository(this.notesRepository.target);
			if (!await notes.existsBy({ id: note.id, userId: user.id })) return null;
			const users = manager.getRepository(this.usersRepository.target);
			const renote = federate && isRenote(note) && !isQuote(note)
				? await notes.findOneBy({ id: note.renoteId }) : null;
			const remoteUsers = federate ? [
				...await this.getMentionedRemoteUsers(note, users),
				...await this.getRenotedOrRepliedRemoteUsers(note, notes),
			] : [];
			const author = deleter && deleter.id !== note.userId
				? await users.findOneByOrFail({ id: note.userId }) : null;
			const content = federate ? this.apRendererService.addContext(renote
				? this.apRendererService.renderUndo(this.apRendererService.renderAnnounce(renote.uri ?? `${this.config.url}/notes/${renote.id}`, note), user)
				: this.apRendererService.renderDelete(this.apRendererService.renderTombstone(`${this.config.url}/notes/${note.id}`), user as MiLocalUser)) : null;
			const delivery = await this.prepareDeliveryPlan(manager, user, note, quiet, content, remoteUsers, relayTargets);
			const result = await notes.delete({ id: note.id, userId: user.id });
			if (result.affected !== 1) return null;

			// 부모 통계도 삭제와 함께 커밋하거나 롤백한다. 외부 후처리는 커밋 뒤 승자만 실행한다.
			if (note.replyId) await notes.decrement({ id: note.replyId }, 'repliesCount', 1);
			const auditNote: NoteDeleteAuditNoteSnapshot | null = author ? {
				id: note.id,
				userId: note.userId,
				userHost: note.userHost,
				uri: note.uri,
				text: note.text,
				cw: note.cw,
				visibility: note.visibility,
				localOnly: note.localOnly,
				replyId: note.replyId,
				renoteId: note.renoteId,
				replyUserId: note.replyUserId,
				replyUserHost: note.replyUserHost,
				renoteUserId: note.renoteUserId,
				renoteUserHost: note.renoteUserHost,
				fileIds: note.fileIds,
				attachedFileTypes: note.attachedFileTypes,
				hasPoll: note.hasPoll,
				channelId: note.channelId,
				visibleUserIds: note.visibleUserIds,
				mentions: note.mentions,
				mentionedRemoteUsers: note.mentionedRemoteUsers,
				tags: note.tags,
				emojis: note.emojis,
				updatedAt: note.updatedAt?.toISOString() ?? null,
				deliveryTargets: note.deliveryTargets,
			} : null;
			const snapshotNote: NoteDeleteNoteSnapshot = {
				id: note.id, userId: note.userId, userHost: note.userHost, visibility: note.visibility,
				hasReply: note.replyId != null, hasRenote: note.renoteId != null, hasFile: note.fileIds.length > 0,
			};
			await manager.getRepository(MiNoteDeleteReceipt).insert({
				noteId: note.id, userId: user.id, deletedAt, quiet,
				snapshot: {
					version: 1,
					actor: { id: user.id, host: user.host },
					deleter: author && deleter ? { id: deleter.id } : null,
					author: author ? { username: author.username, host: author.host } : null,
					note: snapshotNote,
					auditNote,
					stream: quiet ? null : { visibleUserIds: note.visibleUserIds, mentions: note.mentions, replyUserId: note.replyUserId },
					charts: {
						version: 1, notes: !quiet,
						perUser: !quiet && (user.host == null || this.meta.enableChartsForRemoteUser) ? user.id : null,
						instance: !quiet && user.host != null && this.meta.enableStatsForFederatedInstances && this.meta.enableChartsForFederatedInstances ? this.utilityService.toPuny(user.host) : null,
					},
					localPlan: {
						noteStream: !quiet, search: true,
						moderationLog: !!deleter && deleter.id !== note.userId,
						instanceStats: !quiet && user.host != null && this.meta.enableStatsForFederatedInstances,
						notesChart: !quiet,
						perUserNotesChart: !quiet && (user.host == null || this.meta.enableChartsForRemoteUser),
						instanceChart: !quiet && user.host != null && this.meta.enableStatsForFederatedInstances && this.meta.enableChartsForFederatedInstances,
						activityPub: federate,
					},
					delivery,
				},
				effects: {}, attempts: 0, nextAttemptAt: deletedAt,
				claimUntil: null, claimToken: null, claimVersion: 0, lastErrorCode: null, completedAt: null,
			});
			const obligations = [
				...delivery.followers.map(target => ({ ...target, channel: 'followers' as const, relayId: null })),
				...delivery.directTargets.map(target => ({ ...target, channel: 'direct' as const, relayId: null })),
				...delivery.relays.map(target => ({ ...target, channel: 'relay' as const })),
			].map(target => ({
				...target, receiptNoteId: note.id, ownerUserId: user.id,
				payloadRef: target.channel === 'relay' ? 'relaySigned' as const : 'activity' as const,
				state: 'pending' as const, generation: 0, attempts: 0, claimVersion: 0,
				claimToken: null, claimUntil: null, nextAttemptAt: deletedAt, lastErrorCode: null, settledAt: null,
			}));
			if (obligations.length > 0) await manager.getRepository(MiNoteDeleteDelivery).insert(obligations);
			return { renote, remoteUsers, author, content };
		});
		// 접수 실패 시 영수증은 남으며 주기 복구가 다시 찾는다.
		try {
			await this.noteDeleteDeliveryService.requestRecovery();
		} catch {
			this.logger.warn({ message: 'recovery_enqueue_failed', eventName: 'note_delete.recovery_enqueue_failed', attributes: { noteId: note.id, userId: user.id, deletionCommitted: deletion !== null } });
		}

		if (!deletion) return false;

		return true;
	}

	private deliveryTargets(inboxes: Map<string, boolean>): NoteDeleteDeliveryTarget[] {
		return [...inboxes].map(([endpoint, isSharedInbox]) => ({ targetKey: createHash('sha256').update(endpoint).digest('hex'), endpoint, isSharedInbox }));
	}

	private async prepareDeliveryPlan(
		manager: EntityManager, user: { id: string; host: string | null }, note: MiNote, quiet: boolean,
		content: any, remoteUsers: MiRemoteUser[], relays: { id: string; inbox: string }[],
	): Promise<NoteDeleteDeliveryPlan> {
		const plan: NoteDeleteDeliveryPlan = {
			version: 2, reason: quiet ? 'quiet' : user.host != null ? 'remote' : note.localOnly ? 'localOnly' : 'federated',
			followers: [], directTargets: [], relays: [], activity: null, relayUnsigned: null, relaySigned: null,
		};
		if (plan.reason !== 'federated') return plan;

		// 경로마다 별개 manager를 사용해 기존 경로 사이 중복을 보존한다.
		const followings = manager.getRepository(MiFollowing);
		const actor = user as MiLocalUser;
		const followers = this.apDeliverManagerService.createDeliverManager(actor, content, false, followings);
		followers.addFollowersRecipe();
		plan.followers = this.deliveryTargets(await followers.selectInboxes());
		const direct = this.apDeliverManagerService.createDeliverManager(actor, content, false, followings);
		for (const remote of remoteUsers) direct.addDirectRecipe(remote);
		plan.directTargets = this.deliveryTargets(await direct.selectInboxes());
		plan.activity = serializeActivityPub(content);
		plan.relays = relays.map(relay => ({
			targetKey: relay.id, relayId: relay.id, endpoint: relay.inbox, isSharedInbox: false,
		}));
		if (relays.length > 0) plan.relayUnsigned = serializeActivityPub(this.relayService.prepareActivity(content));
		return plan;
	}

	// 기존 호출자도 전달 준비 서비스의 최초 저장 결과를 사용한다.
	@bindThis
	public prepareRelaySignedPayload(noteId: string, ownerUserId: string): Promise<NoteDeletePayload | null> {
		return this.noteDeletePayloadService.prepareRelaySignedPayload(noteId, ownerUserId);
	}

	@bindThis
	private async getMentionedRemoteUsers(note: MiNote, usersRepository: Pick<UsersRepository, 'find'>) {
		const where = [] as any[];

		// mention / reply / dm
		const uris = (JSON.parse(note.mentionedRemoteUsers) as IMentionedRemoteUsers).map(x => x.uri);
		if (uris.length > 0) {
			where.push(
				{ uri: In(uris) },
			);
		}

		// renote / quote
		if (note.renoteUserId) {
			where.push({
				id: note.renoteUserId,
			});
		}

		if (where.length === 0) return [];

		return await usersRepository.find({
			where,
		}) as MiRemoteUser[];
	}

	@bindThis
	private async getRenotedOrRepliedRemoteUsers(note: MiNote, notesRepository: Pick<NotesRepository, 'createQueryBuilder'>) {
		const query = notesRepository.createQueryBuilder('note')
			.leftJoinAndSelect('note.user', 'user')
			.where(new Brackets(qb => {
				qb.orWhere('note.renoteId = :renoteId', { renoteId: note.id });
				qb.orWhere('note.replyId = :replyId', { replyId: note.id });
			}))
			.andWhere({ userHost: Not(IsNull()) });
		const notes = await query.getMany() as (MiNote & { user: MiRemoteUser })[];
		const remoteUsers = notes.map(({ user }) => user);
		return remoteUsers;
	}
}
