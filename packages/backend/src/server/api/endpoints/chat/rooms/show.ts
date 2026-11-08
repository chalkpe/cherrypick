/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { ApiError } from '@/server/api/error.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'read:chat',

	res: {
		type: 'object',
		optional: false, nullable: false,
		ref: 'ChatRoom',
	},

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: '857ae02f-8759-4d20-9adb-6e95fffe4fd7',
		},

		roomDeleted: {
			message: 'This room was deleted.',
			code: 'ROOM_DELETED',
			id: '688e3c65-58d2-4a50-8098-eb9b5e48fdec',
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
		private chatEntityService: ChatEntityService,
		private chatRosterService: ChatRosterService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'read');

			const room = await this.chatService.findRoomById(ps.roomId);
			if (room == null) {
				// Only someone who was in the room may learn that it ever existed.
				if (await this.chatRosterService.wasRoomDeletedFor(me.id, ps.roomId)) throw new ApiError(meta.errors.roomDeleted);
				throw new ApiError(meta.errors.noSuchRoom);
			}

			if (!await this.chatService.hasPermissionToViewRoomInfo(me.id, room)) {
				throw new ApiError(meta.errors.noSuchRoom);
			}

			return this.chatEntityService.packRoom(room, me);
		});
	}
}
