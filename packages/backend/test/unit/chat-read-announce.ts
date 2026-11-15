/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatService } from '@/core/ChatService.js';
import { memoryRedis } from '../misc/chat-unread-redis.js';

// 읽음이 표식을 하나도 지우지 않았으면 미읽음 상태는 그대로다. 상태를 다시 계산해 알리는 비용도 내지 않는다.
// 직접 요청한 모두 읽음은 지울 것이 없었더라도 화면에 현재 상태를 알린다.
function fixture() {
	const redis = memoryRedis();
	const main = vi.fn();
	const chatService = Object.assign(Object.create(ChatService.prototype), {
		redisClient: redis,
		globalEventService: { publishMainStream: main },
	}) as ChatService;
	return {
		redis,
		main,
		chatService,
		scard: vi.spyOn(redis, 'scard'),
		incr: vi.spyOn(redis, 'incr'),
		markUser: async (reader: string, sender: string) => {
			await redis.set(`newUserChatMessageExists:${reader}:${sender}`, 'message1');
			await redis.sadd(`newChatMessagesExists:${reader}`, `user:${sender}`);
		},
		markRoom: async (reader: string, room: string) => {
			await redis.set(`newRoomChatMessageExists:${reader}:${room}`, 'message1');
			await redis.sadd(`newChatMessagesExists:${reader}`, `room:${room}`);
		},
	};
}

describe('a read that removes no mark', () => {
	test('stays silent for a 1on1 conversation', async () => {
		const f = fixture();

		await f.chatService.readUserChatMessage('reader', 'sender');

		expect(f.main).not.toHaveBeenCalled();
		expect(f.scard).not.toHaveBeenCalled();
		expect(f.incr).not.toHaveBeenCalled();
	});

	test('stays silent for a room', async () => {
		const f = fixture();

		await f.chatService.readRoomChatMessage('reader', 'room1');

		expect(f.main).not.toHaveBeenCalled();
		expect(f.scard).not.toHaveBeenCalled();
		expect(f.incr).not.toHaveBeenCalled();
	});

	test('stays silent when the same conversation is read again', async () => {
		const f = fixture();
		await f.markUser('reader', 'sender');
		await f.chatService.readUserChatMessage('reader', 'sender');
		expect(f.main).toHaveBeenCalledTimes(1);
		f.main.mockClear();
		f.scard.mockClear();
		f.incr.mockClear();

		await f.chatService.readUserChatMessage('reader', 'sender');

		expect(f.main).not.toHaveBeenCalled();
		expect(f.scard).not.toHaveBeenCalled();
		expect(f.incr).not.toHaveBeenCalled();
	});
});

describe('a read that removes a mark', () => {
	test('announces once when the last 1on1 mark is cleared', async () => {
		const f = fixture();
		await f.markUser('reader', 'sender');

		await f.chatService.readUserChatMessage('reader', 'sender');

		expect(f.main).toHaveBeenCalledTimes(1);
		expect(f.main).toHaveBeenCalledWith('reader', 'chatUnread', { hasUnreadChatMessages: false, version: 1 });
		expect(await f.chatService.hasUnreadMessages('reader')).toBe(false);
	});

	test('announces once when the last room mark is cleared', async () => {
		const f = fixture();
		await f.markRoom('reader', 'room1');

		await f.chatService.readRoomChatMessage('reader', 'room1');

		expect(f.main).toHaveBeenCalledTimes(1);
		expect(f.main).toHaveBeenCalledWith('reader', 'chatUnread', { hasUnreadChatMessages: false, version: 1 });
		expect(await f.chatService.hasUnreadMessages('reader')).toBe(false);
	});

	test('stays silent while another conversation is still unread', async () => {
		const f = fixture();
		await f.markUser('reader', 'sender');
		await f.markRoom('reader', 'room1');

		await f.chatService.readUserChatMessage('reader', 'sender');

		expect(f.main).not.toHaveBeenCalled();
		expect(f.incr).not.toHaveBeenCalled();
		expect(await f.chatService.hasUnreadMessages('reader')).toBe(true);
	});
});

describe('read-all', () => {
	test('tells the current state even when there was nothing to clear', async () => {
		const f = fixture();

		await f.chatService.readAllChatMessages('reader');

		expect(f.main).toHaveBeenCalledTimes(1);
		expect(f.main).toHaveBeenCalledWith('reader', 'chatUnread', { hasUnreadChatMessages: false, version: 1 });
	});

	test('clears every conversation and tells the state', async () => {
		const f = fixture();
		await f.markUser('reader', 'sender');
		await f.markRoom('reader', 'room1');

		await f.chatService.readAllChatMessages('reader');

		expect(await f.chatService.hasUnreadMessages('reader')).toBe(false);
		expect(await f.redis.get('newUserChatMessageExists:reader:sender')).toBeNull();
		expect(await f.redis.get('newRoomChatMessageExists:reader:room1')).toBeNull();
		expect(f.main).toHaveBeenCalledTimes(1);
		expect(f.main).toHaveBeenCalledWith('reader', 'chatUnread', { hasUnreadChatMessages: false, version: 1 });
	});
});
