/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ChatService } from '@/core/ChatService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['chat'],
	requireCredential: true,
	kind: 'write:chat',
	description: 'Removes a member from a room you own. The account cannot join the room again until you pardon it with chat/rooms/bans/delete.',
	limit: {
		duration: 60 * 1000,
		max: 30,
	},
	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: '932260a0-ccf0-4caf-87be-3e9cccd12c2f',
		},
		noSuchMember: {
			message: 'No such removable member.',
			code: 'NO_SUCH_MEMBER',
			id: 'b4c87e54-c36a-40f4-99c7-b72032c48482',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
		userId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId', 'userId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private chatService: ChatService) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');
			const room = await this.chatService.findMyRoomById(me.id, ps.roomId);
			if (room == null) throw new ApiError(meta.errors.noSuchRoom);
			if (!await this.chatService.kickRoomMember(me, room, ps.userId)) throw new ApiError(meta.errors.noSuchMember);
		});
	}
}
