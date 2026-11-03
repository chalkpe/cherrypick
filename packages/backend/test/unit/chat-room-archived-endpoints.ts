/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChatRoomArchivedError } from '@/core/ChatService.js';
import CreateToRoomEndpoint from '@/server/api/endpoints/chat/messages/create-to-room.js';
import DeleteEndpoint from '@/server/api/endpoints/chat/messages/delete.js';
import ReactEndpoint from '@/server/api/endpoints/chat/messages/react.js';
import UnreactEndpoint from '@/server/api/endpoints/chat/messages/unreact.js';
import UpdateEndpoint from '@/server/api/endpoints/chat/messages/update.js';
import InvitationCreateEndpoint from '@/server/api/endpoints/chat/rooms/invitations/create.js';
import JoinEndpoint from '@/server/api/endpoints/chat/rooms/join.js';
import RoomUpdateEndpoint from '@/server/api/endpoints/chat/rooms/update.js';

const me = { id: 'me', host: null, uri: null } as any;

function chatService(method: string) {
	return {
		checkChatAvailability: vi.fn().mockResolvedValue(undefined),
		findRoomById: vi.fn().mockResolvedValue({ id: 'r1' }),
		findMyMessageById: vi.fn().mockResolvedValue({ id: 'm1' }),
		[method]: vi.fn().mockRejectedValue(new ChatRoomArchivedError('archived')),
	} as any;
}

function ownedRoomService(method: string) {
	return { ...chatService(method), findMyRoomById: vi.fn().mockResolvedValue({ id: 'r1' }) };
}

describe('chat endpoints report an archived room', () => {
	test.each([
		['chat/messages/create-to-room', () => new (CreateToRoomEndpoint as any)({}, {}, chatService('createMessageToRoom')), { toRoomId: 'r1', text: 'hello' }],
		['chat/messages/update', () => new (UpdateEndpoint as any)(chatService('updateMessage'), {}), { messageId: 'm1', text: 'edited' }],
		['chat/messages/delete', () => new (DeleteEndpoint as any)(chatService('deleteMessage')), { messageId: 'm1' }],
		['chat/messages/react', () => new (ReactEndpoint as any)(chatService('react')), { messageId: 'm1', reaction: '👍' }],
		['chat/messages/unreact', () => new (UnreactEndpoint as any)(chatService('unreact')), { messageId: 'm1', reaction: '👍' }],
		['chat/rooms/join', () => new (JoinEndpoint as any)(chatService('joinToRoom')), { roomId: 'r1' }],
		['chat/rooms/invitations/create', () => new (InvitationCreateEndpoint as any)(ownedRoomService('createRoomInvitation'), {}), { roomId: 'r1', userId: 'u1' }],
	])('%s', async (_name, build, params) => {
		await expect(build().exec(params, me, null, null)).rejects.toMatchObject({ code: 'ROOM_IS_ARCHIVED' });
	});
});

describe('chat/rooms/update and the archived state', () => {
	function endpoint(isArchived: boolean) {
		const service = {
			checkChatAvailability: vi.fn().mockResolvedValue(undefined),
			findMyRoomById: vi.fn().mockResolvedValue({ id: 'r1', isArchived }),
			updateRoom: vi.fn(async (room: object, params: object) => ({ ...room, ...params })),
		};
		const entities = { packRoom: vi.fn(async (room: object) => room) };
		return { service, instance: new (RoomUpdateEndpoint as any)(service, entities) };
	}

	test('the owner can archive', async () => {
		const { service, instance } = endpoint(false);

		await instance.exec({ roomId: 'r1', isArchived: true }, me, null, null);

		expect(service.updateRoom).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ isArchived: true }));
	});

	test('someone who does not own the room cannot', async () => {
		const { service, instance } = endpoint(false);
		service.findMyRoomById.mockResolvedValue(null);

		await expect(instance.exec({ roomId: 'r1', isArchived: true }, me, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_ROOM' });
		expect(service.updateRoom).not.toHaveBeenCalled();
	});

	test.each([{ name: 'new' }, { description: 'new' }, { name: 'new', isArchived: true }])('an archived room refuses the edit %j', async (params) => {
		const { service, instance } = endpoint(true);

		await expect(instance.exec({ roomId: 'r1', ...params }, me, null, null)).rejects.toMatchObject({ code: 'ROOM_IS_ARCHIVED' });
		expect(service.updateRoom).not.toHaveBeenCalled();
	});

	test.each([{ isArchived: false }, { isArchived: false, name: 'new' }])('an archived room can be unarchived with %j', async (params) => {
		const { service, instance } = endpoint(true);

		await instance.exec({ roomId: 'r1', ...params }, me, null, null);

		expect(service.updateRoom).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(params));
	});
});
