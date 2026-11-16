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
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';

export const meta = {
	tags: ['chat'],
	requireCredential: true,
	kind: 'write:chat',
	prohibitMoved: true,
	limit: { duration: 60000, max: 500 },
	res: { type: 'object', optional: false, nullable: false, ref: 'ChatRoom' },
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
		private chatEntityService: ChatEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');
			try {
				const room = await this.channels.convert(me.id, ps.roomId);
				await this.chatService.notifyRoomChannelsChanged(room.id);
				return this.chatEntityService.packRoom(room, me);
			} catch (err) {
				if (err instanceof ChatChannelError) throw new ApiError(meta.errors[err.reason]);
				throw err;
			}
		});
	}
}
