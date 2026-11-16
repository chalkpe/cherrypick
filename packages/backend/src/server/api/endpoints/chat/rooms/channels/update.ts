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
	kind: 'write:chat',
	prohibitMoved: true,
	limit: { duration: 60000, max: 500 },
	res: { type: 'object', optional: false, nullable: false, ref: 'ChatRoomChannel' },
	errors: chatChannelApiErrors,
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		channelId: { type: 'string', format: 'misskey:id' },
		name: { type: 'string', minLength: 1 },
	},
	required: ['channelId', 'name'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private channels: ChatRoomChannelService,
		private chatService: ChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');
			try {
				const channel = await this.channels.rename(me.id, ps.channelId, ps.name);
				await this.chatService.notifyRoomChannelsChanged(channel.roomId);
				return this.channels.pack(channel, await this.channels.memberRoom(me.id, channel.roomId));
			} catch (err) {
				if (err instanceof ChatChannelError) throw new ApiError(meta.errors[err.reason]);
				throw err;
			}
		});
	}
}
