/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as mfm from 'mfc-js';
import * as Redis from 'ioredis';
import { Brackets, DataSource, In, IsNull, LessThan } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { QueueService } from '@/core/QueueService.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { PushNotificationService } from '@/core/PushNotificationService.js';
import { bindThis } from '@/decorators.js';
import type { ChatApprovalsRepository, ChatMessagesRepository, ChatRoomInvitationsRepository, ChatRoomMembershipsRepository, ChatRoomsRepository, MiChatMessage, MiChatRoom, MiDriveFile, MiUser, MutingsRepository, UsersRepository } from '@/models/_.js';
import { UserBlockingService } from '@/core/UserBlockingService.js';
import { QueryService } from '@/core/QueryService.js';
import { RoleService } from '@/core/RoleService.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { MiChatRoomInvitation } from '@/models/ChatRoomInvitation.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { Packed } from '@/misc/json-schema.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { extractCustomEmojisFromMfm } from '@/misc/extract-custom-emojis-from-mfm.js';
import { NotificationService } from '@/core/NotificationService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { emojiRegex } from '@/misc/emoji-regex.js';

export class ChatMessageAccessError extends Error {}
export class ChatMessageInvalidTextError extends ChatMessageAccessError {}
export class ChatRoomArchivedError extends Error {}

export const MAX_ROOM_MEMBERS = 50;
// Remote peers may allow longer messages than our composer, up to the text column's limit.
export const MAX_REMOTE_MESSAGE_TEXT_LENGTH = 4096;
const MAX_REACTIONS_PER_MESSAGE = 100;
const PENDING_CHAT_REACTION_TTL = 6 * 60 * 60;
const MAX_PENDING_CHAT_REACTIONS = 100;
const MAX_PENDING_CHAT_REACTIONS_PER_ACTOR = 1000;
const MAX_PENDING_CHAT_REACTION_LENGTH = 256;
const CHAT_REACTION_ACTIVITY_ID_TTL = 30 * 24 * 60 * 60;
const MAX_REMOTE_REACTION_ACTIVITY_ID_LENGTH = 2048;
const isCustomEmojiRegexp = /^:([\w+-]+)(?:@\.)?:$/;

// TODO: ReactionServiceのやつと共通化
function normalizeEmojiString(x: string) {
	const match = emojiRegex.exec(x);
	if (match) {
		// 合字を含む1つの絵文字
		const unicode = match[0];

		// 異体字セレクタ除去
		return unicode.match('\u200d') ? unicode : unicode.replace(/\ufe0f/g, '');
	} else {
		throw new Error('invalid emoji');
	}
}

@Injectable()
export class ChatService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.chatMessagesRepository)
		private chatMessagesRepository: ChatMessagesRepository,

		@Inject(DI.chatApprovalsRepository)
		private chatApprovalsRepository: ChatApprovalsRepository,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomInvitationsRepository)
		private chatRoomInvitationsRepository: ChatRoomInvitationsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		@Inject(DI.mutingsRepository)
		private mutingsRepository: MutingsRepository,

		private userEntityService: UserEntityService,
		private chatEntityService: ChatEntityService,
		private idService: IdService,
		private globalEventService: GlobalEventService,
		private apRendererService: ApRendererService,
		private queueService: QueueService,
		private pushNotificationService: PushNotificationService,
		private notificationService: NotificationService,
		private userBlockingService: UserBlockingService,
		private queryService: QueryService,
		private roleService: RoleService,
		private userFollowingService: UserFollowingService,
		private customEmojiService: CustomEmojiService,
		private moderationLogService: ModerationLogService,
		private liveKitService: LiveKitService,
	) {
	}

	@bindThis
	public async getChatAvailability(userId: MiUser['id']): Promise<{ read: boolean; write: boolean; }> {
		const policies = await this.roleService.getUserPolicies(userId);

		switch (policies.chatAvailability) {
			case 'available':
				return {
					read: true,
					write: true,
				};
			case 'readonly':
				return {
					read: true,
					write: false,
				};
			case 'unavailable':
				return {
					read: false,
					write: false,
				};
			default:
				throw new Error('invalid chat availability (unreachable)');
		}
	}

	/** getChatAvailabilityの糖衣。主にAPI呼び出し時に走らせて、権限的に問題ない場合はそのまま続行する */
	@bindThis
	public async checkChatAvailability(userId: MiUser['id'], permission: 'read' | 'write') {
		const policy = await this.getChatAvailability(userId);
		if (policy[permission] === false) {
			throw new Error('ROLE_PERMISSION_DENIED');
		}
	}

	@bindThis
	public async createMessageToUser(fromUser: { id: MiUser['id']; host: MiUser['host']; }, toUser: MiUser, params: {
		text?: string | null;
		file?: MiDriveFile | null;
		uri?: string | null;
		emojis?: string[];
		editedAt?: Date | null;
	}): Promise<Packed<'ChatMessageLiteFor1on1'>> {
		if (fromUser.id === toUser.id) {
			throw new ChatMessageAccessError('yourself');
		}

		const approvals = await this.chatApprovalsRepository.createQueryBuilder('approval')
			.where(new Brackets(qb => { // 自分が相手を許可しているか
				qb.where('approval.userId = :fromUserId', { fromUserId: fromUser.id })
					.andWhere('approval.otherId = :toUserId', { toUserId: toUser.id });
			}))
			.orWhere(new Brackets(qb => { // 相手が自分を許可しているか
				qb.where('approval.userId = :toUserId', { toUserId: toUser.id })
					.andWhere('approval.otherId = :fromUserId', { fromUserId: fromUser.id });
			}))
			.take(2)
			.getMany();

		const otherApprovedMe = approvals.some(approval => approval.userId === toUser.id);
		const iApprovedOther = approvals.some(approval => approval.userId === fromUser.id);

		if (!otherApprovedMe) {
			if (toUser.chatScope === 'none') {
				throw new ChatMessageAccessError('recipient is cannot chat (none)');
			} else if (toUser.chatScope === 'followers') {
				const isFollower = await this.userFollowingService.isFollowing(fromUser.id, toUser.id);
				if (!isFollower) {
					throw new ChatMessageAccessError('recipient is cannot chat (followers)');
				}
			} else if (toUser.chatScope === 'following') {
				const isFollowing = await this.userFollowingService.isFollowing(toUser.id, fromUser.id);
				if (!isFollowing) {
					throw new ChatMessageAccessError('recipient is cannot chat (following)');
				}
			} else if (toUser.chatScope === 'mutual') {
				const isMutual = await this.userFollowingService.isMutual(fromUser.id, toUser.id);
				if (!isMutual) {
					throw new ChatMessageAccessError('recipient is cannot chat (mutual)');
				}
			}
		}

		if (!(await this.getChatAvailability(toUser.id)).write) {
			throw new ChatMessageAccessError('recipient is cannot chat (policy)');
		}

		const blocked = await this.userBlockingService.checkBlocked(toUser.id, fromUser.id);
		if (blocked) {
			throw new ChatMessageAccessError('blocked');
		}

		// Extract emojis from text if not provided
		// Store only emoji names (like notes do), not name@host format
		let emojis = params.emojis ?? [];
		if (!params.emojis && params.text) {
		// Parse MFM and extract custom emojis, same as notes do
			const tokens = mfm.parse(params.text);
			emojis = extractCustomEmojisFromMfm(tokens);
		}

		const id = this.idService.gen();
		const message = {
			id,
			fromUserId: fromUser.id,
			toUserId: toUser.id,
			text: params.text ? params.text.trim() : null,
			fileId: params.file ? params.file.id : null,
			reads: [],
			uri: params.uri ?? `${this.config.url.replace(/\/$/, '')}/chat/messages/${id}`,
			editedAt: params.editedAt ?? null,
			emojis,
		} satisfies Partial<MiChatMessage>;

		const inserted = await this.chatMessagesRepository.insertOne(message);

		// 相手を許可しておく
		if (!iApprovedOther) {
			this.chatApprovalsRepository.insertOne({
				id: this.idService.gen(),
				userId: fromUser.id,
				otherId: toUser.id,
			});
		}

		const packedMessage = await this.chatEntityService.packMessageLiteFor1on1(inserted);

		if (this.userEntityService.isLocalUser(toUser)) {
			const redisPipeline = this.redisClient.pipeline();
			redisPipeline.set(`newUserChatMessageExists:${toUser.id}:${fromUser.id}`, message.id);
			redisPipeline.sadd(`newChatMessagesExists:${toUser.id}`, `user:${fromUser.id}`);
			redisPipeline.exec();
		}

		if (this.userEntityService.isLocalUser(fromUser)) {
			// 自分のストリーム
			this.globalEventService.publishChatUserStream(fromUser.id, toUser.id, 'message', packedMessage);
		}

		if (this.userEntityService.isLocalUser(toUser)) {
			// 相手のストリーム
			this.globalEventService.publishChatUserStream(toUser.id, fromUser.id, 'message', packedMessage);
		}

		// 3秒経っても既読にならなかったらイベント発行
		if (this.userEntityService.isLocalUser(toUser)) {
			setTimeout(async () => {
				const marker = await this.redisClient.get(`newUserChatMessageExists:${toUser.id}:${fromUser.id}`);

				if (marker == null) return; // 既読

				// Delete and Update can arrive within this delay. Never notify with text the sender already withdrew.
				const latest = await this.chatMessagesRepository.findOneBy({ id: inserted.id });
				if (latest == null || latest.deletedAt != null) return;

				const packedMessageForTo = await this.chatEntityService.packMessageDetailed(latest, toUser);
				this.globalEventService.publishMainStream(toUser.id, 'newChatMessage', packedMessageForTo);
				this.pushNotificationService.pushNotification(toUser.id, 'newChatMessage', packedMessageForTo);
			}, 3000);
		}

		// Federation: Send to remote user if applicable
		if (this.userEntityService.isLocalUser(fromUser) && this.userEntityService.isRemoteUser(toUser)) {
			const fullFromUser = await this.usersRepository.findOneByOrFail({ id: fromUser.id });
			const chatMessageObject = await this.apRendererService.renderChatMessage(inserted, fullFromUser, [toUser]);
			const activity = {
				type: 'Create',
				actor: this.userEntityService.genLocalUserUri(fullFromUser.id),
				object: chatMessageObject,
				published: this.idService.parse(inserted.id).date.toISOString(),
			};
			this.queueService.deliver(fullFromUser, this.apRendererService.addContext(activity), toUser.inbox, false);
		}

		return packedMessage;
	}

	@bindThis
	public async createMessageToRoom(fromUser: { id: MiUser['id']; host: MiUser['host']; }, toRoom: MiChatRoom, params: {
		text?: string | null;
		file?: MiDriveFile | null;
		uri?: string | null;
		emojis?: string[];
		editedAt?: Date | null;
	}): Promise<Packed<'ChatMessageLiteForRoom'>> {
		const memberships = (await this.chatRoomMembershipsRepository.findBy({ roomId: toRoom.id })).map(m => ({
			userId: m.userId,
			isMuted: m.isMuted,
		})).concat({ // ownerはmembershipレコードを作らないため
			userId: toRoom.ownerId,
			isMuted: false,
		});

		if (!memberships.some(member => member.userId === fromUser.id)) {
			throw new ChatMessageAccessError('you are not a member of the room');
		}

		if (fromUser.host == null) {
			if (toRoom.isArchived) throw new ChatRoomArchivedError('room is archived');
		} else {
			await this.assertRemoteWriteAllowed(toRoom);
		}

		const membershipsOtherThanMe = memberships.filter(member => member.userId !== fromUser.id);

		// Extract emojis from text if not provided
		// Store only emoji names (like notes do), not name@host format
		let emojis = params.emojis ?? [];
		if (!params.emojis && params.text) {
		// Parse MFM and extract custom emojis, same as notes do
			const tokens = mfm.parse(params.text);
			emojis = extractCustomEmojisFromMfm(tokens);
		}

		const id = this.idService.gen();
		const message = {
			id,
			fromUserId: fromUser.id,
			toRoomId: toRoom.id,
			text: params.text ? params.text.trim() : null,
			fileId: params.file ? params.file.id : null,
			reads: [],
			uri: params.uri ?? `${this.config.url.replace(/\/$/, '')}/chat/messages/${id}`,
			editedAt: params.editedAt ?? null,
			emojis,
		} satisfies Partial<MiChatMessage>;

		const inserted = await this.chatMessagesRepository.insertOne(message);

		const packedMessage = await this.chatEntityService.packMessageLiteForRoom(inserted);

		this.globalEventService.publishChatRoomStream(toRoom.id, 'message', packedMessage);

		const redisPipeline = this.redisClient.pipeline();
		for (const membership of membershipsOtherThanMe) {
			if (membership.isMuted) continue;

			redisPipeline.set(`newRoomChatMessageExists:${membership.userId}:${toRoom.id}`, message.id);
			redisPipeline.sadd(`newChatMessagesExists:${membership.userId}`, `room:${toRoom.id}`);
		}
		redisPipeline.exec();

		// 3秒経っても既読にならなかったらイベント発行
		setTimeout(async () => {
			const redisPipeline = this.redisClient.pipeline();
			for (const membership of membershipsOtherThanMe) {
				redisPipeline.get(`newRoomChatMessageExists:${membership.userId}:${toRoom.id}`);
			}
			const markers = await redisPipeline.exec();
			if (markers == null) throw new Error('redis error');

			if (markers.every(marker => marker[1] == null)) return;

			// Delete and Update can arrive within this delay. Never notify with text the sender already withdrew.
			const latest = await this.chatMessagesRepository.findOneBy({ id: inserted.id });
			if (latest == null || latest.deletedAt != null) return;

			const packedMessageForTo = await this.chatEntityService.packMessageDetailed(latest);

			for (let i = 0; i < membershipsOtherThanMe.length; i++) {
				const marker = markers[i][1];
				if (marker == null) continue;

				this.globalEventService.publishMainStream(membershipsOtherThanMe[i].userId, 'newChatMessage', packedMessageForTo);
				this.pushNotificationService.pushNotification(membershipsOtherThanMe[i].userId, 'newChatMessage', packedMessageForTo);
			}
		}, 3000);

		// Federation: Send to remote members if applicable
		if (this.userEntityService.isLocalUser(fromUser)) {
			// Get all members (including owner)
			const allMembers = await Promise.all(
				memberships.map(m => this.usersRepository.findOneBy({ id: m.userId })),
			);
			const remoteMembers = allMembers.filter(m => m && this.userEntityService.isRemoteUser(m)) as any[];

			if (remoteMembers.length > 0) {
				const fullFromUser = await this.usersRepository.findOneByOrFail({ id: fromUser.id });
				const allMembersForRendering = allMembers.filter(m => m != null) as MiUser[];
				const chatMessageObject = await this.apRendererService.renderChatMessage(inserted, fullFromUser, allMembersForRendering, toRoom.id, await this.roomUriForRoom(toRoom));
				const activity = {
					type: 'Create',
					actor: this.userEntityService.genLocalUserUri(fullFromUser.id),
					object: chatMessageObject,
					published: this.idService.parse(inserted.id).date.toISOString(),
				};
				const contextedActivity = this.apRendererService.addContext(activity);

				// Send to each remote member
				for (const remoteMember of remoteMembers) {
					this.queueService.deliver(fullFromUser, contextedActivity, remoteMember.inbox, false);
				}
			}
		}

		return packedMessage;
	}

	@bindThis
	public async readUserChatMessage(
		readerId: MiUser['id'],
		senderId: MiUser['id'],
	): Promise<void> {
		const redisPipeline = this.redisClient.pipeline();
		redisPipeline.del(`newUserChatMessageExists:${readerId}:${senderId}`);
		redisPipeline.srem(`newChatMessagesExists:${readerId}`, `user:${senderId}`);
		await redisPipeline.exec();
	}

	@bindThis
	public async readRoomChatMessage(
		readerId: MiUser['id'],
		roomId: MiChatRoom['id'],
	): Promise<void> {
		const redisPipeline = this.redisClient.pipeline();
		redisPipeline.del(`newRoomChatMessageExists:${readerId}:${roomId}`);
		redisPipeline.srem(`newChatMessagesExists:${readerId}`, `room:${roomId}`);
		await redisPipeline.exec();
	}

	@bindThis
	public async readAllChatMessages(
		readerId: MiUser['id'],
	): Promise<void> {
		const redisPipeline = this.redisClient.pipeline();
		// TODO: newUserChatMessageExists とか newRoomChatMessageExists も消したい(けどキーの列挙が必要になって面倒)
		redisPipeline.del(`newChatMessagesExists:${readerId}`);
		await redisPipeline.exec();
	}

	@bindThis
	public findMessageById(messageId: MiChatMessage['id']) {
		return this.chatMessagesRepository.findOneBy({ id: messageId });
	}

	@bindThis
	public findMyMessageById(userId: MiUser['id'], messageId: MiChatMessage['id']) {
		return this.chatMessagesRepository.findOneBy({ id: messageId, fromUserId: userId, deletedAt: IsNull() });
	}

	@bindThis
	public async hasPermissionToViewRoomTimeline(meId: MiUser['id'], room: MiChatRoom) {
		if (await this.isRoomMember(room, meId)) {
			return true;
		} else {
			const iAmModerator = await this.roleService.isModerator({ id: meId });
			if (iAmModerator) {
				return true;
			}

			return false;
		}
	}

	@bindThis
	public async updateMessage(userId: MiUser['id'], messageId: MiChatMessage['id'], text: string): Promise<MiChatMessage> {
		const message = await this.chatMessagesRepository.findOneBy({ id: messageId });
		if (message == null) throw new ChatMessageAccessError('no such message');
		if (message.fromUserId !== userId) throw new ChatMessageAccessError('cannot edit');
		if (message.deletedAt != null) throw new ChatMessageAccessError('deleted');
		await this.assertCanStillEdit(message);
		await this.assertMessageRoomNotArchived(message);

		const trimmed = text.trim();
		if ((trimmed.length === 0 && message.fileId == null) || trimmed.length > 2000) throw new ChatMessageInvalidTextError('invalid text');

		const editedAt = new Date();
		const emojis = extractCustomEmojisFromMfm(mfm.parse(trimmed));
		const result = await this.chatMessagesRepository.update({ id: message.id, deletedAt: IsNull() }, { text: trimmed, editedAt, emojis });
		if (result.affected === 0) throw new ChatMessageAccessError('deleted');
		message.text = trimmed;
		message.editedAt = editedAt;
		message.emojis = emojis;

		const payload = {
			messageId: message.id,
			text: trimmed,
			editedAt: editedAt.toISOString(),
			emojis: await this.customEmojiService.populateEmojis(emojis, null),
		};
		if (message.toUserId) {
			this.globalEventService.publishChatUserStream(message.fromUserId, message.toUserId, 'updated', payload);
			this.globalEventService.publishChatUserStream(message.toUserId, message.fromUserId, 'updated', payload);
		} else if (message.toRoomId) {
			this.globalEventService.publishChatRoomStream(message.toRoomId, 'updated', payload);
		}

		const fromUser = await this.usersRepository.findOneByOrFail({ id: message.fromUserId });
		const participants = await this.participantsForMessage(message);
		const toUsers = participants.filter(user => user.id !== fromUser.id);
		await this.deliverToRemoteUsers(fromUser, participants, await this.apRendererService.renderChatUpdate(message, fromUser, toUsers, message.toRoomId ?? undefined, await this.roomUriForMessage(message)));

		return message;
	}

	@bindThis
	public async deleteMessage(message: MiChatMessage) {
		await this.assertMessageRoomNotArchived(message);

		const deletedAt = new Date();
		await this.chatMessagesRepository.update(message.id, {
			text: null,
			fileId: null,
			reactions: [],
			deletedAt,
		});
		message.text = null;
		message.fileId = null;
		message.reactions = [];
		message.deletedAt = deletedAt;

		const fromUser = await this.usersRepository.findOneByOrFail({ id: message.fromUserId });
		const participants = await this.participantsForMessage(message);
		const toUser = message.toUserId ? participants.find(user => user.id === message.toUserId) : null;

		if (message.toUserId) {
			if (this.userEntityService.isLocalUser(fromUser)) this.globalEventService.publishChatUserStream(message.fromUserId, message.toUserId, 'deleted', message.id);
			if (toUser && this.userEntityService.isLocalUser(toUser)) this.globalEventService.publishChatUserStream(message.toUserId, message.fromUserId, 'deleted', message.id);
		} else if (message.toRoomId) {
			this.globalEventService.publishChatRoomStream(message.toRoomId, 'deleted', message.id);
		}

		const toUsers = participants.filter(user => user.id !== fromUser.id);
		await this.deliverToRemoteUsers(fromUser, participants, this.apRendererService.renderChatDelete(message, fromUser, toUsers, await this.roomUriForMessage(message)));
	}

	@bindThis
	public async userTimeline(meId: MiUser['id'], otherId: MiUser['id'], limit: number, sinceId?: MiChatMessage['id'] | null, untilId?: MiChatMessage['id'] | null) {
		const query = this.queryService.makePaginationQuery(this.chatMessagesRepository.createQueryBuilder('message'), sinceId, untilId)
			.andWhere(new Brackets(qb => {
				qb
					.where(new Brackets(qb => {
						qb
							.where('message.fromUserId = :meId')
							.andWhere('message.toUserId = :otherId');
					}))
					.orWhere(new Brackets(qb => {
						qb
							.where('message.fromUserId = :otherId')
							.andWhere('message.toUserId = :meId');
					}));
			}))
			.setParameter('meId', meId)
			.setParameter('otherId', otherId);

		const messages = await query.take(limit).getMany();

		return messages;
	}

	@bindThis
	public async roomTimeline(roomId: MiChatRoom['id'], limit: number, sinceId?: MiChatMessage['id'] | null, untilId?: MiChatMessage['id'] | null) {
		const query = this.queryService.makePaginationQuery(this.chatMessagesRepository.createQueryBuilder('message'), sinceId, untilId)
			.andWhere('message.toRoomId = :roomId', { roomId })
			.leftJoinAndSelect('message.file', 'file')
			.leftJoinAndSelect('message.fromUser', 'fromUser');

		const messages = await query.take(limit).getMany();

		return messages;
	}

	@bindThis
	public async userHistory(meId: MiUser['id'], limit: number): Promise<MiChatMessage[]> {
		const history: MiChatMessage[] = [];

		const mutingQuery = this.mutingsRepository.createQueryBuilder('muting')
			.select('muting.muteeId')
			.where('muting.muterId = :muterId', { muterId: meId });

		for (let i = 0; i < limit; i++) {
			const found = history.map(m => (m.fromUserId === meId) ? m.toUserId! : m.fromUserId!);

			const query = this.chatMessagesRepository.createQueryBuilder('message')
				.orderBy('message.id', 'DESC')
				.where(new Brackets(qb => {
					qb
						.where('message.fromUserId = :meId', { meId: meId })
						.orWhere('message.toUserId = :meId', { meId: meId });
				}))
				.andWhere('message.toRoomId IS NULL')
				.andWhere('message.deletedAt IS NULL')
				.andWhere(`message.fromUserId NOT IN (${ mutingQuery.getQuery() })`)
				.andWhere(`message.toUserId NOT IN (${ mutingQuery.getQuery() })`);

			if (found.length > 0) {
				query.andWhere('message.fromUserId NOT IN (:...found)', { found: found });
				query.andWhere('message.toUserId NOT IN (:...found)', { found: found });
			}

			query.setParameters(mutingQuery.getParameters());

			const message = await query.getOne();

			if (message) {
				history.push(message);
			} else {
				break;
			}
		}

		return history;
	}

	@bindThis
	public async roomHistory(meId: MiUser['id'], limit: number): Promise<MiChatMessage[]> {
		// TODO: 一回のクエリにまとめられるかも
		const [memberRoomIds, ownedRoomIds] = await Promise.all([
			this.chatRoomMembershipsRepository.findBy({
				userId: meId,
			}).then(xs => xs.map(x => x.roomId)),
			this.chatRoomsRepository.findBy({
				ownerId: meId,
			}).then(xs => xs.map(x => x.id)),
		]);

		const roomIds = memberRoomIds.concat(ownedRoomIds);

		if (memberRoomIds.length === 0 && ownedRoomIds.length === 0) {
			return [];
		}

		const history: MiChatMessage[] = [];

		for (let i = 0; i < limit; i++) {
			const found = history.map(m => m.toRoomId!);

			const query = this.chatMessagesRepository.createQueryBuilder('message')
				.orderBy('message.id', 'DESC')
				.where('message.toRoomId IN (:...roomIds)', { roomIds })
				.andWhere('message.deletedAt IS NULL');

			if (found.length > 0) {
				query.andWhere('message.toRoomId NOT IN (:...found)', { found: found });
			}

			const message = await query.getOne();

			if (message) {
				history.push(message);
			} else {
				break;
			}
		}

		return history;
	}

	@bindThis
	public async getUserReadStateMap(userId: MiUser['id'], otherIds: MiUser['id'][]) {
		const readStateMap: Record<MiUser['id'], boolean> = {};

		const redisPipeline = this.redisClient.pipeline();

		for (const otherId of otherIds) {
			redisPipeline.get(`newUserChatMessageExists:${userId}:${otherId}`);
		}

		const markers = await redisPipeline.exec();
		if (markers == null) throw new Error('redis error');

		for (let i = 0; i < otherIds.length; i++) {
			const marker = markers[i][1];
			readStateMap[otherIds[i]] = marker == null;
		}

		return readStateMap;
	}

	@bindThis
	public async getRoomReadStateMap(userId: MiUser['id'], roomIds: MiChatRoom['id'][]) {
		const readStateMap: Record<MiChatRoom['id'], boolean> = {};

		const redisPipeline = this.redisClient.pipeline();

		for (const roomId of roomIds) {
			redisPipeline.get(`newRoomChatMessageExists:${userId}:${roomId}`);
		}

		const markers = await redisPipeline.exec();
		if (markers == null) throw new Error('redis error');

		for (let i = 0; i < roomIds.length; i++) {
			const marker = markers[i][1];
			readStateMap[roomIds[i]] = marker == null;
		}

		return readStateMap;
	}

	@bindThis
	public async hasUnreadMessages(userId: MiUser['id']) {
		const card = await this.redisClient.scard(`newChatMessagesExists:${userId}`);
		return card > 0;
	}

	@bindThis
	public async createRoom(owner: MiUser, params: Partial<{
		name: string;
		description: string;
	}>) {
		const room = {
			id: this.idService.gen(),
			name: params.name,
			description: params.description,
			ownerId: owner.id,
		} satisfies Partial<MiChatRoom>;

		const created = await this.chatRoomsRepository.insertOne(room);

		return created;
	}

	@bindThis
	public async hasPermissionToViewRoomInfo(meId: MiUser['id'], room: MiChatRoom) {
		if (room.ownerId === meId) {
			return true;
		}

		if (await this.isRoomMember(room, meId)) {
			return true;
		}

		if (await this.chatRoomInvitationsRepository.findOneBy({ roomId: room.id, userId: meId })) {
			return true;
		}

		if (await this.roleService.isModerator({ id: meId })) {
			return true;
		}

		return false;
	}

	@bindThis
	public async hasPermissionToDeleteRoom(meId: MiUser['id'], room: MiChatRoom) {
		if (room.ownerId === meId) {
			return true;
		}

		const iAmModerator = await this.roleService.isModerator({ id: meId });
		if (iAmModerator) {
			return true;
		}

		return false;
	}

	@bindThis
	public async deleteRoom(room: MiChatRoom, deleter?: MiUser, options?: { federate?: boolean }) {
		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		// A remote owner's server is the authority for its room, so only rooms owned here are announced.
		// The announcement is signed by the owner even when a moderator deletes the room.
		if (options?.federate !== false && owner != null && this.userEntityService.isLocalUser(owner)) {
			const participants = await this.participantsForRoom(room);
			const toUsers = participants.filter(user => user.id !== owner.id);
			await this.deliverToRemoteUsers(owner, participants, this.apRendererService.renderChatRoomDelete(room, owner, toUsers));
		}

		const memberships = (await this.chatRoomMembershipsRepository.findBy({ roomId: room.id })).map(m => ({
			userId: m.userId,
		})).concat({ // ownerはmembershipレコードを作らないため
			userId: room.ownerId,
		});

		// 未読フラグ削除
		const redisPipeline = this.redisClient.pipeline();
		for (const membership of memberships) {
			redisPipeline.del(`newRoomChatMessageExists:${membership.userId}:${room.id}`);
			redisPipeline.srem(`newChatMessagesExists:${membership.userId}`, `room:${room.id}`);
		}
		await redisPipeline.exec();

		await this.chatRoomsRepository.delete(room.id);
		this.globalEventService.publishChatRoomStream(room.id, 'roomDeleted');

		// ルームが消えたら通話も終了する。LiveKit が落ちていても削除自体は成功させる
		this.liveKitService.deleteRoom(room.id).catch(() => {});

		if (deleter) {
			const deleterIsModerator = await this.roleService.isModerator(deleter);

			if (deleterIsModerator) {
				this.moderationLogService.log(deleter, 'deleteChatRoom', {
					roomId: room.id,
					room: room,
				});
			}
		}
	}

	@bindThis
	public async findMyRoomById(ownerId: MiUser['id'], roomId: MiChatRoom['id']) {
		return this.chatRoomsRepository.findOneBy({ id: roomId, ownerId: ownerId });
	}

	@bindThis
	public async findRoomById(roomId: MiChatRoom['id']) {
		return this.chatRoomsRepository.findOne({
			where: { id: roomId },
			relations: { owner: true },
		});
	}

	@bindThis
	public async isRoomMember(room: MiChatRoom, userId: MiUser['id']) {
		if (room.ownerId === userId) return true;
		const membership = await this.chatRoomMembershipsRepository.findOneBy({ roomId: room.id, userId });
		return membership != null;
	}

	@bindThis
	public async createRoomInvitation(inviterId: MiUser['id'], roomId: MiChatRoom['id'], inviteeId: MiUser['id']) {
		if (inviterId === inviteeId) {
			throw new Error('yourself');
		}

		const room = await this.chatRoomsRepository.findOneByOrFail({ id: roomId, ownerId: inviterId });

		if (room.isArchived) throw new ChatRoomArchivedError('room is archived');

		if (await this.isRoomMember(room, inviteeId)) {
			throw new Error('already member');
		}

		const existingInvitation = await this.chatRoomInvitationsRepository.findOneBy({ roomId, userId: inviteeId });
		if (existingInvitation) {
			throw new Error('already invited');
		}

		const membershipsCount = await this.chatRoomMembershipsRepository.countBy({ roomId });
		if (membershipsCount >= MAX_ROOM_MEMBERS) {
			throw new Error('room is full');
		}

		const [blocked, blocking] = await Promise.all([
			this.userBlockingService.checkBlocked(inviteeId, inviterId),
			this.userBlockingService.checkBlocked(inviterId, inviteeId),
		]);
		if (blocked) {
			throw new Error('blocked');
		}
		if (blocking) {
			throw new Error('blocking');
		}

		const invitation = {
			id: this.idService.gen(),
			roomId: room.id,
			userId: inviteeId,
		} satisfies Partial<MiChatRoomInvitation>;

		const created = await this.chatRoomInvitationsRepository.insertOne(invitation);

		// Get inviter and invitee users
		const inviter = await this.usersRepository.findOneByOrFail({ id: inviterId });
		const invitee = await this.usersRepository.findOneByOrFail({ id: inviteeId });

		// Send local notification if invitee is local
		if (this.userEntityService.isLocalUser(invitee)) {
			this.notificationService.createNotification(inviteeId, 'chatRoomInvitationReceived', {
				invitationId: invitation.id,
			}, inviterId);
		}

		// Federation: Send Invite activity to remote user if applicable
		if (this.userEntityService.isLocalUser(inviter) && this.userEntityService.isRemoteUser(invitee)) {
			const roomObject = this.apRendererService.renderChatRoom(room, inviter);
			const inviteeUri = invitee.uri;
			const inviteActivity = this.apRendererService.renderInvite(roomObject, inviteeUri, inviter);
			const activity = {
				...inviteActivity,
				published: this.idService.parse(invitation.id).date.toISOString(),
			};
			this.queueService.deliver(inviter, this.apRendererService.addContext(activity), invitee.inbox, false);
		}

		return created;
	}

	@bindThis
	public async getSentRoomInvitationsWithPagination(roomId: MiChatRoom['id'], limit: number, sinceId?: MiChatRoomInvitation['id'] | null, untilId?: MiChatRoomInvitation['id'] | null) {
		const query = this.queryService.makePaginationQuery(this.chatRoomInvitationsRepository.createQueryBuilder('invitation'), sinceId, untilId)
			.andWhere('invitation.roomId = :roomId', { roomId });

		const invitations = await query.take(limit).getMany();

		return invitations;
	}

	@bindThis
	public async getOwnedRoomsWithPagination(ownerId: MiUser['id'], limit: number, sinceId?: MiChatRoom['id'] | null, untilId?: MiChatRoom['id'] | null) {
		const query = this.queryService.makePaginationQuery(this.chatRoomsRepository.createQueryBuilder('room'), sinceId, untilId)
			.andWhere('room.ownerId = :ownerId', { ownerId });

		const rooms = await query.take(limit).getMany();

		return rooms;
	}

	@bindThis
	public async getReceivedRoomInvitationsWithPagination(userId: MiUser['id'], limit: number, sinceId?: MiChatRoomInvitation['id'] | null, untilId?: MiChatRoomInvitation['id'] | null) {
		const query = this.queryService.makePaginationQuery(this.chatRoomInvitationsRepository.createQueryBuilder('invitation'), sinceId, untilId)
			.andWhere('invitation.userId = :userId', { userId })
			.andWhere('invitation.ignored = FALSE');

		const invitations = await query.take(limit).getMany();

		return invitations;
	}

	@bindThis
	public async joinToRoom(userId: MiUser['id'], roomId: MiChatRoom['id']) {
		const invitation = await this.chatRoomInvitationsRepository.findOneByOrFail({ roomId, userId });

		const room = await this.chatRoomsRepository.findOneByOrFail({ id: roomId });
		if (room.isArchived) throw new ChatRoomArchivedError('room is archived');

		// The invitation is the authorization for joining. Consume it atomically
		// with the membership insert so that a cancellation cannot race the join
		// and a failed insert cannot lose the invitation.
		const membership = await this.db.transaction(async (manager) => {
			const consumed = await manager.delete(MiChatRoomInvitation, {
				id: invitation.id,
				roomId,
				userId,
			});
			if (consumed.affected !== 1) {
				throw new Error('invitation not found');
			}

			const existingMembership = await manager.findOneBy(MiChatRoomMembership, { roomId, userId });
			if (existingMembership != null) {
				return null;
			}

			const membershipsCount = await manager.countBy(MiChatRoomMembership, { roomId });
			if (membershipsCount >= MAX_ROOM_MEMBERS) {
				throw new Error('room is full');
			}

			const newMembership = {
				id: this.idService.gen(),
				roomId: roomId,
				userId: userId,
			} satisfies Partial<MiChatRoomMembership>;

			await manager.insert(MiChatRoomMembership, newMembership);
			return newMembership as MiChatRoomMembership;
		});

		// Already a member (e.g. a duplicate join): the invitation was consumed,
		// but there is no new member to announce.
		if (membership == null) return;

		// Federation: Notify about acceptance and new member
		const joiningUser = await this.usersRepository.findOneByOrFail({ id: userId });
		this.globalEventService.publishChatRoomStream(roomId, 'membershipStarted', { userId });
		const owner = await this.usersRepository.findOneByOrFail({ id: room.ownerId });

		// Send Accept activity to the inviter (room owner) if they are remote
		if (this.userEntityService.isLocalUser(joiningUser) && this.userEntityService.isRemoteUser(owner)) {
			const roomObject = this.apRendererService.renderChatRoom(room, owner);
			// Create a simplified invite object reference for the Accept activity
			const inviteObject = {
				type: 'Invite',
				actor: owner.uri,
				object: roomObject,
				target: this.userEntityService.genLocalUserUri(joiningUser.id),
			};
			const acceptActivity = this.apRendererService.renderAccept(inviteObject, joiningUser);
			const activity = {
				...acceptActivity,
				published: this.idService.parse(membership.id).date.toISOString(),
			};
			this.queueService.deliver(joiningUser, this.apRendererService.addContext(activity), owner.inbox, false);
		}

		// Get all members (including owner, excluding the joining user)
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId });
		const memberUserIds = [room.ownerId, ...memberships.map(m => m.userId)].filter(id => id !== userId);
		const memberUsers = await this.usersRepository.findBy({ id: In(memberUserIds) });
		const remoteMembers = memberUsers.filter(m => this.userEntityService.isRemoteUser(m));

		// Send Add activity to other remote members (not the owner, as they got Accept)
		if (remoteMembers.length > 0 && this.userEntityService.isLocalUser(owner)) {
			const roomUri = this.apRendererService.genLocalChatRoomUri(room.id);
			const joiningUserUri = this.userEntityService.isLocalUser(joiningUser)
				? this.userEntityService.genLocalUserUri(joiningUser.id)
				: joiningUser.uri;

			const addActivity = this.apRendererService.renderAdd(owner, roomUri, joiningUserUri ?? '');
			const activity = {
				...addActivity,
				published: this.idService.parse(membership.id).date.toISOString(),
			};
			const contextedActivity = this.apRendererService.addContext(activity);

			for (const remoteMember of remoteMembers) {
				this.queueService.deliver(owner, contextedActivity, remoteMember.inbox, false);
			}
		}
	}

	@bindThis
	public async ignoreRoomInvitation(userId: MiUser['id'], roomId: MiChatRoom['id']) {
		const invitation = await this.chatRoomInvitationsRepository.findOneByOrFail({ roomId, userId });
		await this.chatRoomInvitationsRepository.update(invitation.id, { ignored: true });
	}

	@bindThis
	public async rejectRoomInvitation(userId: MiUser['id'], roomId: MiChatRoom['id']) {
		const invitation = await this.chatRoomInvitationsRepository.findOneByOrFail({ roomId, userId });
		const room = await this.chatRoomsRepository.findOneByOrFail({ id: roomId });

		// Delete the invitation
		await this.chatRoomInvitationsRepository.delete({ id: invitation.id });

		// Federation: Send Reject activity to the inviter if applicable
		const inviter = await this.usersRepository.findOneByOrFail({ id: room.ownerId });
		const invitee = await this.usersRepository.findOneByOrFail({ id: userId });

		if (this.userEntityService.isLocalUser(invitee) && this.userEntityService.isRemoteUser(inviter)) {
			const roomUri = room.uri ?? inviter.uri?.replace(/\/users\/.*$/, `/chat/rooms/${room.id}`) ?? `${this.config.url}/chat/rooms/${room.id}`;

			// Create a simplified invite object reference for the Reject activity
			const inviteObject = {
				type: 'Invite',
				actor: inviter.uri,
				object: roomUri,
				target: this.userEntityService.genLocalUserUri(invitee.id),
			};
			const rejectActivity = this.apRendererService.renderReject(inviteObject, invitee);
			const activity = {
				...rejectActivity,
				published: new Date().toISOString(),
			};
			this.queueService.deliver(invitee, this.apRendererService.addContext(activity), inviter.inbox, false);
		}
	}

	@bindThis
	public async cancelRoomInvitation(inviterId: MiUser['id'], invitationId: MiChatRoomInvitation['id']): Promise<boolean> {
		const invitation = await this.chatRoomInvitationsRepository.findOneBy({ id: invitationId });
		if (!invitation) return false;

		const room = await this.chatRoomsRepository.findOneByOrFail({ id: invitation.roomId });

		// Check if the inviter is the room owner
		if (room.ownerId !== inviterId) {
			throw new Error('not owner');
		}

		// Get inviter and invitee users
		const inviter = await this.usersRepository.findOneByOrFail({ id: inviterId });
		const invitee = await this.usersRepository.findOneByOrFail({ id: invitation.userId });

		// Delete the invitation
		await this.chatRoomInvitationsRepository.delete({ id: invitation.id });

		// Federation: Send Undo(Invite) activity to remote invitee
		if (this.userEntityService.isLocalUser(inviter) && this.userEntityService.isRemoteUser(invitee)) {
			const roomObject = this.apRendererService.renderChatRoom(room, inviter);
			const inviteObject = this.apRendererService.renderInvite(roomObject, invitee.uri, inviter);

			// Generate activity ID for the original Invite
			const inviteActivityId = `${this.config.url}/invitations/${invitation.id}`;
			const inviteWithId = {
				...inviteObject,
				id: inviteActivityId,
			};

			// Create Undo activity
			const undoActivity = this.apRendererService.renderUndo(inviteWithId, inviter);
			const activityId = `${this.config.url}/activities/${this.idService.gen()}`;
			const contextedActivity = this.apRendererService.addContext({
				...undoActivity,
				id: activityId,
			});

			this.queueService.deliver(inviter, contextedActivity, invitee.inbox, false);
		}

		return true;
	}

	@bindThis
	public async leaveRoom(userId: MiUser['id'], roomId: MiChatRoom['id']) {
		const membership = await this.chatRoomMembershipsRepository.findOneByOrFail({ roomId, userId });
		const room = await this.chatRoomsRepository.findOne({ where: { id: roomId }, relations: { owner: true } });
		const leavingUser = await this.usersRepository.findOneByOrFail({ id: userId });

		await this.chatRoomMembershipsRepository.delete(membership.id);
		this.globalEventService.publishChatRoomStream(roomId, 'membershipEnded', { userId });

		// ルームを抜けたら通話からも外す。LiveKit が落ちていても退出自体は成功させる
		this.liveKitService.removeParticipant(roomId, this.liveKitService.identityOf(leavingUser)).catch(() => {});

		// 未読フラグを消す (「既読にする」というわけでもないのでreadメソッドは使わないでおく)
		const redisPipeline = this.redisClient.pipeline();
		redisPipeline.del(`newRoomChatMessageExists:${userId}:${roomId}`);
		redisPipeline.srem(`newChatMessagesExists:${userId}`, `room:${roomId}`);
		await redisPipeline.exec();

		// Federation: Send Remove activity when local user leaves
		if (room && this.userEntityService.isLocalUser(leavingUser)) {
			// Load owner if not already loaded
			const owner = room.owner ?? await this.usersRepository.findOneByOrFail({ id: room.ownerId });

			if (!owner) {
				console.log('[ChatService.leaveRoom] Owner not found for room:', room.id);
				return;
			}

			console.log('[ChatService.leaveRoom] Processing federation for room:', room.id, 'owner:', owner.id, 'isRemote:', this.userEntityService.isRemoteUser(owner));

			// Get all members including owner
			const allMemberIds = (await this.chatRoomMembershipsRepository.findBy({ roomId: room.id }))
				.map(m => m.userId)
				.concat(room.ownerId);

			const allMembers = await this.usersRepository.findBy({ id: In(allMemberIds) });
			const remoteMembers = allMembers.filter(u => this.userEntityService.isRemoteUser(u));

			// Send Remove activity to remote members and owner
			if (remoteMembers.length > 0 || this.userEntityService.isRemoteUser(owner)) {
				// Generate the correct room URI based on the owner's server
				const roomUri = this.userEntityService.isLocalUser(owner)
					? this.apRendererService.genLocalChatRoomUri(room.id)
					: room.uri ?? `${owner.uri?.replace(/\/users\/.*$/, '')}/chat/rooms/${room.id}`;

				console.log('[ChatService.leaveRoom] Generated roomUri:', roomUri);

				const leavingUserUri = this.userEntityService.genLocalUserUri(leavingUser.id) ?? '';
				const removeActivity = this.apRendererService.renderRemove(
					leavingUser,
					roomUri,
					leavingUserUri,
				);

				// Add id and @context to the activity
				const activityId = `${this.config.url}/activities/${this.idService.gen()}`;
				const contextedActivity = this.apRendererService.addContext({
					...removeActivity,
					id: activityId,
				});

				console.log('[ChatService.leaveRoom] Remove activity:', JSON.stringify(contextedActivity, null, 2));

				// Send to all remote members
				for (const remoteMember of remoteMembers) {
					console.log('[ChatService.leaveRoom] Sending Remove to remote member:', remoteMember.id, remoteMember.inbox);
					this.queueService.deliver(leavingUser, contextedActivity, remoteMember.inbox, false);
				}

				// Send to room owner if remote
				if (this.userEntityService.isRemoteUser(owner) && !remoteMembers.some(m => m.id === owner.id)) {
					console.log('[ChatService.leaveRoom] Sending Remove to room owner:', owner.id, owner.inbox);
					this.queueService.deliver(leavingUser, contextedActivity, owner.inbox, false);
				}
			} else {
				console.log('[ChatService.leaveRoom] No remote members or owner, skipping federation');
			}
		}
	}

	/** Only the local owner can remove another member and announce it to all peers. */
	@bindThis
	public async kickRoomMember(owner: MiUser, room: MiChatRoom, userId: MiUser['id']): Promise<boolean> {
		if (owner.host != null || room.ownerId !== owner.id || userId === owner.id) return false;

		// Keep the target in the delivery list so their server also revokes access.
		const participants = await this.participantsForRoom(room);
		const member = participants.find(user => user.id === userId);
		if (member == null || !await this.removeRoomMember(room, member)) return false;

		await this.liveKitService.removeParticipant(room.id, this.liveKitService.identityOf(member)).catch(() => {});
		const memberUri = member.host == null ? this.userEntityService.genLocalUserUri(member.id) : member.uri;
		if (memberUri != null) {
			await this.deliverToRemoteUsers(owner, participants, {
				...this.apRendererService.renderRemove(owner, this.apRendererService.genLocalChatRoomUri(room.id), memberUri),
				id: `${this.config.url}/activities/${this.idService.gen()}`,
				published: new Date().toISOString(),
			});
		}
		return true;
	}

	/** Applies a membership end that another server announced, so nothing is federated back. */
	@bindThis
	public async removeRoomMember(room: MiChatRoom, member: MiUser): Promise<boolean> {
		const result = await this.chatRoomMembershipsRepository.delete({ roomId: room.id, userId: member.id });
		if ((result.affected ?? 0) === 0) return false;

		this.globalEventService.publishChatRoomStream(room.id, 'membershipEnded', { userId: member.id });

		const redisPipeline = this.redisClient.pipeline();
		redisPipeline.del(`newRoomChatMessageExists:${member.id}:${room.id}`);
		redisPipeline.srem(`newChatMessagesExists:${member.id}`, `room:${room.id}`);
		await redisPipeline.exec();

		return true;
	}

	@bindThis
	public async muteRoom(userId: MiUser['id'], roomId: MiChatRoom['id'], mute: boolean) {
		const membership = await this.chatRoomMembershipsRepository.findOneByOrFail({ roomId, userId });
		await this.chatRoomMembershipsRepository.update(membership.id, { isMuted: mute });
	}

	@bindThis
	public async updateRoom(room: MiChatRoom, params: {
		name?: string;
		description?: string;
		isArchived?: boolean;
	}, options?: { federate?: boolean }): Promise<MiChatRoom> {
		const wasArchived = room.isArchived;
		const updated = await this.chatRoomsRepository.createQueryBuilder().update()
			.set(params)
			.where('id = :id', { id: room.id })
			.returning('*')
			.execute()
			.then((response) => {
				return response.raw[0] as MiChatRoom;
			});

		const merged = { ...room, ...updated };
		this.globalEventService.publishChatRoomStream(merged.id, 'roomUpdated', {
			roomId: merged.id,
			name: merged.name,
			description: merged.description,
			isArchived: merged.isArchived,
		});

		const owner = await this.usersRepository.findOneBy({ id: merged.ownerId });
		if (owner != null && owner.host == null && merged.isArchived && !wasArchived) {
			// 残っている参加者は定期的な読み直しでも外れるが、それを待たずに通話を閉じる
			this.liveKitService.deleteRoom(merged.id).catch(() => {});
		}
		if (options?.federate !== false && owner != null && owner.host == null) {
			// 招待中の相手のサーバーにもミラーがあるので、受諾する前に状態を知らせる
			const invitations = await this.chatRoomInvitationsRepository.findBy({ roomId: merged.id });
			const invitees = invitations.length > 0 ? await this.usersRepository.findBy({ id: In(invitations.map(invitation => invitation.userId)) }) : [];
			const participants = [...await this.participantsForRoom(merged), ...invitees];
			const toUsers = participants.filter(user => user.id !== owner.id);
			await this.deliverToRemoteUsers(owner, participants, this.apRendererService.renderChatRoomUpdate(merged, owner, toUsers));
		}

		return merged;
	}

	@bindThis
	public async getRoomMembershipsWithPagination(roomId: MiChatRoom['id'], limit: number, sinceId?: MiChatRoomMembership['id'] | null, untilId?: MiChatRoomMembership['id'] | null) {
		const query = this.queryService.makePaginationQuery(this.chatRoomMembershipsRepository.createQueryBuilder('membership'), sinceId, untilId)
			.andWhere('membership.roomId = :roomId', { roomId });

		const memberships = await query.take(limit).getMany();

		return memberships;
	}

	@bindThis
	public async searchMessages(meId: MiUser['id'], query: string, limit: number, params: {
		userId?: MiUser['id'] | null;
		roomId?: MiChatRoom['id'] | null;
	}) {
		const q = this.chatMessagesRepository.createQueryBuilder('message');

		if (params.userId) {
			q.andWhere(new Brackets(qb => {
				qb
					.where(new Brackets(qb => {
						qb
							.where('message.fromUserId = :meId')
							.andWhere('message.toUserId = :otherId');
					}))
					.orWhere(new Brackets(qb => {
						qb
							.where('message.fromUserId = :otherId')
							.andWhere('message.toUserId = :meId');
					}));
			}))
				.setParameter('meId', meId)
				.setParameter('otherId', params.userId);
		} else if (params.roomId) {
			q.where('message.toRoomId = :roomId', { roomId: params.roomId });
		} else {
			const membershipsQuery = this.chatRoomMembershipsRepository.createQueryBuilder('membership')
				.select('membership.roomId')
				.where('membership.userId = :meId', { meId: meId });

			const ownedRoomsQuery = this.chatRoomsRepository.createQueryBuilder('room')
				.select('room.id')
				.where('room.ownerId = :meId', { meId });

			q.andWhere(new Brackets(qb => {
				qb
					.where('message.fromUserId = :meId')
					.orWhere('message.toUserId = :meId')
					.orWhere(`message.toRoomId IN (${membershipsQuery.getQuery()})`)
					.orWhere(`message.toRoomId IN (${ownedRoomsQuery.getQuery()})`);
			}));

			q.setParameters(membershipsQuery.getParameters());
			q.setParameters(ownedRoomsQuery.getParameters());
		}

		q.andWhere('LOWER(message.text) LIKE :q', { q: `%${ sqlLikeEscape(query.toLowerCase()) }%` });

		q.leftJoinAndSelect('message.file', 'file');
		q.leftJoinAndSelect('message.fromUser', 'fromUser');
		q.leftJoinAndSelect('message.toUser', 'toUser');
		q.leftJoinAndSelect('message.toRoom', 'toRoom');
		q.leftJoinAndSelect('toRoom.owner', 'toRoomOwner');

		const messages = await q.orderBy('message.id', 'DESC').take(limit).getMany();

		return messages;
	}

	@bindThis
	public async react(messageId: MiChatMessage['id'], userId: MiUser['id'], reaction_: string) {
		let reaction;

		const custom = reaction_.match(isCustomEmojiRegexp);

		if (custom == null) {
			reaction = normalizeEmojiString(reaction_);
		} else {
			const name = custom[1];
			const emoji = (await this.customEmojiService.localEmojisCache.fetch()).get(name);

			if (emoji == null) {
				throw new Error('no such emoji');
			} else {
				reaction = `:${name}:`;
			}
		}

		const message = await this.chatMessagesRepository.findOneBy({ id: messageId });
		if (message == null) throw new ChatMessageAccessError('no such message');
		if (message.deletedAt != null) throw new ChatMessageAccessError('deleted');

		if (message.fromUserId === userId) {
			throw new ChatMessageAccessError('cannot react to own message');
		}

		if (message.toRoomId === null && message.toUserId !== userId) {
			throw new ChatMessageAccessError('cannot react to others message');
		}

		const room = message.toRoomId ? await this.chatRoomsRepository.findOneByOrFail({ id: message.toRoomId }) : null;

		if (room) {
			if (!(await this.isRoomMember(room, userId))) {
				throw new ChatMessageAccessError('cannot react to others message');
			}
			if (room.isArchived) throw new ChatRoomArchivedError('room is archived');
		}

		if (message.reactions.length >= MAX_REACTIONS_PER_MESSAGE) {
			throw new Error('too many reactions');
		}

		const result = await this.chatMessagesRepository.createQueryBuilder().update()
			.set({
				reactions: () => 'array_append("reactions", :pair)',
			})
			.where('id = :id', { id: message.id })
			.andWhere('"deletedAt" IS NULL')
			.setParameter('pair', `${userId}/${reaction}`)
			.execute();
		if (result.affected === 0) return;

		if (room) {
			this.globalEventService.publishChatRoomStream(room.id, 'react', {
				messageId: message.id,
				user: await this.userEntityService.pack(userId),
				reaction,
			});
		} else {
			this.globalEventService.publishChatUserStream(message.fromUserId, message.toUserId!, 'react', {
				messageId: message.id,
				reaction,
			});
			this.globalEventService.publishChatUserStream(message.toUserId!, message.fromUserId, 'react', {
				messageId: message.id,
				reaction,
			});
		}

		const actor = await this.usersRepository.findOneByOrFail({ id: userId });
		const participants = await this.participantsForMessage(message);
		if (!participants.some(user => this.userEntityService.isRemoteUser(user))) return;
		const toUsers = participants.filter(user => user.id !== actor.id);
		const messageUri = this.messageUriOf(message);
		const activityId = `${this.userEntityService.genLocalUserUri(actor.id)}/chat-reactions/${randomUUID()}`;
		await this.redisClient.setex(this.chatReactionActivityIdKey(actor.id, messageUri, reaction), CHAT_REACTION_ACTIVITY_ID_TTL, activityId);
		await this.deliverToRemoteUsers(actor, participants, await this.apRendererService.renderChatReaction(message, actor, toUsers, reaction, activityId));
	}

	@bindThis
	public async unreact(messageId: MiChatMessage['id'], userId: MiUser['id'], reaction_: string) {
		let reaction;

		const custom = reaction_.match(isCustomEmojiRegexp);

		if (custom == null) {
			reaction = normalizeEmojiString(reaction_);
		} else { // 削除されたカスタム絵文字のリアクションを削除したいかもしれないので絵文字の存在チェックはする必要なし
			const name = custom[1];
			reaction = `:${name}:`;
		}

		const message = await this.chatMessagesRepository.findOneBy({ id: messageId });
		if (message == null) throw new ChatMessageAccessError('no such message');
		if (message.deletedAt != null) throw new ChatMessageAccessError('deleted');

		const room = message.toRoomId ? await this.chatRoomsRepository.findOneByOrFail({ id: message.toRoomId }) : null;

		if (room) {
			if (!(await this.isRoomMember(room, userId))) {
				throw new ChatMessageAccessError('cannot unreact to others message');
			}
			if (room.isArchived) throw new ChatRoomArchivedError('room is archived');
		} else if (message.fromUserId !== userId && message.toUserId !== userId) {
			throw new ChatMessageAccessError('cannot unreact to others message');
		}

		const result = await this.chatMessagesRepository.createQueryBuilder().update()
			.set({
				reactions: () => 'array_remove("reactions", :pair)',
			})
			.where('id = :id', { id: message.id })
			.andWhere('"deletedAt" IS NULL')
			.setParameter('pair', `${userId}/${reaction}`)
			.execute();
		if (result.affected === 0) return;

		// TODO: 実際に削除が行われたときのみイベントを発行する

		const packedUser = await this.userEntityService.pack(userId);
		if (room) {
			this.globalEventService.publishChatRoomStream(room.id, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
		} else {
			this.globalEventService.publishChatUserStream(message.fromUserId, message.toUserId!, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
			this.globalEventService.publishChatUserStream(message.toUserId!, message.fromUserId, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
		}

		const actor = await this.usersRepository.findOneByOrFail({ id: userId });
		const participants = await this.participantsForMessage(message);
		if (!participants.some(user => this.userEntityService.isRemoteUser(user))) return;
		const toUsers = participants.filter(user => user.id !== actor.id);
		const messageUri = this.messageUriOf(message);
		const activityIdKey = this.chatReactionActivityIdKey(actor.id, messageUri, reaction);
		const activityId = await this.redisClient.get(activityIdKey) ?? undefined;
		await this.redisClient.del(activityIdKey);
		await this.deliverToRemoteUsers(actor, participants, await this.apRendererService.renderChatReactionUndo(message, actor, toUsers, reaction, activityId));
	}

	@bindThis
	public async findMessageByUri(uri: string): Promise<MiChatMessage | null> {
		const message = await this.chatMessagesRepository.findOneBy({ uri });
		if (message != null) return message;

		const prefix = `${this.config.url.replace(/\/$/, '')}/chat/messages/`;
		if (!uri.startsWith(prefix)) return null;

		return this.chatMessagesRepository.findOneBy({ id: uri.slice(prefix.length) });
	}

	@bindThis
	public async updateRemoteMessage(actor: MiUser, message: MiChatMessage, text: string, editedAt: Date, emojis: string[] = []): Promise<MiChatMessage> {
		if (message.fromUserId !== actor.id) throw new ChatMessageAccessError('cannot edit');
		if (message.deletedAt != null) throw new ChatMessageAccessError('deleted');
		if (message.editedAt != null && message.editedAt >= editedAt) return message;
		await this.assertCanStillEdit(message);
		if (message.toRoomId != null) {
			const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
			if (room != null) await this.assertRemoteWriteAllowed(room);
		}

		const trimmed = text.trim();
		if ((trimmed.length === 0 && message.fileId == null) || Array.from(trimmed).length > MAX_REMOTE_MESSAGE_TEXT_LENGTH) throw new ChatMessageAccessError('invalid text');

		// Keep this conditional in SQL as multiple inbox workers may read the same revision.
		const result = await this.chatMessagesRepository.update([
			{ id: message.id, fromUserId: actor.id, deletedAt: IsNull(), editedAt: IsNull() },
			{ id: message.id, fromUserId: actor.id, deletedAt: IsNull(), editedAt: LessThan(editedAt) },
		], { text: trimmed, editedAt, emojis });
		if (result.affected === 0) return message;
		message.text = trimmed;
		message.editedAt = editedAt;
		message.emojis = emojis;

		const payload = {
			messageId: message.id,
			text: trimmed,
			editedAt: editedAt.toISOString(),
			emojis: actor.host == null ? {} : await this.customEmojiService.populateEmojis(emojis, actor.host),
		};
		if (message.toUserId) {
			this.globalEventService.publishChatUserStream(message.fromUserId, message.toUserId, 'updated', payload);
			this.globalEventService.publishChatUserStream(message.toUserId, message.fromUserId, 'updated', payload);
		} else if (message.toRoomId) {
			this.globalEventService.publishChatRoomStream(message.toRoomId, 'updated', payload);
		}

		return message;
	}

	@bindThis
	public async deleteRemoteMessage(actor: MiUser, message: MiChatMessage): Promise<MiChatMessage> {
		if (message.fromUserId !== actor.id) throw new ChatMessageAccessError('cannot delete');
		if (message.deletedAt != null) return message;

		const deletedAt = new Date();
		await this.chatMessagesRepository.update(message.id, {
			text: null,
			fileId: null,
			reactions: [],
			deletedAt,
		});
		message.text = null;
		message.fileId = null;
		message.reactions = [];
		message.deletedAt = deletedAt;

		if (message.toUserId) {
			this.globalEventService.publishChatUserStream(message.fromUserId, message.toUserId, 'deleted', message.id);
			this.globalEventService.publishChatUserStream(message.toUserId, message.fromUserId, 'deleted', message.id);
		} else if (message.toRoomId) {
			this.globalEventService.publishChatRoomStream(message.toRoomId, 'deleted', message.id);
		}

		return message;
	}

	@bindThis
	public async reactRemote(actor: MiUser, message: MiChatMessage, reaction_: string, activityId?: string): Promise<void> {
		const reaction = this.normalizeRemoteReaction(reaction_, actor.host);

		if (message.deletedAt != null) throw new ChatMessageAccessError('deleted');
		if (message.fromUserId === actor.id) throw new ChatMessageAccessError('cannot react to own message');

		const room = message.toRoomId ? await this.chatRoomsRepository.findOneByOrFail({ id: message.toRoomId }) : null;

		if (room) {
			if (!(await this.isRoomMember(room, actor.id))) throw new ChatMessageAccessError('cannot react to others message');
			await this.assertRemoteWriteAllowed(room);
		} else if (message.fromUserId !== actor.id && message.toUserId !== actor.id) {
			throw new ChatMessageAccessError('cannot react to others message');
		}

		const pair = `${actor.id}/${reaction}`;
		if (!message.reactions.includes(pair) && message.reactions.length >= MAX_REACTIONS_PER_MESSAGE) throw new ChatMessageAccessError('too many reactions');
		if (!await this.recordRemoteReactionActivity(actor, message, reaction, activityId, false)) return;
		if (message.reactions.includes(pair)) return;

		const result = await this.chatMessagesRepository.createQueryBuilder().update()
			.set({ reactions: () => 'array_append("reactions", :pair)' })
			.where('id = :id', { id: message.id })
			.andWhere('"deletedAt" IS NULL')
			.andWhere('NOT (:pair = ANY("reactions"))')
			.andWhere('cardinality("reactions") < :limit', { limit: MAX_REACTIONS_PER_MESSAGE })
			.setParameter('pair', pair)
			.execute();
		if (result.affected === 0) return;
		message.reactions.push(pair);

		if (room) {
			this.globalEventService.publishChatRoomStream(room.id, 'react', {
				messageId: message.id,
				user: await this.userEntityService.pack(actor.id),
				reaction,
			});
		} else {
			this.globalEventService.publishChatUserStream(message.fromUserId, message.toUserId!, 'react', {
				messageId: message.id,
				reaction,
			});
			this.globalEventService.publishChatUserStream(message.toUserId!, message.fromUserId, 'react', {
				messageId: message.id,
				reaction,
			});
		}
	}

	@bindThis
	public async unreactRemote(actor: MiUser, message: MiChatMessage, reaction_: string, activityId?: string): Promise<void> {
		const reaction = this.normalizeRemoteReaction(reaction_, actor.host);

		if (message.deletedAt != null) throw new ChatMessageAccessError('deleted');

		const room = message.toRoomId ? await this.chatRoomsRepository.findOneByOrFail({ id: message.toRoomId }) : null;

		if (room) {
			if (!(await this.isRoomMember(room, actor.id))) throw new ChatMessageAccessError('cannot unreact to others message');
			await this.assertRemoteWriteAllowed(room);
		} else if (message.fromUserId !== actor.id && message.toUserId !== actor.id) {
			throw new ChatMessageAccessError('cannot unreact to others message');
		}

		if (!await this.recordRemoteReactionActivity(actor, message, reaction, activityId, true)) return;
		const pair = `${actor.id}/${reaction}`;
		await this.chatMessagesRepository.createQueryBuilder().update()
			.set({ reactions: () => 'array_remove("reactions", :pair)' })
			.where('id = :id', { id: message.id })
			.setParameter('pair', pair)
			.execute();
		message.reactions = message.reactions.filter(value => value !== pair);

		const packedUser = await this.userEntityService.pack(actor.id);
		if (room) {
			this.globalEventService.publishChatRoomStream(room.id, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
		} else {
			this.globalEventService.publishChatUserStream(message.fromUserId, message.toUserId!, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
			this.globalEventService.publishChatUserStream(message.toUserId!, message.fromUserId, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
		}
	}

	/** Called under the inbox message lock, including when draining deferred reactions. */
	private async recordRemoteReactionActivity(actor: MiUser, message: MiChatMessage, reaction: string, activityId: string | undefined, undo: boolean): Promise<boolean> {
		// Older peers sent reactions without IDs; keep their pair-based behavior.
		if (activityId == null) return true;
		if (typeof activityId !== 'string' || activityId.length === 0 || activityId.length > MAX_REMOTE_REACTION_ACTIVITY_ID_LENGTH) throw new ChatMessageAccessError('invalid reaction id');
		const key = `chat_remote_reaction_activities:${message.id}:${actor.id}:${reaction}`;
		const stored = await this.redisClient.get(key);
		const states: Record<string, boolean> = stored == null ? {} : JSON.parse(stored);
		const id = createHash('sha256').update(activityId).digest('hex');
		if (!undo && states[id] === false) return false;

		const countKey = `chat_remote_reaction_activity_count:${actor.id}`;
		if (!(id in states)) {
			// Authenticated participants may still send arbitrarily many IDs. Bound the cache per actor.
			if (Object.keys(states).length >= MAX_PENDING_CHAT_REACTIONS_PER_ACTOR) throw new ChatMessageAccessError('too many reaction activities');
			const counted = await this.redisClient.multi().incr(countKey).expire(countKey, PENDING_CHAT_REACTION_TTL).exec();
			const count = counted?.[0]?.[1];
			if (typeof count !== 'number' || count > MAX_PENDING_CHAT_REACTIONS_PER_ACTOR) throw new ChatMessageAccessError('too many reaction activities');
		}

		states[id] = !undo;
		await this.redisClient.expire(countKey, PENDING_CHAT_REACTION_TTL);
		await this.redisClient.setex(key, PENDING_CHAT_REACTION_TTL, JSON.stringify(states));
		// An older Undo removes only its own addition, preserving a newer re-add even out of order.
		return !undo || !Object.values(states).some(active => active);
	}

	@bindThis
	public async storePendingChatReaction(actorId: MiUser['id'], messageUri: string, reaction: string, undo: boolean, activityId?: string): Promise<boolean> {
		if (reaction.length > MAX_PENDING_CHAT_REACTION_LENGTH) return false;
		if (activityId != null && (typeof activityId !== 'string' || activityId.length === 0 || activityId.length > MAX_REMOTE_REACTION_ACTIVITY_ID_LENGTH)) return false;

		// Any actor can name any URI here, so bound what one actor can keep in Redis until the TTL.
		const countKey = `chat_pending_reaction_count:${actorId}`;
		const counted = await this.redisClient.multi().incr(countKey).expire(countKey, PENDING_CHAT_REACTION_TTL).exec();
		const count = counted?.[0]?.[1];
		if (typeof count !== 'number' || count > MAX_PENDING_CHAT_REACTIONS_PER_ACTOR) return false;

		const key = `chat_pending_reaction_events:${messageUri}`;
		// A set loses both arrival order and repeated react/undo transitions.
		await this.redisClient.multi()
			.rpush(key, JSON.stringify({ actorId, reaction, undo, activityId }))
			.ltrim(key, 0, MAX_PENDING_CHAT_REACTIONS - 1)
			.expire(key, PENDING_CHAT_REACTION_TTL)
			.exec();
		return true;
	}

	@bindThis
	public async applyPendingChatReactions(message: MiChatMessage): Promise<void> {
		if (message.uri == null) return;

		const key = `chat_pending_reaction_events:${message.uri}`;
		// Drain atomically so an append between reading and deleting cannot be lost.
		const results = await this.redisClient.multi().lrange(key, 0, -1).del(key).exec();
		if (results == null) return;
		if (results[0][0] != null) throw results[0][0];
		const entries = results[0][1] as string[];

		for (const entry of entries) {
			try {
				const parsed = JSON.parse(entry) as { actorId?: unknown; reaction?: unknown; undo?: unknown; activityId?: unknown };
				if (typeof parsed.actorId !== 'string' || typeof parsed.reaction !== 'string' || typeof parsed.undo !== 'boolean') continue;
				if (parsed.activityId != null && typeof parsed.activityId !== 'string') continue;
				const actor = await this.usersRepository.findOneBy({ id: parsed.actorId });
				if (actor == null || actor.host == null) continue;

				if (parsed.undo) {
					await this.unreactRemote(actor, message, parsed.reaction, parsed.activityId as string | undefined);
				} else {
					await this.reactRemote(actor, message, parsed.reaction, parsed.activityId as string | undefined);
				}
			} catch (err) {
				if (err instanceof ChatMessageAccessError) continue;
				// A malformed deferred reaction must not prevent the message from being stored.
				continue;
			}
		}
	}

	/**
	 * A custom emoji name only means something on the server that sent it, so it is stored
	 * with the actor's host rather than resolving to a local emoji that happens to share the name.
	 */
	private normalizeRemoteReaction(reaction: string, actorHost: MiUser['host']): string {
		const custom = reaction.match(isCustomEmojiRegexp);
		if (custom != null) return actorHost == null ? `:${custom[1]}:` : `:${custom[1]}@${actorHost}:`;
		try {
			return normalizeEmojiString(reaction);
		} catch {
			throw new ChatMessageAccessError('invalid emoji');
		}
	}

	/**
	 * アーカイブを決めるのはルームを持つサーバーなので、ここが持つルームでは相手のサーバーからの書き込みも断る。
	 * ミラーでは、アーカイブの通知と前後して届いたものを受け取る。
	 */
	private async assertRemoteWriteAllowed(room: MiChatRoom): Promise<void> {
		if (!room.isArchived) return;
		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (owner?.host == null) throw new ChatMessageAccessError('room is archived');
	}

	private async assertMessageRoomNotArchived(message: MiChatMessage): Promise<void> {
		if (message.toRoomId == null) return;
		const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
		if (room?.isArchived) throw new ChatRoomArchivedError('room is archived');
	}

	/** Creating a message checks these too; an edit must not be a way around them. */
	private async assertCanStillEdit(message: MiChatMessage): Promise<void> {
		if (message.toRoomId != null) {
			const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
			if (room == null || !(await this.isRoomMember(room, message.fromUserId))) throw new ChatMessageAccessError('cannot edit');
		} else if (message.toUserId != null && await this.userBlockingService.checkBlocked(message.toUserId, message.fromUserId)) {
			throw new ChatMessageAccessError('cannot edit');
		}
	}

	private messageUriOf(message: MiChatMessage): string {
		return message.uri ?? `${this.config.url.replace(/\/$/, '')}/chat/messages/${message.id}`;
	}

	private chatReactionActivityIdKey(actorId: MiUser['id'], messageUri: string, reaction: string): string {
		return `chat_reaction_activity_id:${messageUri}:${actorId}:${encodeURIComponent(reaction)}`;
	}

	private async participantsForRoom(room: MiChatRoom): Promise<MiUser[]> {
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		const ids = Array.from(new Set([room.ownerId, ...memberships.map(membership => membership.userId)]));
		return this.usersRepository.findBy({ id: In(ids) });
	}

	private async roomUriForMessage(message: MiChatMessage): Promise<string | undefined> {
		if (message.toRoomId == null) return undefined;
		const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
		return room != null ? await this.roomUriForRoom(room) : undefined;
	}

	private async roomUriForRoom(room: MiChatRoom): Promise<string | undefined> {
		if (room.uri != null) return room.uri;
		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		const base = owner?.host != null ? owner.uri?.replace(/\/users\/.*$/, '') : null;
		return base != null ? `${base}/chat/rooms/${room.id}` : undefined;
	}

	private async participantsForMessage(message: MiChatMessage): Promise<MiUser[]> {
		if (message.toUserId) {
			return this.usersRepository.findBy({ id: In([message.fromUserId, message.toUserId]) });
		}

		if (message.toRoomId) {
			const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
			if (room == null) return [];

			const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
			const ids = Array.from(new Set([room.ownerId, ...memberships.map(membership => membership.userId)]));
			return this.usersRepository.findBy({ id: In(ids) });
		}

		return [];
	}

	private async deliverToRemoteUsers(actor: MiUser, users: MiUser[], activity: any): Promise<void> {
		const delivered = new Set<string>();

		for (const user of users) {
			if (user.id === actor.id) continue;
			if (!this.userEntityService.isRemoteUser(user)) continue;
			if (user.inbox == null || delivered.has(user.inbox)) continue;

			delivered.add(user.inbox);
			this.queueService.deliver(actor, this.apRendererService.addContext(activity), user.inbox, false);
		}
	}

	@bindThis
	public async getMyMemberships(userId: MiUser['id'], limit: number, sinceId?: MiChatRoomMembership['id'] | null, untilId?: MiChatRoomMembership['id'] | null) {
		const query = this.queryService.makePaginationQuery(this.chatRoomMembershipsRepository.createQueryBuilder('membership'), sinceId, untilId)
			.andWhere('membership.userId = :userId', { userId });

		const memberships = await query.take(limit).getMany();

		return memberships;
	}
}
