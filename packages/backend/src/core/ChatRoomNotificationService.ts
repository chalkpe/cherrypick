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
import { MiChatRoomUnread } from '@/models/ChatRoomUnread.js';
import { MiUser } from '@/models/User.js';
import type { ChatRoomUnreadsRepository, ChatRoomUserSettingsRepository } from '@/models/_.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { chatMentionedUserIds, effectiveChatNotificationLevel, newlyMentionedUserIds } from '@/core/chat-room-notifications.js';
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

@Injectable()
export class ChatRoomNotificationService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.redis) private redis: Redis.Redis,
		@Inject(DI.config) private config: Config,
		@Inject(DI.chatRoomUserSettingsRepository) private settingsRepository: ChatRoomUserSettingsRepository,
		@Inject(DI.chatRoomUnreadsRepository) private unreadsRepository: ChatRoomUnreadsRepository,
		private channels: ChatRoomChannelService,
		private events: GlobalEventService,
	) {}

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

	public async record(manager: EntityManager, room: MiChatRoom, message: MiChatMessage, previousMentions?: string[]): Promise<string[]> {
		const members = await this.participants(room, manager);
		const mentioned = this.mentioned(message, members);
		const added = newlyMentionedUserIds(mentioned, previousMentions ?? []);
		const remembered = [...new Set([...(previousMentions ?? []), ...mentioned])];
		const sequence = await manager.createQueryBuilder().update(MiChatRoom).set({ messageSequence: () => '"messageSequence" + 1' }).where('id = :roomId', { roomId: room.id }).returning('messageSequence').execute();
		const roomMessageSequence = String(sequence.raw[0].messageSequence);
		await manager.update(MiChatMessage, message.id, { mentionedUserIds: remembered, roomMessageSequence });
		message.mentionedUserIds = remembered;
		message.roomMessageSequence = roomMessageSequence;
		if (previousMentions != null) {
			for (const row of await manager.withRepository(this.unreadsRepository).findBy({ messageId: message.id })) {
				await manager.withRepository(this.unreadsRepository).update({ userId: row.userId, messageId: row.messageId }, { isMention: mentioned.includes(row.userId) });
			}
		}
		const recipients = members.filter(member => member.host == null && member.id !== message.fromUserId && (previousMentions == null || added.includes(member.id)));
		for (const member of recipients) {
			const membership = await manager.findOneBy(MiChatRoomMembership, { roomId: room.id, userId: member.id });
			await manager.withRepository(this.unreadsRepository).upsert({ userId: member.id, roomId: room.id, membershipId: membership?.id ?? null, messageId: message.id, sequence: roomMessageSequence, isMention: mentioned.includes(member.id), notificationSent: false }, ['userId', 'messageId']);
		}
		return added;
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

	/** 아직 알리지 않은 수신자를 고른다. 수정 알림은 onlyUserIds(새로 멘션된 사람)로 한정한다. */
	public async pendingRecipients(message: MiChatMessage, manager = this.db.manager, onlyUserIds?: string[]): Promise<string[]> {
		const repository = manager.withRepository(this.unreadsRepository);
		if (onlyUserIds != null && onlyUserIds.length === 0) return [];
		const rows = await repository.findBy({ messageId: message.id, notificationSent: false, ...(onlyUserIds != null ? { userId: In(onlyUserIds) } : {}) });
		const recipients: string[] = [];
		for (const row of rows) {
			if (!await this.shouldNotify(row.userId, message, manager)) continue;
			const result = await repository.update({ userId: row.userId, messageId: row.messageId, notificationSent: false }, { notificationSent: true });
			if (result.affected) recipients.push(row.userId);
		}
		return recipients;
	}

	private unreadQuery(userId: string) {
		return this.unreadsRepository.createQueryBuilder('unread')
			.innerJoin('unread.message', 'message')
			.innerJoin('message.fromUser', 'author', 'author.isSuspended = false')
			.where('unread.userId = :userId', { userId })
			.andWhere('message.deletedAt IS NULL');
	}

	public async state(userId: string, room: MiChatRoom): Promise<ChatRoomUnreadState> {
		const rows = await this.unreadQuery(userId).andWhere('unread.roomId = :roomId', { roomId: room.id })
			.select('message.toRoomChannelId', 'channelId').addSelect('BOOL_OR(unread.isMention)', 'isMention')
			.groupBy('message.toRoomChannelId').getRawMany<{ channelId: string | null; isMention: boolean }>();
		// 기존 Redis 표시도 최초 열람까지 유지한다. 새 메시지는 DB에만 기록한다.
		const legacy = await this.redis.get(`newRoomChatMessageExists:${userId}:${room.id}`);
		if (legacy != null) {
			const message = await this.db.manager.findOneBy(MiChatMessage, { id: legacy, toRoomId: room.id, deletedAt: IsNull() });
			if (message != null) {
				const channels = room.hasChannels ? await this.redis.smembers(`newRoomChatUnreadChannels:${userId}:${room.id}`) : [];
				const valid = room.hasChannels ? (await this.channels.list(room.id)).map(channel => channel.id) : [];
				for (const channelId of room.hasChannels ? (channels.length ? channels : [message.toRoomChannelId]).filter((id): id is string => id != null && valid.includes(id)) : [null]) {
					if (!rows.some(row => row.channelId === channelId)) rows.push({ channelId, isMention: false });
				}
			}
		}
		const settings = await this.settings(userId, room.id);
		const levelOf = (channelId: string | null) => effectiveChatNotificationLevel(settings.notificationLevel, channelId != null ? settings.channelOverrides[channelId] : null);
		// 알림 끄기는 정적인 미읽음 표시도 만들지 않는다. 행은 남겨 두어 다시 켜면 그대로 보인다.
		const visible = rows.filter(row => levelOf(row.channelId) !== 'none');
		const attention = visible.filter(row => levelOf(row.channelId) === 'all' || row.isMention);
		return { hasUnread: visible.length > 0, hasUnreadNotification: attention.length > 0, unreadChannelIds: visible.flatMap(row => row.channelId != null ? [row.channelId] : []), notificationChannelIds: attention.flatMap(row => row.channelId != null ? [row.channelId] : []) };
	}

	public async totals(userId: string) {
		const rows = await this.unreadQuery(userId).select('unread.roomId', 'roomId').addSelect('message.toRoomChannelId', 'channelId')
			.addSelect('BOOL_OR(unread.isMention)', 'isMention').groupBy('unread.roomId').addGroupBy('message.toRoomChannelId')
			.getRawMany<{ roomId: string; channelId: string | null; isMention: boolean }>();
		const settings = new Map((await this.settingsRepository.findBy({ userId })).map(settings => [settings.roomId, settings]));
		const legacy = await this.redis.smembers(`newChatMessagesExists:${userId}`);
		const roomIds = legacy.filter(value => value.startsWith('room:')).map(value => value.slice(5));
		const direct = legacy.some(value => value.startsWith('user:'));
		const levelOf = (row: { roomId: string; channelId: string | null }) => {
			const setting = settings.get(row.roomId);
			return effectiveChatNotificationLevel(setting?.notificationLevel ?? 'all', row.channelId != null ? setting?.channelOverrides[row.channelId] : null);
		};
		const visible = rows.filter(row => levelOf(row) !== 'none');
		let hasUnreadChatMessages = direct || visible.length > 0;
		let hasUnreadChatNotifications = direct || visible.some(row => levelOf(row) === 'all' || row.isMention);
		for (const roomId of roomIds) {
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
			const messages = manager.createQueryBuilder(MiChatMessage, 'message').select('message.id').where('message.toRoomId = :roomId', { roomId });
			if (selected != null) messages.andWhere('message.toRoomChannelId = :channelId', { channelId: selected });
			const deletion = manager.createQueryBuilder().delete().from(MiChatRoomUnread).where('userId = :userId', { userId }).andWhere(`"messageId" IN (${messages.getQuery()})`, messages.getParameters());
			if (untilId != null) deletion.andWhere('sequence <= :sequence', { sequence: boundary?.roomMessageSequence ?? '0' });
			await deletion.execute();
			if (readAll || !room.hasChannels) {
				await this.redis.multi().del(`newRoomChatMessageExists:${userId}:${roomId}`, `newRoomChatUnreadChannels:${userId}:${roomId}`).srem(`newChatMessagesExists:${userId}`, `room:${roomId}`).exec();
			} else {
				await this.redis.eval("redis.call('SREM', KEYS[1], ARGV[1]); if redis.call('SCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[2]); redis.call('SREM', KEYS[3], ARGV[2]); end", 3, `newRoomChatUnreadChannels:${userId}:${roomId}`, `newRoomChatMessageExists:${userId}:${roomId}`, `newChatMessagesExists:${userId}`, selected!, `room:${roomId}`);
			}
		});
		await this.notify([userId]);
	}

	public async forget(userId: string, roomId: string): Promise<void> {
		await this.db.transaction(async manager => {
			const room = await manager.findOne(MiChatRoom, { where: { id: roomId }, lock: { mode: 'pessimistic_write' } });
			if (room != null && await this.isMember(userId, room, manager)) return;
			await manager.delete(MiChatRoomUnread, { userId, roomId });
			await manager.delete(MiChatRoomUserSettings, { userId, roomId });
		});
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
