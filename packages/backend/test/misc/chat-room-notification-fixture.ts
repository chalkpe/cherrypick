/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { vi } from 'vitest';
import { ChatRoomNotificationService } from '@/core/ChatRoomNotificationService.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
import { MiUser } from '@/models/User.js';
import type { ChatService } from '@/core/ChatService.js';
import type { MiChatRoomUnread } from '@/models/ChatRoomUnread.js';
import type { EntityManager } from 'typeorm';

/** 알림 정책은 실제 서비스를 쓰고, 다른 동작을 검사하는 시험의 저장소만 대체한다. */
export function notificationServiceOver(chat: ChatService): ChatRoomNotificationService {
	const dependencies = chat as unknown as {
		chatRoomsRepository: { findOneBy(where: { id: string }): Promise<MiChatRoom | null> };
		chatRoomMembershipsRepository: { findBy(where: { roomId: string }): Promise<MiChatRoomMembership[]> };
		usersRepository: { findOneBy(where: { id: string }): Promise<MiUser | null> };
	};
	const rows: Partial<MiChatRoomUnread>[] = [];
	const messages = new Map<string, MiChatMessage>();
	let sequence = 0;
	const matches = (row: Partial<MiChatRoomUnread>, where: Partial<MiChatRoomUnread>) => Object.entries(where).every(([key, value]) => row[key as keyof MiChatRoomUnread] === value);
	const unreads = {
		findBy: async (where: Partial<MiChatRoomUnread>) => rows.filter(row => matches(row, where)),
		upsert: async (value: Partial<MiChatRoomUnread>) => {
			const row = rows.find(row => row.userId === value.userId && row.messageId === value.messageId);
			if (row) Object.assign(row, value);
			else rows.push({ ...value });
		},
		update: async (where: Partial<MiChatRoomUnread>, patch: Partial<MiChatRoomUnread>) => {
			const found = rows.filter(row => matches(row, where));
			for (const row of found) Object.assign(row, patch);
			return { affected: found.length };
		},
	};
	const settings = { findOneBy: async () => null };
	const manager = {
		withRepository: (repository: unknown) => repository,
		findOneBy: async (entity: unknown, where: { id: string; roomId: string; userId: string }) => {
			if (entity === MiChatRoom) return dependencies.chatRoomsRepository.findOneBy(where);
			if (entity === MiChatRoomMembership) return (await dependencies.chatRoomMembershipsRepository.findBy({ roomId: where.roomId })).find(member => member.userId === where.userId) ?? null;
			return null;
		},
		existsBy: async (_entity: unknown, where: { roomId: string; userId: string }) => (await dependencies.chatRoomMembershipsRepository.findBy({ roomId: where.roomId })).some(member => member.userId === where.userId),
		findBy: async (entity: unknown, where: { roomId: string; id: { value: string[] } }) => {
			if (entity === MiChatRoomMembership) return dependencies.chatRoomMembershipsRepository.findBy(where);
			if (entity === MiUser) return (await Promise.all(where.id.value.map(id => dependencies.usersRepository.findOneBy({ id })))).filter(user => user != null).map(user => ({ ...user, username: user.username ?? user.id }));
			return [];
		},
		update: async (_entity: unknown, id: string, patch: object) => {
			Object.assign(messages.get(id)!, patch);
			return { affected: 1 };
		},
		createQueryBuilder: () => {
			const builder = { update: () => builder, set: () => builder, where: () => builder, returning: () => builder, execute: async () => ({ raw: [{ messageSequence: String(++sequence) }] }) };
			return builder;
		},
	};
	const service = Object.assign(Object.create(ChatRoomNotificationService.prototype), {
		db: { manager }, settingsRepository: settings, unreadsRepository: unreads,
		config: { host: 'local.test' },
	}) as ChatRoomNotificationService;
	Object.assign(service, {
		pendingRecipients: async (message: MiChatMessage) => ChatRoomNotificationService.prototype.pendingRecipients.call(service, message, manager as unknown as EntityManager),
		record: async (_manager: EntityManager, room: MiChatRoom, message: MiChatMessage, previous?: string[]) => {
			messages.set(message.id, message);
			return ChatRoomNotificationService.prototype.record.call(service, manager as unknown as EntityManager, room, message, previous);
		},
		notify: vi.fn(async () => {}),
		forget: vi.fn(async (userId: string, roomId: string) => {
			for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === userId && rows[i].roomId === roomId) rows.splice(i, 1);
		}),
		channelsChanged: vi.fn(async () => {}),
	});
	return service;
}
