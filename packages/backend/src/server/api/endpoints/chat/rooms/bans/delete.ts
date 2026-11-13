/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomBanService } from '@/core/ChatRoomBanService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:chat',

	description: 'Pardons an account the owner removed from the room. It can then be invited or join again, but it does not become a member, and nobody is invited or told.',

	limit: {
		duration: 60 * 1000,
		max: 30,
	},

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: 'a47c066d-ec11-4e15-930c-49977f0ffac4',
		},
		noSuchBan: {
			message: 'That user is not banned from this room.',
			code: 'NO_SUCH_BAN',
			id: '9b33975c-b8a2-4378-b3f9-3a7e898e0b0d',
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
	constructor(
		private chatService: ChatService,
		private chatRoomBanService: ChatRoomBanService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');

			const room = await this.chatService.findMyRoomById(me.id, ps.roomId);
			if (room == null) throw new ApiError(meta.errors.noSuchRoom);

			if (!await this.chatRoomBanService.pardon(room.id, ps.userId)) throw new ApiError(meta.errors.noSuchBan);
		});
	}
}
