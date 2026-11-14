/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { vi } from 'vitest';
import { ChatRoomNotificationService } from '@/core/ChatRoomNotificationService.js';
import { CHAT_UNREAD_GUARDED_DEL, CHAT_UNREAD_MARK, CHAT_UNREAD_MOVE_MARKER, CHAT_UNREAD_PRUNE_CHANNEL, CHAT_UNREAD_PRUNE_ROOM, CHAT_UNREAD_READ_ALL } from '@/core/chat-room-notifications.js';
import { ChatChannelError } from '@/core/chat-room-channels.js';
import { MiChatRoom } from '@/models/ChatRoom.js';
import { MiChatRoomMembership } from '@/models/ChatRoomMembership.js';
import { MiChatRoomUserSettings } from '@/models/ChatRoomUserSettings.js';
import { MiChatMessage } from '@/models/ChatMessage.js';
import { MiUser } from '@/models/User.js';
import type { ChatService } from '@/core/ChatService.js';
import type { EntityManager } from 'typeorm';

/** 표식 서비스가 쓰는 Redis 명령만 흉내낸다. Lua는 서비스가 쓰는 스크립트만 해석한다. */
export function fakeUnreadRedis() {
	const strings = new Map<string, string>();
	const sets = new Map<string, Set<string>>();
	const setOf = (key: string) => {
		let set = sets.get(key);
		if (set == null) {
			set = new Set();
			sets.set(key, set);
		}
		return set;
	};
	const del = (...keys: string[]) => {
		let removed = 0;
		for (const key of keys) {
			if (strings.delete(key)) removed++;
			if (sets.delete(key)) removed++;
		}
		return removed;
	};
	const redis = {
		get: vi.fn(async (key: string) => strings.get(key) ?? null),
		set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
			if (args.includes('NX') && strings.has(key)) return null;
			strings.set(key, value);
			return 'OK';
		}),
		sadd: vi.fn(async (key: string, ...values: string[]) => {
			const set = setOf(key);
			let added = 0;
			for (const value of values) {
				if (!set.has(value)) {
					set.add(value);
					added++;
				}
			}
			return added;
		}),
		srem: vi.fn(async (key: string, ...values: string[]) => {
			const set = sets.get(key);
			let removed = 0;
			for (const value of values) {
				if (set?.delete(value)) removed++;
			}
			return removed;
		}),
		smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
		del: vi.fn(async (...keys: string[]) => del(...keys)),
		mget: vi.fn(async (...keys: string[]) => keys.map(key => strings.get(key) ?? null)),
		incr: vi.fn(async (key: string) => {
			const value = Number(strings.get(key) ?? '0') + 1;
			strings.set(key, String(value));
			return value;
		}),
		expire: vi.fn(async () => 1),
		eval: vi.fn(async (script: string, _numKeys: number, ...args: string[]) => {
			if (script === CHAT_UNREAD_GUARDED_DEL) {
				const [key, expected] = args;
				return strings.get(key) === expected ? del(key) : 0;
			}
			if (script === CHAT_UNREAD_MARK) {
				const [key, incomingMarker] = args;
				const currentMarker = strings.get(key);
				if (currentMarker == null) {
					strings.set(key, incomingMarker);
					return 1;
				}
				// Lua의 string.match('^(%d+):')는 순번 없는 옛 표식에 nil을 돌려준다
				const seqOf = (marker: string) => marker.match(/^(\d+):/)?.[1] ?? null;
				const current = seqOf(currentMarker);
				const incoming = seqOf(incomingMarker);
				if (incoming == null) return 0;
				if (current == null || incoming.length > current.length || (incoming.length === current.length && incoming > current)) {
					strings.set(key, incomingMarker);
					return 1;
				}
				return 0;
			}
			if (script === CHAT_UNREAD_PRUNE_ROOM) {
				const [roomMessageKey, roomMentionKey, totalsKey, roomEntry] = args;
				if (!strings.has(roomMessageKey) && !strings.has(roomMentionKey)) {
					await redis.srem(totalsKey, roomEntry);
				}
				return 0;
			}
			if (script === CHAT_UNREAD_PRUNE_CHANNEL) {
				const [setKey, channelMessageKey, channelMentionKey, roomMessageKey, roomMentionKey, totalsKey, channelId, roomEntry] = args;
				if (strings.has(channelMessageKey) || strings.has(channelMentionKey)) return 0;
				await redis.srem(setKey, channelId);
				if ((sets.get(setKey)?.size ?? 0) === 0) {
					del(roomMessageKey, roomMentionKey);
					await redis.srem(totalsKey, roomEntry);
				}
				return 0;
			}
			if (script === CHAT_UNREAD_MOVE_MARKER) {
				const [sourceKey, destKey, setKey, totalsKey, expectedMarker, channelId, roomEntry] = args;
				if (strings.get(sourceKey) !== expectedMarker) return 0;
				const seqOf = (marker: string) => marker.match(/^(\d+):/)?.[1] ?? null;
				const currentMarker = strings.get(destKey);
				if (currentMarker == null) {
					strings.set(destKey, expectedMarker);
				} else {
					const current = seqOf(currentMarker);
					const incoming = seqOf(expectedMarker);
					if (incoming != null && (current == null || incoming.length > current.length || (incoming.length === current.length && incoming > current))) {
						strings.set(destKey, expectedMarker);
					}
				}
				del(sourceKey);
				await redis.sadd(setKey, channelId);
				await redis.sadd(totalsKey, roomEntry);
				return 1;
			}
			if (script === CHAT_UNREAD_READ_ALL) {
				const keys = args.slice(0, _numKeys - 1);
				const totalsKey = args[_numKeys - 1];
				const roomEntry = args[_numKeys];
				del(...keys);
				await redis.srem(totalsKey, roomEntry);
				return 1;
			}
			throw new Error('unknown script in fake unread redis');
		}),
	};
	const pipeline = () => {
		const commands: (() => Promise<unknown>)[] = [];
		const chain = {
			get: (key: string) => { commands.push(() => redis.get(key)); return chain; },
			set: (key: string, value: string, ...args: unknown[]) => { commands.push(() => redis.set(key, value, ...args)); return chain; },
			sadd: (key: string, ...values: string[]) => { commands.push(() => redis.sadd(key, ...values)); return chain; },
			srem: (key: string, ...values: string[]) => { commands.push(() => redis.srem(key, ...values)); return chain; },
			del: (...keys: string[]) => { commands.push(() => redis.del(...keys)); return chain; },
			exec: async () => {
				const results: [null, unknown][] = [];
				for (const command of commands) results.push([null, await command()]);
				return results;
			},
		};
		return chain;
	};
	return Object.assign(redis, { pipeline, multi: pipeline });
}

/** 알림 정책은 실제 서비스를 쓰고, 다른 동작을 검사하는 시험의 저장소만 대체한다. */
export function notificationServiceOver(chat: ChatService): ChatRoomNotificationService {
	const dependencies = chat as unknown as {
		chatRoomsRepository?: { findOneBy?(where: { id: string }): Promise<MiChatRoom | null> };
		chatRoomMembershipsRepository: { findBy(where: { roomId: string }): Promise<MiChatRoomMembership[]> };
		usersRepository: { findOneBy(where: { id: string }): Promise<MiUser | null> };
	};
	const messages = new Map<string, MiChatMessage>();
	let sequence = 0;
	const settingsRows = new Map<string, MiChatRoomUserSettings>();
	const settings = {
		findOneBy: async ({ userId, roomId }: { userId: string; roomId: string }) => settingsRows.get(`${userId}:${roomId}`) ?? null,
		upsert: async (value: MiChatRoomUserSettings) => { settingsRows.set(`${value.userId}:${value.roomId}`, value); },
		findBy: async ({ roomId }: { roomId: string }) => [...settingsRows.values()].filter(row => row.roomId === roomId),
	};
	const manager = {
		withRepository: (repository: unknown) => repository,
		findOne: async (entity: unknown, options: { where: { id: string } }) => entity === MiChatRoom ? await dependencies.chatRoomsRepository?.findOneBy?.(options.where) ?? null : null,
		findOneBy: async (entity: unknown, where: { id?: string; roomId?: string; userId?: string; toRoomId?: string }) => {
			if (entity === MiChatRoom) return await dependencies.chatRoomsRepository?.findOneBy?.({ id: where.id! }) ?? null;
			if (entity === MiChatRoomMembership) return (await dependencies.chatRoomMembershipsRepository.findBy({ roomId: where.roomId! })).find(member => member.userId === where.userId) ?? null;
			if (entity === MiChatMessage) {
				const message = messages.get(where.id!) ?? null;
				return message != null && (where.toRoomId == null || message.toRoomId === where.toRoomId) ? message : null;
			}
			return null;
		},
		existsBy: async (_entity: unknown, where: { roomId: string; userId: string }) => (await dependencies.chatRoomMembershipsRepository.findBy({ roomId: where.roomId })).some(member => member.userId === where.userId),
		findBy: async (entity: unknown, where: { roomId: string; id: { value: string[] } }) => {
			if (entity === MiChatRoomMembership) return dependencies.chatRoomMembershipsRepository.findBy(where);
			if (entity === MiUser) return (await Promise.all(where.id.value.map(id => dependencies.usersRepository.findOneBy({ id })))).filter(user => user != null).map(user => ({ ...user, username: user.username ?? user.id }));
			return [];
		},
		update: async (_entity: unknown, idOrWhere: unknown, patch: object) => {
			// 조건 객체 형태(멤버십 음소거 등)는 설정 행이 이미 수준을 들고 있으므로 건너뛴다
			if (typeof idOrWhere !== 'string') return { affected: 1 };
			Object.assign(messages.get(idOrWhere)!, patch);
			return { affected: 1 };
		},
		delete: async (entity: unknown, where: { userId: string; roomId: string }) => {
			if (entity === MiChatRoomUserSettings) return { affected: Number(settingsRows.delete(`${where.userId}:${where.roomId}`)) };
			return { affected: 0 };
		},
		createQueryBuilder: () => {
			let roomId: string | undefined;
			const builder = { update: () => builder, set: () => builder, where: (_sql: string, params?: { roomId?: string }) => { roomId = params?.roomId; return builder; }, returning: () => builder, execute: async () => {
				const value = String(++sequence);
				const target = roomId != null ? await dependencies.chatRoomsRepository?.findOneBy?.({ id: roomId }) : null;
				if (target != null) target.messageSequence = value;
				return { raw: [{ messageSequence: value }] };
			} };
			return builder;
		},
	};
	const service = Object.assign(Object.create(ChatRoomNotificationService.prototype), {
		db: { manager, transaction: async <T>(run: (manager: unknown) => Promise<T>) => run(manager) },
		settingsRepository: settings,
		redis: fakeUnreadRedis(),
		channels: {
			list: async () => [],
			resolve: async (room: MiChatRoom, channelId?: string | null) => {
				if (!room.hasChannels) {
					if (channelId != null) throw new ChatChannelError('NO_SUCH_CHANNEL');
					return null;
				}
				const id = channelId ?? room.legacyChannelId;
				if (id == null) throw new ChatChannelError('NO_SUCH_CHANNEL');
				return id;
			},
		},
		config: { host: 'local.test' },
	}) as ChatRoomNotificationService;
	Object.assign(service, {
		record: async (_manager: EntityManager, room: MiChatRoom, message: MiChatMessage, previous?: string[]) => {
			messages.set(message.id, message);
			return ChatRoomNotificationService.prototype.record.call(service, manager as unknown as EntityManager, room, message, previous);
		},
		notify: vi.fn(async () => {}),
		channelsChanged: vi.fn(async () => {}),
	});
	return service;
}
