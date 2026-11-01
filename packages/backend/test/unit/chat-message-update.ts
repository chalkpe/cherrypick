/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatMessageAccessError, ChatService } from '@/core/ChatService.js';

function createFixture(overrides: { deletedAt?: Date | null } = {}) {
	const message = {
		id: 'm1',
		fromUserId: 'u1',
		toUserId: 'u2',
		toRoomId: null,
		text: 'old',
		editedAt: null,
		deletedAt: overrides.deletedAt ?? null,
		reactions: [],
		emojis: [],
	};

	const chatMessagesRepository = {
		findOneBy: vi.fn().mockImplementation(async ({ id }: { id: string }) => id === message.id ? message : null),
		update: vi.fn().mockImplementation(async (id: string, patch: Partial<typeof message>) => {
			Object.assign(message, patch);
			return { affected: 1 };
		}),
	};
	const publishChatUserStream = vi.fn();
	const publishChatRoomStream = vi.fn();

	const service = Object.assign(Object.create(ChatService.prototype), {
		chatMessagesRepository,
		globalEventService: { publishChatUserStream, publishChatRoomStream },
		userEntityService: {
			isLocalUser: () => true,
			isRemoteUser: () => false,
		},
	}) as ChatService;

	return { service, message, chatMessagesRepository, publishChatUserStream, publishChatRoomStream };
}

describe('ChatService.updateMessage', () => {
	test('updates own message and sets editedAt', async () => {
		const f = createFixture();

		const updated = await f.service.updateMessage('u1', 'm1', ' edited ');

		expect(updated.text).toBe('edited');
		expect(updated.editedAt).toBeInstanceOf(Date);
		expect(f.chatMessagesRepository.update).toHaveBeenCalledWith('m1', expect.objectContaining({ text: 'edited' }));
	});

	test('rejects editing another user message', async () => {
		const f = createFixture();

		await expect(f.service.updateMessage('u2', 'm1', 'x')).rejects.toBeInstanceOf(ChatMessageAccessError);
		expect(f.chatMessagesRepository.update).not.toHaveBeenCalled();
	});

	test('rejects editing a deleted message', async () => {
		const f = createFixture({ deletedAt: new Date() });

		await expect(f.service.updateMessage('u1', 'm1', 'x')).rejects.toThrow('deleted');
	});

	test('rejects empty text and text over 2000 characters', async () => {
		const f = createFixture();

		await expect(f.service.updateMessage('u1', 'm1', '   ')).rejects.toThrow('invalid text');
		await expect(f.service.updateMessage('u1', 'm1', 'x'.repeat(2001))).rejects.toThrow('invalid text');
	});
});
