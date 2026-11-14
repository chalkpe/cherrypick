/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { MiChatRoomUserSettings } from '@/models/ChatRoomUserSettings.js';
import { MiUser } from '@/models/User.js';
import type { ChatRoomUserSettingsRepository } from '@/models/_.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { CHAT_UNREAD_GUARDED_DEL, CHAT_UNREAD_MARK, CHAT_UNREAD_PRUNE_CHANNEL, CHAT_UNREAD_PRUNE_ROOM, CHAT_UNREAD_READ_ALL, CHAT_UNREAD_READ_BOUNDARY, chatMentionedUserIds, chatUnreadMarker, chatUnreadMarkerMessageId, chatUnreadMarkerSequence, effectiveChatNotificationLevel, maxChatReadBoundary, newlyMentionedUserIds } from '@/core/chat-room-notifications.js';
import type { ChatNotificationLevel } from '@/core/chat-room-notifications.js';
import { ChatChannelError } from '@/core/chat-room-channels.js';

export type ChatRoomUnreadState = { hasUnread: boolean; hasUnreadNotification: boolean; unreadChannelIds: string[]; notificationChannelIds: string[] };
export type ChatRoomNotificationSettings = {
	roomId: string;
	channelId: string | null;
	level: ChatNotificationLevel | 'inherit';
	effectiveLevel: ChatNotificationLevel;
	channelOverrides: { channelId: string; level: ChatNotificationLevel }[];
};
/** record가 트랜잭션 안에서 계산해 커밋 후 mark에 넘기는 결과. */
export type ChatRoomRecordResult = { added: string[]; mentioned: string[]; recipients: string[] };
/** 수정 지연 알림의 예약 대상. 수정 시점의 읽음 경계를 함께 실어 발송 시점의 읽음 판단에 쓴다. */
export type ChatRoomEditRecipient = { userId: string; readBoundary: string | null };

@Injectable()
export class ChatRoomNotificationService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.redis) private redis: Redis.Redis,
		@Inject(DI.config) private config: Config,
		@Inject(DI.chatRoomUserSettingsRepository) private settingsRepository: ChatRoomUserSettingsRepository,
		private channels: ChatRoomChannelService,
		private events: GlobalEventService,
	) {}

	private roomMessageKey(userId: string, roomId: string) {
		return `newRoomChatMessageExists:${userId}:${roomId}`;
	}

	private roomMentionKey(userId: string, roomId: string) {
		return `newRoomChatMentionExists:${userId}:${roomId}`;
	}

	private channelMessageKey(userId: string, roomId: string, channelId: string) {
		return `newRoomChatChannelMessageExists:${userId}:${roomId}:${channelId}`;
	}

	private channelMentionKey(userId: string, roomId: string, channelId: string) {
		return `newRoomChatChannelMentionExists:${userId}:${roomId}:${channelId}`;
	}

	private channelSetKey(userId: string, roomId: string) {
		return `newRoomChatUnreadChannels:${userId}:${roomId}`;
	}

	private roomBoundaryKey(userId: string, roomId: string) {
		return `newRoomChatReadBoundary:${userId}:${roomId}`;
	}

	private channelBoundaryKey(userId: string, roomId: string, channelId: string) {
		return `newRoomChatChannelReadBoundary:${userId}:${roomId}:${channelId}`;
	}

	private totalsKey(userId: string) {
		return `newChatMessagesExists:${userId}`;
	}

	public async settings(userId: string, roomId: string, manager = this.db.manager) {
		const stored = await manager.withRepository(this.settingsRepository).findOneBy({ userId, roomId });
		if (stored != null) return stored;
		const membership = await manager.findOneBy(MiChatRoomMembership, { userId, roomId });
		return { userId, roomId, membershipId: membership?.id ?? null, notificationLevel: membership?.isMuted ? 'none' as const : 'all' as const, channelOverrides: {} as Record<string, ChatNotificationLevel> };
	}

	public async setLevel(userId: string, roomId: string, level?: ChatNotificationLevel | 'inherit', channelId?: string): Promise<ChatRoomNotificationSettings> {
		return this.db.transaction<ChatRoomNotificationSettings>(async manager => {
			const room = await manager.findOne(MiChatRoom, { where: { id: roomId }, lock: { mode: 'pessimistic_write' } });
			if (room == null || !await this.isMember(userId, room, manager)) throw new ChatChannelError('NO_SUCH_ROOM');
			if (channelId != null) await this.channels.resolve(room, channelId, manager);
			if (channelId == null && level === 'inherit') throw new ChatChannelError('NO_SUCH_CHANNEL');
			const settings = await this.settings(userId, roomId, manager);
			if (level != null) {
				if (channelId == null) settings.notificationLevel = level as ChatNotificationLevel;
				else if (level === 'inherit') delete settings.channelOverrides[channelId];
				else settings.channelOverrides[channelId] = level;
				await manager.withRepository(this.settingsRepository).upsert(settings, ['userId', 'roomId']);
				if (channelId == null) await manager.update(MiChatRoomMembership, { userId, roomId }, { isMuted: level === 'none' });
			}
			return {
				roomId,
				channelId: channelId ?? null,
				level: channelId == null ? settings.notificationLevel : settings.channelOverrides[channelId] ?? 'inherit',
				effectiveLevel: effectiveChatNotificationLevel(settings.notificationLevel, channelId != null ? settings.channelOverrides[channelId] : null),
				channelOverrides: Object.entries(settings.channelOverrides).map(([channelId, level]) => ({ channelId, level })),
			};
		});
	}

	public isMember(userId: string, room: MiChatRoom, manager = this.db.manager): Promise<boolean> {
		return room.ownerId === userId ? Promise.resolve(true) : manager.existsBy(MiChatRoomMembership, { userId, roomId: room.id });
	}

	public async participants(room: MiChatRoom, manager = this.db.manager): Promise<MiUser[]> {
		const memberships = await manager.findBy(MiChatRoomMembership, { roomId: room.id });
		return manager.findBy(MiUser, { id: In([room.ownerId, ...memberships.map(member => member.userId)]) });
	}

	public mentioned(message: Pick<MiChatMessage, 'text' | 'fromUserId'>, members: MiUser[]): string[] {
		const author = members.find(member => member.id === message.fromUserId);
		return author == null ? [] : chatMentionedUserIds(message.text ?? '', author, members, this.config.hostname ?? this.config.host);
	}

	/** 트랜잭션 안에서 순번·멘션만 기록한다. 미읽음 표식은 커밋 후 mark가 남긴다. */
	public async record(manager: EntityManager, room: MiChatRoom, message: MiChatMessage, previousMentions?: string[]): Promise<ChatRoomRecordResult> {
		const members = await this.participants(room, manager);
		const mentioned = this.mentioned(message, members);
		const added = newlyMentionedUserIds(mentioned, previousMentions ?? []);
		const remembered = [...new Set([...(previousMentions ?? []), ...mentioned])];
		// 수정은 새 글이 아니므로 그룹 순번을 새로 받지 않는다. 순번을 올리면 지난 글이 화면 뒤의 새 글보다 뒤로 가서
		// 그 글까지 읽을 때 아직 보지 않은 새 글도 읽음이 된다. 순번이 없는 글(가져온 과거 기록)은 어떤 읽음 경계에도 포함된다
		let roomMessageSequence: string;
		if (previousMentions != null) {
			roomMessageSequence = message.roomMessageSequence ?? '0';
			await manager.update(MiChatMessage, message.id, { mentionedUserIds: remembered });
		} else {
			const sequence = await manager.createQueryBuilder().update(MiChatRoom).set({ messageSequence: () => '"messageSequence" + 1' }).where('id = :roomId', { roomId: room.id }).returning('messageSequence').execute();
			roomMessageSequence = String(sequence.raw[0].messageSequence);
			await manager.update(MiChatMessage, message.id, { mentionedUserIds: remembered, roomMessageSequence });
			message.roomMessageSequence = roomMessageSequence;
		}
		message.mentionedUserIds = remembered;
		const recipients = members.filter(member => member.host == null && member.id !== message.fromUserId && (previousMentions == null || added.includes(member.id)));
		return { added, mentioned, recipients: recipients.map(member => member.id) };
	}

	/**
	 * 커밋 후 미읽음 표식을 남긴다. 알림 끄기는 표식도 남기지 않는다.
	 * 표식은 순번 CAS로 더 새 글의 것만 유지하므로, 늦게 도착한 이전 글이 표식을 되돌리지 않는다.
	 * 생성은 실제로 표식을 남긴 수신자를 돌려준다. 수정은 표식 CAS와 무관하게 알림 대상 수신자를
	 * 그 시점의 읽음 경계와 함께 돌려준다. 더 새 글이 표식을 가져갔어도 읽지 않았다면 수정 알림은 가야 하기 때문이다.
	 */
	public async mark(room: MiChatRoom, message: MiChatMessage, recorded: ChatRoomRecordResult, edit = false): Promise<ChatRoomEditRecipient[]> {
		const channelId = message.toRoomChannelId ?? null;
		const marker = chatUnreadMarker(message.roomMessageSequence, message.id);
		const marked: ChatRoomEditRecipient[] = [];
		for (const userId of recorded.recipients) {
			const settings = await this.settings(userId, room.id);
			const level = effectiveChatNotificationLevel(settings.notificationLevel, channelId != null ? settings.channelOverrides[channelId] : null);
			if (level === 'none') continue;
			const messageKey = channelId != null ? this.channelMessageKey(userId, room.id, channelId) : this.roomMessageKey(userId, room.id);
			const mentionKey = channelId != null ? this.channelMentionKey(userId, room.id, channelId) : this.roomMentionKey(userId, room.id);
			const messageMarked = await this.redis.eval(CHAT_UNREAD_MARK, 1, messageKey, marker) === 1;
			if (recorded.mentioned.includes(userId)) await this.redis.eval(CHAT_UNREAD_MARK, 1, mentionKey, marker);
			if (edit) {
				const boundaries = await this.redis.mget(this.roomBoundaryKey(userId, room.id), ...(channelId != null ? [this.channelBoundaryKey(userId, room.id, channelId)] : []));
				marked.push({ userId, readBoundary: maxChatReadBoundary(boundaries[0], boundaries[1] ?? null) });
			} else if (messageMarked) {
				marked.push({ userId, readBoundary: null });
			}
			if (channelId != null) await this.redis.sadd(this.channelSetKey(userId, room.id), channelId);
			await this.redis.sadd(this.totalsKey(userId), `room:${room.id}`);
		}
		return marked;
	}

	public async shouldNotify(userId: string, message: MiChatMessage, manager = this.db.manager): Promise<boolean> {
		if (message.toRoomId == null || message.fromUserId === userId || message.deletedAt != null) return false;
		const room = await manager.findOneBy(MiChatRoom, { id: message.toRoomId });
		if (room == null || !await this.isMember(userId, room, manager)) return false;
		const settings = await this.settings(userId, room.id, manager);
		const level = effectiveChatNotificationLevel(settings.notificationLevel, message.toRoomChannelId != null ? settings.channelOverrides[message.toRoomChannelId] : null);
		if (level === 'none') return false;
		return level === 'all' || this.mentioned(message, await this.participants(room, manager)).includes(userId);
	}

	/**
	 * 지연 알림 시점에 아직 알릴 수신자를 고른다. 설정·멤버십은 지금 다시 조회한다.
	 * 생성은 표식이 이 글을 가리키는(아직 읽지 않은) 사람에게만 간다. 멘션 전용 수신자는 멘션 표식으로 판단하므로
	 * 뒤따른 일반 글이 메시지 표식을 옮겨도 멘션 알림은 묻히지 않는다.
	 * 수정은 새로 멘션된 사람에게만 가되, 표식이 더 새 글로 옮겨졌어도 읽지 않았다면 알린다.
	 * 읽음 판단은 표식이 아니라 읽음 경계로 한다: 경계가 이 글의 순번 이상이고 수정 시점보다 나아갔으면 읽은 것이다.
	 */
	public async notificationRecipients(message: MiChatMessage, room: MiChatRoom, editRecipients?: ChatRoomEditRecipient[]): Promise<string[]> {
		if (editRecipients != null && editRecipients.length === 0) return [];
		const members = await this.participants(room);
		const mentioned = editRecipients != null ? this.mentioned(message, members) : null;
		const recipients: string[] = [];
		for (const member of members) {
			if (member.host != null || member.id === message.fromUserId) continue;
			const editRecipient = editRecipients?.find(candidate => candidate.userId === member.id);
			if (editRecipients != null && editRecipient == null) continue;
			const settings = await this.settings(member.id, room.id);
			const channelId = message.toRoomChannelId;
			const level = effectiveChatNotificationLevel(settings.notificationLevel, channelId != null ? settings.channelOverrides[channelId] : null);
			if (level === 'none') continue;
			if (editRecipients != null) {
				// 수정 사이에 멘션이 사라졌으면 알리지 않는다
				if (!mentioned!.includes(member.id)) continue;
				// 수정 사이에 이 글까지 읽었으면 알리지 않는다. 수정 전에 이미 읽은 글은 경계가 나아가지 않았으므로 알린다
				const boundaries = await this.redis.mget(this.roomBoundaryKey(member.id, room.id), ...(channelId != null ? [this.channelBoundaryKey(member.id, room.id, channelId)] : []));
				const boundary = maxChatReadBoundary(boundaries[0], boundaries[1] ?? null);
				if (boundary != null && BigInt(boundary) >= BigInt(message.roomMessageSequence ?? '0') && (editRecipient!.readBoundary == null || BigInt(boundary) > BigInt(editRecipient!.readBoundary))) continue;
			} else {
				const mentionKey = channelId != null ? this.channelMentionKey(member.id, room.id, channelId) : this.roomMentionKey(member.id, room.id);
				if (level === 'mentions') {
					if (chatUnreadMarkerMessageId(await this.redis.get(mentionKey)) !== message.id) continue;
				} else {
					const messageKey = channelId != null ? this.channelMessageKey(member.id, room.id, channelId) : this.roomMessageKey(member.id, room.id);
					if (chatUnreadMarkerMessageId(await this.redis.get(messageKey)) !== message.id) continue;
				}
			}
			recipients.push(member.id);
		}
		return recipients;
	}

	public async state(userId: string, room: MiChatRoom): Promise<ChatRoomUnreadState> {
		const settings = await this.settings(userId, room.id);
		const levelOf = (channelId: string | null) => effectiveChatNotificationLevel(settings.notificationLevel, channelId != null ? settings.channelOverrides[channelId] : null);
		const unreadChannelIds: string[] = [];
		const notificationChannelIds: string[] = [];
		let hasUnread = false;
		let hasUnreadNotification = false;
		const consider = (channelId: string | null, messageMarker: string | null, mentionMarker: string | null) => {
			const level = levelOf(channelId);
			// 알림 끄기는 정적인 미읽음 표시도 만들지 않는다. 표식은 남겨 두어 다시 켜면 그대로 보인다.
			if (level === 'none' || (messageMarker == null && mentionMarker == null)) return;
			hasUnread = true;
			if (channelId != null) unreadChannelIds.push(channelId);
			if (level === 'all' || mentionMarker != null) {
				hasUnreadNotification = true;
				if (channelId != null) notificationChannelIds.push(channelId);
			}
		};
		if (room.hasChannels) {
			const valid = new Set((await this.channels.list(room.id)).map(channel => channel.id));
			const channelIds = (await this.redis.smembers(this.channelSetKey(userId, room.id))).filter(id => valid.has(id));
			for (const channelId of channelIds) {
				const [messageMarker, mentionMarker] = await this.redis.mget(this.channelMessageKey(userId, room.id, channelId), this.channelMentionKey(userId, room.id, channelId));
				consider(channelId, messageMarker, mentionMarker);
			}
		} else {
			const [messageMarker, mentionMarker] = await this.redis.mget(this.roomMessageKey(userId, room.id), this.roomMentionKey(userId, room.id));
			consider(null, messageMarker, mentionMarker);
		}
		return { hasUnread, hasUnreadNotification, unreadChannelIds, notificationChannelIds };
	}

	public async totals(userId: string) {
		const entries = await this.redis.smembers(this.totalsKey(userId));
		let hasUnreadChatMessages = entries.some(value => value.startsWith('user:'));
		let hasUnreadChatNotifications = hasUnreadChatMessages;
		for (const roomId of entries.filter(value => value.startsWith('room:')).map(value => value.slice(5))) {
			const room = await this.db.manager.findOneBy(MiChatRoom, { id: roomId });
			if (room == null || !await this.isMember(userId, room)) continue;
			const state = await this.state(userId, room);
			hasUnreadChatMessages ||= state.hasUnread;
			hasUnreadChatNotifications ||= state.hasUnreadNotification;
		}
		return { hasUnreadChatMessages, hasUnreadChatNotifications };
	}

	public async notify(userIds: string[]): Promise<void> {
		for (const userId of new Set(userIds)) {
			if (!await this.db.manager.existsBy(MiUser, { id: userId, host: IsNull() })) continue;
			const version = await this.redis.incr(`chatUnreadVersion:${userId}`);
			this.events.publishMainStream(userId, 'chatUnread', { ...await this.totals(userId), version });
		}
	}

	public async read(userId: string, roomId: string, channelId?: string, untilId?: string, readAll = false): Promise<void> {
		await this.db.transaction(async manager => {
			const room = await manager.findOne(MiChatRoom, { where: { id: roomId }, lock: { mode: 'pessimistic_write' } });
			if (room == null || !await this.isMember(userId, room, manager)) throw new ChatChannelError('NO_SUCH_ROOM');
			const selected = !readAll ? await this.channels.resolve(room, channelId, manager) : undefined;
			const boundary = untilId != null ? await manager.findOneBy(MiChatMessage, { id: untilId, toRoomId: roomId, ...(selected != null ? { toRoomChannelId: selected } : {}) }) : null;
			if (untilId != null && boundary == null) throw new ChatChannelError('NO_SUCH_ROOM');
			const boundarySequence = BigInt(boundary?.roomMessageSequence ?? '0');
			// 표식이 가리키는 글이 경계 안에 있을 때만 지운다. 그 사이 새 글이 표식을 바꾸었으면 지우지 않는다.
			// 표식 값에 순번이 실려 있으므로 글을 다시 조회하지 않는다.
			const clearMarker = async (key: string) => {
				if (untilId == null) {
					await this.redis.del(key);
					return;
				}
				const marker = await this.redis.get(key);
				if (marker == null) return;
				if (BigInt(chatUnreadMarkerSequence(marker)) <= boundarySequence) {
					await this.redis.eval(CHAT_UNREAD_GUARDED_DEL, 1, key, marker);
				}
			};
			if (readAll) {
				const keys = [this.roomMessageKey(userId, roomId), this.roomMentionKey(userId, roomId), this.channelSetKey(userId, roomId)];
				if (room.hasChannels) {
					const channelIds = new Set((await this.channels.list(room.id)).map(channel => channel.id));
					for (const id of await this.redis.smembers(this.channelSetKey(userId, roomId))) channelIds.add(id);
					for (const id of channelIds) keys.push(this.channelMessageKey(userId, roomId, id), this.channelMentionKey(userId, roomId, id));
				}
				// 지우기와 전체 목록 빼기를 한 스크립트로 묶는다. 그 사이 새 글의 표식 쓰기가 끼어들어도 표식과 목록이 함께 남는다
				await this.redis.eval(CHAT_UNREAD_READ_ALL, keys.length + 1, ...keys, this.totalsKey(userId), `room:${roomId}`);
				await this.redis.eval(CHAT_UNREAD_READ_BOUNDARY, 1, this.roomBoundaryKey(userId, roomId), String(room.messageSequence));
			} else if (!room.hasChannels) {
				// 일반 그룹도 경계 뒤의 새 글은 남긴다. 두 표식이 모두 사라졌을 때만 전체 목록에서 뺀다.
				await clearMarker(this.roomMessageKey(userId, roomId));
				await clearMarker(this.roomMentionKey(userId, roomId));
				await this.redis.eval(CHAT_UNREAD_PRUNE_ROOM, 3, this.roomMessageKey(userId, roomId), this.roomMentionKey(userId, roomId), this.totalsKey(userId), `room:${roomId}`);
				// 읽음 경계는 표식과 따로 남긴다. 표식이 더 새 글로 옮겨져도 수정 알림의 읽음 판단에 쓴다
				await this.redis.eval(CHAT_UNREAD_READ_BOUNDARY, 1, this.roomBoundaryKey(userId, roomId), untilId != null ? String(boundarySequence) : String(room.messageSequence));
			} else {
				await clearMarker(this.channelMessageKey(userId, roomId, selected!));
				await clearMarker(this.channelMentionKey(userId, roomId, selected!));
				await this.redis.eval(
					CHAT_UNREAD_PRUNE_CHANNEL,
					6, this.channelSetKey(userId, roomId), this.channelMessageKey(userId, roomId, selected!), this.channelMentionKey(userId, roomId, selected!), this.roomMessageKey(userId, roomId), this.roomMentionKey(userId, roomId), this.totalsKey(userId), selected!, `room:${roomId}`,
				);
				await this.redis.eval(CHAT_UNREAD_READ_BOUNDARY, 1, this.channelBoundaryKey(userId, roomId, selected!), untilId != null ? String(boundarySequence) : String(room.messageSequence));
			}
		});
		await this.notify([userId]);
	}

	/** 그룹을 떠나거나 사라진 사람의 미읽음 표식과 읽음 경계를 지운다. deleteRoom/leave/kick/forget이 함께 쓴다. */
	public async clearRoom(roomId: string, userIds: string[]): Promise<void> {
		const channelIds = new Set((await this.channels.list(roomId)).map(channel => channel.id));
		for (const userId of new Set(userIds)) {
			const keys = [this.roomMessageKey(userId, roomId), this.roomMentionKey(userId, roomId), this.channelSetKey(userId, roomId), this.roomBoundaryKey(userId, roomId)];
			for (const channelId of await this.redis.smembers(this.channelSetKey(userId, roomId))) channelIds.add(channelId);
			for (const channelId of channelIds) {
				keys.push(this.channelMessageKey(userId, roomId, channelId), this.channelMentionKey(userId, roomId, channelId), this.channelBoundaryKey(userId, roomId, channelId));
			}
			await this.redis.del(...keys);
			await this.redis.srem(this.totalsKey(userId), `room:${roomId}`);
		}
	}

	public async forget(userId: string, roomId: string): Promise<void> {
		const removed = await this.db.transaction(async manager => {
			const room = await manager.findOne(MiChatRoom, { where: { id: roomId }, lock: { mode: 'pessimistic_write' } });
			if (room != null && await this.isMember(userId, room, manager)) return false;
			await manager.delete(MiChatRoomUserSettings, { userId, roomId });
			return true;
		});
		if (removed) await this.clearRoom(roomId, [userId]);
		await this.notify([userId]);
	}

	public async channelsChanged(room: MiChatRoom): Promise<void> {
		await this.db.transaction(async manager => {
			if (!await manager.findOne(MiChatRoom, { where: { id: room.id }, lock: { mode: 'pessimistic_write' } })) return;
			const validIds = new Set((await this.channels.list(room.id)).map(channel => channel.id));
			for (const settings of await manager.withRepository(this.settingsRepository).findBy({ roomId: room.id })) {
				const channelOverrides = Object.fromEntries(Object.entries(settings.channelOverrides).filter(([id]) => validIds.has(id)));
				await manager.update(MiChatRoomUserSettings, { userId: settings.userId, roomId: room.id }, { channelOverrides });
			}
		});
		await this.notify((await this.participants(room)).filter(user => user.host == null).map(user => user.id));
	}
}
