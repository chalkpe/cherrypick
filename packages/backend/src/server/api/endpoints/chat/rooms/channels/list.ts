/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { chatChannelApiErrors } from '@/server/api/chat-channel-errors.js';
import { ChatChannelError } from '@/core/chat-room-channels.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { ChatService } from '@/core/ChatService.js';

export const meta = {
	tags: ['chat'],
	requireCredential: true,
	kind: 'read:chat',
	res: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, ref: 'ChatRoomChannel' } },
	errors: chatChannelApiErrors,
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
		private channels: ChatRoomChannelService,
		private chatService: ChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'read');
			try {
				const room = await this.chatService.findRoomById(ps.roomId);
				if (room == null || !await this.chatService.hasPermissionToViewRoomTimeline(me.id, room)) throw new ChatChannelError('NO_SUCH_ROOM');
				return (await this.channels.list(room.id)).map(channel => this.channels.pack(channel, room));
			} catch (err) {
				if (err instanceof ChatChannelError) throw new ApiError(meta.errors[err.reason]);
				throw err;
			}
		});
	}
}
