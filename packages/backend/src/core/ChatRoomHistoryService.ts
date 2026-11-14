/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { QueueService } from '@/core/QueueService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { buildChatHistoryPage, CHAT_HISTORY_PAGE_SIZE, chatHistoryCopyUri, chatHistoryNoteFields } from '@/core/activitypub/misc/chat-history.js';
import type { ChatHistoryAuthor, ChatHistoryReaction } from '@/core/activitypub/misc/chat-history.js';
import { chatActorUri, chatMessageUri } from '@/core/activitypub/misc/chat-payloads.js';
import type { IObject } from '@/core/activitypub/type.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';
import type { ChatMessagesRepository, ChatRoomHistoryStatesRepository, ChatRoomMembershipsRepository, EmojisRepository, MiEmoji, UsersRepository } from '@/models/_.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
import type { ChatMessageArchivedAuthor } from '@/models/ChatMessage.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { ChatRoomHistoryStatus, MiChatRoomHistoryState } from '@/models/ChatRoomHistoryState.js';
import { MiUser } from '@/models/User.js';
import type { ChatDiceResult } from '@/core/chat-dice.js';
import type { ChatChannelRef } from '@/core/chat-room-channels.js';

// 소유 서버의 메시지당 리액션 한도와 같다
const MAX_REACTIONS_PER_MESSAGE = 100;
// 열람으로 다시 요청하는 간격. 참여는 이 제한 없이 처음부터 다시 받는다.
const RESUME_INTERVAL = 60;
const JOIN_DELAY = 5000;

export type ChatHistoryImport = {
	/** 원래 작성자 서버의 메시지 주소. 저장하는 사본의 출처 */
	sourceUri: string;
	authorUri: string;
	authorId: MiUser['id'] | null;
	archivedAuthor: ChatMessageArchivedAuthor | null;
	published: Date;
	editedAt: Date | null;
	text: string | null;
	dice: ChatDiceResult | null;
	fileIds: string[];
	unavailableFileCount: number;
	emojis: string[];
	toRoomChannelId: string | null;
	channelRefs: ChatChannelRef[];
	/** `${userId}/${reaction}` */
	reactions: string[];
};

/**
 * 그룹 소유 서버가 보관한 전체 기록을 내주고, 다른 서버의 그룹이면 그 기록을 가져와 저장한다.
 * 가져온 글은 사본으로 표시하고 미읽음·알림·실시간 새 글 이벤트를 만들지 않는다.
 */
@Injectable()
export class ChatRoomHistoryService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.chatMessagesRepository)
		private chatMessagesRepository: ChatMessagesRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		@Inject(DI.chatRoomHistoryStatesRepository)
		private chatRoomHistoryStatesRepository: ChatRoomHistoryStatesRepository,

		@Inject(DI.emojisRepository)
		private emojisRepository: EmojisRepository,

		private idService: IdService,
		private queueService: QueueService,
		private globalEventService: GlobalEventService,
		private customEmojiService: CustomEmojiService,
		private chatRoomChannelService: ChatRoomChannelService,
		private apRendererService: ApRendererService,
	) {
	}

	//#region 소유 서버

	/**
	 * 과거 기록 한 페이지. 호출자는 서명한 계정이 지금 멤버인지 먼저 확인한다.
	 * 삭제된 글과 정지된 작성자의 글은 싣지 않고, 채널을 모르는 서버에는 구버전용 기본 채널의 글만 싣는다.
	 */
	@bindThis
	public async renderPage(room: MiChatRoom, requester: Pick<MiUser, 'host'>, until: string | null): Promise<IObject> {
		const roomUri = this.apRendererService.genLocalChatRoomUri(room.id);
		const capability = await this.chatRoomChannelService.deliverableTo(requester.host, { toRoomChannelId: null }, room);
		if (capability == null) throw new Error('chat room channel capability is temporarily unavailable');
		const legacyOnly = room.hasChannels && !capability;
		if (legacyOnly && room.legacyChannelId == null) return buildChatHistoryPage(roomUri, until, [], null);

		const query = this.chatMessagesRepository.createQueryBuilder('message')
			.where('message.toRoomId = :roomId', { roomId: room.id })
			.andWhere('message.deletedAt IS NULL')
			// 실시간 조회와 같이 정지된 작성자의 글은 보이지 않는다. 계정이 없어진 글은 남는다.
			.andWhere('NOT EXISTS (SELECT 1 FROM "user" "author" WHERE "author"."id" = "message"."fromUserId" AND "author"."isSuspended")')
			.orderBy('message.id', 'DESC')
			.limit(CHAT_HISTORY_PAGE_SIZE + 1);
		if (until != null) query.andWhere('message.id < :until', { until });
		if (legacyOnly) query.andWhere('message.toRoomChannelId = :channelId', { channelId: room.legacyChannelId });

		const messages = await query.getMany();
		const hasNext = messages.length > CHAT_HISTORY_PAGE_SIZE;
		if (hasNext) messages.pop();

		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		const userIds = new Set<string>([room.ownerId, ...memberships.map(m => m.userId)]);
		for (const message of messages) {
			if (message.fromUserId != null) userIds.add(message.fromUserId);
			for (const pair of message.reactions) userIds.add(pair.split('/')[0]);
		}
		const users = new Map((await this.usersRepository.findBy({ id: In([...userIds]) })).map(user => [user.id, user]));
		const members = [room.ownerId, ...memberships.map(m => m.userId)].map(id => users.get(id)).filter((user): user is MiUser => user != null);

		const items: IObject[] = [];
		for (const message of messages) {
			const item = await this.renderItem(message, users, members, roomUri);
			if (item != null) items.push(item);
		}

		return buildChatHistoryPage(roomUri, until, items, hasNext ? messages.at(-1)!.id : null);
	}

	private async renderItem(message: MiChatMessage, users: Map<string, MiUser>, members: MiUser[], roomUri: string): Promise<IObject | null> {
		const fromUser = message.fromUserId != null ? users.get(message.fromUserId) : undefined;
		let authorUri: string;
		let author: ChatHistoryAuthor | null;
		if (fromUser != null) {
			authorUri = chatActorUri(fromUser, this.config.url);
			author = { name: fromUser.name, username: fromUser.username, host: fromUser.host ?? this.config.host };
		} else if (message.archivedAuthor != null) {
			authorUri = message.archivedAuthor.uri.startsWith('/') ? new URL(message.archivedAuthor.uri, this.config.url).href : message.archivedAuthor.uri;
			author = { name: message.archivedAuthor.name, username: message.archivedAuthor.username, host: message.archivedAuthor.host ?? this.config.host };
		} else {
			// 원래 작성자 주소가 없으면 받는 서버가 출처를 확인할 수 없다
			return null;
		}

		const authorHost = fromUser?.host ?? message.archivedAuthor?.host ?? null;
		const remoteEmojis = authorHost != null ? await this.remoteEmojis(message.emojis, authorHost) : null;
		const toUsers = members.filter(member => member.id !== message.fromUserId);
		const note = await this.apRendererService.renderChatHistoryNote(message, authorUri, remoteEmojis, toUsers, roomUri);
		return { ...note, ...chatHistoryNoteFields(author, await this.renderReactions(message, users), fromUser == null) };
	}

	private async remoteEmojis(names: string[], host: string): Promise<MiEmoji[]> {
		if (names.length === 0) return [];
		return (await this.emojisRepository.findBy({ name: In(names), host })).filter(emoji => emoji.uri != null);
	}

	private async renderReactions(message: MiChatMessage, users: Map<string, MiUser>): Promise<ChatHistoryReaction[]> {
		const reactions: ChatHistoryReaction[] = [];
		for (const pair of message.reactions) {
			const separator = pair.indexOf('/');
			const user = users.get(pair.slice(0, separator));
			const reaction = pair.slice(separator + 1);
			// 지금 리액션할 수 없는 계정의 리액션은 내주지 않는다
			if (user == null || user.isSuspended || user.isDeleted) continue;
			const custom = reaction.match(/^:([\w+-]+)(?:@([^:]+))?:$/);
			if (custom == null) {
				reactions.push({ actor: chatActorUri(user, this.config.url), reaction });
				continue;
			}
			const host = custom[2] == null || custom[2] === '.' ? null : custom[2];
			const emoji = host == null
				? (await this.customEmojiService.localEmojisCache.fetch()).get(custom[1])
				: await this.emojisRepository.findOneBy({ name: custom[1], host });
			const tag = emoji == null || emoji.localOnly ? undefined : host == null ? this.apRendererService.renderEmoji(emoji) : emoji.uri != null ? this.apRendererService.renderRemoteEmoji(emoji) : undefined;
			reactions.push({ actor: chatActorUri(user, this.config.url), reaction: `:${custom[1]}:`, ...(tag != null ? { tag } : {}) });
		}
		return reactions;
	}

	//#endregion

	//#region 받는 서버

	@bindThis
	public async getStatus(roomId: MiChatRoom['id']): Promise<ChatRoomHistoryStatus | null> {
		return (await this.chatRoomHistoryStatesRepository.findOneBy({ roomId }))?.status ?? null;
	}

	/**
	 * 다른 서버가 소유한 그룹의 과거 기록 가져오기를 요청한다.
	 * restart면 첫 페이지(최근 글)부터 다시 받아 빠진 글을 채운다. 아니면 멈춘 곳부터 이어 받는다.
	 */
	@bindThis
	public async requestImport(room: Pick<MiChatRoom, 'id' | 'uri' | 'ownerId'>, options: { restart: boolean }): Promise<void> {
		if (room.uri == null) return;
		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (owner?.host == null) return;

		if (!options.restart) {
			const acquired = await this.redisClient.set(`chat_room_history_request:${room.id}`, '1', 'EX', RESUME_INTERVAL, 'NX');
			if (acquired == null) return;
		}

		const now = new Date();
		const state = await this.chatRoomHistoryStatesRepository.findOneBy({ roomId: room.id });
		if (!options.restart && state?.status === 'running') {
			if (await this.redisClient.exists(`chat_room_history_lock:${room.id}`)) return;
			if (await this.hasPendingImport(room.id, state.pass)) return;
		}
		if (state == null) {
			await this.chatRoomHistoryStatesRepository.createQueryBuilder().insert()
				.values({ roomId: room.id, status: 'running', nextUri: null, pass: 1, completedAt: null, updatedAt: now })
				.orIgnore()
				.execute();
		} else if (options.restart) {
			await this.chatRoomHistoryStatesRepository.createQueryBuilder().update()
				.set({ status: 'running', nextUri: null, pass: () => '"pass" + 1', updatedAt: now })
				.where('roomId = :roomId', { roomId: room.id })
				.execute();
		} else if (state.status === 'completed') {
			return;
		} else {
			await this.chatRoomHistoryStatesRepository.update({ roomId: room.id }, { status: 'running', updatedAt: now });
		}

		// 참여 직후에는 소유 서버가 수락을 처리할 시간을 조금 둔다
		const current = await this.getState(room.id);
		if (current?.status === 'running') await this.enqueueImport(room.id, current.pass, options.restart ? JOIN_DELAY : undefined);
	}

	/** 같은 차례는 항상 같은 작업 ID. 진행 위치는 작업 데이터가 아니라 DB가 쥐고 있다. */
	private historyJobId(roomId: string, pass: number): string {
		return `chat-history-${createHash('sha256').update(JSON.stringify([roomId, pass])).digest('hex')}`;
	}

	private async hasPendingImport(roomId: string, pass: number): Promise<boolean> {
		const job = await this.queueService.dbQueue.getJob(this.historyJobId(roomId, pass));
		if (job == null) return false;
		return ['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'].includes(await job.getState());
	}

	/**
	 * 같은 차례는 큐에 한 번만 넣는다. 큐가 사라지면 다시 요청할 수 있다.
	 * 실패해 남은 작업은 같은 ID로 다시 넣을 수 없으므로 지우고 넣는다.
	 */
	public async enqueueImport(roomId: string, pass: number, delay?: number): Promise<void> {
		const id = this.historyJobId(roomId, pass);
		const job = await this.queueService.dbQueue.getJob(id);
		if (job != null && await job.getState() === 'failed') await job.remove();
		await this.queueService.createChatRoomHistorySyncJob(roomId, pass, id, delay);
	}

	/** 지금 받고 있는 차례. 처음부터 다시 받기로 바뀌면 pass가 달라진다. */
	@bindThis
	public getState(roomId: MiChatRoom['id']): Promise<MiChatRoomHistoryState | null> {
		return this.chatRoomHistoryStatesRepository.findOneBy({ roomId });
	}

	/** @returns 그 사이에 처음부터 다시 받기로 바뀌어 이 차례가 끝났으면 false */
	@bindThis
	public async advance(roomId: MiChatRoom['id'], pass: number, nextUri: string | null): Promise<boolean> {
		const result = await this.chatRoomHistoryStatesRepository.update({ roomId, pass, status: 'running' }, {
			nextUri,
			updatedAt: new Date(),
			...(nextUri == null ? { status: 'completed', completedAt: new Date() } : {}),
		});
		const advanced = (result.affected ?? 0) > 0;
		if (advanced) this.publishStatus(roomId, nextUri == null ? 'completed' : 'running');
		return advanced;
	}

	@bindThis
	public async markUnavailable(roomId: MiChatRoom['id'], pass: number): Promise<void> {
		const result = await this.chatRoomHistoryStatesRepository.update({ roomId, pass, status: 'running' }, { status: 'unavailable', updatedAt: new Date() });
		if ((result.affected ?? 0) > 0) this.publishStatus(roomId, 'unavailable');
	}

	/** 새 글이 아니라 진행 상태의 알림이다. 화면은 이 알림으로 옛 글을 다시 읽는다. */
	private publishStatus(roomId: MiChatRoom['id'], status: ChatRoomHistoryStatus): void {
		this.globalEventService.publishChatRoomStream(roomId, 'historyImported', { status });
	}

	/**
	 * 소유 서버가 내준 글 하나를 사본으로 저장한다. 호출자는 실시간 수신과 같은 메시지 잠금을 잡고 있어야 한다.
	 * 이미 있는 글(삭제 표시 포함)과 삭제가 먼저 도착한 글은 건드리지 않는다.
	 * @returns 새로 저장한 글. 저장하지 않았으면 null
	 */
	@bindThis
	public async importMessage(room: MiChatRoom, input: ChatHistoryImport): Promise<MiChatMessage | null> {
		// 사본은 원래 URI를 선점하지 않는다. 원래 URI의 글이 이미 있거나 삭제가 먼저 도착했으면 사본도 저장하지 않는다.
		const copyUri = chatHistoryCopyUri(this.config.url, room.id, input.sourceUri);
		if (await this.findExistingCopy(room.id, input.sourceUri) != null) return null;
		for (const uri of [copyUri, input.sourceUri]) {
			const tombstone = `chat_delete_upon_arrival:${uri}:${encodeURIComponent(input.authorUri)}`;
			const [direct, relayed] = await this.redisClient.mget(tombstone, `${tombstone}:room:${room.id}`);
			if (direct === input.authorUri || relayed === input.authorUri) return null;
		}

		const reactions = [...new Set(input.reactions)].slice(0, MAX_REACTIONS_PER_MESSAGE);
		const author = input.authorId != null ? await this.usersRepository.findOneBy({ id: input.authorId }) : null;
		const archivedAuthor = author != null ? { uri: input.authorUri, username: author.username, name: author.name, host: author.host } : input.archivedAuthor;
		const message = {
			id: this.idService.gen(input.published.getTime()),
			fromUserId: input.authorId,
			archivedAuthor,
			toRoomId: room.id,
			uri: copyUri,
			sourceUri: input.sourceUri,
			reads: [],
			importedAt: new Date(),
			toRoomChannelId: input.toRoomChannelId,
			channelRefs: input.channelRefs,
			text: input.text != null ? input.text.trim() : null,
			dice: input.dice,
			editedAt: input.editedAt,
			fileIds: input.fileIds,
			unavailableFileCount: input.unavailableFileCount,
			emojis: input.emojis,
			reactions,
		} satisfies Partial<MiChatMessage>;

		try {
			return await this.chatMessagesRepository.insertOne(message);
		} catch (err) {
			// 다른 작업자가 먼저 저장했거나, 그 사이 그룹이나 채널이 지워졌다
			if (isDuplicateKeyValueError(err) || (err as { code?: string }).code === '23503') return null;
			throw err;
		}
	}

	/** 사본 URI나 원래 주소로 이미 저장된 글(삭제 표시 포함). 사본이 있으면 사본을 우선 돌려준다. */
	@bindThis
	public async findExistingCopy(roomId: MiChatRoom['id'], sourceUri: string): Promise<MiChatMessage | null> {
		const copyUri = chatHistoryCopyUri(this.config.url, roomId, sourceUri);
		const rows = await this.chatMessagesRepository.findBy({ uri: In([copyUri, sourceUri]) });
		return rows.find(message => message.uri === copyUri) ?? rows[0] ?? null;
	}

	/** 원래 URI로 도착한 리액션이 닿을, 삭제되지 않은 보관 사본 하나. 중계된 리액션은 그 그룹의 사본만 본다. */
	@bindThis
	public findArchivedCopyBySourceUri(sourceUri: string, roomId?: MiChatRoom['id']): Promise<MiChatMessage | null> {
		return this.chatMessagesRepository.findOneBy({ sourceUri, deletedAt: IsNull(), ...(roomId != null ? { toRoomId: roomId } : {}) });
	}

	/** 원래 URI로 도착한 Delete가 닿을 수 있는, 삭제되지 않은 보관 사본들 */
	@bindThis
	public findArchivedCopiesBySourceUri(sourceUri: string): Promise<MiChatMessage[]> {
		return this.chatMessagesRepository.findBy({ sourceUri, deletedAt: IsNull() });
	}

	//#endregion

	/** 이 서버의 사용자가 서명할 수 있는, 지금의 멤버 */
	@bindThis
	public async localMembers(room: MiChatRoom): Promise<MiUser[]> {
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		if (memberships.length === 0) return [];
		return this.usersRepository.findBy({ id: In(memberships.map(m => m.userId)), host: IsNull(), isSuspended: false });
	}
}
