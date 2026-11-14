/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DelayedError } from 'bullmq';
import * as Redis from 'ioredis';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { ChatRoomHistoryService } from '@/core/ChatRoomHistoryService.js';
import { ChatChannelError } from '@/core/chat-room-channels.js';
import { parseChatDiceResult } from '@/core/chat-dice.js';
import { HostPolicyService } from '@/core/HostPolicyService.js';
import { IdService } from '@/core/IdService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApMfmService } from '@/core/activitypub/ApMfmService.js';
import { ApResolverService } from '@/core/activitypub/ApResolverService.js';
import { ApNoteService } from '@/core/activitypub/models/ApNoteService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { chatHistoryCopyUri, chatHistoryPageUri, parseChatHistoryItem, parseChatHistoryPage, roomUriOf } from '@/core/activitypub/misc/chat-history.js';
import type { ChatHistoryItem, ChatHistoryItemContext } from '@/core/activitypub/misc/chat-history.js';
import { chatNoteText } from '@/core/activitypub/misc/chat-payloads.js';
import { getApType, getOneApId, isActor, isEmoji } from '@/core/activitypub/type.js';
import type { IObject, IPost } from '@/core/activitypub/type.js';
import { acquireApObjectLock } from '@/misc/distributed-lock.js';
import { isTemporaryFetchFailure } from '@/misc/is-temporary-fetch-failure.js';
import { toArray } from '@/misc/prelude/array.js';
import { StatusError } from '@/misc/status-error.js';
import type { ChatRoomsRepository, EmojisRepository, MiUser, UsersRepository } from '@/models/_.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { MAX_REMOTE_CHAT_MESSAGE_FILES } from '@/core/ChatService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import { ChatRoomRosterSyncProcessorService } from './ChatRoomRosterSyncProcessorService.js';
import type * as Bull from 'bullmq';
import type { ChatRoomHistorySyncJobData } from '../types.js';

// 소유 서버가 이 서버의 멤버를 아직 모를 수 있으니 몇 명까지는 다른 멤버로 서명해 본다 (명단 동기화와 같다)
const MAX_SIGNERS = 3;
// 한 번에 받는 페이지 수. 나머지는 잠시 뒤 이어서 받아 다른 작업이 큐를 쓸 수 있게 한다.
const PAGES_PER_RUN = 25;
const CONTINUE_DELAY = 1000;
const LOCK_TTL = 10 * 60;
const LOCK_RECHECK_DELAY = 30 * 1000;
// 삭제된 작성자 정보가 없는 행은 응답에서 빠질 수 있다. 연속 100페이지까지는 기다린다.
const MAX_PAGES_WITHOUT_PROGRESS = 100;
const PROGRESS_TTL = 7 * 24 * 60 * 60;
// 메시지당 리액션 한도와 같다
const MAX_REACTIONS_PER_MESSAGE = 100;

type ImportRun = {
	lastAttempt: boolean;
	ownerHost: string;
	signers: MiUser[];
	accounts: Map<string, MiRemoteUser | null>;
	authors: Map<string, MiRemoteUser | null>;
	checkedEmojis: Set<string>;
	channelsRefreshed: boolean;
};

class HistoryUnavailableError extends Error {}

/**
 * 다른 서버가 소유한 그룹의 과거 기록을 소유 서버에서 서명 조회로 받아 저장한다.
 * 최근 글부터 끝까지 받고, 페이지마다 진행 위치를 남겨 중단돼도 이어 받는다.
 */
@Injectable()
export class ChatRoomHistorySyncProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.emojisRepository)
		private emojisRepository: EmojisRepository,

		private chatService: ChatService,
		private chatRoomChannelService: ChatRoomChannelService,
		private chatRoomHistoryService: ChatRoomHistoryService,
		private apResolverService: ApResolverService,
		private apDbResolverService: ApDbResolverService,
		private apPersonService: ApPersonService,
		private apInboxService: ApInboxService,
		private apNoteService: ApNoteService,
		private apMfmService: ApMfmService,
		private userEntityService: UserEntityService,
		private utilityService: UtilityService,
		private hostPolicyService: HostPolicyService,
		private idService: IdService,
		private queueLoggerService: QueueLoggerService,
		private chatRoomRosterSyncProcessorService: ChatRoomRosterSyncProcessorService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('chat-room-history-sync');
	}

	@bindThis
	public async process(job: Bull.Job<ChatRoomHistorySyncJobData>): Promise<string> {
		const found = await this.chatRoomsRepository.findOneBy({ id: job.data.roomId });
		if (found?.uri == null) return 'skip: no room to read the history of';
		const room = found as MiChatRoom & { uri: string };

		const state = await this.chatRoomHistoryService.getState(room.id);
		if (state == null || state.status !== 'running') return 'skip: nothing to fetch';
		if (job.data.pass != null && job.data.pass !== state.pass) return 'skip: started over';

		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (owner == null || !this.userEntityService.isRemoteUser(owner)) return 'skip: the room is owned here';
		if (owner.isSuspended || await this.hostPolicyService.isRefusedRemoteHost(owner.host) || this.hostOf(room.uri) !== owner.host) {
			await this.chatRoomHistoryService.markUnavailable(room.id, state.pass);
			return 'skip: the owner\'s server cannot be asked';
		}

		// 한 그룹은 한 작업만 받는다. 같은 글을 두 작업이 동시에 저장하지 않게 하는 것은 메시지 잠금이 맡는다.
		const lockKey = `chat_room_history_lock:${room.id}`;
		const token = randomUUID();
		// 앞선 작업의 잠금이 남아 있으면 시도 횟수를 소모하지 않고 나중에 다시 확인한다.
		// 비정상 종료 뒤 잠금이 만료되기를 기다려도 다른 그룹의 작업은 계속 진행한다.
		if (await this.redisClient.set(lockKey, token, 'EX', LOCK_TTL, 'NX') == null) {
			await job.moveToDelayed(Date.now() + LOCK_RECHECK_DELAY, job.token);
			throw new DelayedError();
		}

		const run: ImportRun = {
			lastAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
			ownerHost: owner.host,
			signers: [],
			accounts: new Map(),
			authors: new Map(),
			checkedEmojis: new Set(),
			channelsRefreshed: false,
		};

		try {
			for (let i = 0; i < PAGES_PER_RUN; i++) {
				await this.redisClient.expire(lockKey, LOCK_TTL);

				const current = await this.chatRoomHistoryService.getState(room.id);
				if (current == null || current.status !== 'running' || current.pass !== state.pass) return 'skip: started over';

				const signers = await this.chatRoomHistoryService.localMembers(room);
				// 처음부터 다시 받는 것은 이 서버의 사용자가 다시 참여할 때다
				if (signers.length === 0) return 'skip: nobody here is in the room';
				run.signers = signers;

				const url = current.nextUri ?? chatHistoryPageUri(room.uri, null);
				const page = parseChatHistoryPage(await this.fetchPage(url, signers), room.uri, url);
				if (page == null) throw new HistoryUnavailableError('the owner\'s server gave no history page');

				// 이 서버 작성자의 글은 보안 검사에서 저장하지 않지만, 서로 다른 글이면 기록은 진행된 것이다.
				const itemIds = page.items.flatMap(item => {
					if (item == null || typeof item !== 'object') return [];
					const note = item as IObject;
					return getApType(note) === 'Note' && typeof note.id === 'string' && note.id.length > 0 && note.id.length <= 1024 ? [note.id] : [];
				});
				if (await this.pagesWithoutProgress(room.id, state.pass, url, itemIds) > MAX_PAGES_WITHOUT_PROGRESS) {
					this.logger.warn(`Stopped fetching ${room.uri}: no new history items in ${MAX_PAGES_WITHOUT_PROGRESS + 1} consecutive pages`);
					throw new HistoryUnavailableError('the history has made no progress');
				}

				for (const item of page.items) {
					await this.importItem(room, item, run);
				}

				if (!await this.chatRoomHistoryService.advance(room.id, state.pass, page.next)) return 'skip: started over';
				if (page.next == null) {
					await this.redisClient.del(...this.progressKeys(room.id, state.pass));
					return 'ok: completed';
				}
			}

			const current = await this.chatRoomHistoryService.getState(room.id);
			if (current?.status === 'running' && current.pass === state.pass) {
				await this.chatRoomHistoryService.enqueueImport(room.id, current.pass, current.nextUri, CONTINUE_DELAY);
			}
			return 'ok: continues';
		} catch (err) {
			if (err instanceof HistoryUnavailableError || run.lastAttempt) {
				await this.chatRoomHistoryService.markUnavailable(room.id, state.pass);
				return `skip: ${err}`;
			}
			throw err;
		} finally {
			if (await this.redisClient.get(lockKey) === token) await this.redisClient.del(lockKey);
		}
	}

	private progressKeys(roomId: string, pass: number): [string, string] {
		const prefix = `chat_room_history_progress:${roomId}:${pass}`;
		return [`${prefix}:seen`, `${prefix}:state`];
	}

	/** 같은 페이지의 재시도는 한 번만 세고, 새 항목이 나타나면 다시 진행하도록 한다. */
	private async pagesWithoutProgress(roomId: string, pass: number, page: string, ids: string[]): Promise<number> {
		const result = await this.redisClient.eval(`
			local samePage = redis.call('HGET', KEYS[2], 'page') == ARGV[1]
			local fresh = 0
			for i = 3, #ARGV do
				fresh = fresh + redis.call('HSETNX', KEYS[1], ARGV[i], '1')
			end
			local count = tonumber(redis.call('HGET', KEYS[2], 'count') or '0')
			if fresh > 0 then
				count = 0
			elseif not samePage then
				count = count + 1
			end
			redis.call('HSET', KEYS[2], 'page', ARGV[1], 'count', count)
			redis.call('EXPIRE', KEYS[1], ARGV[2])
			redis.call('EXPIRE', KEYS[2], ARGV[2])
			return count
		`, 2, ...this.progressKeys(roomId, pass), page, PROGRESS_TTL, ...ids);
		return Number(result);
	}

	/** 그룹 소유 서버에 이 서버의 멤버로 서명해 직접 묻는다. 다른 곳에서 온 기록은 쓰지 않는다. */
	private async fetchPage(url: string, signers: MiUser[]): Promise<IObject> {
		for (const signer of signers.slice(0, MAX_SIGNERS)) {
			const resolver = await this.apResolverService.createResolver();
			resolver.signAs(signer as MiLocalUser);
			try {
				return await resolver.resolve(url);
			} catch (err) {
				// 429와 5xx, 연결 실패는 큐의 재시도로 다시 묻는다
				if (isTemporaryFetchFailure(err)) throw err;
				// 소유 서버가 이 멤버를 아직 모를 수 있으니 다른 멤버로도 묻는다
				if (err instanceof StatusError && err.isClientError) continue;
				// 기록 조회를 모르는 서버(이전 버전)는 AP 문서가 아닌 응답을 준다. 형식이 맞지 않는 응답도 같다
				throw new HistoryUnavailableError(`${err}`);
			}
		}
		// 참여 직후에는 소유 서버가 수락을 아직 처리하지 않았을 수 있다. 큐의 재시도로 다시 묻고 마지막 시도에서 그만둔다
		throw new Error('the owner\'s server does not count anyone here as a member yet');
	}

	private hostOf(uri: string): string | null {
		try {
			return this.utilityService.punyHost(uri);
		} catch {
			return null;
		}
	}

	private itemContext(room: MiChatRoom & { uri: string }): ChatHistoryItemContext {
		return {
			roomUri: room.uri,
			now: Date.now(),
			hostOf: uri => this.hostOf(uri),
			isLocalHost: host => this.utilityService.isSelfHost(host),
			isSafeTime: time => this.idService.isSafeT(time),
			text: note => chatNoteText(note, (html, tag) => this.apMfmService.htmlToMfm(html, { tag })),
		};
	}

	private async importItem(room: MiChatRoom & { uri: string }, value: unknown, run: ImportRun): Promise<void> {
		const item = parseChatHistoryItem(value, this.itemContext(room));
		if ('skip' in item) {
			this.logger.debug(`Skipped a history item of ${room.uri}: ${item.skip}`);
			return;
		}

		const host = this.hostOf(item.uri)!;
		if (await this.hostPolicyService.isRefusedRemoteHost(host)) return;
		// 이미 있는 글은 소유 서버가 다른 내용을 내줘도 바꾸지 않는다. 수정은 작성자 서버의 Update로만 반영한다.
		if (await this.chatRoomHistoryService.findImported(item.uri) != null) return;

		// 소유 서버 자신의 글은 그대로 믿고, 제3 서버의 글은 작성자 서버에 물어 확인한다.
		// 확인할 수 없는 글은 원래 URI를 선점하지 않는 보관 사본으로 남긴다.
		let uri = item.uri;
		let archived = item.note._misskey_chatAuthorArchived === true;
		let source = item;
		if (host !== run.ownerHost) {
			const verdict = await this.verifySource(room, item, run);
			if (verdict === 'reject') {
				this.logger.debug(`Skipped a history item of ${room.uri}: the author's server did not confirm ${item.uri}`);
				return;
			}
			if (verdict === 'archive') {
				uri = chatHistoryCopyUri(this.config.url, room.id, item.uri);
				archived = true;
			} else {
				// 검증된 글의 본문·첨부·시각은 소유 서버의 기록이 아니라 출처 객체에서 다시 읽는다.
				const verified = parseChatHistoryItem(verdict, this.itemContext(room));
				if ('skip' in verified) {
					this.logger.debug(`Skipped a history item of ${room.uri}: the verified source is not readable: ${verified.skip}`);
					return;
				}
				source = verified;
				// 확인에 성공했으므로 보관 표시가 있어도 실제 작성자의 글로 받는다.
				archived = false;
			}
		}

		const channel = await this.resolveChannel(room, source.note, run);
		if (channel === false) return;

		const author = archived ? null : await this.resolveAccount(item.authorUri, run, true);
		const text = source.text;
		const attachments = toArray(source.note.attachment).filter(attach => attach != null && typeof attach === 'object').slice(0, MAX_REMOTE_CHAT_MESSAGE_FILES);
		let fileIds: string[] = [];
		let unavailableFileCount = attachments.length;
		if (author != null && attachments.length > 0) {
			const resolved = await this.apInboxService.resolveChatAttachments(author, { ...source.note, attachment: attachments });
			if (resolved.temporarilyFailed && !run.lastAttempt) throw new Error('a history attachment is temporarily unavailable');
			fileIds = resolved.files.map(file => file.id);
			unavailableFileCount = Math.max(0, attachments.length - fileIds.length);
		}
		if ((text == null || text.trim() === '') && fileIds.length === 0 && unavailableFileCount === 0) return;

		const emojis = await this.confirmedEmojis(source.note, author?.host ?? host, run);
		// 리액션과 작성자 스냅샷은 소유 서버만 아는 기록이므로 기록 항목의 것을 유지한다.
		const reactions = await this.resolveReactions(item, author, run);
		const channelRefs = room.hasChannels ? await this.chatRoomChannelService.remoteRefs(room, text ?? '', source.note._misskey_chatChannelRefs) : [];

		const unlock = await acquireApObjectLock(this.redisClient, item.uri);
		try {
			const stored = await this.chatRoomHistoryService.importMessage(room, {
				uri,
				sourceUri: item.uri,
				authorUri: item.authorUri,
				authorId: author?.id ?? null,
				archivedAuthor: author == null ? { uri: item.authorUri, username: item.author?.username ?? null, name: item.author?.name ?? null, host } : null,
				published: source.published,
				editedAt: source.editedAt,
				text,
				dice: parseChatDiceResult(source.note._misskey_dice),
				fileIds,
				unavailableFileCount,
				emojis,
				toRoomChannelId: channel,
				channelRefs,
				reactions,
			});
			// 가져오는 동안 먼저 도착해 보류된 실시간 리액션과 취소를 기존 처리로 적용한다
			if (stored != null) {
				await this.chatService.applyPendingChatReactions(stored).catch(err => {
					this.logger.warn(`Failed to apply deferred chat reactions: ${err}`);
				});
			}
		} finally {
			await unlock();
		}
	}

	/**
	 * 제3 서버의 글은 작성자 서버에 이 서버의 멤버로 서명해 직접 확인한다. 소유 서버가 대신 말할 수 없다.
	 * 확인하면 검증된 출처 객체를 돌려주고, 어긋나면 버리며, 확인할 수 없으면 보관 사본으로 남긴다.
	 */
	private async verifySource(room: MiChatRoom & { uri: string }, item: ChatHistoryItem, run: ImportRun): Promise<IPost | 'reject' | 'archive'> {
		let denied: StatusError | null = null;
		for (const signer of run.signers.slice(0, MAX_SIGNERS)) {
			const resolver = await this.apResolverService.createResolver();
			resolver.signAs(signer as MiLocalUser);
			try {
				const object = await resolver.resolve(item.uri);
				if (getApType(object) === 'Tombstone') return 'reject';
				if (object.id !== item.uri || getApType(object) !== 'Note') return 'reject';
				const note = object as IPost;
				if (note._misskey_talk !== true) return 'reject';
				if (roomUriOf(note) !== room.uri) return 'reject';
				try {
					if (note.attributedTo == null || getOneApId(note.attributedTo) !== item.authorUri) return 'reject';
				} catch {
					return 'reject';
				}
				return note;
			} catch (err) {
				// 작성자 서버가 글을 내주지 않으면(404/410) 다른 서명자로도 물어본다. 서명자가 정지되었을 수 있다.
				if (err instanceof StatusError && (err.statusCode === 404 || err.statusCode === 410)) {
					denied = err;
					continue;
				}
				if (isTemporaryFetchFailure(err)) {
					if (run.lastAttempt) return 'archive';
					throw err;
				}
				// 작성자 서버가 이 멤버를 아직 모를 수 있으니 다른 멤버로도 묻는다
				if (err instanceof StatusError && err.isClientError) continue;
				if (run.lastAttempt) return 'archive';
				throw err;
			}
		}
		// 모든 서명자가 내주지 않았어도 보관 표시가 있으면 사본으로 남기고, 아니면 큐의 재시도로 다시 묻는다.
		if (run.lastAttempt || (denied != null && item.note._misskey_chatAuthorArchived === true)) return 'archive';
		throw denied ?? new Error('the author\'s server does not count anyone here as a member yet');
	}

	/** 실시간 수신과 같은 채널 판정. 모르는 채널이면 그룹 객체를 한 번 다시 읽고, 그래도 없으면 그 글을 버린다. */
	private async resolveChannel(room: MiChatRoom, note: IPost, run: ImportRun): Promise<string | null | false> {
		for (;;) {
			if (!room.hasChannels && note._misskey_chatChannel == null) return null;
			try {
				const channelId = await this.chatRoomChannelService.remoteChannel(room, note._misskey_chatChannel);
				if (channelId !== undefined) return channelId;
			} catch (err) {
				if (err instanceof ChatChannelError) return false;
				throw err;
			}
			if (run.channelsRefreshed) return false;
			run.channelsRefreshed = true;
			await this.chatRoomRosterSyncProcessorService.syncRoom(room.id);
			Object.assign(room, await this.chatRoomsRepository.findOneByOrFail({ id: room.id }));
		}
	}

	/**
	 * 작성자나 리액션한 계정. 찾지 못하면 null이고, 작성자면 그 글은 과거 기록용 작성자 정보로 보존한다.
	 * @param retryTemporary 일시적인 실패면 큐의 재시도로 다시 찾는다. 마지막 시도에서는 null로 둔다.
	 */
	private async resolveAccount(uri: string, run: ImportRun, retryTemporary: boolean): Promise<MiRemoteUser | null> {
		const cache = retryTemporary ? run.authors : run.accounts;
		if (cache.has(uri)) return cache.get(uri)!;
		let account: MiRemoteUser | null = null;
		try {
			const existing = await this.apDbResolverService.getUserFromApId(uri);
			if (retryTemporary && existing != null) {
				// 캐시된 계정은 삭제되었거나 접근할 수 없을 수 있으므로 작성자는 다시 확인한다.
				const actor = await (await this.apResolverService.createResolver()).resolve(uri);
				if (!isActor(actor) || actor.id !== uri) throw new Error('invalid history author');
			}
			const user = existing ?? await this.apPersonService.resolvePerson(uri, await this.apResolverService.createResolver());
			account = this.userEntityService.isRemoteUser(user) && !user.isDeleted ? user : null;
		} catch (err) {
			if (retryTemporary && isTemporaryFetchFailure(err) && !run.lastAttempt) throw err;
			this.logger.info(`Could not resolve ${uri} in a chat room history: ${err}`);
		}
		cache.set(uri, account);
		return account;
	}

	private async resolveReactions(item: ChatHistoryItem, author: MiRemoteUser | null, run: ImportRun): Promise<string[]> {
		const pairs: string[] = [];
		for (const entry of item.reactions) {
			if (pairs.length >= MAX_REACTIONS_PER_MESSAGE) break;
			// 리액션한 계정을 확인할 수 없으면 그 리액션만 버린다
			const reactor = await this.resolveAccount(entry.actor, run, false);
			if (reactor == null || reactor.isSuspended || reactor.id === author?.id) continue;
			if (await this.hostPolicyService.isRefusedRemoteHost(reactor.host)) continue;
			let reaction: string;
			try {
				reaction = this.chatService.normalizeRemoteReaction(entry.reaction, reactor.host);
			} catch {
				continue;
			}
			if (entry.tag != null && reaction.startsWith(':')) await this.confirmEmoji(entry.tag, reactor.host, run);
			const pair = `${reactor.id}/${reaction}`;
			if (!pairs.includes(pair)) pairs.push(pair);
		}
		return pairs;
	}

	/** 본문의 커스텀 이모지. 그림은 작성자 서버에서만 확인하고, 확인하지 못한 것은 글자로 남는다. */
	private async confirmedEmojis(note: IPost, host: string, run: ImportRun): Promise<string[]> {
		const tags = toArray(note.tag).filter(tag => tag != null && typeof tag === 'object' && getApType(tag) === 'Emoji');
		for (const tag of tags) await this.confirmEmoji(tag, host, run);
		const names = tags.map(tag => typeof tag.name === 'string' ? tag.name.replaceAll(':', '') : null).filter((name): name is string => name != null && name.length > 0);
		if (names.length === 0) return [];
		return (await this.emojisRepository.findBy({ host, name: In(names) })).map(emoji => emoji.name);
	}

	/** 소유 서버는 이 이름으로 아무 그림이나 내줄 수 있으므로, 그 계정의 서버에 Emoji id로 직접 묻는다 (중계된 리액션과 같은 규칙). */
	private async confirmEmoji(tag: IObject, host: string, run: ImportRun): Promise<void> {
		if (typeof tag.id !== 'string' || run.checkedEmojis.has(tag.id)) return;
		run.checkedEmojis.add(tag.id);
		try {
			if (this.utilityService.extractDbHost(tag.id) !== host) return;
			const name = typeof tag.name === 'string' ? tag.name.replaceAll(':', '') : null;
			if (name != null && await this.emojisRepository.existsBy({ host, name })) return;
			const resolver = await this.apResolverService.createResolver();
			const emoji = await resolver.resolve(tag.id);
			if (emoji.id === tag.id && isEmoji(emoji)) await this.apNoteService.extractEmojis(emoji, host);
		} catch (err) {
			this.logger.info(`Could not confirm the emoji ${tag.id}: ${err}`);
		}
	}
}
