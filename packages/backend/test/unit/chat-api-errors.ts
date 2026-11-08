/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiLocalUser } from '@/models/User.js';
import { ChatRoomFullError, ChatService, ChatTooManyReactionsError } from '@/core/ChatService.js';
import { chatRoomUriForOwner } from '@/core/activitypub/misc/chat-payloads.js';
import { ApiError } from '@/server/api/error.js';
import InvitationCreateEndpoint from '@/server/api/endpoints/chat/rooms/invitations/create.js';
import JoinEndpoint from '@/server/api/endpoints/chat/rooms/join.js';
import ReactEndpoint from '@/server/api/endpoints/chat/messages/react.js';
import { meta as searchMeta } from '@/server/api/endpoints/chat/messages/search.js';

const me = { id: 'me' } as MiLocalUser;

describe('chat API refusals', () => {
	test('joining a full room is a client error', async () => {
		const service = {
			checkChatAvailability: vi.fn(),
			joinToRoom: vi.fn().mockRejectedValue(new ChatRoomFullError('room is full')),
		} as unknown as ChatService;

		await expect(new JoinEndpoint(service).exec({ roomId: 'r1' }, me, null, null)).rejects.toMatchObject({ code: 'ROOM_IS_FULL' });
	});

	test('inviting to a full room is a client error', async () => {
		const service = {
			checkChatAvailability: vi.fn(),
			findMyRoomById: vi.fn().mockResolvedValue({ id: 'r1' }),
			createRoomInvitation: vi.fn().mockRejectedValue(new ChatRoomFullError('room is full')),
		} as unknown as ChatService;

		await expect(new InvitationCreateEndpoint(service, {} as never).exec({ roomId: 'r1', userId: 'u1' }, me, null, null)).rejects.toMatchObject({ code: 'ROOM_IS_FULL' });
	});

	test('a reaction past the limit is a client error', async () => {
		const service = {
			checkChatAvailability: vi.fn(),
			react: vi.fn().mockRejectedValue(new ChatTooManyReactionsError('too many reactions')),
		} as unknown as ChatService;

		await expect(new ReactEndpoint(service).exec({ messageId: 'm1', reaction: '👍' }, me, null, null)).rejects.toMatchObject({ code: 'TOO_MANY_REACTIONS' });
	});

	test('searching messages has a rate limit', () => {
		expect(searchMeta.limit).toEqual({ duration: 60_000, max: 30 });
	});

	test.each([
		['readonly', 'write'],
		['unavailable', 'read'],
		['unavailable', 'write'],
	] as const)('a %s account asking for %s access gets a permission error', async (chatAvailability, permission) => {
		const service = Object.assign(Object.create(ChatService.prototype), {
			roleService: { getUserPolicies: vi.fn().mockResolvedValue({ chatAvailability }) },
		}) as ChatService;

		const error = await service.checkChatAvailability('me', permission).then(() => null, err => err);

		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ code: 'ROLE_PERMISSION_DENIED', kind: 'permission' });
	});
});

describe('chatRoomUriForOwner', () => {
	const baseUrl = 'https://local.test';
	const remoteOwner = { host: 'remote.test', uri: 'https://remote.test/users/owner' };
	const localOwner = { host: null, uri: null };

	test('a stored URI always wins', () => {
		expect(chatRoomUriForOwner({ id: 'r1', uri: 'https://remote.test/custom/r1' }, remoteOwner, baseUrl)).toBe('https://remote.test/custom/r1');
	});

	test('a local room lives on this server', () => {
		expect(chatRoomUriForOwner({ id: 'r1', uri: null }, localOwner, baseUrl)).toBe('https://local.test/chat/rooms/r1');
	});

	test('a remote room without a stored URI lives on its owner\'s server', () => {
		expect(chatRoomUriForOwner({ id: 'r1', uri: null }, remoteOwner, baseUrl)).toBe('https://remote.test/chat/rooms/r1');
	});
});
