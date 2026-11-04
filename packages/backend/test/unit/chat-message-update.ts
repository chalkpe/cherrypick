/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { IsNull } from 'typeorm';
import { ChatMessageAccessError, ChatService } from '@/core/ChatService.js';
import UpdateEndpoint, { paramDef as updateParams } from '@/server/api/endpoints/chat/messages/update.js';
import { paramDef as createToRoomParams } from '@/server/api/endpoints/chat/messages/create-to-room.js';
import { paramDef as createToUserParams } from '@/server/api/endpoints/chat/messages/create-to-user.js';
import type { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import type { MiChatMessage, MiUser } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';

function createFixture(overrides: { deletedAt?: Date | null } = {}) {
	const message = {
		id: 'm1',
		fromUserId: 'u1',
		toUserId: 'u2',
		toRoomId: null,
		fileIds: [] as string[],
		text: 'old',
		editedAt: null as Date | null,
		deletedAt: overrides.deletedAt ?? null,
		reactions: [],
		emojis: [] as string[],
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
	const users = new Map([
		['u1', { id: 'u1', host: null, uri: null, inbox: null }],
		['u2', { id: 'u2', host: null, uri: null, inbox: null }],
	]);

	const service = Object.assign(Object.create(ChatService.prototype), {
		chatMessagesRepository,
		chatRoomsRepository: { findOneBy: vi.fn() },
		chatRoomMembershipsRepository: { findBy: vi.fn() },
		driveFilesRepository: { countBy: vi.fn(async ({ id }: { id: { value: string[] } }) => id.value.length) },
		usersRepository: {
			findOneByOrFail: vi.fn(async ({ id }: { id: string }) => users.get(id)),
			findBy: vi.fn(async ({ id }: { id: { value: string[] } }) => id.value.map(value => users.get(value)).filter(Boolean)),
		},
		globalEventService: { publishChatUserStream, publishChatRoomStream },
		queueService: { deliver: vi.fn() },
		apRendererService: {
			renderChatUpdate: vi.fn().mockReturnValue({ type: 'Update' }),
			addContext: vi.fn((activity: unknown) => activity),
		},
		userEntityService: {
			isLocalUser: () => true,
			isRemoteUser: () => false,
		},
		userBlockingService: { checkBlocked: vi.fn().mockResolvedValue(false) },
		customEmojiService: {
			populateEmojis: vi.fn(async (names: string[]) => Object.fromEntries(names.map(name => [name, `https://remote.test/${name}.png`]))),
		},
	}) as ChatService;

	return { service, message, chatMessagesRepository, publishChatUserStream, publishChatRoomStream };
}

test.each([
	['chat/messages/create-to-user', createToUserParams],
	['chat/messages/create-to-room', createToRoomParams],
	['chat/messages/update', updateParams],
])('%s takes the length both servers agree on', (_name, params) => {
	expect(params.properties.text.maxLength).toBe(4096);
});

describe('ChatService.updateMessage', () => {
	test.each(['', '   '])('clears an attachment caption through the local API (%j)', async text => {
		const f = createFixture();
		f.message.fileIds = ['file1'];
		const service = { checkChatAvailability: vi.fn(), updateMessage: f.service.updateMessage } as unknown as ChatService;
		const entityService = { packMessageDetailed: vi.fn(async value => value) } as unknown as ChatEntityService;
		const endpoint = new UpdateEndpoint(service, entityService);

		await endpoint.exec({ messageId: 'm1', text }, { id: 'u1' } as MiLocalUser, null, null);

		expect(f.message.text).toBe('');
		expect(f.message.fileIds).toEqual(['file1']);
		expect(f.publishChatUserStream).toHaveBeenCalledWith('u1', 'u2', 'updated', expect.objectContaining({ text: '' }));
	});

	test('the local API rejects an empty edit of a text-only message', async () => {
		const f = createFixture();
		const service = { checkChatAvailability: vi.fn(), updateMessage: f.service.updateMessage } as unknown as ChatService;
		const entityService = { packMessageDetailed: vi.fn() } as unknown as ChatEntityService;
		const endpoint = new UpdateEndpoint(service, entityService);

		await expect(endpoint.exec({ messageId: 'm1', text: '' }, { id: 'u1' } as MiLocalUser, null, null)).rejects.toMatchObject({ code: 'INVALID_TEXT' });
		expect(f.chatMessagesRepository.update).not.toHaveBeenCalled();
	});

	test('updates own message and sets editedAt', async () => {
		const f = createFixture();

		const updated = await f.service.updateMessage('u1', 'm1', ' edited ');

		expect(updated.text).toBe('edited');
		expect(updated.editedAt).toBeInstanceOf(Date);
		expect(f.chatMessagesRepository.update).toHaveBeenCalledWith({ id: 'm1', deletedAt: IsNull() }, expect.objectContaining({ text: 'edited' }));
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

	test('does not publish an edit when deletion wins the database update', async () => {
		const f = createFixture();
		f.chatMessagesRepository.update.mockResolvedValueOnce({ affected: 0 });

		await expect(f.service.updateMessage('u1', 'm1', 'late edit')).rejects.toBeInstanceOf(ChatMessageAccessError);
		expect(f.publishChatUserStream).not.toHaveBeenCalled();
	});

	test('rejects empty text and text past the limit, counted by code points', async () => {
		const f = createFixture();

		await expect(f.service.updateMessage('u1', 'm1', '   ')).rejects.toThrow('invalid text');
		await expect(f.service.updateMessage('u1', 'm1', 'x'.repeat(4097))).rejects.toThrow('invalid text');
	});

	test('counts text like the API schema, so a sendable emoji message stays editable', async () => {
		const f = createFixture();

		await expect(f.service.updateMessage('u1', 'm1', '👍'.repeat(4096))).resolves.toMatchObject({ text: '👍'.repeat(4096) });
		await expect(f.service.updateMessage('u1', 'm1', '👍'.repeat(4097))).rejects.toThrow('invalid text');
	});

	test('refreshes custom emoji names when editing the text', async () => {
		const f = createFixture();
		f.message.emojis = ['removed'];
		await f.service.updateMessage('u1', 'm1', 'hello :wave:');
		expect(f.message.emojis).toEqual(['wave']);
	});

	test('local edits refresh emoji metadata in storage and streams', async () => {
		const f = createFixture();
		f.message.emojis = ['removed'];
		await f.service.updateMessage('u1', 'm1', ':wave:');
		expect(f.message.emojis).toEqual(['wave']);
		expect(f.publishChatUserStream).toHaveBeenCalledWith('u1', 'u2', 'updated', expect.objectContaining({ emojis: { wave: 'https://remote.test/wave.png' } }));
	});

	test('ignores remote edits older than or equal to the stored revision', async () => {
		const f = createFixture();
		f.message.text = 'latest';
		f.message.editedAt = new Date('2026-11-02T12:02:00Z');
		for (const time of ['2026-11-02T12:01:00Z', '2026-11-02T12:02:00Z']) {
			await f.service.updateRemoteMessage({ id: 'u1', host: 'remote.test' } as MiUser, f.message as unknown as MiChatMessage, 'old', new Date(time));
		}
		expect(f.message.text).toBe('latest');
		expect(f.message.editedAt.toISOString()).toBe('2026-11-02T12:02:00.000Z');
		expect(f.publishChatUserStream).not.toHaveBeenCalled();
	});

	test('remote edits replace emoji metadata in storage and streams', async () => {
		const f = createFixture();
		f.message.emojis = ['removed'];
		await f.service.updateRemoteMessage({ id: 'u1', host: 'remote.test' } as MiUser, f.message as unknown as MiChatMessage, ':wave:', new Date('2026-11-02T12:02:00Z'), ['wave']);
		expect(f.message.emojis).toEqual(['wave']);
		expect(f.publishChatUserStream).toHaveBeenCalledWith('u1', 'u2', 'updated', expect.objectContaining({ emojis: { wave: 'https://remote.test/wave.png' } }));
	});

	test.each(['x', '🦈'])('accepts a remote edit at the 4096-character storage limit (%s)', async (character) => {
		const f = createFixture();
		const text = character.repeat(4096);

		await f.service.updateRemoteMessage({ id: 'u1', host: 'remote.test' } as MiUser, f.message as unknown as MiChatMessage, text, new Date());

		expect(f.message.text).toBe(text);
	});

	test('rejects remote edits beyond the storage limit', async () => {
		const f = createFixture();

		await expect(f.service.updateRemoteMessage({ id: 'u1', host: 'remote.test' } as MiUser, f.message as unknown as MiChatMessage, 'x'.repeat(4097), new Date())).rejects.toThrow('invalid text');
		expect(f.message.text).toBe('old');
	});

	test('lets a remote author clear an attachment caption', async () => {
		const f = createFixture();
		f.message.fileIds = ['file1'];

		await f.service.updateRemoteMessage({ id: 'u1', host: 'remote.test' } as MiUser, f.message as unknown as MiChatMessage, '', new Date());

		expect(f.message.text).toBe('');
		expect(f.message.fileIds).toEqual(['file1']);
		expect(f.publishChatUserStream).toHaveBeenCalledWith('u1', 'u2', 'updated', expect.objectContaining({ text: '' }));
	});

	test('rejects an empty remote edit when the message has no attachment', async () => {
		const f = createFixture();

		await expect(f.service.updateRemoteMessage({ id: 'u1', host: 'remote.test' } as MiUser, f.message as unknown as MiChatMessage, ' ', new Date())).rejects.toThrow('invalid text');
		expect(f.message.text).toBe('old');
	});
});
