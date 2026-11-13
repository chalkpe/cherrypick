/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import * as mfm from 'mfc-js';
import * as Redis from 'ioredis';
import { Brackets, DataSource, In, IsNull, LessThan, Not } from 'typeorm';
import type { EntityManager, SelectQueryBuilder } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { QueueService } from '@/core/QueueService.js';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import type { IObject } from '@/core/activitypub/type.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { PushNotificationService } from '@/core/PushNotificationService.js';
import { bindThis } from '@/decorators.js';
import type { ChatApprovalsRepository, ChatMessagesRepository, ChatRoomInvitationsRepository, ChatRoomMembershipsRepository, ChatRoomsRepository, DriveFilesRepository, MiDriveFile, MiUser, MutingsRepository, UsersRepository } from '@/models/_.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { UserBlockingService } from '@/core/UserBlockingService.js';
import { QueryService } from '@/core/QueryService.js';
import { RoleService } from '@/core/RoleService.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { MiChatRoomInvitation } from '@/models/ChatRoomInvitation.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
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
import { chatMessageUri, chatRoomUriForOwner, localChatMessageIdFromUri } from '@/core/activitypub/misc/chat-payloads.js';
import { ChatDiceService } from '@/core/ChatDiceService.js';
import { chatDiceNotation, parseChatDiceResult } from '@/core/chat-dice.js';
import { ApiError } from '@/server/api/error.js';
import type Logger from '@/logger.js';
import { LoggerService } from '@/core/LoggerService.js';

export class ChatMessageAccessError extends Error {}
export class ChatMessageInvalidTextError extends ChatMessageAccessError {}
export class ChatMessageBlockedError extends ChatMessageAccessError {}
export class ChatMessageRecipientSuspendedError extends ChatMessageAccessError {}
export class ChatRoomArchivedError extends Error {}
/** The invitation or membership a request relies on is missing. Callers must not reveal whether the room exists. */
export class ChatRoomAccessError extends Error {}
export class ChatRoomFullError extends Error {}
export class ChatRoomInvitationRefusedError extends Error {
	constructor(public reason: 'yourself' | 'noSuchUser' | 'suspended' | 'alreadyMember' | 'alreadyInvited' | 'blocked' | 'blocking') {
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
const isCustomEmojiRegexp = /^:([\w+-]+)(?:@\.)?:$/;

/** One reader's unread mark on one conversation: a direct conversation goes by its sender, a room by its ID. */
type UnreadSnapshot = [latest: string, first: string, revision: string, messageIds: string[], pendingIds: string[]];

type UnreadMark = { readerId: MiUser['id'] } & ({ senderId: MiUser['id'] } | { roomId: MiChatRoom['id'] });

/**
 * What one read covered: the messages it handed out, and everything up to and including `upTo`.
 * A message stored after the read looked is not in it, so it stays unread.
 */
export type ChatReadBoundary = { seenIds: MiChatMessage['id'][]; upTo: MiChatMessage['id'] | null; snapshot?: string | null };

/** Serializes remote message storage with a Delete for the same ActivityPub URI. */
export function chatMessageUriLockKey(uri: string): string {
	return `chat-message-uri:${uri}`;
}

const READ_RETRY_DELAYS = [1000, 5000, 30000];

/** The read a chat screen sends over the stream names the newest message it has shown. Older clients name none. */
export function chatReadBoundaryOfStream(body: unknown): ChatReadBoundary | undefined {
	const id = typeof body === 'object' && body != null ? (body as { id?: unknown }).id : undefined;
	return typeof id === 'string' && id.length > 0 && id.length <= 32 ? { seenIds: [id], upTo: id } : undefined;
}

function escapeRedisPattern(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('*', '\\*').replaceAll('?', '\\?').replaceAll('[', '\\[');
}

// KEYS: 최신 ID, 첫 미읽음 ID, 집계 set, revision, 미읽음 ID set, 저장 중인 ID set
// 개별 표식과 집계 set은 항상 함께 바꾼다. 첫 미읽음 ID는 읽은 과거 글과 새 글을 구분한다.
// 표식은 쪽지를 저장하기 전에 남긴다. 저장된 쪽지를 본 읽기는 반드시 표식 뒤에 온다.
const MARK_CHAT_UNREAD = `-- mark chat unread
local active = redis.call('SISMEMBER', KEYS[3], ARGV[2]) == 1
local latest = active and redis.call('GET', KEYS[1]) or nil
local first = active and redis.call('GET', KEYS[2]) or nil
if not active then
 local pending = redis.call('SMEMBERS', KEYS[6])
 redis.call('DEL', KEYS[5])
 for _, id in ipairs(pending) do
  redis.call('SADD', KEYS[5], id)
  if not first or id < first then first = id end
  if not latest or id > latest then latest = id end
 end
end
-- An active legacy mark has no saved read boundary. Receiving more cannot reconstruct it.
if not active or first then
 if not first or ARGV[1] < first then first = ARGV[1] end
 redis.call('SET', KEYS[2], first)
end
if not latest or ARGV[1] > latest then latest = ARGV[1] end
redis.call('SET', KEYS[1], latest)
redis.call('SADD', KEYS[3], ARGV[2])
redis.call('SADD', KEYS[5], ARGV[1])
-- 저장이 끝날 때까지 이 ID를 보지 못한 읽기·정리가 표식을 지우지 않게 한다.
redis.call('SADD', KEYS[6], ARGV[1])
redis.call('SET', KEYS[4], ARGV[3])
return 1
`;

// 저장이 끝났다. 그사이 이 쪽지를 본 읽기가 이미 지웠다면 되살리지 않는다.
const SETTLE_CHAT_UNREAD = `-- settle chat unread
if redis.call('SREM', KEYS[6], ARGV[1]) == 0 then return 0 end
if redis.call('SISMEMBER', KEYS[3], ARGV[3]) == 0 then return 0 end
redis.call('SET', KEYS[4], ARGV[2])
return 1
`;

// 받지 않은 것이 된 쪽지(저장 실패, 그사이의 뮤트)만 뺀다. 그 전의 미읽음은 그대로 둔다.
const UNMARK_CHAT_UNREAD = `-- unmark chat unread
local removed = 0
for i = 3, #ARGV do
 removed = removed + redis.call('SREM', KEYS[5], ARGV[i])
 redis.call('SREM', KEYS[6], ARGV[i])
end
if removed == 0 then return 0 end
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 0 then return 0 end
-- 첫 미읽음 ID가 없는 이전 형식은 개별 ID 밖의 미읽음이 남아 있을 수 있으므로 지우지 않는다.
if redis.call('SCARD', KEYS[5]) == 0 and redis.call('EXISTS', KEYS[2]) == 1 then
 redis.call('DEL', KEYS[1], KEYS[2], KEYS[4], KEYS[5], KEYS[6])
 redis.call('SREM', KEYS[3], ARGV[1])
 return 2
end
redis.call('SET', KEYS[4], ARGV[2])
return 1
`;

// ARGV[3]: '*'는 저장이 끝난 전부, ''는 경계 없음, 그 밖에는 그 ID까지. ARGV[5] 이후는 읽기가 돌려준 ID.
const READ_CHAT_UNREAD = `-- read chat unread
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 0 then
 if ARGV[4] == '1' then redis.call('DEL', KEYS[7]) end
 return {0, {}}
end
local seen = {}
for i = 5, #ARGV do seen[ARGV[i]] = true end
local pending = {}
for _, id in ipairs(redis.call('SMEMBERS', KEYS[6])) do pending[id] = true end
local changed = 0
for _, id in ipairs(redis.call('SMEMBERS', KEYS[5])) do
 if seen[id] or (not pending[id] and (ARGV[3] == '*' or (ARGV[3] ~= '' and id <= ARGV[3])) and (ARGV[4] ~= '1' or redis.call('SISMEMBER', KEYS[7], id) == 1)) then
  redis.call('SREM', KEYS[5], id)
  redis.call('SREM', KEYS[6], id)
  changed = 1
 end
end
if ARGV[4] == '1' then redis.call('DEL', KEYS[7]) end
local first, latest
for _, id in ipairs(redis.call('SMEMBERS', KEYS[5])) do
 if not first or id < first then first = id end
 if not latest or id > latest then latest = id end
end
-- 남은 저장 중 ID도 돌려준다. 끝나지 않은 전송의 것인지는 호출한 쪽이 PostgreSQL 잠금으로 확인한다.
if not first then
 redis.call('DEL', KEYS[1], KEYS[2], KEYS[4], KEYS[5], KEYS[6])
 if redis.call('SREM', KEYS[3], ARGV[1]) == 1 then return {2, {}} end
 return {changed, {}}
end
local pendingLeft = redis.call('SMEMBERS', KEYS[6])
-- 첫 미읽음 ID가 없는 이전 형식은 개별 ID 밖의 미읽음이 대화를 읽으면서 모두 읽은 것이 되어 새 형식이 된다.
if changed == 0 and redis.call('GET', KEYS[2]) then return {0, pendingLeft} end
redis.call('SET', KEYS[1], latest)
redis.call('SET', KEYS[2], first)
redis.call('SET', KEYS[4], ARGV[2])
return {1, pendingLeft}
`;

const READ_ALL_CHAT_UNREAD = `-- read all chat unread
-- 저장 중인 쪽지는 전체 읽음 뒤에 도착한 것으로 남긴다.
local function keepPending(base)
 local pending = redis.call('SMEMBERS', base .. ':pending')
 if #pending == 0 then
  redis.call('DEL', base, base .. ':first', base .. ':revision', base .. ':messages', base .. ':pending')
  return false
 end
 redis.call('DEL', base .. ':messages')
 local first, latest
 for _, id in ipairs(pending) do
  redis.call('SADD', base .. ':messages', id)
  if not first or id < first then first = id end
  if not latest or id > latest then latest = id end
 end
 redis.call('SET', base, latest)
 redis.call('SET', base .. ':first', first)
 redis.call('SET', base .. ':revision', ARGV[3])
 return true
end
local left = {}
for _, conversation in ipairs(redis.call('SMEMBERS', KEYS[1])) do
 local kind, id = string.match(conversation, '^(%w+):(.+)$')
 local base = id and ((kind == 'user' and ARGV[1] or ARGV[2]) .. id)
 if base and keepPending(base) then
  table.insert(left, conversation)
 else
  redis.call('SREM', KEYS[1], conversation)
 end
end
-- 저장 중이라 남긴 대화. 끝나지 않은 전송의 것인지는 호출한 쪽이 확인한다.
return left
`;

const CLEAR_CHAT_UNREAD = `-- clear chat unread
redis.call('DEL', KEYS[1], KEYS[2], KEYS[4], KEYS[5], KEYS[6])
return redis.call('SREM', KEYS[3], ARGV[1])
`;

// 읽음 표식의 여러 키를 한 시점에 읽는다.
const SNAPSHOT_CHAT_UNREAD = `-- snapshot chat unread
return {redis.call('GET', KEYS[1]) or '', redis.call('GET', KEYS[2]) or '', redis.call('GET', KEYS[3]) or '', redis.call('SMEMBERS', KEYS[4]), redis.call('SMEMBERS', KEYS[5])}
`;

// 읽기 전에 저장을 마친 ID를 Redis 안에 고정한다. 조회 실패나 프로세스 종료 때는 만료된다.
const CAPTURE_CHAT_READ = `-- capture chat read
redis.call('SDIFFSTORE', KEYS[3], KEYS[1], KEYS[2])
redis.call('PEXPIRE', KEYS[3], 120000)
return 1
`;

// A valid latest ID is enough for the normal unread check; only a stale one needs the full set.
const SNAPSHOT_CHAT_UNREAD_HEAD = `-- snapshot chat unread head
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 0 then return {'', '', 0} end
local latest = redis.call('GET', KEYS[1]) or ''
return {latest, redis.call('GET', KEYS[2]) or '', latest ~= '' and redis.call('SISMEMBER', KEYS[3], latest) or 0}
`;

const IS_CHAT_MESSAGE_UNREAD = `-- is chat message unread
return redis.call('SISMEMBER', KEYS[1], ARGV[1]) * redis.call('SISMEMBER', KEYS[2], ARGV[2])
`;

// Check both conditions in the same Redis operation that removes the candidate.
const CLEAN_LEGACY_CHAT_UNREAD = `-- clean legacy chat unread
if redis.call('GET', KEYS[5]) ~= ARGV[3] then return -1 end
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
 redis.call('SREM', KEYS[4], ARGV[2])
 return 0
end
if redis.call('SCARD', KEYS[2]) > 0 then
 redis.call('SADD', KEYS[4], ARGV[2])
 return 2
end
redis.call('UNLINK', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[2])
return 1
`;

const SAVE_LEGACY_CLEANUP_CURSOR = `-- save legacy cleanup cursor
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

const RELEASE_LEGACY_CLEANUP_LOCK = `-- release legacy cleanup lock
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

// 저장 중인 쪽지가 있으면 DB에서 아직 보이지 않으므로 그 대화는 정리하지 않는다.
const RECONCILE_CHAT_UNREAD = `-- reconcile chat unread
if redis.call('SISMEMBER', KEYS[3], ARGV[5]) == 0 then return 0 end
if redis.call('SCARD', KEYS[6]) > 0 then return 0 end
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] or (redis.call('GET', KEYS[2]) or '') ~= ARGV[2] or (redis.call('GET', KEYS[4]) or '') ~= ARGV[3] then return 0 end
if ARGV[4] ~= '' then
 redis.call('SET', KEYS[1], ARGV[4])
 redis.call('SET', KEYS[4], ARGV[6])
 return 1
end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[4], KEYS[5], KEYS[6])
redis.call('SREM', KEYS[3], ARGV[5])
return 2
`;

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
	private logger: Logger;

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
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('chat');
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
		deleteActorUri?: string;
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

		const unreadMarks: UnreadMark[] = this.userEntityService.isLocalUser(toUser) ? [{ readerId: toUser.id, senderId: fromUser.id }] : [];
		const inserted = await this.insertMarkedUnread(message, unreadMarks, params.deleteActorUri);

		const packedMessage = await this.chatEntityService.packMessageLiteFor1on1(inserted);

		await this.settleUnreadMarks(inserted, unreadMarks);

		if (this.userEntityService.isLocalUser(fromUser)) {
			// 自分のストリーム
			this.globalEventService.publishChatUserStream(fromUser.id, toUser.id, 'message', packedMessage);
		}

		if (this.userEntityService.isLocalUser(toUser)) {
			// 相手のストリーム
			this.globalEventService.publishChatUserStream(toUser.id, fromUser.id, 'message', packedMessage);
		}

		// 3秒経っても既読にならなかったらイベント発行
		if (unreadMarks.length > 0) {
			setTimeout(() => {
				this.noticeUnreadDirectMessage(inserted, toUser, unreadMarks[0]).catch(error => this.reportUnreadFailure('notice of a direct message', error));
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
		files?: MiDriveFile[];
		uri?: string | null;
		emojis?: string[];
		editedAt?: Date | null;
		dice?: unknown;
		deleteActorUri?: string;
	}): Promise<Packed<'ChatMessageLiteForRoom'>> {
		// The recipients of this send must include members already committed on the primary.
		const memberships = await this.db.transaction(async manager => {
			const room = await manager.withRepository(this.chatRoomsRepository).findOneBy({ id: toRoom.id });
			if (room == null) throw new ChatMessageAccessError('no such room');
			return (await manager.withRepository(this.chatRoomMembershipsRepository).findBy({ roomId: room.id })).map(m => ({
				userId: m.userId,
				isMuted: m.isMuted,
			})).concat({ // ownerはmembershipレコードを作らないため
				userId: room.ownerId,
				isMuted: room.isMutedByOwner,
			});
		});

		if (!memberships.some(member => member.userId === fromUser.id)) {
			throw new ChatMessageAccessError('you are not a member of the room');
		}

		if (fromUser.host == null) {
			if (toRoom.isArchived) throw new ChatRoomArchivedError('room is archived');
		} else {
			await this.assertRemoteWriteAllowed(toRoom);
		}

		const membershipsOtherThanMe = memberships.filter(member => member.userId !== fromUser.id && !member.isMuted);

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

		// 다른 서버의 참가자는 이 서버에서 읽지 않으므로, 아무도 거두지 않을 표식이 쌓이지 않게 이 서버 계정에만 남긴다.
		const readers = membershipsOtherThanMe.length === 0 ? [] : await this.db.transaction(manager => manager.withRepository(this.usersRepository).findBy({ id: In(membershipsOtherThanMe.map(member => member.userId)) }));
		const localReaderIds = new Set(readers.filter(user => this.userEntityService.isLocalUser(user)).map(user => user.id));
		const unreadMarks: UnreadMark[] = membershipsOtherThanMe.filter(member => localReaderIds.has(member.userId)).map(member => ({ readerId: member.userId, roomId: toRoom.id }));
		const inserted = await this.insertMarkedUnread(message, unreadMarks, params.deleteActorUri);

		const packedMessage = await this.chatEntityService.packMessageLiteForRoom(inserted);

		await this.settleUnreadMarks(inserted, unreadMarks);

		this.globalEventService.publishChatRoomStream(toRoom.id, 'message', packedMessage);

		// 3秒経っても既読にならなかったらイベント発行
		if (unreadMarks.length > 0) {
			setTimeout(() => {
				this.noticeUnreadRoomMessage(inserted, toRoom, unreadMarks).catch(error => this.reportUnreadFailure('notice of a room message', error));
			}, 3000);
		}

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
				await this.deliverToRemoteUsers(fullFromUser, remoteMembers, activity);
			}
		} else {
			await this.relayToOtherServers(toRoom, fromUser, (owner, toUsers) => this.apRendererService.renderChatRoomRelay(inserted, toRoom, owner, toUsers));
		}

		return packedMessage;
	}

	/**
	 * A sender's server only knows the members it has heard about so far, so a message can miss someone
	 * who joined just before. The owner's server knows them all and points them at the message.
	 */
	private async relayToOtherServers(room: MiChatRoom, fromUser: Pick<MiUser, 'id' | 'host'>, render: (owner: MiUser, toUsers: MiUser[]) => IObject): Promise<void> {
		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (owner == null || !this.userEntityService.isLocalUser(owner)) return;

		const members = await this.participantsForRoom(room);
		const others = members.filter(member => this.userEntityService.isRemoteUser(member) && member.host !== fromUser.host);
		if (others.length === 0) return;

		const toUsers = members.filter(member => member.id !== owner.id && member.id !== fromUser.id);
		await this.deliverToRemoteUsers(owner, others, render(owner, toUsers));
	}

	/** Only what changed something here gets this far, so a copy of an activity is not passed on again. An activity without an ID could not be told from its copies. */
	private async relayRoomActivity(message: MiChatMessage, fromUser: Pick<MiUser, 'id' | 'host'>, activity: IObject | undefined): Promise<void> {
		if (activity == null || typeof activity.id !== 'string' || message.toRoomId == null) return;
		const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
		if (room == null) return;
		await this.relayToOtherServers(room, fromUser, (owner, toUsers) => this.apRendererService.renderChatRoomActivityRelay(activity as IObject & { id: string }, room, owner, toUsers));
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
		boundary?: ChatReadBoundary,
	): Promise<void> {
		await this.readUnreadMark({ readerId, senderId }, boundary);
	}

	@bindThis
	public async readRoomChatMessage(
		readerId: MiUser['id'],
		roomId: MiChatRoom['id'],
		boundary?: ChatReadBoundary,
	): Promise<void> {
		await this.readUnreadMark({ readerId, roomId }, boundary);
	}

	/**
	 * Records a read that came with something the reader asked for, such as a timeline. The answer goes out even when
	 * the read cannot be recorded: the conversation then stays unread as stored, and the same read is tried again shortly.
	 * The boundary keeps a late retry from covering messages that arrived after the read.
	 */
	@bindThis
	public async recordUserChatRead(readerId: MiUser['id'], senderId: MiUser['id'], boundary?: ChatReadBoundary): Promise<void> {
		await this.recordRead({ readerId, senderId }, boundary);
	}

	/** {@link recordUserChatRead} for a room. */
	@bindThis
	public async recordRoomChatRead(readerId: MiUser['id'], roomId: MiChatRoom['id'], boundary?: ChatReadBoundary): Promise<void> {
		await this.recordRead({ readerId, roomId }, boundary);
	}

	/** What a timeline page covered, for the read that comes with it. */
	@bindThis
	public readBoundaryOf(messages: Pick<MiChatMessage, 'id'>[], limit: number, sinceId?: MiChatMessage['id'] | null, beforeQuery?: string | null): ChatReadBoundary {
		const seenIds = messages.map(message => message.id);
		// A full page stops short of older messages. Opening the conversation counts those as read, as it always has.
		const oldest = seenIds.length >= limit ? seenIds.reduce((a, b) => (a < b ? a : b)) : null;
		const upTo = sinceId ?? oldest;
		if (beforeQuery === undefined) return { seenIds, upTo };
		// Only IDs settled before the query may be covered below the page boundary.
		return { seenIds, upTo, snapshot: beforeQuery };
	}

	/** Captures settled unread IDs before a timeline query, without preventing the query if Redis is unavailable. */
	private async captureChatRead(mark: UnreadMark): Promise<string | null> {
		const key = this.unreadKey(mark);
		const snapshot = `chatReadSnapshot:${randomUUID()}`;
		try {
			await this.redisClient.eval(CAPTURE_CHAT_READ, 3, `${key}:messages`, `${key}:pending`, snapshot);
			return snapshot;
		} catch (error) {
			this.reportUnreadFailure('capturing a read boundary', error);
			return null;
		}
	}

	@bindThis
	public async captureUserChatRead(readerId: MiUser['id'], senderId: MiUser['id']): Promise<string | null> {
		return await this.captureChatRead({ readerId, senderId });
	}

	@bindThis
	public async captureRoomChatRead(readerId: MiUser['id'], roomId: MiChatRoom['id']): Promise<string | null> {
		return await this.captureChatRead({ readerId, roomId });
	}

	private async recordRead(mark: UnreadMark, boundary: ChatReadBoundary | undefined, attempt = 0): Promise<void> {
		try {
			await this.readUnreadMark(mark, boundary);
		} catch (error) {
			const delay = READ_RETRY_DELAYS.at(attempt);
			this.reportUnreadFailure(delay == null ? 'read, given up' : 'read, retrying', error);
			if (delay == null) return;
			setTimeout(() => {
				this.recordRead(mark, boundary, attempt + 1).catch(() => {});
			}, delay);
		}
	}

	private async readUnreadMark(mark: UnreadMark, boundary: ChatReadBoundary | undefined): Promise<void> {
		const upTo = boundary == null ? '*' : (boundary.upTo ?? '');
		const captured = boundary != null && 'snapshot' in boundary;
		const snapshot = boundary?.snapshot ?? `${this.unreadKey(mark)}:read:none`;
		const [result, pendingLeft] = await this.redisClient.eval(READ_CHAT_UNREAD, 7, ...this.unreadKeys(mark), snapshot,
			this.unreadConversation(mark), randomUUID(), upTo, captured ? '1' : '0', ...(boundary?.seenIds ?? [])) as [number, string[]];
		if (Number(result) > 0) await this.announceIfAllRead([mark.readerId]);
		// 읽기가 남긴 저장 중 표식이 끝난 전송의 것이면 여기서 정리한다.
		if (pendingLeft.length > 0) await this.settleAbandonedSends([mark], [pendingLeft]);
	}

	@bindThis
	public async readAllChatMessages(
		readerId: MiUser['id'],
	): Promise<void> {
		// 저장까지 마치고 끝난 전송이 남긴 저장 중 표시를 먼저 정리한다. 그래야 이미 저장된 그 쪽지도 이번 전체 읽음에 든다.
		// 지금 저장 중인 전송의 쪽지는 아래에서 전체 읽음 뒤에 도착한 것으로 남는다.
		const active = (await this.redisClient.smembers(`newChatMessagesExists:${readerId}`)).map(conversation => this.markOf(readerId, conversation));
		if (active.length > 0) {
			const pipeline = this.redisClient.pipeline();
			for (const mark of active) pipeline.smembers(`${this.unreadKey(mark)}:pending`);
			const pending = ((await pipeline.exec()) ?? []).map(([error, ids]) => {
				if (error != null) throw error;
				return ids as string[];
			});
			await this.settleAbandonedSends(active, pending);
		}

		const prefix = this.redisClient.options?.keyPrefix ?? '';
		const left = await this.redisClient.eval(READ_ALL_CHAT_UNREAD, 1, `newChatMessagesExists:${readerId}`,
			`${prefix}newUserChatMessageExists:${readerId}:`, `${prefix}newRoomChatMessageExists:${readerId}:`, randomUUID()) as string[];
		const marks = left.map(conversation => this.markOf(readerId, conversation));
		if (marks.length > 0) {
			const snapshots = await Promise.all(marks.map(mark => this.snapshotUnread(mark)));
			await this.settleAbandonedSends(marks, snapshots.map(snapshot => snapshot[4]));
		}

		// Asked for outright, so the reader's screens are told even if the server had nothing left to clear.
		this.globalEventService.publishMainStream(readerId, 'readAllChatMessages');
	}

	/** Incrementally removes marks left outside the aggregate by older versions. */
	@bindThis
	public async cleanupLegacyUnreadMarks(): Promise<boolean> {
		const lock = 'chatLegacyUnreadCleanup:lock';
		const cursorKey = 'chatLegacyUnreadCleanup:cursor';
		const deferred = 'chatLegacyUnreadCleanup:deferred';
		const token = randomUUID();
		if (await this.redisClient.set(lock, token, 'PX', 30000, 'NX') == null) return false;
		try {
			let cursor = await this.redisClient.get(cursorKey) ?? '0';
			if (cursor === 'done') return true;
			const prefix = this.redisClient.options?.keyPrefix ?? '';
			const clean = async (keys: string[]) => {
				const pipeline = this.redisClient.pipeline();
				const candidates: UnreadMark[] = [];
				for (const key of keys) {
					const match = /^new(User|Room)ChatMessageExists:([^:]+):([^:]+)(?::.*)?$/.exec(key);
					if (match == null) continue;
					const [, kind, readerId, id] = match;
					const base = `new${kind}ChatMessageExists:${readerId}:${id}`;
					candidates.push(kind === 'User' ? { readerId, senderId: id } : { readerId, roomId: id });
					pipeline.eval(CLEAN_LEGACY_CHAT_UNREAD, 5, `newChatMessagesExists:${readerId}`, `${base}:pending`, key, deferred, lock,
						`${kind === 'User' ? 'user' : 'room'}:${id}`, key, token);
				}
				const results = await pipeline.exec();
				if (results == null) throw new Error('legacy chat cleanup pipeline did not complete');
				for (const [error] of results) if (error != null) throw error;
				if (results.some(([, result]) => Number(result) === -1)) throw new Error('legacy chat cleanup lock expired');
				const pending = candidates.filter((_, index) => Number(results[index][1]) === 2);
				const unique = [...new Map(pending.map(mark => [this.unreadKey(mark), mark])).values()];
				if (unique.length > 0) {
					const ids = await Promise.all(unique.map(mark => this.redisClient.smembers(`${this.unreadKey(mark)}:pending`)));
					await this.settleAbandonedSends(unique, ids);
				}
			};
			for (let page = 0; page < 20 && cursor !== 'scanned'; page++) {
				const [next, keys] = await this.redisClient.scan(cursor, 'MATCH', `${escapeRedisPattern(prefix)}new*ChatMessageExists:*`, 'COUNT', 100);
				await clean(keys.filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)));
				cursor = next === '0' ? 'scanned' : next;
				if (Number(await this.redisClient.eval(SAVE_LEGACY_CLEANUP_CURSOR, 2, lock, cursorKey, token, cursor)) !== 1) return false;
				await delay(20);
			}
			if (cursor !== 'scanned') return false;
			const [, keys] = await this.redisClient.sscan(deferred, '0', 'COUNT', 100);
			await clean(keys);
			if (await this.redisClient.scard(deferred) > 0) return false;
			return Number(await this.redisClient.eval(SAVE_LEGACY_CLEANUP_CURSOR, 2, lock, cursorKey, token, 'done')) === 1;
		} finally {
			await this.redisClient.eval(RELEASE_LEGACY_CLEANUP_LOCK, 1, lock, token);
		}
	}

	private unreadKey(mark: UnreadMark): string {
		return 'senderId' in mark ? `newUserChatMessageExists:${mark.readerId}:${mark.senderId}` : `newRoomChatMessageExists:${mark.readerId}:${mark.roomId}`;
	}

	private unreadKeys(mark: UnreadMark): string[] {
		const key = this.unreadKey(mark);
		return [key, `${key}:first`, `newChatMessagesExists:${mark.readerId}`, `${key}:revision`, `${key}:messages`, `${key}:pending`];
	}

	private unreadConversation(mark: UnreadMark): string {
		return 'senderId' in mark ? `user:${mark.senderId}` : `room:${mark.roomId}`;
	}

	/** The mark a member of the reader's aggregate set stands for: {@link unreadConversation} read back. */
	private markOf(readerId: MiUser['id'], conversation: string): UnreadMark {
		return conversation.startsWith('user:')
			? { readerId, senderId: conversation.slice('user:'.length) }
			: { readerId, roomId: conversation.slice('room:'.length) };
	}

	/** A failed unread update never undoes what it follows. The mark stays as it was, and the next read or check settles it. */
	private reportUnreadFailure(step: string, error: unknown): void {
		this.logger.warn(`Chat unread mark not updated (${step}): ${error instanceof Error ? error.message : String(error)}`);
	}

	/**
	 * Marks the message unread for its readers, then stores it. A reader can fetch a stored message at once,
	 * so the mark has to be there first, or the read that fetched it would leave the late mark behind.
	 * If either step fails, nothing is stored and the sender can send again without a duplicate.
	 */
	private async insertMarkedUnread(message: Parameters<ChatMessagesRepository['insertOne']>[0] & { id: MiChatMessage['id'] }, marks: UnreadMark[], deleteActorUri?: string): Promise<MiChatMessage> {
		// insertOne reads the inserted row back; that read must use the primary even without unread recipients.
		if (marks.length === 0 && deleteActorUri == null) return await this.db.transaction(manager => manager.withRepository(this.chatMessagesRepository).insertOne(message));

		try {
			// 표식부터 저장 완료까지 이 쪽지의 잠금을 쥔다. 프로세스가 끝나면 PostgreSQL이 연결과 함께 잠금을 푼다.
			return await this.db.transaction(async manager => {
				if (deleteActorUri != null) {
					if (typeof message.uri !== 'string') throw new Error('remote chat message has no URI');
					await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [chatMessageUriLockKey(message.uri)]);
					const key = `chat_delete_upon_arrival:${message.uri}:${encodeURIComponent(deleteActorUri)}`;
					if (await this.redisClient.get(key) === deleteActorUri || (typeof message.toRoomId === 'string' && await this.redisClient.get(`${key}:room:${message.toRoomId}`) === deleteActorUri)) {
						throw new ChatMessageAccessError('deleted');
					}
				}
				await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.sendLockKey(message.id)]);
				const marked = await Promise.allSettled(marks.map(mark => this.redisClient.eval(MARK_CHAT_UNREAD, 6, ...this.unreadKeys(mark),
					message.id, this.unreadConversation(mark), randomUUID())));
				const failure = marked.find(result => result.status === 'rejected');
				if (failure != null) throw failure.reason;
				return await manager.withRepository(this.chatMessagesRepository).insertOne(message);
			});
		} catch (error) {
			// 저장되지 않았다. 여기서 거두지 못한 표식은 다음 읽기나 정리가 끝난 전송의 것임을 확인하고 거둔다.
			await this.unmarkUnread(marks, [message.id]).catch(cleanupError => this.reportUnreadFailure('cleanup after a failed send', cleanupError));
			throw error;
		}
	}

	private sendLockKey(messageId: MiChatMessage['id']): string {
		return `chat-message-send:${messageId}`;
	}

	/**
	 * Settles what sends left as being stored when they ended without settling it: the process stopped, or the cleanup failed.
	 * A send still holding its lock is left alone however long it takes. Once the lock is free, the table says how it ended:
	 * a stored message stays unread, one that was never stored is taken back.
	 * @returns Whether anything was settled.
	 */
	private async settleAbandonedSends(marks: UnreadMark[], pendingIds: string[][]): Promise<boolean> {
		let settled = false;
		for (const id of new Set(pendingIds.flat())) {
			const outcome = await this.db.transaction(async manager => {
				const [{ free }] = await manager.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS free', [this.sendLockKey(id)]) as [{ free: boolean }];
				if (!free) return 'sending';
				return await manager.existsBy(MiChatMessage, { id }) ? 'stored' : 'abandoned';
			});
			if (outcome === 'sending') continue;
			const owners = marks.filter((_, index) => pendingIds[index].includes(id));
			if (outcome === 'stored') {
				await Promise.all(owners.map(mark => this.redisClient.eval(SETTLE_CHAT_UNREAD, 6, ...this.unreadKeys(mark), id, randomUUID(), this.unreadConversation(mark))));
			} else {
				await this.unmarkUnread(owners, [id]);
			}
			settled = true;
		}
		return settled;
	}

	/**
	 * After the message is stored: lets reads and cleanups touch its mark again, then undoes what a withdrawal,
	 * suspension, departure or mute that finished in the meantime would have cleared. The message is out by now,
	 * so a failure here is only reported.
	 */
	private async settleUnreadMarks(message: MiChatMessage, marks: UnreadMark[]): Promise<void> {
		if (marks.length === 0) return;
		try {
			await Promise.all(marks.map(mark => this.redisClient.eval(SETTLE_CHAT_UNREAD, 6, ...this.unreadKeys(mark), message.id, randomUUID(), this.unreadConversation(mark))));

			// 표식을 거둘지는 주 DB에서 정한다. 읽기 복제본은 방금 저장한 쪽지나 참가자를 아직 모를 수 있다.
			const quiet = await this.db.transaction(async manager => {
				const current = await manager.withRepository(this.chatMessagesRepository).findOneBy({ id: message.id });
				if (current == null || current.deletedAt != null || await manager.withRepository(this.usersRepository).existsBy({ id: message.fromUserId, isSuspended: true })) return 'withdrawn';
				if (message.toRoomId == null) return null;
				return await this.quietReadersOf({ id: message.toRoomId }, marks.map(mark => mark.readerId), manager);
			});
			if (quiet === 'withdrawn') {
				await this.reconcileUnreadMarks(marks);
				return;
			}
			if (quiet == null) return;
			await this.clearUnreadMarks(marks.filter(mark => quiet.get(mark.readerId) === 'gone'));
			// 뮤트 전에 받은 미읽음은 그대로 두고, 뮤트와 겹친 이 쪽지만 받지 않은 것으로 한다.
			await this.unmarkUnread(marks.filter(mark => quiet.get(mark.readerId) === 'muted'), [message.id]);
		} catch (error) {
			this.reportUnreadFailure('settling a new message', error);
		}
	}

	private async unmarkUnread(marks: UnreadMark[], messageIds: MiChatMessage['id'][]): Promise<void> {
		if (marks.length === 0) return;
		const results = await Promise.all(marks.map(mark => this.redisClient.eval(UNMARK_CHAT_UNREAD, 6, ...this.unreadKeys(mark),
			this.unreadConversation(mark), randomUUID(), ...messageIds)));
		await this.announceIfAllRead(marks.filter((_, index) => Number(results[index]) === 2).map(mark => mark.readerId));
	}

	/**
	 * Clears unread marks, then tells every reader for whom that was the last unread conversation the chat list shows,
	 * so that screens already open drop the sign. Clearing a mark that was not there is not announced:
	 * an open conversation sends a read for each message it receives.
	 */
	private async clearUnreadMarks(marks: UnreadMark[]): Promise<void> {
		if (marks.length === 0) return;

		const results = await Promise.all(marks.map(mark => this.redisClient.eval(CLEAR_CHAT_UNREAD, 6, ...this.unreadKeys(mark), this.unreadConversation(mark))));
		await this.announceIfAllRead(marks.filter((_, index) => Number(results[index]) > 0).map(mark => mark.readerId));
	}

	private async announceIfAllRead(readerIds: MiUser['id'][]): Promise<void> {
		await Promise.all([...new Set(readerIds)].map(async readerId => {
			if (await this.hasUnreadMessages(readerId)) return;
			this.globalEventService.publishMainStream(readerId, 'readAllChatMessages');
		}));
	}

	/** 철회 뒤 남은 미읽음만 센다. 읽은 과거 글이나 독자 본인의 글은 미읽음을 유지하지 않는다. */
	private async reconcileUnreadAfterMessageDeletion(message: MiChatMessage, participants?: MiUser[]): Promise<void> {
		let marks: UnreadMark[] = [];
		if (message.toUserId != null) {
			marks = [{ readerId: message.toUserId, senderId: message.fromUserId }];
		} else if (message.toRoomId != null) {
			const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
			if (room == null) return;
			const roomId = room.id;
			const people = participants ?? await this.participantsForRoom(room);
			marks = people.filter(user => this.userEntityService.isLocalUser(user)).map(user => ({ readerId: user.id, roomId }));
		}

		// 철회한 ID는 읽기 응답에 포함되지 않는다. 이전 형식의 경계가 없어도 개별 ID에서는 뺀다.
		await this.unmarkUnread(marks, [message.id]);
		await this.reconcileUnreadMarks(marks);
	}

	private async snapshotUnread(mark: UnreadMark): Promise<UnreadSnapshot> {
		const key = this.unreadKey(mark);
		return await this.redisClient.eval(SNAPSHOT_CHAT_UNREAD, 5,
			key, `${key}:first`, `${key}:revision`, `${key}:messages`, `${key}:pending`) as UnreadSnapshot;
	}

	/**
	 * The newest message each mark still stands for, or null: shown, not withdrawn, from someone other than the reader.
	 * All the marked IDs go in one query, newest first, until every mark has its answer.
	 */
	private async newestVisibleUnread(marks: UnreadMark[], snapshots: UnreadSnapshot[], messages: ChatMessagesRepository = this.chatMessagesRepository): Promise<(MiChatMessage['id'] | null)[]> {
		const newest: (MiChatMessage['id'] | null)[] = marks.map(() => null);
		const owners = new Map<MiChatMessage['id'], number[]>();
		snapshots.forEach(([marker, first, , messageIds], index) => {
			if (marker === '' || first === '') return;
			for (const id of messageIds) owners.set(id, [...(owners.get(id) ?? []), index]);
		});

		const ids = [...owners.keys()].sort().reverse();
		const unresolved = new Set([...owners.values()].flat());
		// 장기간 읽지 않은 방도 DB 매개변수 한도를 넘지 않게 나눠 조회한다.
		for (let offset = 0; offset < ids.length && unresolved.size > 0; offset += 1000) {
			const chunk = ids.slice(offset, offset + 1000).filter(id => owners.get(id)!.some(index => unresolved.has(index)));
			if (chunk.length === 0) continue;
			const visible = await messages.find({
				select: { id: true, fromUserId: true },
				where: { id: In(chunk), deletedAt: IsNull(), fromUser: { isSuspended: false } },
			});
			for (const message of visible.sort((a, b) => (a.id < b.id ? 1 : -1))) {
				for (const index of owners.get(message.id) ?? []) {
					if (!unresolved.has(index) || message.fromUserId === marks[index].readerId) continue;
					newest[index] = message.id;
					unresolved.delete(index);
				}
			}
		}

		return newest;
	}

	/** Messages addressed to the reader in the mark's conversation, by someone else. */
	private conversationOf(mark: UnreadMark) {
		return 'senderId' in mark
			? { fromUserId: mark.senderId, toUserId: mark.readerId }
			: { toRoomId: mark.roomId, fromUserId: Not(mark.readerId) };
	}

	private async unreadConversations(marks: UnreadMark[]): Promise<boolean[]> {
		const heads = await Promise.all(marks.map(async mark => {
			const key = this.unreadKey(mark);
			return await this.redisClient.eval(SNAPSHOT_CHAT_UNREAD_HEAD, 4, key, `${key}:first`, `${key}:messages`, `newChatMessagesExists:${mark.readerId}`, this.unreadConversation(mark)) as [string, string, number];
		}));
		const candidates: UnreadSnapshot[] = heads.map(([marker, first, present]) => [marker, first, '', Number(present) === 1 ? [marker] : [], []]);
		const newest = await this.newestVisibleUnread(marks, candidates);
		const unresolved = marks.map((_, index) => index).filter(index => heads[index][0] !== '' && heads[index][1] !== '' && newest[index] == null);
		const remainingMarks = unresolved.map(index => marks[index]);
		const snapshots = await Promise.all(remainingMarks.map(mark => this.snapshotUnread(mark)));
		const remaining = await this.newestVisibleUnread(remainingMarks, snapshots);
		const fallback = new Map(unresolved.map((index, position) => [index, { snapshot: snapshots[position], newest: remaining[position] }]));
		return await Promise.all(marks.map(async (mark, index) => {
			const [marker, first] = fallback.get(index)?.snapshot ?? heads[index];
			if (marker === '') return false;
			if (first !== '') return newest[index] != null || fallback.get(index)?.newest != null;
			// 레거시 표식은 저장하지 않았던 읽음 경계를 만들어 내지 않는다. 다만 독자 본인의 글로는 미읽음이 되지 않는다.
			return this.chatMessagesRepository.existsBy({ ...this.conversationOf(mark), deletedAt: IsNull(), fromUser: { isSuspended: false } });
		}));
	}

	private async reconcileUnreadMarks(marks: UnreadMark[]): Promise<void> {
		if (marks.length === 0) return;
		let snapshots = await Promise.all(marks.map(mark => this.snapshotUnread(mark)));
		// 저장 중 표식이 있으면 정리하지 않는다. 그중 끝난 전송이 남긴 것은 먼저 정리한다.
		if (await this.settleAbandonedSends(marks, snapshots.map(snapshot => snapshot[4]))) {
			snapshots = await Promise.all(marks.map(mark => this.snapshotUnread(mark)));
		}
		// 남은 미읽음이 없다고 보고 표식을 거두는 판단이므로 주 DB에서 읽는다. 복제본은 방금 저장하거나 철회한 쪽지를 아직 모를 수 있다.
		const remaining = await this.db.transaction(manager => this.newestVisibleUnread(marks, snapshots, manager.withRepository(this.chatMessagesRepository)));

		const results = await Promise.all(marks.map(async (mark, index) => {
			const [marker, first, revision] = snapshots[index];
			// 과거 읽음 정보가 없는 표식은 명시적 읽기만 정리한다. 뮤트·철회는 읽기가 아니다.
			if (marker === '' || first === '') return 0;
			if (remaining[index] === marker) return 0;
			// DB를 읽는 동안 새 수신이나 읽음이 있었다면 그 상태를 보존한다.
			return Number(await this.redisClient.eval(RECONCILE_CHAT_UNREAD, 6, ...this.unreadKeys(mark),
				marker, first, revision, remaining[index] ?? '', this.unreadConversation(mark), randomUUID()));
		}));

		const changedReaders = new Map<MiUser['id'], boolean>();
		marks.forEach((mark, index) => {
			if (results[index] === 0) return;
			changedReaders.set(mark.readerId, (changedReaders.get(mark.readerId) ?? false) || results[index] === 1);
		});
		await Promise.all([...changedReaders].map(async ([readerId, unreadLeft]) => {
			if (await this.hasUnreadMessages(readerId)) {
				// 철회한 마지막 글의 지연 알림은 취소되므로, 남은 미읽음은 소리 없이 동기화한다.
				if (unreadLeft) this.globalEventService.publishMainStream(readerId, 'chatUnreadChanged');
			} else {
				this.globalEventService.publishMainStream(readerId, 'readAllChatMessages');
			}
		}));
	}

	/** Whether this very message is still unread for the reader, asked just before a delayed notice goes out. */
	private async isMessageUnread(mark: UnreadMark, messageId: MiChatMessage['id']): Promise<boolean> {
		return Number(await this.redisClient.eval(IS_CHAT_MESSAGE_UNREAD, 2, `newChatMessagesExists:${mark.readerId}`, `${this.unreadKey(mark)}:messages`, this.unreadConversation(mark), messageId)) === 1;
	}

	/**
	 * A notice for a message still unread after a while. A read in the meantime, of this message or of a later one,
	 * cancels it: a notice arriving after the word that everything had been read would leave the sign on for good.
	 */
	private async noticeUnreadDirectMessage(message: MiChatMessage, toUser: MiUser, mark: UnreadMark): Promise<void> {
		if (!(await this.isMessageUnread(mark, message.id))) return;

		// Delete and Update can arrive within this delay. Never notify with text the sender already withdrew.
		const latest = await this.chatMessagesRepository.findOneBy({ id: message.id });
		if (latest == null || latest.deletedAt != null) return;
		if (await this.isFromSuspendedUser(latest)) return;

		// The chat list leaves out a conversation with a muted account, so nothing points the recipient at it either.
		if (await this.mutingsRepository.existsBy({ muterId: toUser.id, muteeId: message.fromUserId })) return;

		const packedMessageForTo = await this.chatEntityService.packMessageDetailed(latest, toUser);
		if (!(await this.isMessageUnread(mark, message.id))) return;
		this.globalEventService.publishMainStream(toUser.id, 'newChatMessage', packedMessageForTo);
		this.pushNotificationService.pushNotification(toUser.id, 'newChatMessage', packedMessageForTo);
	}

	/** {@link noticeUnreadDirectMessage} for a room: only those who still have it unread, and still take the room's messages. */
	private async noticeUnreadRoomMessage(message: MiChatMessage, room: MiChatRoom, marks: UnreadMark[]): Promise<void> {
		const unread = await this.stillUnread(marks, message.id);
		if (unread.length === 0) return;

		const latest = await this.db.transaction(async manager => {
			const current = await manager.withRepository(this.chatMessagesRepository).findOneBy({ id: message.id });
			if (current == null || current.deletedAt != null || await manager.withRepository(this.usersRepository).existsBy({ id: current.fromUserId, isSuspended: true })) return null;
			return current;
		});
		if (latest == null) return;

		const packedMessageForTo = await this.chatEntityService.packMessageDetailed(latest);

		const quiet = await this.db.transaction(manager => this.quietReadersOf(room, unread.map(mark => mark.readerId), manager));
		for (const mark of await this.stillUnread(unread.filter(mark => !quiet.has(mark.readerId)), message.id)) {
			this.globalEventService.publishMainStream(mark.readerId, 'newChatMessage', packedMessageForTo);
			this.pushNotificationService.pushNotification(mark.readerId, 'newChatMessage', packedMessageForTo);
		}
	}

	private async stillUnread(marks: UnreadMark[], messageId: MiChatMessage['id']): Promise<UnreadMark[]> {
		const unread = await Promise.all(marks.map(mark => this.isMessageUnread(mark, messageId)));
		return marks.filter((_, index) => unread[index]);
	}

	/**
	 * Of these participants, those a new message in the room is to stay away from: they muted the room, or are no longer in it.
	 * Asked again after storing and before the delayed notice, as both can change in the meantime.
	 */
	private async quietReadersOf(room: Pick<MiChatRoom, 'id'>, userIds: MiUser['id'][], manager?: EntityManager): Promise<Map<MiUser['id'], 'muted' | 'gone'>> {
		const quiet = new Map<MiUser['id'], 'muted' | 'gone'>();
		const current = await (manager?.withRepository(this.chatRoomsRepository) ?? this.chatRoomsRepository).findOneBy({ id: room.id });
		if (current == null) {
			for (const userId of userIds) quiet.set(userId, 'gone');
			return quiet;
		}
		const memberships = await (manager?.withRepository(this.chatRoomMembershipsRepository) ?? this.chatRoomMembershipsRepository).findBy({ roomId: current.id });
		for (const userId of userIds) {
			if (userId === current.ownerId) {
				if (current.isMutedByOwner) quiet.set(userId, 'muted');
				continue;
			}
			const membership = memberships.find(member => member.userId === userId);
			if (membership == null) quiet.set(userId, 'gone');
			else if (membership.isMuted) quiet.set(userId, 'muted');
		}
		return quiet;
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
	public isFromSuspendedUser(message: Pick<MiChatMessage, 'fromUserId'>): Promise<boolean> {
		return this.usersRepository.existsBy({ id: message.fromUserId, isSuspended: true });
	}

	/**
	 * The unread marks of a direct message from this account lead to something no longer shown, so they go.
	 * A remote account also leaves the rooms owned here and loses its invitations to them, for good:
	 * lifting the suspension does not bring either back.
	 */
	@bindThis
	public async handleUserSuspended(user: MiUser): Promise<void> {
		// 정지는 이미 저장됐다. 읽음 정리가 실패해도 아래의 연합 정리는 계속한다.
		await this.clearUnreadMarksOfDirectMessagesFrom(user.id).catch(error => this.reportUnreadFailure('suspension, direct messages', error));
		await this.clearUnreadMarksOfHiddenRoomsFrom(user.id).catch(error => this.reportUnreadFailure('suspension, rooms', error));

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
				if (room?.owner != null) await this.kickRoomMember(room.owner, room, user.id);
			}),
			...invitations.map(async invitation => {
				const room = roomOwnedHere(invitation.roomId);
				if (room != null) await this.cancelRoomInvitation(room.ownerId, invitation.id);
			}),
		]);
	}

	private async unreadMarksOfRoomsFrom(authorId: MiUser['id']): Promise<UnreadMark[]> {
		const marks: UnreadMark[] = [];
		const messages = await this.chatMessagesRepository.createQueryBuilder('message')
			.select('DISTINCT message.toRoomId', 'roomId')
			.where('message.fromUserId = :authorId', { authorId })
			.andWhere('message.toRoomId IS NOT NULL')
			.getRawMany<{ roomId: MiChatRoom['id'] }>();
		for (const { roomId } of messages) {
			if (roomId == null) continue;
			const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
			if (room == null) continue;
			const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId });
			marks.push(...[...memberships.map(member => member.userId), room.ownerId].map(readerId => ({ readerId, roomId })));
		}
		return marks;
	}

	private async clearUnreadMarksOfHiddenRoomsFrom(authorId: MiUser['id']): Promise<void> {
		await this.reconcileUnreadMarks(await this.unreadMarksOfRoomsFrom(authorId));
	}

	private async unreadMarksOfDirectMessagesFrom(senderId: MiUser['id']): Promise<UnreadMark[]> {
		const readers = await this.chatMessagesRepository.createQueryBuilder('message')
			.select('DISTINCT message.toUserId', 'toUserId')
			.where('message.fromUserId = :userId', { userId: senderId })
			.andWhere('message.toUserId IS NOT NULL')
			.getRawMany<{ toUserId: MiUser['id'] }>();
		return readers.map(({ toUserId }) => ({ readerId: toUserId, senderId }));
	}

	/** For an account whose direct messages are going out of sight while they stay stored: suspended. */
	@bindThis
	public async clearUnreadMarksOfDirectMessagesFrom(senderId: MiUser['id']): Promise<void> {
		await this.clearUnreadMarks(await this.unreadMarksOfDirectMessagesFrom(senderId));
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
		if (message.dice != null) throw new ChatMessageAccessError('dice message is immutable');
		await this.assertCanStillEdit(message);
		await this.assertMessageRoomNotArchived(message);

		const trimmed = text.trim();
		if ((trimmed.length === 0 && !await this.hasFile(message)) || Array.from(trimmed).length > MAX_CHAT_MESSAGE_TEXT_LENGTH) throw new ChatMessageInvalidTextError('invalid text');

		const editedAt = new Date();
		const emojis = extractCustomEmojisFromMfm(mfm.parse(trimmed));
		const result = await this.chatMessagesRepository.update({ id: message.id, deletedAt: IsNull(), dice: IsNull() }, { text: trimmed, editedAt, emojis });
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
			dice: null,
			fileIds: [],
			reactions: [],
			deletedAt,
		});
		message.text = null;
		message.dice = null;
		message.fileIds = [];
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

		// The withdrawal is stored and on its way to other servers. A failed unread update does not undo or fail it.
		await this.reconcileUnreadAfterMessageDeletion(message, participants).catch(error => this.reportUnreadFailure('withdrawal', error));
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
	public async roomTimeline(roomId: MiChatRoom['id'], limit: number, sinceId?: MiChatMessage['id'] | null, untilId?: MiChatMessage['id'] | null, includeDeleted = false) {
		const query = this.queryService.makePaginationQuery(this.chatMessagesRepository.createQueryBuilder('message'), sinceId, untilId)
			.andWhere('message.toRoomId = :roomId', { roomId })
			.leftJoinAndSelect('message.fromUser', 'fromUser');
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

			const message = await query.take(1).getOne();

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

		const roomIds = [...new Set(memberRoomIds.concat(ownedRoomIds))];

		if (memberRoomIds.length === 0 && ownedRoomIds.length === 0) {
			return [];
		}

		const history: MiChatMessage[] = [];

		// Once every room has a result, another lookup can only scan messages from rooms already found.
		for (let i = 0; i < Math.min(limit, roomIds.length); i++) {
			const found = history.map(m => m.toRoomId!);

			const query = this.chatMessagesRepository.createQueryBuilder('message')
				.orderBy('message.id', 'DESC')
				.where('message.toRoomId IN (:...roomIds)', { roomIds })
				.andWhere('message.deletedAt IS NULL');
			this.excludeSuspendedAuthors(query);

			if (found.length > 0) {
				query.andWhere('message.toRoomId NOT IN (:...found)', { found: found });
			}

			const message = await query.take(1).getOne();

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
		const unread = await this.unreadConversations(otherIds.map(senderId => ({ readerId: userId, senderId })));
		return Object.fromEntries(otherIds.map((senderId, index) => [senderId, !unread[index]]));
	}

	@bindThis
	public async getRoomReadStateMap(userId: MiUser['id'], roomIds: MiChatRoom['id'][]) {
		const unread = await this.unreadConversations(roomIds.map(roomId => ({ readerId: userId, roomId })));
		return Object.fromEntries(roomIds.map((roomId, index) => [roomId, !unread[index]]));
	}

	/**
	 * Whether a conversation the chat list shows is unread. A mark does not count while the list leaves its
	 * conversation out: one with no message left in it, or a direct one with an account the reader mutes.
	 * Otherwise the sign would stay on with nothing to open.
	 */
	@bindThis
	public async hasUnreadMessages(userId: MiUser['id']) {
		const conversations = await this.redisClient.smembers(`newChatMessagesExists:${userId}`);
		if (conversations.length === 0) return false;

		const idsOf = (kind: 'user' | 'room') => conversations.filter(conversation => conversation.startsWith(`${kind}:`)).map(conversation => conversation.slice(kind.length + 1));

		const senderIds = idsOf('user');
		const mutings = senderIds.length > 0 ? await this.mutingsRepository.findBy({ muterId: userId, muteeId: In(senderIds) }) : [];
		const shownIds = senderIds.filter(senderId => !mutings.some(muting => muting.muteeId === senderId));
		const roomIds = idsOf('room');
		// 탈퇴나 제거가 저장된 직후에도 접근할 수 없는 방은 미읽음에 포함하지 않는다.
		const visibleRoomIds = roomIds.length === 0 ? new Set<string>() : await this.db.transaction(async manager => {
			const [memberships, owned] = await Promise.all([
				manager.withRepository(this.chatRoomMembershipsRepository).findBy({ userId, roomId: In(roomIds) }),
				manager.withRepository(this.chatRoomsRepository).findBy({ ownerId: userId, id: In(roomIds) }),
			]);
			return new Set([...memberships.map(membership => membership.roomId), ...owned.map(room => room.id)]);
		});

		// 대화마다 따로 묻지 않고 한 번에 확인한다. 계정 정보를 받을 때마다 불린다.
		const marks: UnreadMark[] = [
			...roomIds.filter(roomId => visibleRoomIds.has(roomId)).map(roomId => ({ readerId: userId, roomId })),
			...shownIds.map(senderId => ({ readerId: userId, senderId })),
		];
		if (marks.length === 0) return false;
		return (await this.unreadConversations(marks)).some(unread => unread);
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
	public async deleteRoom(requestedRoom: MiChatRoom, deleter?: MiUser, options?: { federate?: boolean }): Promise<void> {
		// 삭제할 방과 수신 대상을 주 DB에서 함께 읽고, 큐 등록을 기다리기 전에 트랜잭션을 닫는다.
		const snapshot = await this.db.transaction(async manager => {
			const room = await manager.withRepository(this.chatRoomsRepository).findOneBy({ id: requestedRoom.id });
			if (room == null) return null;
			const memberships = await manager.withRepository(this.chatRoomMembershipsRepository).findBy({ roomId: room.id });
			const invitations = await manager.withRepository(this.chatRoomInvitationsRepository).findBy({ roomId: room.id });
			const ids = [...new Set([room.ownerId, ...memberships.map(membership => membership.userId), ...invitations.map(invitation => invitation.userId)])];
			const users = await manager.withRepository(this.usersRepository).findBy({ id: In(ids) });
			const byId = new Map(users.map(user => [user.id, user]));
			const participants = [...new Set([room.ownerId, ...memberships.map(membership => membership.userId)])].flatMap(id => {
				const user = byId.get(id);
				return user == null ? [] : [user];
			});
			const invitees = invitations.flatMap(invitation => {
				const user = byId.get(invitation.userId);
				return user == null ? [] : [user];
			});
			return { room, owner: byId.get(room.ownerId), participants, invitees, memberships, invitations };
		});
		if (snapshot == null) return;
		const { room, owner, participants, invitees, memberships, invitations } = snapshot;
		if (options?.federate !== false && owner != null) {
			if (this.userEntityService.isLocalUser(owner)) {
				// A remote owner's server is the authority for its room, so only rooms owned here are announced.
				// The announcement is signed by the owner even when a moderator deletes the room.
				await this.deliverToRemoteUsers(owner, [...participants, ...invitees], this.apRendererService.renderChatRoomDelete(room, owner), { required: true });
			} else if (this.userEntityService.isRemoteUser(owner)) {
				await this.leaveRoomRemovedHere(room, owner, participants, invitees, invitations);
			}
		}

		// 미읽음 정리는 배송 등록 뒤에 진행하며, 소유자는 별도 membership 행이 없다.
		await this.clearUnreadMarks([...memberships.map(membership => membership.userId), room.ownerId].map(readerId => ({ readerId, roomId: room.id })))
			.catch(error => this.reportUnreadFailure('room deletion', error));

		const peopleHere = this.localUserIds([...participants, ...invitees]);
		await this.chatRosterService.markRoomDeletedFor(peopleHere, room.id);

		await this.chatRoomsRepository.delete(room.id);
		this.globalEventService.publishChatRoomStream(room.id, 'roomDeleted');
		this.notifyRoomListChanged(peopleHere);

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
	private async leaveRoomRemovedHere(room: MiChatRoom, owner: MiRemoteUser, participants: MiUser[], invitees: MiUser[], invitations: MiChatRoomInvitation[]): Promise<void> {
		const roomUri = await this.roomUriForRoom(room);
		for (const member of participants) {
			if (!this.userEntityService.isLocalUser(member)) continue;
			await this.deliverToRemoteUsers(member, participants, {
				...this.apRendererService.renderRemove(member, roomUri, this.userEntityService.genLocalUserUri(member.id)),
				id: `${this.config.url}/activities/${this.idService.gen()}`,
				published: new Date().toISOString(),
			}, { required: true });
		}
		const rejections = invitees.flatMap(invitee => {
			const invitation = invitations.find(candidate => candidate.userId === invitee.id);
			return invitation != null && this.userEntityService.isLocalUser(invitee)
				? [Promise.resolve(this.deliverInvitationReject(room, owner, invitee, invitation))]
				: [];
		});
		const results = await Promise.allSettled(rejections);
		const failures = results.filter(result => result.status === 'rejected');
		if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Failed to queue room invitation rejections');
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

		const room = await this.chatRoomsRepository.findOneBy({ id: roomId, ownerId: inviterId });
		if (room == null) throw new ChatRoomAccessError('no such room');

		if (room.isArchived) throw new ChatRoomArchivedError('room is archived');

		const invitee = await this.usersRepository.findOneBy({ id: inviteeId });
		if (invitee == null) throw new ChatRoomInvitationRefusedError('noSuchUser');
		if (invitee.isSuspended) throw new ChatRoomInvitationRefusedError('suspended');

		if (await this.isRoomMember(room, inviteeId)) {
			throw new ChatRoomInvitationRefusedError('alreadyMember');
		}

		const existingInvitation = await this.chatRoomInvitationsRepository.findOneBy({ roomId, userId: inviteeId });
		if (existingInvitation) {
			throw new ChatRoomInvitationRefusedError('alreadyInvited');
		}

		const membershipsCount = await this.chatRoomMembershipsRepository.countBy({ roomId });
		if (membershipsCount >= MAX_ROOM_MEMBERS) {
			throw new ChatRoomFullError('room is full');
		}

		const [blocked, blocking] = await Promise.all([
			this.userBlockingService.checkBlocked(inviteeId, inviterId),
			this.userBlockingService.checkBlocked(inviterId, inviteeId),
		]);
		if (blocked) {
			throw new ChatRoomInvitationRefusedError('blocked');
		}
		if (blocking) {
			throw new ChatRoomInvitationRefusedError('blocking');
		}

		const invitation = {
			id: this.idService.gen(),
			roomId: room.id,
			userId: inviteeId,
		} satisfies Partial<MiChatRoomInvitation>;

		const created = await this.chatRoomInvitationsRepository.insertOne(invitation).catch(err => {
			// A second request can pass the check above while the first one is still inserting.
			if (isDuplicateKeyValueError(err)) throw new ChatRoomInvitationRefusedError('alreadyInvited');
			throw err;
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

		// Federation: Notify about acceptance and new member
		// Without a new membership (e.g. a duplicate join, or one a lost Remove left behind) there is no new member to announce.
		if (newMembership != null) this.globalEventService.publishChatRoomStream(roomId, 'membershipStarted', { userId });
		const owner = await this.usersRepository.findOneByOrFail({ id: room.ownerId });
		const joinedAt = newMembership != null ? this.idService.parse(newMembership.id).date : new Date();

		// Get all members (including owner, excluding the joining user)
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId });
		const memberUserIds = [room.ownerId, ...memberships.map(m => m.userId)].filter(id => id !== userId);
		const memberUsers = await this.usersRepository.findBy({ id: In(memberUserIds) });
		const remoteMembers = memberUsers.filter(m => this.userEntityService.isRemoteUser(m));

		// Send Accept activity to the inviter (room owner) if they are remote
		if (this.userEntityService.isLocalUser(joiningUser) && this.userEntityService.isRemoteUser(owner)) {
			const roomObject = this.apRendererService.renderChatRoom(room, owner);
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
		if (newMembership != null && remoteMembers.length > 0 && this.userEntityService.isLocalUser(owner)) {
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

	private deliverInvitationReject(room: MiChatRoom, inviter: MiRemoteUser, invitee: MiLocalUser, invitation: Pick<MiChatRoomInvitation, 'invitePublishedAt'>) {
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
		return this.queueService.deliver(invitee, this.apRendererService.addContext(activity), inviter.inbox, false);
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
		});
		this.globalEventService.publishChatRoomStream(roomId, 'membershipEnded', { userId });
		this.notifyRoomListChanged(this.localUserIds([leavingUser]));

		// ルームを抜けたら通話からも外す。LiveKit が落ちていても退出自体は成功させる
		this.liveKitService.removeParticipant(roomId, this.liveKitService.identityOf(leavingUser)).catch(() => {});

		// 未読フラグを消す (「既読にする」というわけでもないのでreadメソッドは使わないでおく)
		// 탈퇴는 이미 저장됐다. 읽음 정리가 실패해도 다른 서버에 탈퇴를 알린다.
		await this.clearUnreadMarks([{ readerId: userId, roomId }]).catch(error => this.reportUnreadFailure('leaving a room', error));

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
		const removed = await this.db.transaction(async manager => {
			const locked = await manager.findOne(MiChatRoom, { where: { id: room.id }, lock: { mode: 'pessimistic_write' } });
			if (locked == null) return false;
			const result = await manager.delete(MiChatRoomMembership, { roomId: room.id, userId: member.id });
			return (result.affected ?? 0) > 0;
		});
		if (!removed) return false;
		await this.finishRoomMemberRemoval(room, member);
		return true;
	}

	/** Call after the transaction that removed the membership commits. */
	@bindThis
	public async finishRoomMemberRemoval(room: MiChatRoom, member: MiUser): Promise<void> {
		this.globalEventService.publishChatRoomStream(room.id, 'membershipEnded', { userId: member.id });

		// 멤버 제거는 이미 저장됐다. 읽음 정리가 실패해도 호출한 쪽의 연합 전달을 막지 않는다.
		await this.clearUnreadMarks([{ readerId: member.id, roomId: room.id }]).catch(error => this.reportUnreadFailure('removing a member', error));

		this.notifyRoomListChanged(this.localUserIds([member]));
	}

	/**
	 * Muting is each participant's own choice, told to nobody else on this server or another.
	 * A member's is kept on the membership. The owner has none, so the room keeps theirs.
	 */
	@bindThis
	public async muteRoom(userId: MiUser['id'], roomId: MiChatRoom['id'], mute: boolean) {
		const membership = await this.chatRoomMembershipsRepository.findOneBy({ roomId, userId });
		if (membership != null) {
			await this.chatRoomMembershipsRepository.update(membership.id, { isMuted: mute });
			return;
		}

		const owned = await this.chatRoomsRepository.update({ id: roomId, ownerId: userId }, { isMutedByOwner: mute });
		if ((owned.affected ?? 0) === 0) throw new ChatRoomAccessError('not a member');
	}

	@bindThis
	public async updateRoom(room: MiChatRoom, params: {
		name?: string;
		description?: string;
		isArchived?: boolean;
	}, options?: { federate?: boolean; remoteUpdatedAt?: Date }): Promise<MiChatRoom> {
		const wasArchived = room.isArchived;
		const remoteUpdatedAt = options?.remoteUpdatedAt;
		// TypeORM refuses an UPDATE that has nothing to set.
		if (remoteUpdatedAt == null && Object.values(params).every(value => value === undefined)) return room;
		const query = this.chatRoomsRepository.createQueryBuilder().update()
			.set(remoteUpdatedAt != null ? { ...params, lastRemoteUpdatedAt: remoteUpdatedAt } : params)
			.where('id = :id', { id: room.id });
		// Keep this conditional in SQL as multiple inbox workers may read the same revision.
		if (remoteUpdatedAt != null) {
			query.andWhere('("lastRemoteUpdatedAt" IS NULL OR "lastRemoteUpdatedAt" <= :remoteUpdatedAt)', { remoteUpdatedAt });
		}
		const updated = await query
			.returning('*')
			.execute()
			.then((response) => {
				return response.raw[0] as MiChatRoom | undefined;
			});
		if (updated == null) return room;

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
		const participants = [...await this.participantsForRoom(merged), ...await this.inviteesForRoom(merged)];
		this.notifyRoomListChanged(this.localUserIds(participants));
		if (options?.federate !== false && owner != null && owner.host == null) {
			await this.deliverToRemoteUsers(owner, participants, this.apRendererService.renderChatRoomUpdate(merged, owner));
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
		} else if (await this.userBlockingService.checkBlocked(message.fromUserId, userId)) {
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
		const messageUri = chatMessageUri(message, this.config.url);
		const activityId = `${this.userEntityService.genLocalUserUri(actor.id)}/chat-reactions/${randomUUID()}`;
		await this.redisClient.setex(this.chatReactionActivityIdKey(actor.id, messageUri, reaction), CHAT_REACTION_ACTIVITY_ID_TTL, activityId);
		await this.deliverToRemoteUsers(actor, participants, await this.apRendererService.renderChatReaction(message, actor, toUsers, reaction, activityId, await this.roomUriForMessage(message)));
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
		const messageUri = chatMessageUri(message, this.config.url);
		const activityIdKey = this.chatReactionActivityIdKey(actor.id, messageUri, reaction);
		const activityId = await this.redisClient.get(activityIdKey) ?? undefined;
		await this.redisClient.del(activityIdKey);
		await this.deliverToRemoteUsers(actor, participants, await this.apRendererService.renderChatReactionUndo(message, actor, toUsers, reaction, activityId, await this.roomUriForMessage(message)));
	}

	@bindThis
	public async findMessageByUri(uri: string): Promise<MiChatMessage | null> {
		const message = await this.chatMessagesRepository.findOneBy({ uri });
		if (message != null) return message;

		const id = localChatMessageIdFromUri(uri, this.config.url);
		return id != null ? this.chatMessagesRepository.findOneBy({ id }) : null;
	}

	@bindThis
	public async updateRemoteMessage(actor: MiUser, message: MiChatMessage, text: string, editedAt: Date, emojis: string[] = []): Promise<MiChatMessage> {
		if (message.fromUserId !== actor.id) throw new ChatMessageAccessError('cannot edit');
		if (message.deletedAt != null) throw new ChatMessageAccessError('deleted');
		if (message.dice != null) throw new ChatMessageAccessError('dice message is immutable');
		if (message.editedAt != null && message.editedAt >= editedAt) return message;
		await this.assertCanStillEdit(message);
		const room = message.toRoomId != null ? await this.chatRoomsRepository.findOneBy({ id: message.toRoomId }) : null;
		if (room != null) await this.assertRemoteWriteAllowed(room);

		const trimmed = text.trim();
		if ((trimmed.length === 0 && !await this.hasFile(message)) || Array.from(trimmed).length > MAX_CHAT_MESSAGE_TEXT_LENGTH) throw new ChatMessageAccessError('invalid text');

		// Keep this conditional in SQL as multiple inbox workers may read the same revision.
		const result = await this.chatMessagesRepository.update([
			{ id: message.id, fromUserId: actor.id, deletedAt: IsNull(), dice: IsNull(), editedAt: IsNull() },
			{ id: message.id, fromUserId: actor.id, deletedAt: IsNull(), dice: IsNull(), editedAt: LessThan(editedAt) },
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

		if (room != null) await this.relayToOtherServers(room, actor, (owner, toUsers) => this.apRendererService.renderChatRoomRelay(message, room, owner, toUsers, editedAt));

		return message;
	}

	/** @param options.activity What arrived, for the owner's server to pass on. */
	@bindThis
	public async deleteRemoteMessage(actor: MiUser, message: MiChatMessage, options?: { activity?: IObject }): Promise<MiChatMessage> {
		if (message.fromUserId !== actor.id) {
			const author = await this.usersRepository.findOneBy({ id: message.fromUserId });
			if (author == null || this.userEntityService.isLocalUser(author)) throw new ChatMessageAccessError('cannot delete');
			// The room's owner moderates it, including what someone else wrote.
			const room = message.toRoomId != null ? await this.chatRoomsRepository.findOneBy({ id: message.toRoomId }) : null;
			if (room?.ownerId !== actor.id) throw new ChatMessageAccessError('cannot delete');
		}
		if (message.deletedAt != null) return message;

		const deletedAt = new Date();
		await this.chatMessagesRepository.update(message.id, {
			text: null,
			dice: null,
			fileIds: [],
			reactions: [],
			deletedAt,
		});
		message.text = null;
		message.dice = null;
		message.fileIds = [];
		message.reactions = [];
		message.deletedAt = deletedAt;

		if (message.toUserId) {
			this.globalEventService.publishChatUserStream(message.fromUserId, message.toUserId, 'deleted', message.id);
			this.globalEventService.publishChatUserStream(message.toUserId, message.fromUserId, 'deleted', message.id);
		} else if (message.toRoomId) {
			this.globalEventService.publishChatRoomStream(message.toRoomId, 'deleted', message.id);
		}

		await this.relayRoomActivity(message, actor, options?.activity);

		// The withdrawal is stored and passed on. A failed unread update does not make the activity fail and come back.
		await this.reconcileUnreadAfterMessageDeletion(message).catch(error => this.reportUnreadFailure('withdrawal from another server', error));

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
		} else if (await this.userBlockingService.checkBlocked(message.fromUserId, actor.id)) {
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
			this.globalEventService.publishChatUserStream(message.fromUserId, message.toUserId!, 'react', {
				messageId: message.id,
				reaction,
			});
			this.globalEventService.publishChatUserStream(message.toUserId!, message.fromUserId, 'react', {
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
			return this.usersRepository.findBy({ id: In([message.fromUserId, message.toUserId]) });
		}

		if (message.toRoomId) {
			const room = await this.chatRoomsRepository.findOneBy({ id: message.toRoomId });
			return room != null ? await this.participantsForRoom(room) : [];
		}

		return [];
	}

	/** @returns The IDs of the queued delivery jobs. Required deliveries fail the caller if registration fails. */
	private async deliverToRemoteUsers(actor: MiUser, users: MiUser[], activity: any, options?: { required?: boolean }): Promise<void> {
		const contextedActivity = this.apRendererService.addContext(activity);
		const delivered = new Set<string>();
		const jobs: Promise<unknown>[] = [];

		for (const user of users) {
			if (user.id === actor.id) continue;
			if (!this.userEntityService.isRemoteUser(user)) continue;
			if (user.isSuspended && !ACTIVITIES_FOR_SUSPENDED_ACCOUNTS.has(activity.type)) continue;

			// Every recipient is named in the activity, so a server needs it only once however many members it has.
			const inbox = user.sharedInbox ?? user.inbox;
			if (inbox == null || delivered.has(inbox)) continue;

			delivered.add(inbox);
			jobs.push(Promise.resolve(this.queueService.deliver(actor, contextedActivity, inbox, user.sharedInbox != null)));
		}

		const queued = await Promise.allSettled(jobs);
		for (const result of queued) {
			if (result.status === 'rejected') this.logger.error(`Failed to queue a chat delivery from ${actor.id}: ${result.reason}`);
		}
		const failures = queued.filter(result => result.status === 'rejected');
		if (options?.required && failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Failed to queue required chat deliveries');
	}

	@bindThis
	public async getMyMemberships(userId: MiUser['id'], limit: number, sinceId?: MiChatRoomMembership['id'] | null, untilId?: MiChatRoomMembership['id'] | null) {
		const query = this.queryService.makePaginationQuery(this.chatRoomMembershipsRepository.createQueryBuilder('membership'), sinceId, untilId)
			.andWhere('membership.userId = :userId', { userId });

		const memberships = await query.take(limit).getMany();

		return memberships;
	}
}
