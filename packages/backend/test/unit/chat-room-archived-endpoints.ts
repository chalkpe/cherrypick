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
import JoinEndpoint from '@/server/api/endpoints/chat/rooms/join.js';

const me = { id: 'me', host: null, uri: null } as any;

function chatService(method: string) {
	return {
		checkChatAvailability: vi.fn().mockResolvedValue(undefined),
		findRoomById: vi.fn().mockResolvedValue({ id: 'r1' }),
		findMyMessageById: vi.fn().mockResolvedValue({ id: 'm1' }),
		[method]: vi.fn().mockRejectedValue(new ChatRoomArchivedError('archived')),
	} as any;
}

describe('chat endpoints report an archived room', () => {
	test.each([
		['chat/messages/create-to-room', () => new (CreateToRoomEndpoint as any)({}, {}, chatService('createMessageToRoom')), { toRoomId: 'r1', text: 'hello' }],
		['chat/messages/update', () => new (UpdateEndpoint as any)(chatService('updateMessage'), {}), { messageId: 'm1', text: 'edited' }],
		['chat/messages/delete', () => new (DeleteEndpoint as any)(chatService('deleteMessage')), { messageId: 'm1' }],
		['chat/messages/react', () => new (ReactEndpoint as any)(chatService('react')), { messageId: 'm1', reaction: '👍' }],
		['chat/messages/unreact', () => new (UnreactEndpoint as any)(chatService('unreact')), { messageId: 'm1', reaction: '👍' }],
		['chat/rooms/join', () => new (JoinEndpoint as any)(chatService('joinToRoom')), { roomId: 'r1' }],
	])('%s', async (_name, build, params) => {
		await expect(build().exec(params, me, null, null)).rejects.toMatchObject({ code: 'ROOM_IS_ARCHIVED' });
	});
});
