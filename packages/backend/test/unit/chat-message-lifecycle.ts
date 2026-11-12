/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import { ChatService } from '@/core/ChatService.js';

function createService() {
	return new ChatEntityService(
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{ pack: vi.fn().mockResolvedValue({ id: 'u1' }) } as never,
		{ pack: vi.fn().mockResolvedValue({ id: 'f1' }) } as never,
		{ populateEmojis: vi.fn().mockResolvedValue([]) } as never,
		{ parse: vi.fn().mockReturnValue({ date: new Date('2026-11-02T00:00:00.000Z') }) } as never,
		{} as never,
		{} as never,
	);
}

describe('chat message lifecycle packing', () => {
	test('packs editedAt/deletedAt and clears deleted content', async () => {
		const service = createService();
		const message = await service.packMessageDetailed({
			id: 'm1',
			text: 'secret',
			editedAt: new Date('2026-11-02T00:00:00Z'),
			deletedAt: new Date('2026-11-02T00:01:00Z'),
			reactions: ['u1/👍'],
			fileIds: ['f1'],
			fromUserId: 'u1',
			fromUser: { id: 'u1', host: null },
			toUserId: null,
			toRoomId: null,
			emojis: [],
		} as never, { id: 'u2' });

		expect(message.editedAt).toBe('2026-11-02T00:00:00.000Z');
		expect(message.deletedAt).toBe('2026-11-02T00:01:00.000Z');
		expect(message.text).toBeNull();
		expect(message.file).toBeNull();
		expect(message.files).toEqual([]);
		expect(message.reactions).toEqual([]);
	});
});

describe('deleted messages in a timeline', () => {
	const hidden = 'message.deletedAt IS NULL';

	function createChatService() {
		const conditions: string[] = [];
		const builder = {
			andWhere(condition: unknown) { if (typeof condition === 'string') conditions.push(condition); return this; },
			take() { return this; },
			setParameter() { return this; },
			leftJoinAndSelect() { return this; },
			getMany: async () => [],
		};
		const service = Object.assign(Object.create(ChatService.prototype), {
			queryService: { makePaginationQuery: () => builder },
			chatMessagesRepository: { createQueryBuilder: () => builder },
			chatRoomsRepository: { findOneBy: async () => ({ id: 'r1' }) },
			chatRoomChannelService: Object.assign(Object.create(ChatRoomChannelService.prototype), { db: { manager: {} } }),
		}) as ChatService;
		return { service, conditions };
	}

	test.each([
		['a conversation', (service: ChatService, includeDeleted?: boolean) => service.userTimeline('me', 'other', 10, null, null, includeDeleted)],
		['a room', (service: ChatService, includeDeleted?: boolean) => service.roomTimeline('r1', 10, null, null, includeDeleted)],
	])('are left out of %s for clients that do not know the marker, unless asked for', async (_name, run) => {
		const plain = createChatService();
		await run(plain.service);
		expect(plain.conditions).toContain(hidden);

		const asked = createChatService();
		await run(asked.service, true);
		expect(asked.conditions).not.toContain(hidden);
	});
});
