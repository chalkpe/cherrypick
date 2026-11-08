/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { ChatRoomAccessError, ChatRoomArchivedError, ChatRoomFullError, ChatService } from '@/core/ChatService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:chat',

	limit: {
		duration: ms('1hour'),
		max: 50,
	},

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: '84416476-5ce8-4a2c-b568-9569f1b10733',
		},
		roomIsArchived: {
			message: 'This room is archived.',
			code: 'ROOM_IS_ARCHIVED',
			id: 'c60a4f18-d3b2-4e75-9c06-7a1e58d3f2b9',
		},
		roomIsFull: {
			message: 'This room is full.',
			code: 'ROOM_IS_FULL',
			id: '56d5a1da-4d30-4f7d-a931-f62e746533f9',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');

			try {
				await this.chatService.joinToRoom(me.id, ps.roomId);
			} catch (e) {
				if (e instanceof ChatRoomAccessError) throw new ApiError(meta.errors.noSuchRoom);
				if (e instanceof ChatRoomArchivedError) throw new ApiError(meta.errors.roomIsArchived);
				if (e instanceof ChatRoomFullError) throw new ApiError(meta.errors.roomIsFull);
				throw e;
			}
		});
	}
}
