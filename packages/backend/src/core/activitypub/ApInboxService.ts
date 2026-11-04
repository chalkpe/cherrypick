/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { ReactionService } from '@/core/ReactionService.js';
import { RelayService } from '@/core/RelayService.js';
import { NotePiningService } from '@/core/NotePiningService.js';
import { UserBlockingService } from '@/core/UserBlockingService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { ChatMessageAccessError, ChatService, MAX_CHAT_MESSAGE_TEXT_LENGTH, MAX_REMOTE_CHAT_MESSAGE_FILES, MAX_ROOM_MEMBERS } from '@/core/ChatService.js';
import { HostPolicyService } from '@/core/HostPolicyService.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';
import { truncate } from '@/misc/truncate.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { RoleService } from '@/core/RoleService.js';
import { acquireApObjectLock } from '@/misc/distributed-lock.js';
import { concat, toArray, toSingle, unique } from '@/misc/prelude/array.js';
import type Logger from '@/logger.js';
import { IdService } from '@/core/IdService.js';
import { StatusError } from '@/misc/status-error.js';
import { UtilityService } from '@/core/UtilityService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { QueueService } from '@/core/QueueService.js';
import { MiChatRoomInvitation, MiChatRoomMembership, type UsersRepository, type NotesRepository, type FollowingsRepository, type AbuseUserReportsRepository, type FollowRequestsRepository, type MiChatMessage, type MiChatRoom, type MiMeta, type ChatMessagesRepository, type ChatRoomsRepository, type ChatRoomInvitationsRepository, type ChatRoomMembershipsRepository } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import type { MiLocalUser, MiRemoteUser, MiUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { AbuseReportService } from '@/core/AbuseReportService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { getApHrefNullable, getApId, getApIds, getApType, getOneApId, isAccept, isActor, isAdd, isAnnounce, isBlock, isCollection, isCollectionOrOrderedCollection, isCreate, isDelete, isFlag, isFollow, isInvite, isLike, isMove, isPost, isReject, isRemove, isTombstone, isUndo, isUpdate, validActor, validPost } from './type.js';
import { ApNoteService } from './models/ApNoteService.js';
import { ApLoggerService } from './ApLoggerService.js';
import { ApDbResolverService } from './ApDbResolverService.js';
import { ApResolverService } from './ApResolverService.js';
import { ApAudienceService } from './ApAudienceService.js';
import { ApPersonService } from './models/ApPersonService.js';
import { ApQuestionService } from './models/ApQuestionService.js';
import { ApImageService } from './models/ApImageService.js';
import { ApMfmService } from './ApMfmService.js';
import type { Resolver } from './ApResolverService.js';
import type { IAccept, IAdd, IAnnounce, IBlock, ICreate, IDelete, IFlag, IFollow, IInvite, ILike, IObject, IRead, IReject, IRemove, IUndo, IUpdate, IMove, IPost } from './type.js';

const PENDING_ROOM_ACTIVITY_TTL = 6 * 60 * 60;
const MAX_PENDING_ROOM_ACTIVITIES = 100;
const MAX_PENDING_ROOM_ACTIVITY_ATTEMPTS = 3;
const MAX_PENDING_ROOMS_PER_ACTOR = 100;
const DEFERRED_CHAT_DELETE_TTL = 6 * 60 * 60;
const ROOM_FULL = 'skip: room is full';
const ROOM_ARCHIVED = 'skip: room is archived';
const MAX_DEFERRED_CHAT_DELETES_PER_ACTOR = 1000;

@Injectable()
export class ApInboxService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.followRequestsRepository)
		private followRequestsRepository: FollowRequestsRepository,

		@Inject(DI.chatMessagesRepository)
		private chatMessagesRepository: ChatMessagesRepository,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomInvitationsRepository)
		private chatRoomInvitationsRepository: ChatRoomInvitationsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		@Inject(DI.db)
		private db: DataSource,

		private userEntityService: UserEntityService,
		private noteEntityService: NoteEntityService,
		private utilityService: UtilityService,
		private hostPolicyService: HostPolicyService,
		private idService: IdService,
		private abuseReportService: AbuseReportService,
		private userFollowingService: UserFollowingService,
		private apAudienceService: ApAudienceService,
		private reactionService: ReactionService,
		private relayService: RelayService,
		private notePiningService: NotePiningService,
		private userBlockingService: UserBlockingService,
		private noteCreateService: NoteCreateService,
		private noteDeleteService: NoteDeleteService,
		private notificationService: NotificationService,
		private chatService: ChatService,
		private chatVoiceService: ChatVoiceService,
		private liveKitService: LiveKitService,
		private roleService: RoleService,
		private apRendererService: ApRendererService,
		private apResolverService: ApResolverService,
		private apDbResolverService: ApDbResolverService,
		private apLoggerService: ApLoggerService,
		private apNoteService: ApNoteService,
		private apPersonService: ApPersonService,
		private apQuestionService: ApQuestionService,
		private apImageService: ApImageService,
		private apMfmService: ApMfmService,
		private queueService: QueueService,
		private globalEventService: GlobalEventService,
	) {
		this.logger = this.apLoggerService.logger;
	}

	@bindThis
	public async performActivity(actor: MiRemoteUser, activity: IObject, resolver?: Resolver): Promise<string | void> {
		let result = undefined as string | void;
		if (isCollectionOrOrderedCollection(activity)) {
			const results = [] as [string, string | void][];
			// eslint-disable-next-line no-param-reassign
			resolver ??= await this.apResolverService.createResolver();

			const items = toArray(isCollection(activity) ? activity.items : activity.orderedItems);
			if (items.length >= resolver.getRecursionLimit()) {
				throw new Error(`skipping activity: collection would surpass recursion limit: ${this.utilityService.extractDbHost(actor.uri)}`);
			}

			for (const item of items) {
				const act = await resolver.resolve(item);
				if (act.id == null || this.utilityService.extractDbHost(act.id) !== this.utilityService.extractDbHost(actor.uri)) {
					this.logger.debug('skipping activity: activity id is null or mismatching');
					continue;
				}
				try {
					results.push([getApId(item), await this.performOneActivity(actor, act, resolver)]);
				} catch (err) {
					if (err instanceof Error || typeof err === 'string') {
						this.logger.error(err);
					} else {
						throw err;
					}
				}
			}

			const hasReason = results.some(([, reason]) => (reason != null && !reason.startsWith('ok')));
			if (hasReason) {
				result = results.map(([id, reason]) => `${id}: ${reason}`).join('\n');
			}
		} else {
			result = await this.performOneActivity(actor, activity, resolver);
		}

		// ついでにリモートユーザーの情報が古かったら更新しておく
		if (actor.uri) {
			if (actor.lastFetchedAt == null || Date.now() - actor.lastFetchedAt.getTime() > 1000 * 60 * 60 * 24) {
				setImmediate(() => {
					// 同一ユーザーの情報を再度処理するので、使用済みのresolverを再利用してはいけない
					this.apPersonService.updatePerson(actor.uri);
				});
			}
		}
		return result;
	}

	@bindThis
	public async performOneActivity(actor: MiRemoteUser, activity: IObject, resolver?: Resolver): Promise<string | void> {
		if (actor.isSuspended) return;

		if (isCreate(activity)) {
			return await this.create(actor, activity, resolver);
		} else if (isDelete(activity)) {
			return await this.delete(actor, activity);
		} else if (isUpdate(activity)) {
			return await this.update(actor, activity, resolver);
		} else if (isFollow(activity)) {
			return await this.follow(actor, activity);
		} else if (isAccept(activity)) {
			return await this.accept(actor, activity, resolver);
		} else if (isReject(activity)) {
			return await this.reject(actor, activity, resolver);
		} else if (isAdd(activity)) {
			return await this.add(actor, activity, resolver);
		} else if (isRemove(activity)) {
			return await this.remove(actor, activity, resolver);
		} else if (isAnnounce(activity)) {
			return await this.announce(actor, activity, resolver);
		} else if (isLike(activity)) {
			return await this.like(actor, activity);
		} else if (isUndo(activity)) {
			return await this.undo(actor, activity, resolver);
		} else if (isBlock(activity)) {
			return await this.block(actor, activity);
		} else if (isFlag(activity)) {
			return await this.flag(actor, activity);
		} else if (isMove(activity)) {
			return await this.move(actor, activity, resolver);
		} else if (isInvite(activity)) {
			return await this.invite(actor, activity, resolver);
		} else {
			return `unrecognized activity type: ${activity.type}`;
		}
	}

	@bindThis
	private async follow(actor: MiRemoteUser, activity: IFollow): Promise<string> {
		const followee = await this.apDbResolverService.getUserFromApId(activity.object);

		if (followee == null) {
			return 'skip: followee not found';
		}

		if (followee.host != null) {
			return 'skip: フォローしようとしているユーザーはローカルユーザーではありません';
		}

		// don't queue because the sender may attempt again when timeout
		await this.userFollowingService.follow(actor, followee, { requestId: activity.id });
		return 'ok';
	}

	@bindThis
	private async like(actor: MiRemoteUser, activity: ILike): Promise<string> {
		const targetUri = getApId(activity.object);
		const { isChatMessage, chatMessage, note } = await this.findReactionTarget(targetUri);

		if (isChatMessage && note == null) {
			const reaction = activity._misskey_reaction ?? activity.content ?? activity.name;
			if (typeof reaction !== 'string' || reaction === '') return 'skip: empty reaction';
			await this.apNoteService.extractEmojis(activity.tag ?? [], actor.host).catch(() => null);
			return await this.applyChatReaction(actor, targetUri, chatMessage, reaction, false, activity.id);
		}

		if (!note) return `skip: target note not found ${targetUri}`;

		await this.apNoteService.extractEmojis(activity.tag ?? [], actor.host).catch(() => null);

		try {
			await this.reactionService.create(actor, note, activity._misskey_reaction ?? activity.content ?? activity.name);
			return 'ok';
		} catch (err) {
			if (err instanceof IdentifiableError && err.id === '51c42bb4-931a-456b-bff7-e5a8a70dd298') {
				return 'skip: already reacted';
			} else {
				throw err;
			}
		}
	}

	/**
	 * A reply from another server is stored as a chat message under that server's own URI.
	 * Reactions to notes are frequent, so chat messages are looked up only when no note matches.
	 */
	private async findReactionTarget(uri: string): Promise<{ isChatMessage: boolean; chatMessage: MiChatMessage | null; note: MiNote | null; }> {
		if (this.isChatMessageUri(uri)) {
			const chatMessage = await this.chatService.findMessageByUri(uri);
			return { isChatMessage: true, chatMessage, note: chatMessage == null ? await this.apNoteService.fetchNote(uri) : null };
		}

		const note = await this.apNoteService.fetchNote(uri);
		if (note != null) return { isChatMessage: false, chatMessage: null, note };

		const chatMessage = await this.chatService.findMessageByUri(uri);
		return { isChatMessage: chatMessage != null, chatMessage, note: null };
	}

	/**
	 * A reaction can overtake its message. createChatMessage inserts the message and drains the
	 * deferred reactions under this lock, so the final lookup and the deferral must hold it too.
	 */
	private async applyChatReaction(actor: MiRemoteUser, targetUri: string, known: MiChatMessage | null, reaction: string, undo: boolean, activityId?: string): Promise<string> {
		const apply = async (message: MiChatMessage): Promise<string> => {
			try {
				if (undo) {
					await this.chatService.unreactRemote(actor, message, reaction, activityId);
				} else {
					await this.chatService.reactRemote(actor, message, reaction, activityId);
				}
				return 'ok';
			} catch (err) {
				if (err instanceof ChatMessageAccessError) return `skip: ${err.message}`;
				throw err;
			}
		};
		if (known != null && activityId == null) return await apply(known);

		const unlock = await acquireApObjectLock(this.redisClient, targetUri);
		try {
			const message = await this.chatService.findMessageByUri(targetUri);
			if (message != null) return await apply(message);

			const stored = await this.chatService.storePendingChatReaction(actor.id, targetUri, reaction, undo, activityId);
			if (!stored) return 'skip: chat reaction was not deferred';
			return undo ? 'ok: pending chat Unreact' : 'ok: pending chat reaction';
		} finally {
			await unlock();
		}
	}

	@bindThis
	private async accept(actor: MiRemoteUser, activity: IAccept, resolver?: Resolver): Promise<string> {
		const uri = activity.id ?? activity;

		this.logger.info(`Accept: ${uri}`);

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		const object = await resolver.resolve(activity.object).catch(err => {
			this.logger.error(`Resolution failed: ${err}`);
			throw err;
		});

		if (isFollow(object)) return await this.acceptFollow(actor, object);
		if (isInvite(object)) return await this.acceptInvite(actor, object);

		return `skip: Unknown Accept type: ${getApType(object)}`;
	}

	@bindThis
	private async acceptFollow(actor: MiRemoteUser, activity: IFollow): Promise<string> {
		// ※ activityはこっちから投げたフォローリクエストなので、activity.actorは存在するローカルユーザーである必要がある

		const follower = await this.apDbResolverService.getUserFromApId(activity.actor);

		if (follower == null) {
			return 'skip: follower not found';
		}

		if (follower.host != null) {
			return 'skip: follower is not a local user';
		}

		// relay
		const match = activity.id?.match(/follow-relay\/(\w+)/);
		if (match) {
			return await this.relayService.relayAccepted(match[1], actor);
		}

		await this.userFollowingService.acceptFollowRequest(actor, follower);
		return 'ok';
	}

	@bindThis
	private async acceptInvite(actor: MiRemoteUser, activity: IInvite): Promise<string> {
		// actor is the one who accepted the invitation (invitee)
		// activity.target should be the actor who accepted
		// activity.object should be the room

		const roomObject = activity.object;
		if (typeof roomObject === 'string') return 'skip: object must be a full object, not a URI';

		const roomUri = getApId(roomObject);
		if (!roomUri) return 'skip: invalid room object';

		// Extract room ID from URI
		const roomIdMatch = roomUri.match(/\/chat\/rooms\/([a-zA-Z0-9]+)$/);
		if (!roomIdMatch) return 'skip: invalid room URI format';
		const roomId = roomIdMatch[1];

		// Find the room
		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (!room) {
			this.logger.warn(`Room not found: ${roomId}`);
			return 'skip: room not found';
		}

		// Only an actor we actually invited may join.
		// The room URI is rendered on the invitee's server, so its host says nothing about the room.
		// Consuming the invitation and creating the membership must be atomic:
		// - the conditional delete is the concurrency guard, so a cancelled or
		//   concurrently consumed invitation cannot add a membership;
		// - a failed membership insert rolls the delete back, so the invitation
		//   is not lost and the actor can retry.
		const result = await this.db.transaction(async (manager) => {
			const consumed = await manager.delete(MiChatRoomInvitation, {
				roomId: room.id,
				userId: actor.id,
			});
			if (consumed.affected !== 1) {
				return 'skip: invitation not found';
			}

			// The owner is always a member, so there is nothing to insert.
			if (room.ownerId === actor.id) {
				return 'ok';
			}

			const existingMembership = await manager.findOneBy(MiChatRoomMembership, {
				roomId: room.id,
				userId: actor.id,
			});
			if (existingMembership != null) {
				this.logger.info(`User ${actor.id} is already a member of room ${roomId}`);
				return 'ok';
			}

			// Commit the delete: the invitee's server consumed its copy before sending Accept,
			// so the invitation can never be accepted again and would only block a new one.
			if (room.isArchived) return ROOM_ARCHIVED;

			const membershipsCount = await manager.countBy(MiChatRoomMembership, { roomId: room.id });
			if (membershipsCount >= MAX_ROOM_MEMBERS) return ROOM_FULL;

			const membership = {
				id: this.idService.gen(),
				roomId: room.id,
				userId: actor.id,
			};

			await manager.insert(MiChatRoomMembership, membership);

			this.logger.info(`Remote user ${actor.id} accepted invitation and joined room ${roomId}`);
			return 'ok';
		});

		if (result === ROOM_FULL || result === ROOM_ARCHIVED) {
			await this.revokeRemoteJoin(room, actor);
			return result;
		}
		if (result !== 'ok') return result;

		this.globalEventService.publishChatRoomStream(room.id, 'membershipStarted', { userId: actor.id });

		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (owner == null) return result;

		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		const memberIds = Array.from(new Set([owner.id, ...memberships.map(membership => membership.userId)]));
		const members = await this.usersRepository.findBy({ id: In(memberIds) });
		const roomActivityUri = this.apRendererService.genLocalChatRoomUri(room.id);
		const uriOf = (user: MiUser) => this.userEntityService.isLocalUser(user) ? this.userEntityService.genLocalUserUri(user.id) : user.uri!;

		for (const member of members) {
			// A room's owner is known from the room itself, so only the other members need announcing.
			if (member.id === actor.id || member.id === owner.id) continue;
			const activity = this.apRendererService.addContext({
				...this.apRendererService.renderAdd(owner as never, roomActivityUri, uriOf(member)),
				published: new Date().toISOString(),
			});
			if (actor.inbox != null) this.queueService.deliver(owner, activity, actor.inbox, false);
		}

		for (const member of members) {
			if (member.id === actor.id || member.id === owner.id) continue;
			if (!this.userEntityService.isRemoteUser(member) || member.isSuspended || member.inbox == null) continue;
			const activity = this.apRendererService.addContext({
				...this.apRendererService.renderAdd(owner as never, roomActivityUri, uriOf(actor)),
				published: new Date().toISOString(),
			});
			this.queueService.deliver(owner, activity, member.inbox, false);
		}

		return result;
	}

	/** The invitee's server added its membership before sending Accept, so it has to be told to drop it. */
	private async revokeRemoteJoin(room: MiChatRoom, invitee: MiRemoteUser): Promise<void> {
		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (owner == null || owner.host != null || invitee.inbox == null) return;

		const activity = this.apRendererService.addContext({
			...this.apRendererService.renderRemove(owner, this.apRendererService.genLocalChatRoomUri(room.id), invitee.uri),
			published: new Date().toISOString(),
		});
		this.queueService.deliver(owner, activity, invitee.inbox, false);
	}

	@bindThis
	private async add(actor: MiRemoteUser, activity: IAdd, resolver?: Resolver): Promise<string | void> {
		if (actor.uri !== getApId(activity.actor)) {
			return 'invalid actor';
		}

		if (activity.target == null) {
			return 'target is null';
		}

		const targetUri = getApId(activity.target);
		const roomIdMatch = targetUri.match(/\/chat\/rooms\/([a-zA-Z0-9]+)$/);
		if (roomIdMatch) {
			const room = await this.chatRoomsRepository.findOneBy({ id: roomIdMatch[1] });
			if (room == null) {
				return await this.storePendingRoomActivity(actor, activity) ? 'ok: room not found, activity deferred' : 'skip: room not found';
			}
			if (room.ownerId !== actor.id) return 'skip: only the room owner can add a member';

			const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
			if (memberships.length >= MAX_ROOM_MEMBERS) return 'skip: room is full';

			const userId = getApId(activity.object);
			const user = await this.apDbResolverService.getUserFromApId(userId) ?? await this.apPersonService.resolvePerson(userId, resolver);
			if (user == null) return 'skip: user not found';
			// Only a local invitation acceptance may grant membership to a local user.
			if (this.userEntityService.isLocalUser(user)) return 'skip: local membership is managed locally';
			if (user.id === room.ownerId) return 'skip: owner is already a member';

			const existing = await this.chatRoomMembershipsRepository.findOneBy({ roomId: room.id, userId: user.id });
			if (existing == null) {
				await this.chatRoomMembershipsRepository.insertOne({
					id: this.idService.gen(),
					roomId: room.id,
					userId: user.id,
				});
				this.globalEventService.publishChatRoomStream(room.id, 'membershipStarted', { userId: user.id });
			}

			return 'ok: chat room member added';
		}

		if (activity.target === actor.featured) {
			const note = await this.apNoteService.resolveNote(activity.object, { resolver });
			if (note == null) return 'note not found';
			await this.notePiningService.addPinned(actor, note.id);
			return;
		}

		return `unknown target: ${activity.target}`;
	}

	@bindThis
	private async announce(actor: MiRemoteUser, activity: IAnnounce, resolver?: Resolver): Promise<string | void> {
		const uri = getApId(activity);

		this.logger.info(`Announce: ${uri}`);

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		if (!activity.object) return 'skip: activity has no object property';
		const targetUri = getApId(activity.object);
		if (targetUri.startsWith('bear:')) return 'skip: bearcaps url not supported.';

		const chatRoomUri = this.chatRoomUriOf(activity as unknown as IPost);
		if (chatRoomUri != null) return await this.relayedChatMessage(actor, activity, targetUri, chatRoomUri, resolver);

		const target = await resolver.resolve(activity.object).catch(e => {
			this.logger.error(`Resolution failed: ${e}`);
			throw e;
		});

		if (isPost(target)) return await this.announceNote(actor, activity, target);

		return `skip: unknown object type ${getApType(target)}`;
	}

	/**
	 * The room owner points at a message it received from another member. Only the owner may do this,
	 * and the message itself comes from its author's server, so the owner cannot put words in a member's mouth.
	 */
	private async relayedChatMessage(actor: MiRemoteUser, activity: IAnnounce, messageUri: string, roomUri: string, resolver: Resolver): Promise<string> {
		if (!this.isOnActorHost(roomUri, actor)) return 'skip: room is not on the relaying server';
		// The inbox turns away what a refused server sends. A relay must not let that in through the owner, or sign a request to it as a member.
		if (await this.hostPolicyService.isRefusedRemoteHost(this.utilityService.extractDbHost(messageUri))) return 'skip: refused host';

		const roomId = roomUri.match(/\/chat\/rooms\/([a-zA-Z0-9]+)$/)?.[1];
		const room = roomId != null ? await this.chatRoomsRepository.findOneBy({ id: roomId }) : null;
		if (room == null) return 'skip: room not found';
		if (room.ownerId !== actor.id) return 'skip: only the room owner can relay';
		if (await this.chatService.findMessageByUri(messageUri) != null) return 'skip: chat message exists';

		const member = await this.localRoomMemberFrom(room, getApIds(activity.to), resolver);
		if (member == null) return 'skip: no local members in room';

		// Only this request speaks for the member. The resolver of the activity also fetches the next item of a
		// collection and the actors the message names, and createNote takes what it fetched as publicly readable.
		const memberResolver = await this.apResolverService.createResolver();
		memberResolver.signAs(member);

		let object: IObject;
		try {
			object = await memberResolver.resolve(messageUri);
		} catch (err) {
			// The author's server serves it to members only and may not have heard that ours joined yet.
			throw new Error(`relayed chat message is not available yet: ${messageUri}: ${err}`);
		}

		const note = object as IPost;
		if (getApType(note) !== 'Note' || note._misskey_talk !== true || note.id !== messageUri) return 'skip: relayed object is not a chat message';
		if (this.chatRoomUriOf(note) !== roomUri) return 'skip: relayed message is from another room';
		if (note.attributedTo == null) return 'skip: relayed message has no author';

		const author = await this.apPersonService.resolvePerson(getOneApId(note.attributedTo), resolver);
		if (!this.userEntityService.isRemoteUser(author) || author.isSuspended) return 'skip: invalid relayed message author';

		return await this.createChatMessage(resolver, author as MiRemoteUser, note, activity);
	}

	private async localRoomMemberFrom(room: MiChatRoom, uris: string[], resolver: Resolver): Promise<MiLocalUser | null> {
		for (const uri of uris) {
			const user = await this.apPersonService.resolvePerson(uri, resolver).catch(() => null);
			if (user != null && this.userEntityService.isLocalUser(user) && await this.chatService.isRoomMember(room, user.id)) return user;
		}
		return null;
	}

	@bindThis
	private async announceNote(actor: MiRemoteUser, activity: IAnnounce, target: IPost, resolver?: Resolver): Promise<string | void> {
		if (actor.isSuspended) {
			return;
		}

		// リレーからのAnnounceかチェック
		const fromRelay = await this.relayService.isRelayActor(actor);
		const uri = getApId(fromRelay ? target : activity);

		// アナウンス先が許可されているかチェック
		if (!this.utilityService.isFederationAllowedUri(uri)) return;

		const activityUri = getApId(activity);
		const unlock = await acquireApObjectLock(this.redisClient, activityUri);

		try {
			// 既に同じURIを持つものが登録されていないかチェック
			const exist = await this.apNoteService.fetchNote(fromRelay ? target : uri);
			if (exist) {
				return;
			}

			// Announce対象をresolve
			let renote;
			try {
				renote = await this.apNoteService.resolveNote(target, { resolver });
				if (renote == null) return 'announce target is null';
			} catch (err) {
				// 対象が4xxならスキップ
				if (err instanceof StatusError) {
					if (!err.isRetryable) {
						return `Ignored announce target ${target.id} - ${err.statusCode}`;
					}
					return `Error in announce target ${target.id} - ${err.statusCode}`;
				}
				throw err;
			}

			// リレーからのAnnounceはリノートを作成せず、ノートを直接公開する
			if (fromRelay) {
				this.logger.info(`Publishing relay-delivered note: ${uri}`);
				const noteObj = await this.noteEntityService.pack(renote, null, { skipHide: true, withReactionAndUserPairCache: true });
				this.globalEventService.publishNotesStream(noteObj);
				return;
			}

			if (!await this.noteEntityService.isVisibleForMe(renote, actor.id)) {
				return 'skip: invalid actor for this activity';
			}

			if (fromRelay) {
				const noteObj = await this.noteEntityService.pack(renote);
				this.globalEventService.publishNotesStream(noteObj);
				return;
			}

			this.logger.info(`Creating the (Re)Note: ${uri}`);

			const activityAudience = await this.apAudienceService.parseAudience(actor, activity.to, activity.cc, resolver);
			const createdAt = activity.published ? new Date(activity.published) : null;

			if (createdAt && createdAt < this.idService.parse(renote.id).date) {
				return 'skip: malformed createdAt';
			}

			await this.noteCreateService.create(actor, {
				createdAt,
				renote,
				visibility: activityAudience.visibility,
				visibleUsers: activityAudience.visibleUsers,
				uri,
			});
		} finally {
			unlock();
		}
	}

	@bindThis
	private async block(actor: MiRemoteUser, activity: IBlock): Promise<string> {
		// ※ activity.objectにブロック対象があり、それは存在するローカルユーザーのはず

		const blockee = await this.apDbResolverService.getUserFromApId(activity.object);

		if (blockee == null) {
			return 'skip: blockee not found';
		}

		if (blockee.host != null) {
			return 'skip: ブロックしようとしているユーザーはローカルユーザーではありません';
		}

		await this.userBlockingService.block(await this.usersRepository.findOneByOrFail({ id: actor.id }), await this.usersRepository.findOneByOrFail({ id: blockee.id }));
		return 'ok';
	}

	@bindThis
	private async create(actor: MiRemoteUser, activity: ICreate, resolver?: Resolver): Promise<string | void> {
		const uri = getApId(activity);

		this.logger.info(`Create: ${uri}`);

		if (!activity.object) return 'skip: activity has no object property';
		const targetUri = getApId(activity.object);
		if (targetUri.startsWith('bear:')) return 'skip: bearcaps url not supported.';

		// copy audiences between activity <=> object.
		if (typeof activity.object === 'object') {
			const to = unique(concat([toArray(activity.to), toArray(activity.object.to)]));
			const cc = unique(concat([toArray(activity.cc), toArray(activity.object.cc)]));

			activity.to = to;
			activity.cc = cc;
			activity.object.to = to;
			activity.object.cc = cc;
		}

		// If there is no attributedTo, use Activity actor.
		if (typeof activity.object === 'object' && !activity.object.attributedTo) {
			activity.object.attributedTo = activity.actor;
		}

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		const object = await resolver.resolve(activity.object).catch(e => {
			this.logger.error(`Resolution failed: ${e}`);
			throw e;
		});

		if (isPost(object)) {
			// Check if this is a chat message (legacy Misskey format)
			if (typeof object === 'object' && '_misskey_talk' in object && object._misskey_talk === true) {
				await this.createChatMessage(resolver, actor, object, activity);
			} else {
				// Check if this is a reply to a chat message
				// If so, treat it as a chat message even without `_misskey_talk` flag
				let isReplyToChatMessage = false;
				if (typeof object === 'object' && object.inReplyTo) {
					try {
						const inReplyToUri = getApId(object.inReplyTo);
						// Check if inReplyTo is our chat message by checking the URI pattern and host
						const url = new URL(inReplyToUri);
						if (this.utilityService.isSelfHost(url.hostname) && inReplyToUri.includes('/chat/messages/')) {
							isReplyToChatMessage = true;
						} else {
							// Check if inReplyTo exists in our chat_messages table
							// This handles cases where the reply is to a previous reply that was saved as a chat message
							const inReplyToId = inReplyToUri.split('/').pop();
							if (inReplyToId) {
								const chatMessage = await this.chatMessagesRepository.findOneBy({ uri: inReplyToUri });
								if (chatMessage) {
									isReplyToChatMessage = true;
								}
							}
						}
					} catch (e) {
						// Ignore error, treat as normal note
					}
				}

				if (isReplyToChatMessage) {
					await this.createChatMessage(resolver, actor, object, activity);
				} else {
					await this.createNote(resolver, actor, object, false, activity);
				}
			}
		} else {
			return `Unknown type: ${getApType(object)}`;
		}
	}

	@bindThis
	private async createNote(resolver: Resolver, actor: MiRemoteUser, note: IObject, silent = false, activity?: ICreate): Promise<string> {
		const uri = getApId(note);

		if (typeof note === 'object') {
			if (actor.uri !== note.attributedTo) {
				return 'skip: actor.uri !== note.attributedTo';
			}

			if (typeof note.id === 'string') {
				if (this.utilityService.extractDbHost(actor.uri) !== this.utilityService.extractDbHost(note.id)) {
					return 'skip: host in actor.uri !== note.id';
				}
			} else {
				return 'skip: note.id is not a string';
			}
		}

		const unlock = await acquireApObjectLock(this.redisClient, uri);

		try {
			const exist = await this.apNoteService.fetchNote(note);
			if (exist) return 'skip: note exists';

			await this.apNoteService.createNote(note, actor, resolver, silent);
			return 'ok';
		} catch (err) {
			if (err instanceof StatusError && !err.isRetryable) {
				return `skip ${err.statusCode}`;
			} else {
				throw err;
			}
		} finally {
			unlock();
		}
	}

	private chatMessageText(object: IPost): string | null {
		if (object.source?.mediaType === 'text/x.misskeymarkdown' && typeof object.source.content === 'string') {
			return object.source.content;
		}
		if (typeof object._misskey_content === 'string') {
			return object._misskey_content;
		}
		if (typeof object.content === 'string') {
			return this.apMfmService.htmlToMfm(object.content, object.tag);
		}
		return null;
	}

	private chatRoomUriOf(object: IPost): string | null {
		for (const value of [object._misskey_chatRoom, object.context, object['@context']]) {
			const uri = this.chatRoomUriFromValue(value);
			if (uri != null) return uri;
		}
		return null;
	}

	private chatRoomUriFromValue(value: unknown): string | null {
		if (typeof value === 'string') {
			return /\/chat\/rooms\/[a-zA-Z0-9]+$/.test(value) ? value : null;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				const uri = this.chatRoomUriFromValue(item);
				if (uri != null) return uri;
			}
			return null;
		}
		if (value != null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
			const id = (value as { id: string }).id;
			return /\/chat\/rooms\/[a-zA-Z0-9]+$/.test(id) ? id : null;
		}
		return null;
	}

	/** The room of a new message, or why it is skipped. Throws what the inbox queue's bounded retries can still resolve. */
	private async chatRoomForMessage(contextUri: string, recipients: MiUser[], actor: MiRemoteUser): Promise<MiChatRoom | string> {
		const roomId = contextUri.match(/\/chat\/rooms\/([a-zA-Z0-9]+)$/)?.[1];
		if (roomId == null) {
			this.logger.warn(`Invalid context URI format: ${contextUri}`);
			return 'skip: invalid context URI format';
		}

		// Check if the room exists locally
		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (!room) {
			// The Invite can still be in flight; use the inbox queue's bounded retries.
			throw new Error('chat room is not ready');
		}

		// Check if at least one recipient is a local user who is a member of the room
		let hasLocalMember = false;
		for (const recipient of recipients) {
			if (this.userEntityService.isLocalUser(recipient)) {
				// Check if this local user is a member of the room
				const isMember = await this.chatService.isRoomMember(room, recipient.id);
				if (isMember) {
					hasLocalMember = true;
					break;
				}
			}
		}

		if (!hasLocalMember) {
			for (const recipient of recipients) {
				if (this.userEntityService.isLocalUser(recipient) && await this.chatRoomInvitationsRepository.findOneBy({ roomId: room.id, userId: recipient.id })) {
					throw new Error('chat room membership is not ready');
				}
			}
			this.logger.warn('No local members found in the room');
			return 'skip: no local members in room';
		}

		// A new member's message can overtake the Accept or Add that makes them a member.
		// The inbox queue's bounded retries also end what a removed member keeps sending.
		if (!await this.chatService.isRoomMember(room, actor.id)) throw new Error('chat room membership is not ready');

		return room;
	}

	/**
	 * The files of a new message, in the order of the Note. What this actor already stored is not downloaded
	 * again, so that a retry only fetches what failed. `failed` tells a failed download from something that is not a file.
	 */
	private async resolveChatAttachments(actor: MiRemoteUser, object: IPost): Promise<{ files: MiDriveFile[]; failed: boolean }> {
		const files = new Map<MiDriveFile['id'], MiDriveFile>();
		let failed = false;
		for (const attach of toArray(object.attachment).slice(0, MAX_REMOTE_CHAT_MESSAGE_FILES)) {
			try {
				if (typeof attach === 'object') attach.sensitive ??= object.sensitive;
				const file = await this.apImageService.findStoredImage(actor, attach) ?? await this.apImageService.resolveImage(actor, attach);
				if (file != null) files.set(file.id, file);
			} catch (err) {
				this.logger.warn(`Failed to resolve attachment: ${err}`);
				failed = true;
			}
		}
		return { files: [...files.values()], failed };
	}

	@bindThis
	private async createChatMessage(resolver: Resolver, actor: MiRemoteUser, object: IPost, activity: ICreate | IUpdate | IAnnounce): Promise<string> {
		if (typeof object !== 'object') return 'skip: object is not an object';
		if (typeof object.id !== 'string') return 'skip: object has no id';
		if (object.attributedTo == null || getOneApId(object.attributedTo) !== actor.uri) return 'skip: actor.uri !== object.attributedTo';
		if (!this.isOnActorHost(object.id, actor)) return 'skip: host in actor.uri !== object.id';

		if (await this.redisClient.get(`chat_delete_upon_arrival:${object.id}:${encodeURIComponent(actor.uri)}`) === actor.uri) return 'skip: deleted';
		// A room message can reach us once per member inbox, so avoid repeating the network work below.
		// This is only a shortcut: the check under the lock remains the one that decides.
		const stored = await this.chatMessagesRepository.findOneBy({ uri: object.id });
		if (stored != null && getApType(activity) !== 'Update') return 'skip: chat message exists';
		this.logger.info(`Processing chat message: ${object.id}`);

		// Get recipients from the 'to' field
		// The sender may not have known our members yet. A relay from the owner addresses them itself.
		const toUris = getApType(activity) === 'Announce'
			? Array.from(new Set([...getApIds(object.to), ...getApIds(activity.to)]))
			: getApIds(object.to);
		if (!toUris || toUris.length === 0) return 'skip: no recipients';

		// Resolve recipient users
		const recipients: MiUser[] = [];
		for (const uri of toUris) {
			try {
				const user = await this.apPersonService.resolvePerson(uri, resolver);
				if (user) {
					recipients.push(user);
				}
			} catch (e) {
				this.logger.warn(`Failed to resolve recipient: ${uri}`);
			}
		}

		if (recipients.length === 0) return 'skip: no valid recipients';

		// Extract message content
		const text = this.chatMessageText(object);
		if (text != null && Array.from(text.trim()).length > MAX_CHAT_MESSAGE_TEXT_LENGTH) return 'skip: chat message is too long';
		const uri = object.id;
		const editedAt = this.parseRemoteDate(object.updated);

		const contextUri = this.chatRoomUriOf(object);
		const isGroup = contextUri != null;

		// The room context, not the recipient count, decides whether this is a group message.
		if (!isGroup && recipients.length !== 1) return 'skip: no room context';
		if (!isGroup) {
			const recipient = recipients[0];
			// A conversation between two users of other servers has nobody here to read it.
			if (!this.userEntityService.isLocalUser(recipient)) return 'skip: recipient is not a local user';
			const recipientCanChat = (await this.roleService.getUserPolicies(recipient.id)).chatAvailability !== 'unavailable';
			if (!recipientCanChat) {
				// Note creation can also fetch attachments and must not hold the chat insertion lock.
				const tombstoneKey = `chat_delete_upon_arrival:${object.id}:${encodeURIComponent(actor.uri)}`;
				if (await this.redisClient.get(tombstoneKey) === actor.uri) return 'skip: deleted';
				this.logger.info(`Recipient ${recipient.username} cannot use chat, converting to DM`);
				try {
					await this.apNoteService.createNote(object, actor, resolver, true);
				} catch (err) {
					if (err instanceof StatusError && !err.isRetryable) return `skip ${err.statusCode}`;
					throw err;
				}

				// Serialize with a Delete that may have seen no Note before its insertion.
				// Release this lock before deleteNote takes the same lock for its author check.
				const unlock = await acquireApObjectLock(this.redisClient, object.id);
				let deleted: boolean;
				try {
					deleted = await this.redisClient.get(tombstoneKey) === actor.uri;
				} finally {
					await unlock();
				}
				if (deleted) return await this.deleteNote(actor, object.id);
				return 'ok';
			}
		}

		// What follows costs downloads, so a message that would be refused stops here. The lock below decides again.
		if (stored == null) {
			try {
				if (isGroup) {
					const room = await this.chatRoomForMessage(contextUri, recipients, actor);
					if (typeof room === 'string') return room;
					await this.chatService.assertRemoteWriteAllowed(room);
				} else {
					await this.chatService.assertCanSendToUser(actor, recipients[0]);
				}
			} catch (err) {
				if (err instanceof ChatMessageAccessError) return `skip: ${err.message}`;
				throw err;
			}
		}

		// An edit does not change the files of a stored message.
		const { files, failed } = stored == null ? await this.resolveChatAttachments(actor, object) : { files: [], failed: false };

		// Extract emojis
		const emojis = await this.apNoteService.extractEmojis(object.tag ?? [], actor.host).catch(e => {
			this.logger.info(`extractEmojis: ${e}`);
			return [];
		});

		const apEmojis = emojis.map(emoji => emoji.name);

		// Recipient resolution and attachment downloads can outlast the lock lease.
		// Take a fresh lock only after network preparation, then recheck persistence state.
		const unlock = await acquireApObjectLock(this.redisClient, object.id);
		try {
			if (await this.redisClient.get(`chat_delete_upon_arrival:${object.id}:${encodeURIComponent(actor.uri)}`) === actor.uri) return 'skip: deleted';
			const existing = await this.chatMessagesRepository.findOneBy({ uri: object.id });
			if (existing != null) {
				if (getApType(activity) === 'Update') {
					if (text == null) return 'skip: chat message has no content';
					await this.chatService.updateRemoteMessage(actor, existing, text, editedAt ?? new Date(), apEmojis);
					return 'ok: chat message updated';
				}
				return 'skip: chat message exists';
			}

			// Only a new message can be empty this way: an edit may clear the text of a stored message that keeps its file.
			if ((text == null || text.trim() === '') && files.length === 0) {
				// A failed download would otherwise leave an empty bubble for good. Let the inbox queue's bounded retries try again.
				if (failed) throw new Error('chat message attachment is not available');
				return 'skip: chat message has no content';
			}

			if (!isGroup) {
				// 1:1 chat
				const recipient = recipients[0];
				await this.chatService.createMessageToUser(actor, recipient, {
					text,
					files,
					uri,
					emojis: apEmojis,
					editedAt,
				});
			} else {
				// Group chat
				const room = await this.chatRoomForMessage(contextUri!, recipients, actor);
				if (typeof room === 'string') return room;

				// Create the message to the room
				await this.chatService.createMessageToRoom(actor, room, {
					text,
					files,
					uri,
					emojis: apEmojis,
					editedAt,
				});
			}

			const stored = await this.chatService.findMessageByUri(uri);
			if (stored != null) {
				await this.chatService.applyPendingChatReactions(stored).catch(err => {
					this.logger.warn(`Failed to apply deferred chat reactions: ${err}`);
				});
			}
			return 'ok';
		} catch (err) {
			// The recipient refused for good.
			if (err instanceof ChatMessageAccessError) return `skip: ${err.message}`;
			// The attachment or recipient work above can outlast the lock, so another worker may have got there first.
			if (isDuplicateKeyValueError(err)) return 'skip: chat message exists';
			this.logger.error(`Failed to create chat message: ${err}`);
			throw err;
		} finally {
			await unlock();
		}
	}

	@bindThis
	private async delete(actor: MiRemoteUser, activity: IDelete): Promise<string> {
		if (actor.uri !== getApId(activity.actor)) {
			return 'invalid actor';
		}
		if (activity.object == null) return 'skip: invalid Delete object';

		// 削除対象objectのtype
		let formerType: string | undefined;

		if (typeof activity.object === 'string') {
			// typeが不明だけど、どうせ消えてるのでremote resolveしない
			formerType = undefined;
		} else {
			const object = activity.object;
			if (isTombstone(object)) {
				formerType = toSingle(object.formerType);
			} else {
				formerType = toSingle(object.type);
			}
		}

		let uri: string;
		try {
			uri = getApId(activity.object);
		} catch {
			return 'skip: invalid Delete object';
		}

		// Servers announce deleted accounts to everyone they know, so spare that flood the query.
		const isChatUri = uri !== actor.uri && (this.isChatMessageUri(uri) || await this.chatService.findMessageByUri(uri) != null);
		const unlock = isChatUri ? await acquireApObjectLock(this.redisClient, uri) : null;
		try {
			const chatMessage = isChatUri ? await this.chatService.findMessageByUri(uri) : null;
			if (chatMessage != null) {
				try {
					await this.chatService.deleteRemoteMessage(actor, chatMessage);
					return 'ok: chat message deleted';
				} catch (err) {
					if (err instanceof ChatMessageAccessError) return `skip: ${err.message}`;
					throw err;
				}
			}

			// A chat-disabled recipient stores the object as a private Note instead.
			// Let that object use the normal Note deletion and author checks below.
			if (isChatUri && await this.apNoteService.fetchNote(uri) == null) {
				if (!this.isOnActorHost(uri, actor)) return 'skip: message is not on the actor\'s server';
				const stored = await this.storeDeferredChatDelete(actor, uri);
				return stored ? 'ok: chat message tombstone stored' : 'skip: too many deferred chat deletes';
			}
		} finally {
			if (unlock != null) await unlock();
		}

		// type不明でもactorとobjectが同じならばそれはPersonに違いない
		if (!formerType && actor.uri === uri) {
			formerType = 'Person';
		}

		// それでもなかったらおそらくNote
		if (!formerType) {
			formerType = 'Note';
		}

		if (formerType === 'Group' && uri.includes('/chat/rooms/')) {
			const roomIdMatch = uri.match(/\/chat\/rooms\/([a-zA-Z0-9]+)$/);
			if (!roomIdMatch) return 'skip: invalid room URI';
			const room = await this.chatRoomsRepository.findOneBy({ id: roomIdMatch[1] });
			if (room == null) {
				return await this.storePendingRoomActivity(actor, activity) ? 'skip: room not found, activity deferred' : 'skip: room not found';
			}
			if (room.ownerId !== actor.id) return 'skip: only the room owner can delete it';
			// Keep the deletion after consuming pending activities: a delayed/retried Invite
			// must not recreate this mirror room or notify the invitee again.
			await this.redisClient.setex(`chat_room_deleted:${uri}:${actor.id}`, PENDING_ROOM_ACTIVITY_TTL, '1');
			await this.chatService.deleteRoom(room, undefined, { federate: false });
			return 'ok: chat room deleted';
		}

		if (validPost.includes(formerType)) {
			return await this.deleteNote(actor, uri);
		} else if (validActor.includes(formerType)) {
			return await this.deleteActor(actor, uri);
		} else {
			return `Unknown type ${formerType}`;
		}
	}

	@bindThis
	private async deleteActor(actor: MiRemoteUser, uri: string): Promise<string> {
		this.logger.info(`Deleting the Actor: ${uri}`);

		if (actor.uri !== uri) {
			return `skip: delete actor ${actor.uri} !== ${uri}`;
		}

		if (!(await this.usersRepository.update({ id: actor.id, isDeleted: false }, { isDeleted: true })).affected) {
			return 'skip: already deleted or actor not found';
		}

		const job = await this.queueService.createDeleteAccountJob(actor);

		this.globalEventService.publishInternalEvent('remoteUserUpdated', { id: actor.id });

		return `ok: queued ${job.name} ${job.id}`;
	}

	@bindThis
	private async deleteNote(actor: MiRemoteUser, uri: string): Promise<string> {
		this.logger.info(`Deleting the Note: ${uri}`);

		const unlock = await acquireApObjectLock(this.redisClient, uri);

		try {
			const note = await this.apDbResolverService.getNoteFromApId(uri);

			if (note == null) {
				return 'message not found';
			}

			if (note.userId !== actor.id) {
				return '投稿を削除しようとしているユーザーは投稿の作成者ではありません';
			}

			await this.noteDeleteService.delete(actor, note);
			return 'ok: note deleted';
		} finally {
			unlock();
		}
	}

	@bindThis
	private async flag(actor: MiRemoteUser, activity: IFlag): Promise<string> {
		// objectは `(User|Note) | (User|Note)[]` だけど、全パターンDBスキーマと対応させられないので
		// 対象ユーザーは一番最初のユーザー として あとはコメントとして格納する
		const uris = getApIds(activity.object);

		const userIds = uris
			.filter(uri => uri.startsWith(this.config.url + '/users/'))
			.map(uri => uri.split('/').at(-1))
			.filter(x => x != null);
		const users = await this.usersRepository.findBy({
			id: In(userIds),
		});
		if (users.length < 1) return 'skip';

		await this.abuseReportService.report([{
			targetUserId: users[0].id,
			targetUserHost: users[0].host,
			reporterId: actor.id,
			reporterHost: actor.host,
			comment: `${activity.content}\n${JSON.stringify(uris, null, 2)}`,
		}]);

		return 'ok';
	}

	@bindThis
	private async reject(actor: MiRemoteUser, activity: IReject, resolver?: Resolver): Promise<string> {
		const uri = activity.id ?? activity;

		this.logger.info(`Reject: ${uri}`);

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		const object = await resolver.resolve(activity.object).catch(e => {
			this.logger.error(`Resolution failed: ${e}`);
			throw e;
		});

		if (isFollow(object)) return await this.rejectFollow(actor, object);
		if (isInvite(object)) return await this.rejectInvite(actor, activity);

		return `skip: Unknown Reject type: ${getApType(object)}`;
	}

	@bindThis
	private async rejectFollow(actor: MiRemoteUser, activity: IFollow): Promise<string> {
		// ※ activityはこっちから投げたフォローリクエストなので、activity.actorは存在するローカルユーザーである必要がある

		const follower = await this.apDbResolverService.getUserFromApId(activity.actor);

		if (follower == null) {
			return 'skip: follower not found';
		}

		if (!this.userEntityService.isLocalUser(follower)) {
			return 'skip: follower is not a local user';
		}

		// relay
		const match = activity.id?.match(/follow-relay\/(\w+)/);
		if (match) {
			return await this.relayService.relayRejected(match[1], actor);
		}

		await this.userFollowingService.remoteReject(actor, follower);
		return 'ok';
	}

	@bindThis
	private async rejectInvite(actor: MiRemoteUser, activity: IReject): Promise<string> {
		// actor is the one who rejected the invitation (invitee)
		// activity is the Reject activity
		// activity.object should be the Invite object being rejected
		// activity.object.object should be the room URI

		this.logger.info(`[rejectInvite] Processing rejection from actor: ${actor.id}, username: ${actor.username}@${actor.host}`);

		const inviteObject = activity.object;
		if (typeof inviteObject === 'string') {
			this.logger.warn(`[rejectInvite] inviteObject is a string: ${inviteObject}`);
			return 'skip: object must be a full Invite object, not a URI';
		}

		this.logger.info(`[rejectInvite] inviteObject type: ${(inviteObject as any).type}`);

		// The Invite object contains the room URI in its object property
		const roomObject = (inviteObject as any).object;
		if (!roomObject) {
			this.logger.warn('[rejectInvite] invite object missing room');
			return 'skip: invite object missing room';
		}

		const roomUri = getApId(roomObject);
		if (!roomUri) {
			this.logger.warn('[rejectInvite] invalid room object');
			return 'skip: invalid room object';
		}

		this.logger.info(`[rejectInvite] Room URI: ${roomUri}`);

		// Extract room ID from URI
		const roomIdMatch = roomUri.match(/\/chat\/rooms\/([a-zA-Z0-9]+)$/);
		if (!roomIdMatch) return 'skip: invalid room URI format';
		const roomId = roomIdMatch[1];

		this.logger.info(`[rejectInvite] Searching for invitation - roomId: ${roomId}, userId: ${actor.id}`);

		// Find the invitation and delete it
		const invitation = await this.chatRoomInvitationsRepository.findOneBy({
			roomId,
			userId: actor.id,
		});

		if (!invitation) {
			this.logger.warn(`[rejectInvite] Invitation not found for roomId: ${roomId}, userId: ${actor.id}`);
			// Try to find all invitations for this room to debug
			const allInvitations = await this.chatRoomInvitationsRepository.findBy({ roomId });
			this.logger.warn(`[rejectInvite] All invitations for room ${roomId}: ${JSON.stringify(allInvitations.map(i => ({ id: i.id, userId: i.userId })))}`);
			return 'skip: invitation not found';
		}

		this.logger.info(`[rejectInvite] Found invitation: ${invitation.id}, deleting...`);

		// Delete the invitation
		const deleteResult = await this.chatRoomInvitationsRepository.delete({ id: invitation.id });

		this.logger.info(`[rejectInvite] Delete result: ${JSON.stringify(deleteResult)}`);
		this.logger.info(`[rejectInvite] Successfully deleted invitation ${invitation.id} from user ${actor.id} for room ${roomId}`);

		return 'ok';
	}

	@bindThis
	private async remove(actor: MiRemoteUser, activity: IRemove, resolver?: Resolver): Promise<string | void> {
		if (actor.uri !== getApId(activity.actor)) {
			return 'invalid actor';
		}

		if (activity.target == null) {
			return 'target is null';
		}

		if (activity.target === actor.featured) {
			const note = await this.apNoteService.resolveNote(activity.object, { resolver });
			if (note == null) return 'note not found';
			await this.notePiningService.removePinned(actor, note.id);
			return;
		}

		// Handle chat room membership removal
		const targetUri = getApId(activity.target);
		this.logger.info(`[ApInboxService.remove] Processing Remove activity, target: ${targetUri}`);

		const roomIdMatch = targetUri.match(/\/chat\/rooms\/([a-zA-Z0-9]+)$/);
		if (roomIdMatch) {
			const roomId = roomIdMatch[1];
			this.logger.info(`[ApInboxService.remove] Matched room ID: ${roomId}, actor: ${actor.uri}`);

			const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
			if (!room) {
				this.logger.warn(`[ApInboxService.remove] Room not found: ${roomId}`);
				return 'room not found';
			}

			let member: MiUser = actor;
			if (activity.object != null) {
				let memberUri: string;
				try {
					memberUri = getApId(activity.object);
				} catch {
					return 'skip: invalid Remove object';
				}
				if (memberUri !== actor.uri) {
					if (room.ownerId !== actor.id) return 'skip: only the room owner can remove another member';
					const resolved = await this.apDbResolverService.getUserFromApId(memberUri) ?? await this.apPersonService.resolvePerson(memberUri, resolver);
					if (resolved == null) return 'skip: user not found';
					member = resolved;
				}
			}

			if (member.id === room.ownerId) return 'skip: owner cannot be removed';

			const removed = await this.chatService.removeRoomMember(room, member);

			this.logger.info(`[ApInboxService.remove] Removed: ${removed}, room: ${room.id}, user: ${member.id}`);

			// このサーバーが持つルームなら、抜けたメンバーを通話からも外す。
			// 外せなくてもジョブは失敗させない。メンバーでない参加者は通話の定期的な読み直し (ChatVoiceService.sweep) が外す
			if (removed) {
				const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
				if (owner != null && owner.host == null) {
					await this.liveKitService.removeParticipant(room.id, this.liveKitService.identityOf(member)).catch(err => {
						this.logger.warn(`[ApInboxService.remove] Failed to remove ${member.uri} from the voice call in ${room.id}`, { error: err });
					});

					if (member.host != null && member.uri != null) {
						await this.relayChatRoomLeave(room, owner, member as MiRemoteUser);
					}
				}
			}

			return 'ok: removed from chat room';
		}

		return `unknown target: ${activity.target}`;
	}

	/** Members on other servers learn the roster from the owner, as they did when this member joined. */
	private async relayChatRoomLeave(room: MiChatRoom, owner: MiUser, leaver: MiRemoteUser): Promise<void> {
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		const members = await this.usersRepository.findBy({ id: In(memberships.map(membership => membership.userId)) });
		const inboxes = new Set<string>();
		for (const member of members) {
			if (member.id !== leaver.id && this.userEntityService.isRemoteUser(member) && member.inbox != null) inboxes.add(member.inbox);
		}
		if (inboxes.size === 0) return;

		const activity = this.apRendererService.addContext({
			...this.apRendererService.renderRemove(owner, this.apRendererService.genLocalChatRoomUri(room.id), leaver.uri),
			published: new Date().toISOString(),
		});
		for (const inbox of inboxes) {
			this.queueService.deliver(owner, activity, inbox, false);
		}
	}

	@bindThis
	private async undo(actor: MiRemoteUser, activity: IUndo, resolver?: Resolver): Promise<string> {
		if (actor.uri !== getApId(activity.actor)) {
			return 'invalid actor';
		}

		const uri = activity.id ?? activity;

		this.logger.info(`Undo: ${uri}`);

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		const object = await resolver.resolve(activity.object).catch(e => {
			this.logger.error(`Resolution failed: ${e}`);
			throw e;
		});

		// don't queue because the sender may attempt again when timeout
		if (isFollow(object)) return await this.undoFollow(actor, object);
		if (isBlock(object)) return await this.undoBlock(actor, object);
		if (isLike(object)) {
			const targetUri = getApId(object.object);
			const { isChatMessage, chatMessage, note } = await this.findReactionTarget(targetUri);
			if (isChatMessage && (chatMessage != null || note == null)) {
				const reaction = object._misskey_reaction ?? object.content ?? object.name;
				if (typeof reaction !== 'string' || reaction === '') return 'skip: empty reaction';
				return await this.applyChatReaction(actor, targetUri, chatMessage, reaction, true, object.id);
			}
			return await this.undoLike(actor, object);
		}
		if (isAnnounce(object)) return await this.undoAnnounce(actor, object);
		if (isAccept(object)) return await this.undoAccept(actor, object);
		if (isInvite(object)) return await this.undoInvite(actor, object);

		return `skip: unknown object type ${getApType(object)}`;
	}

	@bindThis
	private async undoAccept(actor: MiRemoteUser, activity: IAccept): Promise<string> {
		const follower = await this.apDbResolverService.getUserFromApId(activity.object);
		if (follower == null) {
			return 'skip: follower not found';
		}

		const isFollowing = await this.followingsRepository.exists({
			where: {
				followerId: follower.id,
				followeeId: actor.id,
			},
		});

		if (isFollowing) {
			await this.userFollowingService.unfollow(follower, actor);
			return 'ok: unfollowed';
		}

		return 'skip: フォローされていない';
	}

	@bindThis
	private async undoInvite(actor: MiRemoteUser, activity: IInvite): Promise<string> {
		// Parse the room object from the Invite activity
		const roomObject = activity.object;
		if (typeof roomObject === 'string') return 'skip: object must be a full object, not a URI';

		const roomUri = getApId(roomObject);
		if (!roomUri) return 'skip: invalid room object';

		// Extract room ID from URI
		const roomIdMatch = roomUri.match(/\/chat\/rooms\/([a-zA-Z0-9]+)$/);
		if (!roomIdMatch) return 'skip: invalid room URI format';
		const roomId = roomIdMatch[1];

		// Get the target user (invitee)
		const targetUri = getApHrefNullable(activity.target);
		if (!targetUri) return 'skip: invalid activity target';

		const invitee = await this.apDbResolverService.getUserFromApId(targetUri);
		if (!invitee) return 'skip: target user not found';
		if (!this.userEntityService.isLocalUser(invitee)) return 'skip: target user is not local';

		// Only the room owner can cancel an invitation
		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (!room || room.ownerId !== actor.id) return 'skip: only the room owner can cancel an invitation';

		// Find and delete the invitation
		const invitation = await this.chatRoomInvitationsRepository.findOneBy({
			roomId: roomId,
			userId: invitee.id,
		});

		if (!invitation) {
			this.logger.warn(`Invitation not found: room=${roomId}, user=${invitee.id}`);
			return 'skip: invitation not found';
		}

		await this.chatRoomInvitationsRepository.delete(invitation.id);

		this.logger.info(`Cancelled invitation: room=${roomId}, user=${invitee.id}`);
		return 'ok: invitation cancelled';
	}

	@bindThis
	private async undoAnnounce(actor: MiRemoteUser, activity: IAnnounce): Promise<string> {
		const uri = getApId(activity);

		const note = await this.notesRepository.findOneBy({
			uri,
			userId: actor.id,
		});

		if (!note) return 'skip: no such Announce';

		await this.noteDeleteService.delete(actor, note);
		return 'ok: deleted';
	}

	@bindThis
	private async undoBlock(actor: MiRemoteUser, activity: IBlock): Promise<string> {
		const blockee = await this.apDbResolverService.getUserFromApId(activity.object);

		if (blockee == null) {
			return 'skip: blockee not found';
		}

		if (blockee.host != null) {
			return 'skip: ブロック解除しようとしているユーザーはローカルユーザーではありません';
		}

		await this.userBlockingService.unblock(await this.usersRepository.findOneByOrFail({ id: actor.id }), blockee);
		return 'ok';
	}

	@bindThis
	private async undoFollow(actor: MiRemoteUser, activity: IFollow): Promise<string> {
		const followee = await this.apDbResolverService.getUserFromApId(activity.object);
		if (followee == null) {
			return 'skip: followee not found';
		}

		if (followee.host != null) {
			return 'skip: フォロー解除しようとしているユーザーはローカルユーザーではありません';
		}

		const requestExist = await this.followRequestsRepository.exists({
			where: {
				followerId: actor.id,
				followeeId: followee.id,
			},
		});

		const isFollowing = await this.followingsRepository.exists({
			where: {
				followerId: actor.id,
				followeeId: followee.id,
			},
		});

		if (requestExist) {
			await this.userFollowingService.cancelFollowRequest(followee, actor);
			return 'ok: follow request canceled';
		}

		if (isFollowing) {
			await this.userFollowingService.unfollow(actor, followee);
			return 'ok: unfollowed';
		}

		return 'skip: リクエストもフォローもされていない';
	}

	@bindThis
	private async undoLike(actor: MiRemoteUser, activity: ILike): Promise<string> {
		const targetUri = getApId(activity.object);

		const note = await this.apNoteService.fetchNote(targetUri);
		if (!note) return `skip: target note not found ${targetUri}`;

		await this.reactionService.delete(actor, note).catch(e => {
			if (e.id === '60527ec9-b4cb-4a88-a6bd-32d3ad26817d') return;
			throw e;
		});

		return 'ok';
	}

	@bindThis
	private async update(actor: MiRemoteUser, activity: IUpdate, resolver?: Resolver): Promise<string> {
		if (actor.uri !== getApId(activity.actor)) {
			return 'skip: invalid actor';
		}

		// 通話の参加者の現況はルームの持ち主から中身ごと届く。URL だけのものは受け付けないので、ここでは何も取りに行かない
		if (typeof activity.object !== 'string' && getApType(activity.object) === 'ChatRoomVoiceState') {
			return await this.chatVoiceService.receiveRemoteSnapshot(actor, activity.object);
		}

		this.logger.debug(`Update: ${getApId(activity.object)}`);

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		const object = await resolver.resolve(activity.object).catch(e => {
			this.logger.error(`Resolution failed: ${e}`);
			throw e;
		});

		// A reply from another server is stored as a chat message, but that server does not know it is one.
		if (getApType(object) === 'Note' && ((object as IPost)._misskey_talk === true || (typeof object.id === 'string' && await this.chatService.findMessageByUri(object.id) != null))) {
			const note = object as IPost;
			if (note.attributedTo == null || actor.uri !== getOneApId(note.attributedTo)) return 'skip: actor.uri !== note.attributedTo';
			if (typeof note.id !== 'string') return 'skip: chat message has no id';
			if (this.utilityService.extractDbHost(actor.uri) !== this.utilityService.extractDbHost(note.id)) return 'skip: host in actor.uri !== note.id';

			try {
				const message = await this.chatService.findMessageByUri(note.id);
				if (message == null) {
					if (await this.apNoteService.fetchNote(note.id) != null) {
						return await this.updateNote(resolver, actor, { ...note, attributedTo: getOneApId(note.attributedTo) }, false, activity);
					}
					return await this.createChatMessage(resolver, actor, note, activity);
				}

				const text = this.chatMessageText(note);
				if (text == null) return 'skip: chat message has no content';

				const editedAt = this.parseRemoteDate(note.updated) ?? new Date();
				const emojis = await this.apNoteService.extractEmojis(note.tag ?? [], actor.host);

				await this.chatService.updateRemoteMessage(actor, message, text, editedAt, emojis.map(emoji => emoji.name));
				return 'ok: chat message updated';
			} catch (err) {
				if (err instanceof ChatMessageAccessError) return `skip: ${err.message}`;
				throw err;
			}
		}

		if (getApType(object) === 'Group' && /\/chat\/rooms\/[a-zA-Z0-9]+$/.test(getApId(object))) {
			const roomUri = getApId(object);
			const roomIdMatch = roomUri.match(/\/chat\/rooms\/([a-zA-Z0-9]+)$/);
			if (!roomIdMatch) return 'skip: invalid room URI';
			const room = await this.chatRoomsRepository.findOneBy({ id: roomIdMatch[1] });
			if (room == null) {
				return await this.storePendingRoomActivity(actor, activity) ? 'skip: room not found, activity deferred' : 'skip: room not found';
			}
			if (room.ownerId !== actor.id) return 'skip: only the room owner can update it';

			await this.applyRemoteRoomState(room, object);
			return 'ok: chat room updated';
		}

		if (isActor(object)) {
			await this.apPersonService.updatePerson(actor.uri, resolver, object);
			return 'ok: Person updated';
		} else if (getApType(object) === 'Question') {
			const question = object as IPost;
			// The note editor replaces omitted fields. Partial tally-only Questions must retain
			// the existing poll path, which also validates missing attribution against its owner.
			const hasContent = typeof question.content === 'string' || question.content === null ||
				typeof question._misskey_content === 'string' ||
				(question.source?.mediaType === 'text/x.misskeymarkdown' && typeof question.source.content === 'string');
			if (question.attributedTo != null && question.attachment !== undefined && hasContent &&
				(question.to !== undefined || question.cc !== undefined)) {
				const normalizedQuestion = { ...question, attributedTo: getOneApId(question.attributedTo) };
				const result = await this.updateNote(resolver, actor, normalizedQuestion, false, activity);
				if (result !== 'ok') return result;
			}
			await this.apQuestionService.updateQuestion(object, actor, resolver).catch(err => console.error(err));
			return 'ok: Question updated';
		} else if (getApType(object) === 'Note') {
			await this.updateNote(resolver, actor, object, false, activity);
			return 'ok: Note updated';
		} else {
			return `skip: Unknown type: ${getApType(object)}`;
		}
	}

	@bindThis
	private async updateNote(resolver: Resolver, actor: MiRemoteUser, note: IObject, silent = false, activity?: IUpdate): Promise<string> {
		const uri = getApId(note);

		if (typeof note === 'object') {
			if (actor.uri !== note.attributedTo) {
				return 'skip: actor.uri !== note.attributedTo';
			}

			if (typeof note.id === 'string') {
				if (this.utilityService.extractDbHost(actor.uri) !== this.utilityService.extractDbHost(note.id)) {
					return 'skip: host in actor.uri !== note.id';
				}
			}
		}

		const unlock = await acquireApObjectLock(this.redisClient, uri);

		try {
			const target = await this.notesRepository.findOneBy({ uri: uri });
			if (!target) return `skip: target note not located: ${uri}`;
			await this.apNoteService.updateNote(note, target, resolver, silent);
			return 'ok';
		} catch (err) {
			if (err instanceof StatusError && err.isClientError) {
				return `skip ${err.statusCode}`;
			} else {
				throw err;
			}
		} finally {
			unlock();
		}
	}

	@bindThis
	private async move(actor: MiRemoteUser, activity: IMove, resolver?: Resolver): Promise<string> {
		// fetch the new and old accounts
		const targetUri = getApHrefNullable(activity.target);
		if (!targetUri) return 'skip: invalid activity target';

		return await this.apPersonService.updatePerson(actor.uri, resolver) ?? 'skip: nothing to do';
	}

	@bindThis
	private isOnActorHost(uri: string, actor: MiRemoteUser): boolean {
		try {
			return this.utilityService.punyHost(uri) === this.utilityService.punyHost(actor.uri);
		} catch {
			return false;
		}
	}

	/**
	 * Delivery retries can reorder a room's updates. An owner that does not state the time is applied in arrival order.
	 */
	private chatRoomUpdatedAt(room: IObject): Date | undefined {
		return this.parseRemoteDate(room.updated) ?? undefined;
	}

	/**
	 * JavaScript accepts years PostgreSQL refuses, and that refusal would only use up the inbox queue's retries.
	 * Dates outside the years 0 to 9999 count as not stated.
	 */
	private parseRemoteDate(value: unknown): Date | null {
		if (typeof value !== 'string') return null;
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return null;
		const year = date.getUTCFullYear();
		return year >= 0 && year <= 9999 ? date : null;
	}

	private applyRemoteRoomState(room: MiChatRoom, object: IObject): Promise<MiChatRoom> {
		return this.chatService.updateRoom(room, {
			name: typeof object.name === 'string' ? truncate(object.name, 256) : room.name,
			description: typeof object.summary === 'string' ? truncate(object.summary, 2048) : room.description,
			isArchived: typeof object._misskey_chatArchived === 'boolean' ? object._misskey_chatArchived : room.isArchived,
		}, { federate: false, remoteUpdatedAt: this.chatRoomUpdatedAt(object) });
	}

	private isChatMessageUri(uri: string): boolean {
		return uri.includes('/chat/messages/');
	}

	private chatRoomUriFromActivity(activity: IAdd | IUpdate | IDelete): string | null {
		try {
			const value = getApType(activity) === 'Add' ? activity.target : activity.object;
			return this.chatRoomUriFromValue(value);
		} catch {
			return null;
		}
	}

	private async storeDeferredChatDelete(actor: MiRemoteUser, uri: string): Promise<boolean> {
		const indexKey = `chat_delete_upon_arrival_index:${actor.id}`;
		const count = await this.redisClient.scard(indexKey);
		if (count >= MAX_DEFERRED_CHAT_DELETES_PER_ACTOR) return false;
		await this.redisClient.sadd(indexKey, uri);
		// NX keeps this a fixed window: extended on every call, the set of an actor that stays active never empties until it reaches the cap.
		await this.redisClient.expire(indexKey, DEFERRED_CHAT_DELETE_TTL, 'NX');
		await this.redisClient.setex(`chat_delete_upon_arrival:${uri}:${encodeURIComponent(actor.uri)}`, DEFERRED_CHAT_DELETE_TTL, actor.uri);
		return true;
	}

	private async storePendingRoomActivity(actor: MiRemoteUser, activity: IAdd | IUpdate | IDelete): Promise<boolean> {
		const roomUri = this.chatRoomUriFromActivity(activity);
		if (roomUri == null) return false;

		// Only the owner sends these, and the room lives on the owner's server.
		// Without this another server could fill the room's slots before the owner's activities arrive.
		if (!this.isOnActorHost(roomUri, actor)) return false;

		const indexKey = `chat_pending_room_activities_index:${actor.id}`;
		if (await this.redisClient.scard(indexKey) >= MAX_PENDING_ROOMS_PER_ACTOR) return false;

		const key = this.pendingRoomActivitiesKey(roomUri);
		const count = await this.redisClient.llen(key);
		if (count >= MAX_PENDING_ROOM_ACTIVITIES) return false;
		await this.redisClient.sadd(indexKey, roomUri);
		// NX keeps this a fixed window: extended on every call, the set of an actor that stays active never empties until it reaches the cap.
		await this.redisClient.expire(indexKey, PENDING_ROOM_ACTIVITY_TTL, 'NX');
		await this.redisClient.multi()
			.rpush(key, JSON.stringify({ actorId: actor.id, activity, attempts: 0 }))
			.expire(key, PENDING_ROOM_ACTIVITY_TTL)
			.exec();
		return true;
	}

	private pendingRoomActivitiesKey(roomUri: string): string {
		return `chat_pending_room_activity_events:${roomUri}`;
	}

	private async applyPendingRoomActivities(roomUri: string): Promise<boolean> {
		const key = this.pendingRoomActivitiesKey(roomUri);
		// Drain atomically so an append between reading and deleting cannot be lost.
		const results = await this.redisClient.multi().lrange(key, 0, -1).del(key).exec();
		if (results == null) return false;
		if (results[0][0] != null) throw results[0][0];
		const entries = results[0][1] as string[];
		if (entries.length === 0) return false;

		const pending: { actorId: string; activity: IAdd | IUpdate | IDelete; attempts: number; }[] = [];
		for (const entry of entries) {
			try {
				const parsed = JSON.parse(entry) as { actorId?: unknown; activity?: unknown; attempts?: unknown };
				if (typeof parsed.actorId !== 'string' || parsed.activity == null || typeof parsed.activity !== 'object') continue;
				pending.push({ actorId: parsed.actorId, activity: parsed.activity as IAdd | IUpdate | IDelete, attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0 });
			} catch {
				// Ignore malformed deferred activities.
			}
		}

		// A Delete wins over any older Add/Update that arrived while the room was unknown.
		pending.sort((a, b) => Number(getApType(a.activity) === 'Delete') - Number(getApType(b.activity) === 'Delete'));

		let deleted = false;
		const failed: typeof pending = [];
		for (const entry of pending) {
			const actor = await this.usersRepository.findOneBy({ id: entry.actorId });
			if (actor == null || actor.host == null || actor.uri == null) continue;
			const remoteActor = actor as MiRemoteUser;
			try {
				switch (getApType(entry.activity)) {
					case 'Add':
						await this.add(remoteActor, entry.activity as IAdd);
						break;
					case 'Update':
						await this.update(remoteActor, entry.activity as IUpdate);
						break;
					case 'Delete':
						deleted = await this.delete(remoteActor, entry.activity as IDelete) === 'ok: chat room deleted';
						break;
				}
			} catch (err) {
				this.logger.warn(`Failed to apply deferred chat room activity: ${err}`);
				if (entry.attempts + 1 < MAX_PENDING_ROOM_ACTIVITY_ATTEMPTS) failed.push({ ...entry, attempts: entry.attempts + 1 });
			}
			if (deleted) break;
		}

		// Retrying the Invite replays these. The attempt limit stops one bad activity from losing the invitation.
		if (!deleted && failed.length > 0) {
			await this.redisClient.multi()
				.rpush(key, ...failed.map(entry => JSON.stringify(entry)))
				.expire(key, PENDING_ROOM_ACTIVITY_TTL)
				.exec();
			throw new Error('failed to apply deferred chat room activities');
		}

		return deleted;
	}

	@bindThis
	private async invite(actor: MiRemoteUser, activity: IInvite, resolver?: Resolver): Promise<string> {
		// Parse the room object
		const roomObject = activity.object;
		if (typeof roomObject === 'string') return 'skip: object must be a full object, not a URI';

		const roomUri = getApId(roomObject);
		if (!roomUri) return 'skip: invalid room object';

		// Extract room ID from URI (format: https://example.com/chat/rooms/{roomId})
		const roomIdMatch = roomUri.match(/\/chat\/rooms\/([a-zA-Z0-9]+)$/);
		if (!roomIdMatch) return 'skip: invalid room URI format';
		const roomId = roomIdMatch[1];

		// Only the room owner sends Invite, and the room lives on the owner's server
		if (!this.isOnActorHost(roomUri, actor)) return 'skip: room is not on the inviter\'s server';
		if (await this.redisClient.get(`chat_room_deleted:${roomUri}:${actor.id}`) != null) return 'skip: room was deleted';

		// Get the target user (invitee)
		const targetUri = getApHrefNullable(activity.target);
		if (!targetUri) return 'skip: invalid activity target';

		const invitee = await this.apDbResolverService.getUserFromApId(targetUri);
		if (!invitee) return 'skip: target user not found';
		if (!this.userEntityService.isLocalUser(invitee)) return 'skip: target user is not local';
		// A local inviter is refused the same way in ChatService.createRoomInvitation.
		if (await this.userBlockingService.checkBlocked(invitee.id, actor.id)) return 'skip: the invitee has blocked the inviter';

		// Check if the room already exists locally
		let room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room && room.ownerId !== actor.id) return 'skip: inviter is not the room owner';

		// If the room doesn't exist, create a local copy for the remote room
		if (!room) {
			const roomName = truncate(typeof roomObject.name === 'string' ? roomObject.name : 'Remote Chat Room', 256);
			const roomDescription = truncate(typeof roomObject.summary === 'string' ? roomObject.summary : '', 1024);

			// The room must be attributed to the inviter, if attributed at all
			if (roomObject.attributedTo) {
				// Handle both single value and array
				const attributedTo = Array.isArray(roomObject.attributedTo)
					? roomObject.attributedTo[0]
					: roomObject.attributedTo;
				if (getApHrefNullable(attributedTo) !== actor.uri) return 'skip: room is not attributed to the inviter';
			}

			room = await this.chatRoomsRepository.insertOne({
				id: roomId,
				name: roomName,
				description: roomDescription,
				ownerId: actor.id,
				isArchived: roomObject._misskey_chatArchived === true,
				uri: roomUri,
				lastRemoteUpdatedAt: this.chatRoomUpdatedAt(roomObject) ?? null,
			});
		} else {
			if (room.uri == null) {
				await this.chatRoomsRepository.update(room.id, { uri: roomUri });
				room.uri = roomUri;
			}
			// The owner tells a server about changes only while someone there takes part or is invited, so a mirror
			// can be out of date by now. Left archived, it would refuse the invitation this activity brings.
			const mirror = room;
			room = await this.applyRemoteRoomState(mirror, roomObject).catch(err => {
				this.logger.warn(`Failed to refresh chat room ${mirror.id} from an Invite: ${err}`);
				return mirror;
			});
		}

		const deletedByPendingActivity = await this.applyPendingRoomActivities(roomUri);
		if (deletedByPendingActivity) return 'ok: pending room deletion applied';

		// Check if invitation already exists
		const existingInvitation = await this.chatRoomInvitationsRepository.findOneBy({
			roomId: room.id,
			userId: invitee.id,
		});
		if (existingInvitation) {
			return 'skip: invitation already exists';
		}

		// Create the invitation directly
		const invitation = {
			id: this.idService.gen(),
			roomId: room.id,
			userId: invitee.id,
		};

		await this.chatRoomInvitationsRepository.insertOne(invitation);

		// Send local notification
		this.notificationService.createNotification(invitee.id, 'chatRoomInvitationReceived', {
			invitationId: invitation.id,
		}, actor.id);

		this.logger.info(`Created chat room invitation for local user ${invitee.id} to remote room ${room.id}`);
		return 'ok';
	}
}
