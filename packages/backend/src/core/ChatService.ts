/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import * as mfm from 'mfc-js';
import * as Redis from 'ioredis';
import { Brackets, DataSource, In, IsNull, LessThan, Not } from 'typeorm';
import type { SelectQueryBuilder } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { QueueService } from '@/core/QueueService.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { ChatRoomNotificationService } from '@/core/ChatRoomNotificationService.js';
import { ChatRoomBanService } from '@/core/ChatRoomBanService.js';
import { ChatChannelError, parseChatChannels } from '@/core/chat-room-channels.js';
import type { ChatChannelRef } from '@/core/chat-room-channels.js';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { ChatRoomHistoryService } from '@/core/ChatRoomHistoryService.js';
import { MiBlocking } from '@/models/Blocking.js';
import type { IObject } from '@/core/activitypub/type.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { PushNotificationService } from '@/core/PushNotificationService.js';
import { bindThis } from '@/decorators.js';
import type { ChatApprovalsRepository, ChatMessagesRepository, ChatRoomInvitationsRepository, ChatRoomMembershipsRepository, ChatRoomsRepository, DriveFilesRepository, MiChatMessage, MiDriveFile, MutingsRepository, UsersRepository } from '@/models/_.js';
import { MiUser } from '@/models/User.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { UserBlockingService } from '@/core/UserBlockingService.js';
import { QueryService } from '@/core/QueryService.js';
import { RoleService } from '@/core/RoleService.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { MiChatRoomInvitation } from '@/models/ChatRoomInvitation.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiChatMessage as ChatMessageEntity } from '@/models/ChatMessage.js';
import { MiChatRoomUnread } from '@/models/ChatRoomUnread.js';
import { MiChatRoomUserSettings } from '@/models/ChatRoomUserSettings.js';
import { Packed } from '@/misc/json-schema.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { extractCustomEmojisFromMfm } from '@/misc/extract-custom-emojis-from-mfm.js';
import { NotificationService } from '@/core/NotificationService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { VoiceBackendService as LiveKitService } from '@/core/VoiceBackendService.js';
import { HostPolicyService } from '@/core/HostPolicyService.js';
import { emojiRegex } from '@/misc/emoji-regex.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';
import { chatActorUri, chatMessageUri, chatRoomUriForOwner, localChatMessageIdFromUri } from '@/core/activitypub/misc/chat-payloads.js';
import { ChatDiceService } from '@/core/ChatDiceService.js';
import { chatDiceNotation, parseChatDiceResult } from '@/core/chat-dice.js';
import { ApiError } from '@/server/api/error.js';

export class ChatMessageAccessError extends Error {}
export class ChatMessageInvalidTextError extends ChatMessageAccessError {}
export class ChatMessageBlockedError extends ChatMessageAccessError {}
export class ChatMessageRecipientSuspendedError extends ChatMessageAccessError {}
export class ChatRoomArchivedError extends Error {}
/** The invitation or membership a request relies on is missing. Callers must not reveal whether the room exists. */
export class ChatRoomAccessError extends Error {}
export class ChatRoomFullError extends Error {}
/** 그룹장이 내보낸 계정이며 아직 사면되지 않았다. */
export class ChatRoomBannedError extends Error {}
export class ChatRoomInvitationRefusedError extends Error {
	constructor(public reason: 'yourself' | 'noSuchUser' | 'suspended' | 'alreadyMember' | 'banned' | 'alreadyInvited' | 'blocked' | 'blocking') {
		super(reason);
	}
}
export class ChatReactionInvalidError extends Error {}
export class ChatTooManyReactionsError extends Error {}

export const MAX_ROOM_MEMBERS = 50;
export const MAX_CHAT_MESSAGE_FILES = 4;
// Other servers can let their users attach more than this one does. Up to the limit of a note, such a message stays whole.
export const MAX_REMOTE_CHAT_MESSAGE_FILES = 16;
export const MAX_CHAT_MESSAGE_TEXT_LENGTH = 4096;
const MAX_REACTIONS_PER_MESSAGE = 100;
const PENDING_CHAT_REACTION_TTL = 6 * 60 * 60;
const MAX_PENDING_CHAT_REACTIONS = 100;
const MAX_PENDING_CHAT_REACTIONS_PER_ACTOR = 1000;
const MAX_PENDING_CHAT_REACTION_LENGTH = 256;
const MAX_PENDING_CHAT_ACTIVITY_LENGTH = 8192;
const CHAT_REACTION_ACTIVITY_ID_TTL = 30 * 24 * 60 * 60;
const MAX_REMOTE_REACTION_ACTIVITY_ID_LENGTH = 2048;
// An account suspended here gets nothing new, but still hears what was taken back.
const ACTIVITIES_FOR_SUSPENDED_ACCOUNTS = new Set(['Delete', 'Remove', 'Undo']);
const CLEAR_CHAT_CHANNEL_UNREAD = `redis.call('SREM', KEYS[1], ARGV[1]); if redis.call('SCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[2]); redis.call('SREM', KEYS[3], ARGV[2]); end`;
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
		throw new ChatReactionInvalidError('invalid emoji');
	}
}

@Injectable()
export class ChatService {
	private iconRecoveryTimer: NodeJS.Timeout;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

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

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

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
		private hostPolicyService: HostPolicyService,
		private chatRosterService: ChatRosterService,
		private chatDiceService: ChatDiceService,
		private chatRoomChannelService: ChatRoomChannelService,
		private chatRoomNotificationService: ChatRoomNotificationService,
		private chatRoomHistoryService: ChatRoomHistoryService,
		private chatRoomBanService: ChatRoomBanService,
	) {
	}

	public onModuleInit(): void {
		this.redisForSub.on('message', this.onIconFileEvent);
		this.recoverMissingRoomIcons();
		this.iconRecoveryTimer = setInterval(() => this.recoverMissingRoomIcons(), 60_000);
		this.iconRecoveryTimer.unref();
	}

	public onApplicationShutdown(): void {
		this.redisForSub.off('message', this.onIconFileEvent);
		clearInterval(this.iconRecoveryTimer);
	}

	private recoverMissingRoomIcons(): void {
		this.enqueueMissingRoomIcons().catch(error => Logger.error(error, 'ChatService'));
	}

	@bindThis
	private onIconFileEvent(_channel: string, data: string): void {
		// 모든 이벤트가 지나가므로 파일 삭제가 아니면 해석하지 않는다.
		if (!data.includes('"fileDeleted"')) return;
		try {
			const event = JSON.parse(data);
			if (typeof event.channel === 'string' && event.channel.startsWith('driveStream:') && event.message?.type === 'fileDeleted' && typeof event.message.body === 'string') {
				this.enqueueMissingRoomIcons(event.message.body).catch(error => Logger.error(error, 'ChatService'));
			}
		} catch (error) {
			Logger.error(error, 'ChatService');
		}
	}

	@bindThis
	public async enqueueMissingRoomIcons(fileId?: string): Promise<void> {
		const rooms = await this.chatRoomsRepository.find({
			where: { iconId: IsNull(), iconFileId: fileId ?? Not(IsNull()) },
			select: { id: true, iconFileId: true },
			take: 100,
			order: { id: 'ASC' },
		});
		for (const room of rooms) {
			if (room.iconFileId != null) await this.queueService.createChatRoomIconDeletedJob(room.id, room.iconFileId);
		}
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
			throw new ApiError({
				message: 'Your role does not allow this chat action.',
				code: 'ROLE_PERMISSION_DENIED',
				kind: 'permission',
				id: '4768787a-dc92-45ad-ac96-6491d4a0d0a8',
			});
		}
	}

	/** The files a user names for a new message in the order named, or null if one of them is not theirs. */
	@bindThis
	public async findOwnFilesForMessage(userId: MiUser['id'], fileIds: MiDriveFile['id'][]): Promise<MiDriveFile[] | null> {
		if (fileIds.length === 0) return [];
		const files = await this.driveFilesRepository.findBy({ id: In(fileIds), userId });
		const ordered = fileIds.map(id => files.find(file => file.id === id)).filter(file => file != null);
		return ordered.length === fileIds.length ? ordered : null;
	}

	/**
	 * Whether this user takes messages from the sender. A remote sender's message also has to pass this
	 * before its attachments are downloaded. Tells the caller if the sender has approved the recipient yet.
	 */
	@bindThis
	public async assertCanSendToUser(fromUser: { id: MiUser['id']; host: MiUser['host']; }, toUser: MiUser): Promise<{ iApprovedOther: boolean }> {
		if (fromUser.id === toUser.id) {
			throw new ChatMessageAccessError('yourself');
		}

		if (toUser.isSuspended) {
			throw new ChatMessageRecipientSuspendedError('recipient is suspended');
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
			throw new ChatMessageBlockedError('blocked');
		}

		return { iApprovedOther };
	}

	@bindThis
	public async createMessageToUser(fromUser: { id: MiUser['id']; host: MiUser['host']; }, toUser: MiUser, params: {
		text?: string | null;
		files?: MiDriveFile[];
		uri?: string | null;
		emojis?: string[];
		editedAt?: Date | null;
		dice?: unknown;
	}): Promise<Packed<'ChatMessageLiteFor1on1'>> {
		const { iApprovedOther } = await this.assertCanSendToUser(fromUser, toUser);

		// Extract emojis from text if not provided
		// Store only emoji names (like notes do), not name@host format
		let emojis = params.emojis ?? [];
		if (!params.emojis && params.text) {
		// Parse MFM and extract custom emojis, same as notes do
			const tokens = mfm.parse(params.text);
			emojis = extractCustomEmojisFromMfm(tokens);
		}

		const notation = fromUser.host == null ? chatDiceNotation(params.text) : null;
		const dice = fromUser.host == null
			? (notation != null ? await this.chatDiceService.roll(fromUser.id, notation) : null)
			: parseChatDiceResult(params.dice);
		const id = this.idService.gen();
		const message = {
			id,
			fromUserId: fromUser.id,
			directFromUserId: fromUser.id,
			toUserId: toUser.id,
			text: params.text ? params.text.trim() : null,
			dice,
			fileIds: params.files?.map(file => file.id) ?? [],
			reads: [],
			uri: chatMessageUri({ id, uri: params.uri }, this.config.url),
			editedAt: params.editedAt ?? null,
			emojis,
		} satisfies Partial<MiChatMessage>;

		// 相手を許可しておく。メッセージより先に入れるので、失敗すればメッセージも残らず、そのまま送り直せる
		if (!iApprovedOther) {
			try {
				await this.chatApprovalsRepository.insertOne({
					id: this.idService.gen(),
					userId: fromUser.id,
					otherId: toUser.id,
				});
			} catch (err) {
				// 同じ相手への最初のメッセージが重なると、どちらも未許可と見てここへ来る。許可は入っているので続ける
				if (!isDuplicateKeyValueError(err)) throw err;
			}
		}

		const inserted = await this.chatMessagesRepository.insertOne(message);

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
				if (await this.isFromSuspendedUser(latest)) return;

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
	public async createMessageToRoom(fromUser: { id: MiUser['id']; host: MiUser['host']; } & Partial<Pick<MiUser, 'username' | 'name' | 'uri'>>, toRoom: MiChatRoom, params: {
		text?: string | null;
		files?: MiDriveFile[];
		uri?: string | null;
		emojis?: string[];
		editedAt?: Date | null;
		dice?: unknown;
		toRoomChannelId?: string | null;
		channelRefs?: ChatChannelRef[];
		remoteChannelRefs?: unknown;
	}): Promise<Packed<'ChatMessageLiteForRoom'>> {
		let memberships = (await this.chatRoomMembershipsRepository.findBy({ roomId: toRoom.id })).map(m => ({
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

		// Extract emojis from text if not provided
		// Store only emoji names (like notes do), not name@host format
		let emojis = params.emojis ?? [];
		if (!params.emojis && params.text) {
		// Parse MFM and extract custom emojis, same as notes do
			const tokens = mfm.parse(params.text);
			emojis = extractCustomEmojisFromMfm(tokens);
		}

		const notation = fromUser.host == null ? chatDiceNotation(params.text) : null;
		const dice = fromUser.host == null
			? (notation != null ? await this.chatDiceService.roll(fromUser.id, notation) : null)
			: parseChatDiceResult(params.dice);
		const id = this.idService.gen();
		const message = {
			id,
			fromUserId: fromUser.id,
			toRoomId: toRoom.id,
			text: params.text ? params.text.trim() : null,
			dice,
			fileIds: params.files?.map(file => file.id) ?? [],
			reads: [],
			uri: chatMessageUri({ id, uri: params.uri }, this.config.url),
			editedAt: params.editedAt ?? null,
			emojis,
		} satisfies Partial<MiChatMessage>;

		const inserted = await this.db.transaction(async manager => {
			const current = await manager.findOne(MiChatRoom, { where: { id: toRoom.id }, lock: { mode: 'pessimistic_write' } });
			if (current == null || (current.ownerId !== fromUser.id && !await manager.existsBy(MiChatRoomMembership, { roomId: current.id, userId: fromUser.id }))) throw new ChatMessageAccessError('you are not a member of the room');
			if (current.isArchived) {
				if (fromUser.host == null) throw new ChatRoomArchivedError('room is archived');
				await this.assertRemoteWriteAllowed(current);
			}
			memberships = (await manager.findBy(MiChatRoomMembership, { roomId: current.id })).map(member => ({ userId: member.userId, isMuted: member.isMuted })).concat({ userId: current.ownerId, isMuted: false });
			const toRoomChannelId = await this.chatRoomChannelService.resolve(current, params.toRoomChannelId, manager);
			const text = params.text ?? '';
			const channelRefs = fromUser.host == null
				? await this.chatRoomChannelService.localRefs(current, text, params.channelRefs ?? [], manager)
				: await this.chatRoomChannelService.remoteRefs(current, text, params.remoteChannelRefs, manager);
			// 계정이 지워져도 그룹 글이 남도록 작성자 정보를 글과 함께 보관한다.
			const archivedAuthor = fromUser.username != null ? { uri: chatActorUri(fromUser, this.config.url), username: fromUser.username, name: fromUser.name ?? null, host: fromUser.host } : null;
			const inserted = await manager.withRepository(this.chatMessagesRepository).insertOne({ ...message, archivedAuthor, toRoomChannelId, channelRefs });
			await this.chatRoomNotificationService.record(manager, current, inserted);
			Object.assign(toRoom, current);
			return inserted;
		});

		const membershipsOtherThanMe = memberships.filter(member => member.userId !== fromUser.id);
		const packedMessage = await this.chatEntityService.packMessageLiteForRoom(inserted);

		this.globalEventService.publishChatRoomStream(toRoom.id, 'message', packedMessage);
		await this.chatRoomNotificationService.notify(membershipsOtherThanMe.map(member => member.userId));
		this.scheduleRoomNotification(inserted.id);

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
				const roomUri = await this.roomUriForRoom(toRoom);
				const chatMessageObject = await this.apRendererService.renderChatMessage(inserted, fullFromUser, allMembersForRendering, toRoom.id, roomUri);
				const activity = {
					type: 'Create',
					actor: this.userEntityService.genLocalUserUri(fullFromUser.id),
					// Servers from before `context` and `_misskey_chatRoom` read the room only from here, and drop the message without it.
					// Only this embedded Note carries it: on a fetched Note, it would replace the real @context in addContext.
					object: { ...chatMessageObject, '@context': roomUri },
					published: this.idService.parse(inserted.id).date.toISOString(),
				};
				await this.deliverToRemoteUsers(fullFromUser, remoteMembers, activity, inserted);
			}
		} else {
			await this.relayToOtherServers(toRoom, fromUser, (owner, toUsers) => this.apRendererService.renderChatRoomRelay(inserted, toRoom, owner, toUsers), inserted);
		}

		return packedMessage;
	}

	/**
	 * A sender's server only knows the members it has heard about so far, so a message can miss someone
	 * who joined just before. The owner's server knows them all and points them at the message.
	 */
	private async relayToOtherServers(room: MiChatRoom, fromUser: Pick<MiUser, 'id' | 'host'>, render: (owner: MiUser, toUsers: MiUser[]) => IObject, message?: MiChatMessage): Promise<void> {
		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (owner == null || !this.userEntityService.isLocalUser(owner)) return;

		const members = await this.participantsForRoom(room);
		const others = members.filter(member => this.userEntityService.isRemoteUser(member) && member.host !== fromUser.host);
		if (others.length === 0) return;

		const toUsers = members.filter(member => member.id !== owner.id && member.id !== fromUser.id);
		await this.deliverToRemoteUsers(owner, others, render(owner, toUsers), message);
	}

	/** Only what changed something here gets this far, so a copy of an activity is not passed on again. An activity without an ID could not be told from its copies. */
	private async relayRoomActivity(message: MiChatMessage, fromUser: Pick<MiUser, 'id' | 'host'>, activity: IObject | undefined): Promise<void> {
		if (activity == null || typeof activity.id !== 'string' || message.toRoomId == null) return;
		const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
		if (room == null) return;
		await this.relayToOtherServers(room, fromUser, (owner, toUsers) => this.apRendererService.renderChatRoomActivityRelay(activity as IObject & { id: string }, room, owner, toUsers), message);
	}

	/** The invitation, joined room and owned room lists stay on screen until told to read again. */
	@bindThis
	public notifyRoomListChanged(localUserIds: MiUser['id'][]): void {
		for (const userId of localUserIds) {
			this.globalEventService.publishMainStream(userId, 'chatRoomListChanged');
		}
	}

	private localUserIds(users: MiUser[]): MiUser['id'][] {
		return users.filter(user => this.userEntityService.isLocalUser(user)).map(user => user.id);
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
		await this.chatRoomNotificationService.notify([readerId]);
	}

	@bindThis
	public resolveRoomChannel(room: MiChatRoom, channelId?: string | null) {
		return this.chatRoomChannelService.resolve(room, channelId);
	}

	@bindThis
	public async readRoomChatMessage(readerId: string, roomId: string, channelId?: string | null, untilId?: string): Promise<void> {
		await this.chatRoomNotificationService.read(readerId, roomId, channelId ?? undefined, untilId);
	}

	@bindThis
	public async readAllChatMessages(readerId: MiUser['id']): Promise<void> {
		const rooms = await this.chatRoomsRepository.findBy({ ownerId: readerId });
		const memberships = await this.chatRoomMembershipsRepository.findBy({ userId: readerId });
		for (const roomId of new Set([...rooms.map(room => room.id), ...memberships.map(member => member.roomId)])) {
			await this.chatRoomNotificationService.read(readerId, roomId, undefined, undefined, true);
		}
		const entries = await this.redisClient.smembers(`newChatMessagesExists:${readerId}`);
		const pipeline = this.redisClient.multi();
		for (const entry of entries.filter(value => value.startsWith('user:'))) {
			pipeline.del(`newUserChatMessageExists:${readerId}:${entry.slice(5)}`);
			pipeline.srem(`newChatMessagesExists:${readerId}`, entry);
		}
		await pipeline.exec();
		await this.chatRoomNotificationService.notify([readerId]);
	}

	@bindThis
	public async shouldNotifyRoomMessage(userId: string, messageId: string): Promise<boolean> {
		const message = await this.chatMessagesRepository.findOneBy({ id: messageId });
		return message != null && await this.chatRoomNotificationService.shouldNotify(userId, message);
	}

	private scheduleRoomNotification(messageId: string, onlyUserIds?: string[]): void {
		setTimeout(async () => {
			if (onlyUserIds?.length === 0) return;
			while (true) {
				const initial = await this.chatMessagesRepository.findOneBy({ id: messageId });
				if (initial?.toRoomId == null || initial.deletedAt != null) return;
				// 알릴 행이 없으면 포장이나 그룹 잠금이 필요하지 않다. 새 멘션은 수정 시 별도로 예약한다.
				if (!await this.db.manager.existsBy(MiChatRoomUnread, {
					messageId, notificationSent: false, ...(onlyUserIds != null ? { userId: In(onlyUserIds) } : {}),
				})) return;
				if (await this.isFromSuspendedUser(initial)) return;
				const initialRoom = await this.chatRoomsRepository.findOneBy({ id: initial.toRoomId });
				if (initialRoom == null) return;
				const snapshot = JSON.stringify(initial);
				const roomSnapshot = JSON.stringify({ ...initialRoom, messageSequence: null });
				// 포장 중에는 여러 저장소의 연결을 사용하므로 그룹 행을 잠그기 전에 끝낸다.
				const packed = await this.chatEntityService.packMessageDetailed(initial);
				const retry = await this.db.transaction(async manager => {
					const room = await manager.findOne(MiChatRoom, { where: { id: initial.toRoomId! }, lock: { mode: 'pessimistic_write' } });
					if (room == null) return false;
					if (JSON.stringify({ ...room, messageSequence: null }) !== roomSnapshot) return true;
					const message = await manager.findOneBy(ChatMessageEntity, { id: messageId });
					if (message == null || message.deletedAt != null) return false;
					// 잠금을 기다리는 동안 수정되었다면 최신 내용을 다시 포장한다.
					if (JSON.stringify(message) !== snapshot) return true;
					if (message.fromUserId != null && await manager.existsBy(MiUser, { id: message.fromUserId, isSuspended: true })) return false;
					const recipients = await this.chatRoomNotificationService.pendingRecipients(message, manager, onlyUserIds);
					for (const userId of recipients) {
						this.globalEventService.publishMainStream(userId, 'newChatMessage', packed);
						this.pushNotificationService.pushNotification(userId, 'newChatMessage', packed);
					}
					return false;
				});
				if (!retry) return;
			}
		}, 3000);
	}

	@bindThis
	public findMessageById(messageId: MiChatMessage['id']) {
		return this.chatMessagesRepository.findOneBy({ id: messageId });
	}

	/** Like a note, a message goes out of sight while its author is suspended and comes back when that ends. */
	private excludeSuspendedAuthors(query: SelectQueryBuilder<MiChatMessage>): void {
		query.andWhere('NOT EXISTS (SELECT 1 FROM "user" "author" WHERE "author"."id" = "message"."fromUserId" AND "author"."isSuspended")');
	}

	@bindThis
	public async isFromSuspendedUser(message: Pick<MiChatMessage, 'fromUserId'>): Promise<boolean> {
		if (message.fromUserId == null) return false;
		return await this.usersRepository.existsBy({ id: message.fromUserId, isSuspended: true });
	}

	/**
	 * The unread marks of a direct message from this account lead to something no longer shown, so they go.
	 * A remote account also leaves the rooms owned here and loses its invitations to them, for good:
	 * lifting the suspension does not bring either back.
	 * 다만 재참여 금지는 남기지 않는다. 그룹장이 직접 내보낸 것이 아니므로 정지가 풀리면 다시 초대할 수 있다.
	 */
	@bindThis
	public async handleUserSuspended(user: MiUser): Promise<void> {
		const readers = await this.chatMessagesRepository.createQueryBuilder('message')
			.select('DISTINCT message.toUserId', 'toUserId')
			.where('message.fromUserId = :userId', { userId: user.id })
			.andWhere('message.toUserId IS NOT NULL')
			.getRawMany<{ toUserId: MiUser['id'] }>();
		const redisPipeline = this.redisClient.pipeline();
		for (const { toUserId } of readers) {
			redisPipeline.del(`newUserChatMessageExists:${toUserId}:${user.id}`);
			redisPipeline.srem(`newChatMessagesExists:${toUserId}`, `user:${user.id}`);
		}
		await redisPipeline.exec();

		if (!this.userEntityService.isRemoteUser(user)) return;

		const [memberships, invitations] = await Promise.all([
			this.chatRoomMembershipsRepository.findBy({ userId: user.id }),
			this.chatRoomInvitationsRepository.findBy({ userId: user.id }),
		]);
		if (memberships.length === 0 && invitations.length === 0) return;

		const rooms = await this.chatRoomsRepository.find({ where: { id: In([...memberships, ...invitations].map(record => record.roomId)) }, relations: { owner: true } });
		const roomOwnedHere = (roomId: MiChatRoom['id']) => rooms.find(room => room.id === roomId && room.owner != null && this.userEntityService.isLocalUser(room.owner));
		await Promise.allSettled([
			...memberships.map(async membership => {
				const room = roomOwnedHere(membership.roomId);
				if (room?.owner != null) await this.evictRoomMember(room.owner, room, user.id);
			}),
			...invitations.map(async invitation => {
				const room = roomOwnedHere(invitation.roomId);
				if (room != null) await this.cancelRoomInvitation(room.ownerId, invitation.id);
			}),
		]);
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

	private async saveRoomMessageEdit(message: MiChatMessage, patch: Pick<MiChatMessage, 'text' | 'editedAt' | 'emojis' | 'channelRefs'>, remote = false) {
		return this.db.transaction(async manager => {
			const room = await manager.findOne(MiChatRoom, { where: { id: message.toRoomId! }, lock: { mode: 'pessimistic_write' } });
			if (room == null || message.fromUserId == null || !await this.chatRoomNotificationService.isMember(message.fromUserId, room, manager)) throw new ChatMessageAccessError('not a room member');
			if (room.isArchived) {
				if (!remote) throw new ChatRoomArchivedError('room is archived');
				await this.assertRemoteWriteAllowed(room);
			}
			const current = await manager.findOne(ChatMessageEntity, { where: { id: message.id }, lock: { mode: 'pessimistic_write' } });
			if (current == null || current.deletedAt != null || current.dice != null) return null;
			if (remote && current.editedAt != null && current.editedAt >= patch.editedAt!) return null;
			const previous = current.mentionedUserIds?.length ? current.mentionedUserIds : this.chatRoomNotificationService.mentioned(current, await this.chatRoomNotificationService.participants(room, manager));
			await manager.update(ChatMessageEntity, current.id, patch);
			Object.assign(current, patch);
			const newMentionUserIds = await this.chatRoomNotificationService.record(manager, room, current, previous);
			return { message: current, newMentionUserIds };
		});
	}

	@bindThis
	public async updateMessage(userId: MiUser['id'], messageId: MiChatMessage['id'], text: string, refs: ChatChannelRef[] = []): Promise<MiChatMessage> {
		const message = await this.chatMessagesRepository.findOneBy({ id: messageId });
		if (message == null) throw new ChatMessageAccessError('no such message');
		if (message.fromUserId !== userId) throw new ChatMessageAccessError('cannot edit');
		if (message.deletedAt != null) throw new ChatMessageAccessError('deleted');
		if (message.dice != null) throw new ChatMessageAccessError('dice message is immutable');
		await this.assertCanStillEdit(message);
		await this.assertMessageRoomNotArchived(message);

		const trimmed = text.trim();
		if ((trimmed.length === 0 && !await this.hasFile(message)) || Array.from(trimmed).length > MAX_CHAT_MESSAGE_TEXT_LENGTH) throw new ChatMessageInvalidTextError('invalid text');

		const channelRefs = message.toRoomId != null ? await this.chatRoomChannelService.localRefs(await this.chatRoomsRepository.findOneByOrFail({ id: message.toRoomId }), text, refs, undefined, message) : [];
		if (message.toRoomId == null && refs.length) throw new ChatChannelError('INVALID_CHANNEL_REFS');
		const editedAt = new Date();
		const emojis = extractCustomEmojisFromMfm(mfm.parse(trimmed));
		let newMentionUserIds: string[] = [];
		if (message.toRoomId != null) {
			const saved = await this.saveRoomMessageEdit(message, { text: trimmed, editedAt, emojis, channelRefs });
			if (saved == null) throw new ChatMessageAccessError('deleted');
			Object.assign(message, saved.message);
			newMentionUserIds = saved.newMentionUserIds;
		} else {
			const result = await this.chatMessagesRepository.update({ id: message.id, deletedAt: IsNull(), dice: IsNull() }, { text: trimmed, editedAt, emojis, channelRefs });
			if (result.affected === 0) throw new ChatMessageAccessError('deleted');
		}
		message.channelRefs = channelRefs;
		message.text = trimmed;
		message.editedAt = editedAt;
		message.emojis = emojis;

		const payload = {
			messageId: message.id,
			text: trimmed,
			channelRefs,
			editedAt: editedAt.toISOString(),
			emojis: await this.customEmojiService.populateEmojis(emojis, null),
		};
		if (message.toUserId) {
			this.globalEventService.publishChatUserStream(userId, message.toUserId, 'updated', payload);
			this.globalEventService.publishChatUserStream(message.toUserId, userId, 'updated', payload);
		} else if (message.toRoomId) {
			this.globalEventService.publishChatRoomStream(message.toRoomId, 'updated', { ...payload, newMentionUserIds });
			await this.chatRoomNotificationService.notify(this.localUserIds(await this.participantsForMessage(message)));
			if (newMentionUserIds.length) this.scheduleRoomNotification(message.id, newMentionUserIds);
		}

		const fromUser = await this.usersRepository.findOneByOrFail({ id: userId });
		const participants = await this.participantsForMessage(message);
		const toUsers = participants.filter(user => user.id !== fromUser.id);
		await this.deliverToRemoteUsers(fromUser, participants, await this.apRendererService.renderChatUpdate(message, fromUser, toUsers, message.toRoomId ?? undefined, await this.roomUriForMessage(message)), message);

		return message;
	}

	private async removeMessageContent(message: MiChatMessage, deletedAt: Date): Promise<void> {
		const patch = { text: null, dice: null, fileIds: [], reactions: [], deletedAt };
		if (message.toRoomId == null) {
			await this.chatMessagesRepository.update(message.id, patch);
			return;
		}
		const readers = await this.db.transaction(async manager => {
			await manager.findOne(MiChatRoom, { where: { id: message.toRoomId! }, lock: { mode: 'pessimistic_write' } });
			const rows = await manager.findBy(MiChatRoomUnread, { messageId: message.id });
			await manager.update(ChatMessageEntity, message.id, patch);
			await manager.delete(MiChatRoomUnread, { messageId: message.id });
			return rows.map(row => row.userId);
		});
		await this.chatRoomNotificationService.notify(readers);
	}

	@bindThis
	public async deleteMessage(message: MiChatMessage) {
		await this.assertMessageRoomNotArchived(message);

		const deletedAt = new Date();
		await this.removeMessageContent(message, deletedAt);
		message.text = null;
		message.dice = null;
		message.fileIds = [];
		message.reactions = [];
		message.deletedAt = deletedAt;

		const participants = await this.participantsForMessage(message);
		if (message.toRoomId) this.globalEventService.publishChatRoomStream(message.toRoomId, 'deleted', message.id);
		// 계정이 없어진 뒤 남은 그룹 메시지에는 삭제를 대신 알릴 작성자가 없다
		if (message.fromUserId == null) return;
		const fromUser = await this.usersRepository.findOneByOrFail({ id: message.fromUserId });
		const toUser = message.toUserId ? participants.find(user => user.id === message.toUserId) : null;

		if (message.toUserId) {
			if (this.userEntityService.isLocalUser(fromUser)) this.globalEventService.publishChatUserStream(fromUser.id, message.toUserId, 'deleted', message.id);
			if (toUser && this.userEntityService.isLocalUser(toUser)) this.globalEventService.publishChatUserStream(message.toUserId, fromUser.id, 'deleted', message.id);
		}

		const toUsers = participants.filter(user => user.id !== fromUser.id);
		await this.deliverToRemoteUsers(fromUser, participants, this.apRendererService.renderChatDelete(message, fromUser, toUsers, await this.roomUriForMessage(message)), message);
	}

	@bindThis
	public async userTimeline(meId: MiUser['id'], otherId: MiUser['id'], limit: number, sinceId?: MiChatMessage['id'] | null, untilId?: MiChatMessage['id'] | null, includeDeleted = false) {
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
		this.excludeSuspendedAuthors(query);
		if (!includeDeleted) query.andWhere('message.deletedAt IS NULL');

		const messages = await query.take(limit).getMany();

		return messages;
	}

	@bindThis
	public async roomTimeline(roomId: MiChatRoom['id'], limit: number, sinceId?: MiChatMessage['id'] | null, untilId?: MiChatMessage['id'] | null, includeDeleted = false, channelId?: string | null) {
		const query = this.queryService.makePaginationQuery(this.chatMessagesRepository.createQueryBuilder('message'), sinceId, untilId)
			.andWhere('message.toRoomId = :roomId', { roomId })
			.leftJoinAndSelect('message.fromUser', 'fromUser');
		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room == null) throw new ChatChannelError('NO_SUCH_ROOM');
		const resolvedChannel = await this.chatRoomChannelService.resolve(room, channelId);
		if (resolvedChannel != null) query.andWhere('message.toRoomChannelId = :channelId', { channelId: resolvedChannel });
		this.excludeSuspendedAuthors(query);
		if (!includeDeleted) query.andWhere('message.deletedAt IS NULL');

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
			this.excludeSuspendedAuthors(query);

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
			this.excludeSuspendedAuthors(query);

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
		const states: Record<string, boolean> = {};
		for (const roomId of new Set(roomIds)) {
			const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
			states[roomId] = room == null || !(await this.chatRoomNotificationService.state(userId, room)).hasUnread;
		}
		return states;
	}

	@bindThis
	public async hasUnreadMessages(userId: MiUser['id']) {
		return (await this.chatRoomNotificationService.totals(userId)).hasUnreadChatMessages;
	}

	@bindThis
	public async hasUnreadChatNotifications(userId: MiUser['id']) {
		return (await this.chatRoomNotificationService.totals(userId)).hasUnreadChatNotifications;
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

		this.notifyRoomListChanged([owner.id]);

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
		const participants = await this.participantsForRoom(room);
		const invitees = await this.inviteesForRoom(room);
		if (options?.federate !== false && owner != null) {
			if (this.userEntityService.isLocalUser(owner)) {
				// A remote owner's server is the authority for its room, so only rooms owned here are announced.
				// The announcement is signed by the owner even when a moderator deletes the room.
				await this.deliverToRemoteUsers(owner, [...participants, ...invitees], this.apRendererService.renderChatRoomDelete(room, owner));
			} else if (this.userEntityService.isRemoteUser(owner)) {
				await this.leaveRoomRemovedHere(room, owner, participants, invitees);
			}
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
			redisPipeline.del(`newRoomChatUnreadChannels:${membership.userId}:${room.id}`);
			redisPipeline.srem(`newChatMessagesExists:${membership.userId}`, `room:${room.id}`);
		}
		await redisPipeline.exec();

		const peopleHere = this.localUserIds([...participants, ...invitees]);
		await this.chatRosterService.markRoomDeletedFor(peopleHere, room.id);

		await this.chatRoomsRepository.delete(room.id);
		this.globalEventService.publishChatRoomStream(room.id, 'roomDeleted');
		this.notifyRoomListChanged(peopleHere);
		await this.chatRoomNotificationService.notify(peopleHere);

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

	/** A moderator removed this server's copy. The room goes on on its owner's server, which has to stop counting the people here. */
	private async leaveRoomRemovedHere(room: MiChatRoom, owner: MiRemoteUser, participants: MiUser[], invitees: MiUser[]): Promise<void> {
		const roomUri = await this.roomUriForRoom(room);
		for (const member of participants) {
			if (!this.userEntityService.isLocalUser(member)) continue;
			await this.deliverToRemoteUsers(member, participants, {
				...this.apRendererService.renderRemove(member, roomUri, this.userEntityService.genLocalUserUri(member.id)),
				id: `${this.config.url}/activities/${this.idService.gen()}`,
				published: new Date().toISOString(),
			});
		}
		const invitations = invitees.length > 0 ? await this.chatRoomInvitationsRepository.findBy({ roomId: room.id }) : [];
		for (const invitee of invitees) {
			const invitation = invitations.find(candidate => candidate.userId === invitee.id);
			if (invitation != null && this.userEntityService.isLocalUser(invitee)) this.deliverInvitationReject(room, owner, invitee, invitation);
		}
		await this.chatRosterService.markRoomClosedHere(roomUri);
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
			throw new ChatRoomInvitationRefusedError('yourself');
		}

		const initialRoom = await this.chatRoomsRepository.findOneBy({ id: roomId, ownerId: inviterId });
		if (initialRoom == null) throw new ChatRoomAccessError('no such room');

		if (initialRoom.isArchived) throw new ChatRoomArchivedError('room is archived');

		const invitee = await this.usersRepository.findOneBy({ id: inviteeId });
		if (invitee == null) throw new ChatRoomInvitationRefusedError('noSuchUser');
		if (invitee.isSuspended) throw new ChatRoomInvitationRefusedError('suspended');

		// 차단 조회는 잠금 전에 끝내고, 거절은 기존 자격 검사 순서로 처리한다.
		const [blocked, blocking] = await Promise.all([
			this.userBlockingService.checkBlocked(inviteeId, inviterId),
			this.userBlockingService.checkBlocked(inviterId, inviteeId),
		]);

		// 보관·내보내기·가입과 같은 그룹 잠금 아래에서 자격을 다시 확인하고 초대를 만든다.
		const { room, invitation, created } = await this.db.transaction(async manager => {
			const room = await manager.findOne(MiChatRoom, { where: { id: roomId, ownerId: inviterId }, lock: { mode: 'pessimistic_write' } });
			if (room == null) throw new ChatRoomAccessError('no such room');
			if (room.isArchived) throw new ChatRoomArchivedError('room is archived');

			const membership = await manager.findOneBy(MiChatRoomMembership, { roomId, userId: inviteeId });
			if (membership != null) throw new ChatRoomInvitationRefusedError('alreadyMember');
			if (await this.chatRoomBanService.isBanned(roomId, inviteeId, manager)) throw new ChatRoomInvitationRefusedError('banned');

			const existingInvitation = await manager.findOneBy(MiChatRoomInvitation, { roomId, userId: inviteeId });
			if (existingInvitation != null) throw new ChatRoomInvitationRefusedError('alreadyInvited');
			const membershipsCount = await manager.countBy(MiChatRoomMembership, { roomId });
			if (membershipsCount >= MAX_ROOM_MEMBERS) throw new ChatRoomFullError('room is full');
			if (blocked) throw new ChatRoomInvitationRefusedError('blocked');
			if (blocking) throw new ChatRoomInvitationRefusedError('blocking');

			const invitation = {
				id: this.idService.gen(),
				roomId,
				userId: inviteeId,
			} satisfies Partial<MiChatRoomInvitation>;
			const created = await manager.withRepository(this.chatRoomInvitationsRepository).insertOne(invitation).catch(err => {
				if (isDuplicateKeyValueError(err)) throw new ChatRoomInvitationRefusedError('alreadyInvited');
				throw err;
			});
			return { room, invitation, created };
		});

		const inviter = await this.usersRepository.findOneByOrFail({ id: inviterId });

		// Send local notification if invitee is local
		if (this.userEntityService.isLocalUser(invitee)) {
			this.notificationService.createNotification(inviteeId, 'chatRoomInvitationReceived', {
				invitationId: invitation.id,
			}, inviterId);
			this.notifyRoomListChanged([inviteeId]);
		}

		// Federation: Send Invite activity to remote user if applicable
		if (this.userEntityService.isLocalUser(inviter) && this.userEntityService.isRemoteUser(invitee)) {
			await this.deliverRoomInvite(room, inviter, invitee, invitation.id);
		}

		return created;
	}

	/** Invite의 시각은 초대장의 시각이다. 받은 서버가 답에 그대로 실어 예전 초대에 대한 답과 구분한다 */
	@bindThis
	public async deliverRoomInvite(room: MiChatRoom, inviter: MiLocalUser, invitee: MiRemoteUser, invitationId: MiChatRoomInvitation['id']): Promise<void> {
		const roomObject = await this.apRendererService.renderChatRoom(room, inviter);
		const activity = {
			...this.apRendererService.renderInvite(roomObject, invitee.uri, inviter),
			published: this.idService.parse(invitationId).date.toISOString(),
		};
		this.queueService.deliver(inviter, this.apRendererService.addContext(activity), invitee.inbox, false);
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
		const invitation = await this.chatRoomInvitationsRepository.findOneBy({ roomId, userId });
		if (invitation == null) throw new ChatRoomAccessError('invitation not found');

		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room == null) throw new ChatRoomAccessError('no such room');
		if (room.isArchived) throw new ChatRoomArchivedError('room is archived');

		// The owner would never hear of this join, and only this server would hold the member.
		const roomOwner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (roomOwner?.host != null && (roomOwner.isSuspended || await this.hostPolicyService.isRefusedRemoteHost(roomOwner.host))) {
			throw new ChatRoomAccessError('no such room');
		}
		const joiningUser = await this.usersRepository.findOneByOrFail({ id: userId });

		// The invitation is the authorization for joining. Consume it atomically
		// with the membership insert so that a cancellation cannot race the join
		// and a failed insert cannot lose the invitation.
		const newMembership = await this.db.transaction(async (manager) => {
			const lockedRoom = await manager.findOne(MiChatRoom, { where: { id: roomId }, lock: { mode: 'pessimistic_write' } });
			if (lockedRoom == null) throw new ChatRoomAccessError('no such room');
			if (lockedRoom.isArchived) throw new ChatRoomArchivedError('room is archived');
			const consumed = await manager.delete(MiChatRoomInvitation, {
				id: invitation.id,
				roomId,
				userId,
			});
			if (consumed.affected !== 1) {
				throw new ChatRoomAccessError('invitation not found');
			}
			const existingMembership = await manager.findOneBy(MiChatRoomMembership, { roomId, userId });
			if (existingMembership == null) {
				// 이미 멤버인 사람은 그대로 둔다.
				// 금지 기록은 그룹장의 서버가 가지므로 이 서버의 그룹에서만 확인한다.
				if (roomOwner?.host == null && await this.chatRoomBanService.isBanned(roomId, userId, manager)) {
					throw new ChatRoomBannedError('banned from the room');
				}
				if (roomOwner?.host == null && await manager.existsBy(MiBlocking, { blockerId: room.ownerId, blockeeId: userId })) {
					throw new ChatRoomAccessError('blocked by the room owner');
				}
				const membershipsCount = await manager.countBy(MiChatRoomMembership, { roomId });
				if (membershipsCount >= MAX_ROOM_MEMBERS) throw new ChatRoomFullError('room is full');
			}

			// Drop an abandoned mirror's old remote roster before accepting any new
			// roster activity. Both paths hold the room lock, so a newer Add cannot
			// be deleted by a cleanup based on an older snapshot.
			if (roomOwner != null && this.userEntityService.isRemoteUser(roomOwner) && this.userEntityService.isLocalUser(joiningUser)) {
				const oldMemberships = await manager.find(MiChatRoomMembership, { where: { roomId }, relations: { user: true } });
				const otherUsers = oldMemberships.map(m => m.user).filter((u): u is MiUser => u != null && u.id !== userId);
				if (!otherUsers.some(u => this.userEntityService.isLocalUser(u))) {
					const staleIds = otherUsers.filter(u => this.userEntityService.isRemoteUser(u) && u.id !== roomOwner.id).map(u => u.id);
					if (staleIds.length > 0) await manager.delete(MiChatRoomMembership, { roomId, userId: In(staleIds) });
				}
			}

			if (existingMembership != null) {
				await this.chatRosterService.recordAccepted(roomId, userId, new Date(), manager);
				return null;
			}

			const created = {
				id: this.idService.gen(),
				roomId: roomId,
				userId: userId,
			} satisfies Partial<MiChatRoomMembership>;

			await manager.insert(MiChatRoomMembership, created);
			await this.chatRosterService.recordAccepted(roomId, userId, new Date(), manager);
			return created as MiChatRoomMembership;
		});

		this.notifyRoomListChanged([userId]);

		// 다른 서버가 소유한 그룹이면 초대 방식과 관계없이 소유 서버가 보관한 전체 기록을 가져온다.
		// 이미 사본이 있던 그룹도 처음부터 다시 받아 빠진 글을 채운다.
		if (roomOwner != null && this.userEntityService.isRemoteUser(roomOwner) && this.userEntityService.isLocalUser(joiningUser)) {
			// 가져오기를 요청하지 못해도 참여는 끝났다. 그룹을 열 때 다시 요청한다.
			await this.chatRoomHistoryService.requestImport(room, { restart: true }).catch(() => {});
		}

		// Federation: Notify about acceptance and new member
		// Without a new membership (e.g. a duplicate join, or one a lost Remove left behind) there is no new member to announce.
		if (newMembership != null) this.globalEventService.publishChatRoomStream(roomId, 'membershipStarted', { userId });
		const owner = await this.usersRepository.findOneByOrFail({ id: room.ownerId });
		const joinedAt = newMembership != null ? this.idService.parse(newMembership.id).date : new Date();

		// Get all members (including owner, excluding the joining user)
		const remoteMembers = await this.remoteMembersOtherThan(room, userId);

		// Send Accept activity to the inviter (room owner) if they are remote
		if (this.userEntityService.isLocalUser(joiningUser) && this.userEntityService.isRemoteUser(owner)) {
			const roomObject = await this.apRendererService.renderChatRoom(room, owner);
			// Create a simplified invite object reference for the Accept activity
			const inviteObject = {
				type: 'Invite',
				actor: owner.uri,
				object: roomObject,
				target: this.userEntityService.genLocalUserUri(joiningUser.id),
				...this.invitationAnswered(invitation),
			};
			const acceptActivity = this.apRendererService.renderAccept(inviteObject, joiningUser);
			const activity = {
				...acceptActivity,
				published: joinedAt.toISOString(),
			};
			// Even with a membership here already: the owner invited this user because it does not count them, and would otherwise never hear back.
			this.queueService.deliver(joiningUser, this.apRendererService.addContext(activity), owner.inbox, false);
		}

		// Send Add activity to other remote members (not the owner, as they got Accept)
		if (newMembership != null) this.deliverRoomMemberAdd(room, owner, joiningUser, remoteMembers, joinedAt);
	}

	private async remoteMembersOtherThan(room: MiChatRoom, userId: MiUser['id']): Promise<MiUser[]> {
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		const memberUserIds = [room.ownerId, ...memberships.map(m => m.userId)].filter(id => id !== userId);
		const memberUsers = await this.usersRepository.findBy({ id: In(memberUserIds) });
		return memberUsers.filter(m => this.userEntityService.isRemoteUser(m));
	}

	/** 새 멤버를 다른 멤버들의 서버에 알린다. 그룹을 소유한 서버만 알리고, 다른 서버 그룹의 사본은 알리지 않는다 */
	@bindThis
	public async announceNewRoomMember(room: MiChatRoom, owner: MiUser, joiningUser: MiUser, joinedAt: Date): Promise<void> {
		if (!this.userEntityService.isLocalUser(owner)) return;
		this.deliverRoomMemberAdd(room, owner, joiningUser, await this.remoteMembersOtherThan(room, joiningUser.id), joinedAt);
	}

	private deliverRoomMemberAdd(room: MiChatRoom, owner: MiUser, joiningUser: MiUser, remoteMembers: MiUser[], joinedAt: Date): void {
		if (remoteMembers.length === 0 || !this.userEntityService.isLocalUser(owner)) return;

		const roomUri = this.apRendererService.genLocalChatRoomUri(room.id);
		const joiningUserUri = this.userEntityService.isLocalUser(joiningUser)
			? this.userEntityService.genLocalUserUri(joiningUser.id)
			: joiningUser.uri;

		const addActivity = this.apRendererService.renderAdd(owner, roomUri, joiningUserUri ?? '');
		const activity = {
			...addActivity,
			published: joinedAt.toISOString(),
		};
		const contextedActivity = this.apRendererService.addContext(activity);

		for (const remoteMember of remoteMembers) {
			if (!remoteMember.isSuspended) this.queueService.deliver(owner, contextedActivity, remoteMember.inbox, false);
		}
	}

	@bindThis
	public async ignoreRoomInvitation(userId: MiUser['id'], roomId: MiChatRoom['id']) {
		const invitation = await this.chatRoomInvitationsRepository.findOneBy({ roomId, userId });
		if (invitation == null) throw new ChatRoomAccessError('invitation not found');
		await this.chatRoomInvitationsRepository.update(invitation.id, { ignored: true });
		this.notifyRoomListChanged([userId]);
	}

	@bindThis
	public async rejectRoomInvitation(userId: MiUser['id'], roomId: MiChatRoom['id']) {
		const invitation = await this.chatRoomInvitationsRepository.findOneBy({ roomId, userId });
		if (invitation == null) throw new ChatRoomAccessError('invitation not found');
		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room == null) throw new ChatRoomAccessError('no such room');

		// Delete the invitation
		const deleted = await this.chatRoomInvitationsRepository.delete({ id: invitation.id });
		if (deleted.affected !== 1) throw new ChatRoomAccessError('invitation not found');
		this.notifyRoomListChanged([userId]);

		// Federation: Send Reject activity to the inviter if applicable
		const inviter = await this.usersRepository.findOneByOrFail({ id: room.ownerId });
		const invitee = await this.usersRepository.findOneByOrFail({ id: userId });

		// The owner's room says who is still invited, and no room event tells them the answer was no.
		if (this.userEntityService.isLocalUser(inviter)) this.notifyRoomListChanged([inviter.id]);

		if (this.userEntityService.isLocalUser(invitee) && this.userEntityService.isRemoteUser(inviter)) {
			this.deliverInvitationReject(room, inviter, invitee, invitation);
		}
	}

	/** The time on the Invite, as the owner stated it. An answer to an invitation since cancelled and sent again can then be told from one to the new invitation. */
	private invitationAnswered(invitation: Pick<MiChatRoomInvitation, 'invitePublishedAt'>): { published?: string } {
		return invitation.invitePublishedAt != null ? { published: invitation.invitePublishedAt.toISOString() } : {};
	}

	private deliverInvitationReject(room: MiChatRoom, inviter: MiRemoteUser, invitee: MiLocalUser, invitation: Pick<MiChatRoomInvitation, 'invitePublishedAt'>): void {
		const roomUri = chatRoomUriForOwner(room, inviter, this.config.url);

		// Create a simplified invite object reference for the Reject activity
		const inviteObject = {
			type: 'Invite',
			actor: inviter.uri,
			object: roomUri,
			target: this.userEntityService.genLocalUserUri(invitee.id),
			...this.invitationAnswered(invitation),
		};
		const rejectActivity = this.apRendererService.renderReject(inviteObject, invitee);
		const activity = {
			...rejectActivity,
			published: new Date().toISOString(),
		};
		this.queueService.deliver(invitee, this.apRendererService.addContext(activity), inviter.inbox, false);
	}

	@bindThis
	public async cancelRoomInvitation(inviterId: MiUser['id'], invitationId: MiChatRoomInvitation['id']): Promise<boolean> {
		const invitation = await this.chatRoomInvitationsRepository.findOneBy({ id: invitationId });
		if (!invitation) return false;

		const room = await this.chatRoomsRepository.findOneBy({ id: invitation.roomId });
		if (room == null) return false;

		// Someone else's invitation is reported as missing rather than revealed.
		if (room.ownerId !== inviterId) return false;

		// Get inviter and invitee users
		const inviter = await this.usersRepository.findOneByOrFail({ id: inviterId });
		const invitee = await this.usersRepository.findOneByOrFail({ id: invitation.userId });

		// Delete the invitation
		const deleted = await this.chatRoomInvitationsRepository.delete({ id: invitation.id });
		if (deleted.affected !== 1) return false;
		this.notifyRoomListChanged(this.localUserIds([invitee]));

		// Federation: Send Undo(Invite) activity to remote invitee
		if (this.userEntityService.isLocalUser(inviter) && this.userEntityService.isRemoteUser(invitee)) {
			const roomObject = await this.apRendererService.renderChatRoom(room, inviter);
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
				published: new Date().toISOString(),
			});

			this.queueService.deliver(inviter, contextedActivity, invitee.inbox, false);
		}

		return true;
	}

	@bindThis
	public async leaveRoom(userId: MiUser['id'], roomId: MiChatRoom['id']) {
		const membership = await this.chatRoomMembershipsRepository.findOneBy({ roomId, userId });
		if (membership == null) throw new ChatRoomAccessError('not a member');
		const room = await this.chatRoomsRepository.findOne({ where: { id: roomId }, relations: { owner: true } });
		const leavingUser = await this.usersRepository.findOneByOrFail({ id: userId });

		await this.db.transaction(async manager => {
			const locked = await manager.findOne(MiChatRoom, { where: { id: roomId }, lock: { mode: 'pessimistic_write' } });
			if (locked == null) throw new ChatRoomAccessError('no such room');
			const removed = await manager.delete(MiChatRoomMembership, { id: membership.id, roomId, userId });
			if ((removed.affected ?? 0) === 0) throw new ChatRoomAccessError('not a member');
			await this.chatRosterService.forgetAccepted(roomId, userId, manager);
			await manager.delete(MiChatRoomUnread, { roomId, userId });
			await manager.delete(MiChatRoomUserSettings, { roomId, userId });
		});
		this.globalEventService.publishChatRoomStream(roomId, 'membershipEnded', { userId });
		this.notifyRoomListChanged(this.localUserIds([leavingUser]));
		await this.chatRoomNotificationService.notify(this.localUserIds([leavingUser]));

		// ルームを抜けたら通話からも外す。LiveKit が落ちていても退出自体は成功させる
		this.liveKitService.removeParticipant(roomId, this.liveKitService.identityOf(leavingUser)).catch(() => {});

		// 未読フラグを消す (「既読にする」というわけでもないのでreadメソッドは使わないでおく)
		const redisPipeline = this.redisClient.pipeline();
		redisPipeline.del(`newRoomChatMessageExists:${userId}:${roomId}`);
		redisPipeline.del(`newRoomChatUnreadChannels:${userId}:${roomId}`);
		redisPipeline.srem(`newChatMessagesExists:${userId}`, `room:${roomId}`);
		await redisPipeline.exec();

		// Federation: Send Remove activity when local user leaves
		if (room && this.userEntityService.isLocalUser(leavingUser)) {
			const owner = room.owner ?? await this.usersRepository.findOneByOrFail({ id: room.ownerId });

			// The owner is one of these, so a remote owner hears about it too.
			const allMemberIds = (await this.chatRoomMembershipsRepository.findBy({ roomId: room.id }))
				.map(m => m.userId)
				.concat(room.ownerId);

			const allMembers = await this.usersRepository.findBy({ id: In(allMemberIds) });
			const remoteMembers = allMembers.filter(u => this.userEntityService.isRemoteUser(u));

			if (remoteMembers.length > 0) {
				const removeActivity = this.apRendererService.renderRemove(
					leavingUser,
					chatRoomUriForOwner(room, owner, this.config.url),
					this.userEntityService.genLocalUserUri(leavingUser.id),
				);

				// Add id and @context to the activity
				const activityId = `${this.config.url}/activities/${this.idService.gen()}`;
				const contextedActivity = this.apRendererService.addContext({
					...removeActivity,
					id: activityId,
					published: new Date().toISOString(),
				});

				for (const remoteMember of remoteMembers) {
					this.queueService.deliver(leavingUser, contextedActivity, remoteMember.inbox, false);
				}
			}
		}
	}

	/**
	 * 그룹장이 멤버를 직접 내보낸다. 내보낸 계정은 사면하기 전까지 다시 참여할 수 없다.
	 * 멤버십을 끝내는 트랜잭션에서 그룹 잠금 아래 금지를 기록하므로 그 사이에 참여가 끼어들 수 없다.
	 */
	@bindThis
	public async kickRoomMember(owner: MiUser, room: MiChatRoom, userId: MiUser['id']): Promise<boolean> {
		return await this.removeRoomMemberAsOwner(owner, room, userId, { ban: true });
	}

	/** 계정 정지처럼 서버가 스스로 멤버를 정리한다. 그룹장의 결정이 아니므로 금지를 기록하지 않는다. */
	@bindThis
	public async evictRoomMember(owner: MiUser, room: MiChatRoom, userId: MiUser['id']): Promise<boolean> {
		return await this.removeRoomMemberAsOwner(owner, room, userId, { ban: false });
	}

	/** Only the local owner can remove another member and announce it to all peers. */
	private async removeRoomMemberAsOwner(owner: MiUser, room: MiChatRoom, userId: MiUser['id'], options: { ban: boolean }): Promise<boolean> {
		if (owner.host != null || room.ownerId !== owner.id || userId === owner.id) return false;

		// Keep the target in the delivery list so their server also revokes access.
		const participants = await this.participantsForRoom(room);
		const member = participants.find(user => user.id === userId);
		if (member == null || !await this.removeRoomMember(room, member, options)) return false;

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

	/**
	 * 멤버십을 끝내되 연합으로 알리지는 않는다.
	 * `ban`은 그룹장의 직접 내보내기만 넘기며, 같은 트랜잭션에서 재참여 금지를 기록한다.
	 */
	@bindThis
	public async removeRoomMember(room: MiChatRoom, member: MiUser, options: { ban?: boolean } = {}): Promise<boolean> {
		const removed = await this.db.transaction(async manager => {
			const locked = await manager.findOne(MiChatRoom, { where: { id: room.id }, lock: { mode: 'pessimistic_write' } });
			if (locked == null) return false;
			const result = await manager.delete(MiChatRoomMembership, { roomId: room.id, userId: member.id });
			const ended = (result.affected ?? 0) > 0;
			if (ended && options.ban === true) await this.chatRoomBanService.ban(manager, room.id, member.id);
			return ended;
		});
		if (!removed) return false;
		await this.finishRoomMemberRemoval(room, member);
		return true;
	}

	/** Call after the transaction that removed the membership commits. */
	@bindThis
	public async finishRoomMemberRemoval(room: MiChatRoom, member: MiUser): Promise<void> {
		this.globalEventService.publishChatRoomStream(room.id, 'membershipEnded', { userId: member.id });

		const redisPipeline = this.redisClient.pipeline();
		redisPipeline.del(`newRoomChatMessageExists:${member.id}:${room.id}`);
		redisPipeline.del(`newRoomChatUnreadChannels:${member.id}:${room.id}`);
		redisPipeline.srem(`newChatMessagesExists:${member.id}`, `room:${room.id}`);
		await redisPipeline.exec();

		await this.chatRoomNotificationService.forget(member.id, room.id);
		this.notifyRoomListChanged(this.localUserIds([member]));
	}

	@bindThis
	public async muteRoom(userId: MiUser['id'], roomId: MiChatRoom['id'], mute: boolean) {
		try {
			await this.chatRoomNotificationService.setLevel(userId, roomId, mute ? 'none' : 'all');
			await this.chatRoomNotificationService.notify([userId]);
		} catch (err) {
			if (err instanceof ChatChannelError && err.reason === 'NO_SUCH_ROOM') throw new ChatRoomAccessError('not a member');
			throw err;
		}
	}

	@bindThis
	public async updateRoom(room: MiChatRoom, params: {
		name?: string;
		description?: string;
		isArchived?: boolean;
	} & Partial<Pick<MiChatRoom, 'iconId' | 'iconUrl' | 'iconBlurhash' | 'iconDecorations'>>, options?: { federate?: boolean; remoteUpdatedAt?: Date; remoteGroup?: IObject; deletedIconId?: string }): Promise<MiChatRoom> {
		const wasArchived = room.isArchived;
		const patch = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)) as typeof params;
		const remoteUpdatedAt = options?.remoteUpdatedAt;
		// TypeORM refuses an UPDATE that has nothing to set.
		if (remoteUpdatedAt == null && Object.values(params).every(value => value === undefined)) return room;
		const snapshot = options?.remoteGroup?._misskey_chatChannels !== undefined && remoteUpdatedAt != null ? parseChatChannels(options.remoteGroup, await this.chatRoomChannelService.roomUri(room)) : null;
		let resetOwner: MiUser | null = null;
		const updated = await this.db.transaction(async manager => {
			const current = await manager.findOne(MiChatRoom, { where: { id: room.id }, lock: { mode: 'pessimistic_write' } });
			if (current == null || (remoteUpdatedAt != null && current.lastRemoteUpdatedAt != null && current.lastRemoteUpdatedAt > remoteUpdatedAt)) return null;
			if (options?.deletedIconId != null && (current.iconFileId !== options.deletedIconId || current.iconId != null)) return null;
			if (options?.federate !== false && options?.deletedIconId == null && current.isArchived && (params.iconId !== undefined || params.iconDecorations !== undefined)) throw new ChatRoomArchivedError();
			if (options?.deletedIconId != null) resetOwner = await manager.findOne(MiUser, { where: { id: current.ownerId } });
			const revision = remoteUpdatedAt ?? (options?.federate === false || resetOwner?.host != null ? current.lastRemoteUpdatedAt : new Date(Math.max(Date.now(), (current.lastRemoteUpdatedAt?.getTime() ?? 0) + 1)));
			const iconFileId = options?.deletedIconId != null || params.iconId === undefined ? current.iconFileId : params.iconId;
			await manager.update(MiChatRoom, current.id, { ...patch, iconFileId, lastRemoteUpdatedAt: revision });
			const updated = { ...current, ...patch, iconFileId, lastRemoteUpdatedAt: revision };
			return snapshot != null ? this.chatRoomChannelService.applyRemote(manager, updated, snapshot) : updated;
		});
		if (updated == null) return room;

		const merged = { ...room, ...updated };
		if (snapshot != null) {
			await this.cleanChannelUnread(merged);
			this.globalEventService.publishChatRoomStream(merged.id, 'channelsUpdated', { roomId: merged.id });
		}
		this.globalEventService.publishChatRoomStream(merged.id, 'roomUpdated', {
			roomId: merged.id,
			name: merged.name,
			description: merged.description,
			isArchived: merged.isArchived,
			hasChannels: merged.hasChannels,
			...(params.iconId !== undefined || params.iconDecorations !== undefined ? await this.chatEntityService.packRoomIcon(merged) : {}),
		});

		const owner = resetOwner ?? await this.usersRepository.findOneBy({ id: merged.ownerId });
		if (owner != null && owner.host == null && merged.isArchived && !wasArchived) {
			// 残っている参加者は定期的な読み直しでも外れるが、それを待たずに通話を閉じる
			this.liveKitService.deleteRoom(merged.id).catch(() => {});
		}
		const participants = [...await this.participantsForRoom(merged), ...await this.inviteesForRoom(merged)];
		this.notifyRoomListChanged(this.localUserIds(participants));
		if (options?.federate !== false && owner != null && owner.host == null) {
			await this.federateRoomUpdate(merged, owner);
		}

		if (options?.deletedIconId != null) {
			await this.chatRoomsRepository.update({ id: merged.id, iconId: IsNull(), iconFileId: options.deletedIconId }, { iconFileId: null });
		}

		return merged;
	}

	@bindThis
	public async notifyRoomChannelsChanged(roomId: string): Promise<void> {
		const room = await this.chatRoomsRepository.findOneByOrFail({ id: roomId });
		await this.cleanChannelUnread(room);
		this.globalEventService.publishChatRoomStream(roomId, 'channelsUpdated', { roomId });
		const members = await this.participantsForRoom(room);
		this.notifyRoomListChanged(this.localUserIds(members));
		const owner = await this.usersRepository.findOneByOrFail({ id: room.ownerId });
		if (owner.host == null) await this.federateRoomUpdate(room, owner);
	}

	private async cleanChannelUnread(room: MiChatRoom): Promise<void> {
		const members = this.localUserIds(await this.participantsForRoom(room));
		for (const userId of members) {
			const key = `newRoomChatUnreadChannels:${userId}:${room.id}`;
			let unread = await this.redisClient.smembers(key);
			if (unread.length === 0) {
				const marker = await this.redisClient.get(`newRoomChatMessageExists:${userId}:${room.id}`);
				const message = marker != null ? await this.chatMessagesRepository.findOneBy({ id: marker, toRoomId: room.id }) : null;
				if (message?.toRoomChannelId != null) {
					await this.redisClient.sadd(key, message.toRoomChannelId);
					unread = [message.toRoomChannelId];
				}
			}
			for (const channelId of unread) {
				try {
					await this.chatRoomChannelService.resolve(room, channelId);
				} catch (err) {
					if (!(err instanceof ChatChannelError)) throw err;
					await this.redisClient.eval(
						CLEAR_CHAT_CHANNEL_UNREAD,
						3, key, `newRoomChatMessageExists:${userId}:${room.id}`, `newChatMessagesExists:${userId}`, channelId, `room:${room.id}`,
					);
				}
			}
		}
		await this.chatRoomNotificationService.channelsChanged(room);
	}

	private async federateRoomUpdate(room: MiChatRoom, owner: MiUser): Promise<void> {
		const snapshot = room.hasChannels ? await this.chatRoomChannelService.snapshot(room.id) : null;
		if (room.hasChannels && snapshot == null) return;
		room = snapshot?.room ?? room;
		const members = await this.participantsForRoom(room);
		const fields = snapshot?.fields ?? {};
		await this.deliverToRemoteUsers(owner, members, await this.apRendererService.renderChatRoomUpdate(room, owner, fields), undefined, room.hasChannels);
		const invitees = (await this.inviteesForRoom(room)).filter(user => !members.some(member => member.id === user.id));
		if (invitees.length > 0) await this.deliverToRemoteUsers(owner, invitees, await this.apRendererService.renderChatRoomUpdate(room, owner));
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
		channelId?: string | null;
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

		if (params.channelId != null) {
			if (params.roomId == null) throw new ChatChannelError('NO_SUCH_CHANNEL');
			const room = await this.chatRoomsRepository.findOneByOrFail({ id: params.roomId });
			await this.chatRoomChannelService.resolve(room, params.channelId);
			q.andWhere('message.toRoomChannelId = :channelId', { channelId: params.channelId });
		}

		q.andWhere('LOWER(message.text) LIKE :q', { q: `%${ sqlLikeEscape(query.toLowerCase()) }%` });
		this.excludeSuspendedAuthors(q);

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
				throw new ChatReactionInvalidError('no such emoji');
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

		const room = message.toRoomId ? await this.chatRoomsRepository.findOneBy({ id: message.toRoomId }) : null;
		// The room and its messages are being deleted at this moment.
		if (message.toRoomId != null && room == null) throw new ChatMessageAccessError('no such message');

		if (room) {
			if (!(await this.isRoomMember(room, userId))) {
				throw new ChatMessageAccessError('cannot react to others message');
			}
			if (room.isArchived) throw new ChatRoomArchivedError('room is archived');
		} else if (await this.userBlockingService.checkBlocked(message.fromUserId!, userId)) {
			throw new ChatMessageAccessError('blocked');
		}

		const pair = `${userId}/${reaction}`;
		if (message.reactions.includes(pair)) return;

		if (message.reactions.length >= MAX_REACTIONS_PER_MESSAGE) {
			throw new ChatTooManyReactionsError('too many reactions');
		}

		// Undo names one Like, so a second Like for the same reaction could never be withdrawn remotely.
		const result = await this.chatMessagesRepository.createQueryBuilder().update()
			.set({
				reactions: () => 'array_append("reactions", :pair)',
			})
			.where('id = :id', { id: message.id })
			.andWhere('"deletedAt" IS NULL')
			.andWhere('NOT (:pair = ANY("reactions"))')
			.setParameter('pair', pair)
			.execute();
		if (result.affected === 0) return;

		if (room) {
			this.globalEventService.publishChatRoomStream(room.id, 'react', {
				messageId: message.id,
				user: await this.userEntityService.pack(userId),
				reaction,
			});
		} else {
			this.globalEventService.publishChatUserStream(message.fromUserId!, message.toUserId!, 'react', {
				messageId: message.id,
				reaction,
			});
			this.globalEventService.publishChatUserStream(message.toUserId!, message.fromUserId!, 'react', {
				messageId: message.id,
				reaction,
			});
		}

		const actor = await this.usersRepository.findOneByOrFail({ id: userId });
		const participants = await this.participantsForMessage(message);
		if (!participants.some(user => this.userEntityService.isRemoteUser(user))) return;
		const toUsers = participants.filter(user => user.id !== actor.id);
		const messageUri = chatMessageUri(message, this.config.url);
		const activityId = `${this.userEntityService.genLocalUserUri(actor.id)}/chat-reactions/${randomUUID()}`;
		await this.redisClient.setex(this.chatReactionActivityIdKey(actor.id, messageUri, reaction), CHAT_REACTION_ACTIVITY_ID_TTL, activityId);
		await this.deliverToRemoteUsers(actor, participants, await this.apRendererService.renderChatReaction(message, actor, toUsers, reaction, activityId, await this.roomUriForMessage(message)), message);
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

		const room = message.toRoomId ? await this.chatRoomsRepository.findOneBy({ id: message.toRoomId }) : null;
		// The room and its messages are being deleted at this moment.
		if (message.toRoomId != null && room == null) throw new ChatMessageAccessError('no such message');

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
			.andWhere(':pair = ANY("reactions")')
			.setParameter('pair', `${userId}/${reaction}`)
			.execute();
		if (result.affected === 0) return;

		const packedUser = await this.userEntityService.pack(userId);
		if (room) {
			this.globalEventService.publishChatRoomStream(room.id, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
		} else {
			this.globalEventService.publishChatUserStream(message.fromUserId!, message.toUserId!, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
			this.globalEventService.publishChatUserStream(message.toUserId!, message.fromUserId!, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
		}

		const actor = await this.usersRepository.findOneByOrFail({ id: userId });
		const participants = await this.participantsForMessage(message);
		if (!participants.some(user => this.userEntityService.isRemoteUser(user))) return;
		const toUsers = participants.filter(user => user.id !== actor.id);
		const messageUri = chatMessageUri(message, this.config.url);
		const activityIdKey = this.chatReactionActivityIdKey(actor.id, messageUri, reaction);
		const activityId = await this.redisClient.get(activityIdKey) ?? undefined;
		await this.redisClient.del(activityIdKey);
		await this.deliverToRemoteUsers(actor, participants, await this.apRendererService.renderChatReactionUndo(message, actor, toUsers, reaction, activityId, await this.roomUriForMessage(message)), message);
	}

	@bindThis
	public async findMessageByUri(uri: string): Promise<MiChatMessage | null> {
		const message = await this.chatMessagesRepository.findOneBy({ uri });
		if (message != null) return message;

		const id = localChatMessageIdFromUri(uri, this.config.url);
		return id != null ? this.chatMessagesRepository.findOneBy({ id }) : null;
	}

	@bindThis
	public async updateRemoteMessage(actor: MiUser, message: MiChatMessage, text: string, editedAt: Date, emojis: string[] = [], refs?: unknown): Promise<MiChatMessage> {
		if (message.fromUserId !== actor.id) throw new ChatMessageAccessError('cannot edit');
		if (message.deletedAt != null) throw new ChatMessageAccessError('deleted');
		if (message.dice != null) throw new ChatMessageAccessError('dice message is immutable');
		if (message.editedAt != null && message.editedAt >= editedAt) return message;
		await this.assertCanStillEdit(message);
		const room = message.toRoomId != null ? await this.chatRoomsRepository.findOneBy({ id: message.toRoomId }) : null;
		if (room != null) await this.assertRemoteWriteAllowed(room);

		const trimmed = text.trim();
		if ((trimmed.length === 0 && !await this.hasFile(message)) || Array.from(trimmed).length > MAX_CHAT_MESSAGE_TEXT_LENGTH) throw new ChatMessageAccessError('invalid text');

		const channelRefs = room != null && room.hasChannels ? await this.chatRoomChannelService.remoteRefs(room, text, refs) : [];

		let newMentionUserIds: string[] = [];
		if (message.toRoomId != null) {
			const saved = await this.saveRoomMessageEdit(message, { text: trimmed, editedAt, emojis, channelRefs }, true);
			if (saved == null) return message;
			Object.assign(message, saved.message);
			newMentionUserIds = saved.newMentionUserIds;
		} else {
			const result = await this.chatMessagesRepository.update([
				{ id: message.id, fromUserId: actor.id, deletedAt: IsNull(), dice: IsNull(), editedAt: IsNull() },
				{ id: message.id, fromUserId: actor.id, deletedAt: IsNull(), dice: IsNull(), editedAt: LessThan(editedAt) },
			], { text: trimmed, editedAt, emojis, channelRefs });
			if (result.affected === 0) return message;
		}
		message.channelRefs = channelRefs;
		message.text = trimmed;
		message.editedAt = editedAt;
		message.emojis = emojis;

		const payload = {
			messageId: message.id,
			text: trimmed,
			channelRefs,
			editedAt: editedAt.toISOString(),
			emojis: actor.host == null ? {} : await this.customEmojiService.populateEmojis(emojis, actor.host),
		};
		if (message.toUserId) {
			this.globalEventService.publishChatUserStream(actor.id, message.toUserId, 'updated', payload);
			this.globalEventService.publishChatUserStream(message.toUserId, actor.id, 'updated', payload);
		} else if (message.toRoomId) {
			this.globalEventService.publishChatRoomStream(message.toRoomId, 'updated', { ...payload, newMentionUserIds });
			await this.chatRoomNotificationService.notify(this.localUserIds(await this.participantsForMessage(message)));
			if (newMentionUserIds.length) this.scheduleRoomNotification(message.id, newMentionUserIds);
		}

		if (room != null) await this.relayToOtherServers(room, actor, (owner, toUsers) => this.apRendererService.renderChatRoomRelay(message, room, owner, toUsers, editedAt), message);

		return message;
	}

	/** @param options.activity What arrived, for the owner's server to pass on. */
	@bindThis
	public async deleteRemoteMessage(actor: MiUser, message: MiChatMessage, options?: { activity?: IObject }): Promise<MiChatMessage> {
		if (message.fromUserId !== actor.id) {
			const author = message.fromUserId != null ? await this.usersRepository.findOneBy({ id: message.fromUserId }) : null;
			if (message.fromUserId != null ? author == null || this.userEntityService.isLocalUser(author) : message.archivedAuthor?.host == null) throw new ChatMessageAccessError('cannot delete');
			// The room's owner moderates it, including what someone else wrote.
			const room = message.toRoomId != null ? await this.chatRoomsRepository.findOneBy({ id: message.toRoomId }) : null;
			if (room?.ownerId !== actor.id) throw new ChatMessageAccessError('cannot delete');
		}
		if (message.deletedAt != null) return message;

		const deletedAt = new Date();
		await this.removeMessageContent(message, deletedAt);
		message.text = null;
		message.dice = null;
		message.fileIds = [];
		message.reactions = [];
		message.deletedAt = deletedAt;

		if (message.toUserId) {
			this.globalEventService.publishChatUserStream(message.fromUserId!, message.toUserId, 'deleted', message.id);
			this.globalEventService.publishChatUserStream(message.toUserId, message.fromUserId!, 'deleted', message.id);
		} else if (message.toRoomId) {
			this.globalEventService.publishChatRoomStream(message.toRoomId, 'deleted', message.id);
		}

		await this.relayRoomActivity(message, actor, options?.activity);

		return message;
	}

	/** @param options.activity What arrived, for the owner's server to pass on. */
	@bindThis
	public async reactRemote(actor: MiUser, message: MiChatMessage, reaction_: string, activityId?: string, options?: { activity?: IObject }): Promise<void> {
		const reaction = this.normalizeRemoteReaction(reaction_, actor.host);

		if (message.deletedAt != null) throw new ChatMessageAccessError('deleted');
		if (message.fromUserId === actor.id) throw new ChatMessageAccessError('cannot react to own message');

		const room = message.toRoomId ? await this.chatRoomsRepository.findOneBy({ id: message.toRoomId }) : null;
		// The room and its messages are being deleted at this moment.
		if (message.toRoomId != null && room == null) throw new ChatMessageAccessError('no such message');

		if (room) {
			if (!(await this.isRoomMember(room, actor.id))) throw new ChatMessageAccessError('cannot react to others message');
			await this.assertRemoteWriteAllowed(room);
		} else if (message.toUserId !== actor.id) {
			throw new ChatMessageAccessError('cannot react to others message');
		} else if (await this.userBlockingService.checkBlocked(message.fromUserId!, actor.id)) {
			throw new ChatMessageAccessError('blocked');
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
			this.globalEventService.publishChatUserStream(message.fromUserId!, message.toUserId!, 'react', {
				messageId: message.id,
				reaction,
			});
			this.globalEventService.publishChatUserStream(message.toUserId!, message.fromUserId!, 'react', {
				messageId: message.id,
				reaction,
			});
		}

		await this.relayRoomActivity(message, actor, options?.activity);
	}

	/** @param options.activity What arrived, for the owner's server to pass on. */
	@bindThis
	public async unreactRemote(actor: MiUser, message: MiChatMessage, reaction_: string, activityId?: string, options?: { activity?: IObject }): Promise<void> {
		const reaction = this.normalizeRemoteReaction(reaction_, actor.host);

		if (message.deletedAt != null) throw new ChatMessageAccessError('deleted');

		const room = message.toRoomId ? await this.chatRoomsRepository.findOneBy({ id: message.toRoomId }) : null;
		// The room and its messages are being deleted at this moment.
		if (message.toRoomId != null && room == null) throw new ChatMessageAccessError('no such message');

		if (room) {
			// Someone who has left can still take their reaction back, and this only ever removes their own.
			await this.assertRemoteWriteAllowed(room);
		} else if (message.fromUserId !== actor.id && message.toUserId !== actor.id) {
			throw new ChatMessageAccessError('cannot unreact to others message');
		}

		if (!await this.recordRemoteReactionActivity(actor, message, reaction, activityId, true)) return;
		const pair = `${actor.id}/${reaction}`;
		const result = await this.chatMessagesRepository.createQueryBuilder().update()
			.set({ reactions: () => 'array_remove("reactions", :pair)' })
			.where('id = :id', { id: message.id })
			.andWhere('"deletedAt" IS NULL')
			.andWhere(':pair = ANY("reactions")')
			.setParameter('pair', pair)
			.execute();
		message.reactions = message.reactions.filter(value => value !== pair);
		// The same Undo can reach this server once per member here, and only the first one changes anything.
		if (result.affected === 0) return;

		const packedUser = await this.userEntityService.pack(actor.id);
		if (room) {
			this.globalEventService.publishChatRoomStream(room.id, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
		} else {
			this.globalEventService.publishChatUserStream(message.fromUserId!, message.toUserId!, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
			this.globalEventService.publishChatUserStream(message.toUserId!, message.fromUserId!, 'unreact', {
				messageId: message.id,
				user: packedUser,
				reaction,
			});
		}

		await this.relayRoomActivity(message, actor, options?.activity);
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
			// NX keeps this a fixed window: extending it on every call would lock out a busy actor for good.
			const counted = await this.redisClient.multi().incr(countKey).expire(countKey, PENDING_CHAT_REACTION_TTL, 'NX').exec();
			const count = counted?.[0]?.[1];
			if (typeof count !== 'number' || count > MAX_PENDING_CHAT_REACTIONS_PER_ACTOR) throw new ChatMessageAccessError('too many reaction activities');
		}

		states[id] = !undo;
		await this.redisClient.setex(key, PENDING_CHAT_REACTION_TTL, JSON.stringify(states));
		// An older Undo removes only its own addition, preserving a newer re-add even out of order.
		return !undo || !Object.values(states).some(active => active);
	}

	/**
	 * @param options.roomId The room owner passed this on, which is only good for a message of that room.
	 * @param options.activity What arrived, for the owner's server to pass on. Left out when it is unreasonably long.
	 */
	@bindThis
	public async storePendingChatReaction(actorId: MiUser['id'], messageUri: string, reaction: string, undo: boolean, activityId?: string, options?: { roomId?: MiChatRoom['id']; activity?: IObject }): Promise<boolean> {
		if (reaction.length > MAX_PENDING_CHAT_REACTION_LENGTH) return false;
		if (activityId != null && (typeof activityId !== 'string' || activityId.length === 0 || activityId.length > MAX_REMOTE_REACTION_ACTIVITY_ID_LENGTH)) return false;

		// Any actor can name any URI here, so bound what one actor can keep in Redis until the TTL.
		const countKey = `chat_pending_reaction_count:${actorId}`;
		const counted = await this.redisClient.multi().incr(countKey).expire(countKey, PENDING_CHAT_REACTION_TTL, 'NX').exec();
		const count = counted?.[0]?.[1];
		if (typeof count !== 'number' || count > MAX_PENDING_CHAT_REACTIONS_PER_ACTOR) return false;

		const activity = options?.activity != null && JSON.stringify(options.activity).length <= MAX_PENDING_CHAT_ACTIVITY_LENGTH ? options.activity : undefined;

		const key = `chat_pending_reaction_events:${messageUri}`;
		// A set loses both arrival order and repeated react/undo transitions.
		await this.redisClient.multi()
			.rpush(key, JSON.stringify({ actorId, reaction, undo, activityId, roomId: options?.roomId, activity }))
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
				const parsed = JSON.parse(entry) as { actorId?: unknown; reaction?: unknown; undo?: unknown; activityId?: unknown; roomId?: unknown; activity?: unknown };
				if (typeof parsed.actorId !== 'string' || typeof parsed.reaction !== 'string' || typeof parsed.undo !== 'boolean') continue;
				if (parsed.activityId != null && typeof parsed.activityId !== 'string') continue;
				if (parsed.roomId != null && parsed.roomId !== message.toRoomId) continue;
				const actor = await this.usersRepository.findOneBy({ id: parsed.actorId });
				if (actor == null || actor.host == null || actor.isSuspended) continue;

				const activity = parsed.activity != null && typeof parsed.activity === 'object' ? parsed.activity as IObject : undefined;
				if (parsed.undo) {
					await this.unreactRemote(actor, message, parsed.reaction, parsed.activityId as string | undefined, { activity });
				} else {
					await this.reactRemote(actor, message, parsed.reaction, parsed.activityId as string | undefined, { activity });
				}
			} catch {
				// A malformed deferred reaction must not prevent the message from being stored.
				continue;
			}
		}
	}

	/**
	 * A custom emoji name only means something on the server that sent it, so it is stored
	 * with the actor's host rather than resolving to a local emoji that happens to share the name.
	 */
	@bindThis
	public normalizeRemoteReaction(reaction: string, actorHost: MiUser['host']): string {
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
	@bindThis
	public async assertRemoteWriteAllowed(room: MiChatRoom): Promise<void> {
		if (!room.isArchived) return;
		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (owner?.host == null) throw new ChatMessageAccessError('room is archived');
	}

	/** Nothing refers to a file by a foreign key, so one can be gone by now. A message without text and files would have nothing to show. */
	private async hasFile(message: MiChatMessage): Promise<boolean> {
		return message.fileIds.length > 0 && await this.driveFilesRepository.countBy({ id: In(message.fileIds) }) > 0;
	}

	private async assertMessageRoomNotArchived(message: MiChatMessage): Promise<void> {
		if (message.toRoomId == null) return;
		const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
		if (room?.isArchived) throw new ChatRoomArchivedError('room is archived');
	}

	/** Creating a message checks these too; an edit must not be a way around them. */
	private async assertCanStillEdit(message: MiChatMessage): Promise<void> {
		if (message.fromUserId == null) throw new ChatMessageAccessError('cannot edit');
		if (message.toRoomId != null) {
			const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
			if (room == null || !(await this.isRoomMember(room, message.fromUserId))) throw new ChatMessageAccessError('cannot edit');
		} else if (message.toUserId != null && await this.userBlockingService.checkBlocked(message.toUserId, message.fromUserId)) {
			throw new ChatMessageAccessError('cannot edit');
		}
	}

	private chatReactionActivityIdKey(actorId: MiUser['id'], messageUri: string, reaction: string): string {
		return `chat_reaction_activity_id:${messageUri}:${actorId}:${encodeURIComponent(reaction)}`;
	}

	private async participantsForRoom(room: MiChatRoom): Promise<MiUser[]> {
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		const ids = Array.from(new Set([room.ownerId, ...memberships.map(membership => membership.userId)]));
		return this.usersRepository.findBy({ id: In(ids) });
	}

	// 招待中の相手のサーバーにもミラーがあるので、受諾する前の変更も知らせる
	private async inviteesForRoom(room: MiChatRoom): Promise<MiUser[]> {
		const invitations = await this.chatRoomInvitationsRepository.findBy({ roomId: room.id });
		return invitations.length > 0 ? await this.usersRepository.findBy({ id: In(invitations.map(invitation => invitation.userId)) }) : [];
	}

	private async roomUriForMessage(message: MiChatMessage): Promise<string | undefined> {
		if (message.toRoomId == null) return undefined;
		const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
		return room != null ? await this.roomUriForRoom(room) : undefined;
	}

	private async roomUriForRoom(room: MiChatRoom): Promise<string> {
		if (room.uri != null) return room.uri;
		return chatRoomUriForOwner(room, await this.usersRepository.findOneBy({ id: room.ownerId }), this.config.url);
	}

	private async participantsForMessage(message: MiChatMessage): Promise<MiUser[]> {
		if (message.toUserId) {
			return this.usersRepository.findBy({ id: In([message.fromUserId!, message.toUserId]) });
		}

		if (message.toRoomId) {
			const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
			return room != null ? await this.participantsForRoom(room) : [];
		}

		return [];
	}

	private async deliverToRemoteUsers(actor: MiUser, users: MiUser[], activity: any, message?: MiChatMessage, channelState = false): Promise<void> {
		const room = message?.toRoomId != null ? await this.chatRoomsRepository.findOneBy({ id: message.toRoomId }) : null;
		const contextedActivity = this.apRendererService.addContext(activity);
		const delivered = new Set<string>();

		for (const user of users) {
			if (user.id === actor.id) continue;
			if (!this.userEntityService.isRemoteUser(user)) continue;
			if (user.isSuspended && !ACTIVITIES_FOR_SUSPENDED_ACCOUNTS.has(activity.type)) continue;

			if (message?.toRoomId != null && room == null) continue;

			// Every recipient is named in the activity, so a server needs it only once however many members it has.
			const inbox = user.sharedInbox ?? user.inbox;
			if (inbox == null || delivered.has(inbox)) continue;

			delivered.add(inbox);
			const needsCapability = channelState || (message != null && room?.hasChannels === true && (message.toRoomChannelId == null || message.toRoomChannelId !== room.legacyChannelId));
			if (needsCapability) {
				await this.chatRoomChannelService.deliverWithCapability(actor, contextedActivity, inbox, user.sharedInbox != null, user.host);
			} else {
				this.queueService.deliver(actor, contextedActivity, inbox, user.sharedInbox != null);
			}
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
