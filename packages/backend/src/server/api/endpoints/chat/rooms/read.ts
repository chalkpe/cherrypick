/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomNotificationService } from '@/core/ChatRoomNotificationService.js';
import { ChatChannelError } from '@/core/chat-room-channels.js';
import { chatChannelApiErrors } from '@/server/api/chat-channel-errors.js';

export const meta = {
	tags: ['chat'], requireCredential: true, kind: 'write:chat', errors: chatChannelApiErrors,
	limit: { duration: 60000, max: 500 },
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
		channelId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		readAll: { type: 'boolean', default: false },
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private chat: ChatService, private notifications: ChatRoomNotificationService) {
		super(meta, paramDef, async (ps, me) => {
			await this.chat.checkChatAvailability(me.id, 'read');
			try {
				await this.notifications.read(me.id, ps.roomId, ps.channelId, ps.untilId, ps.readAll);
			} catch (err) {
				if (err instanceof ChatChannelError) throw new ApiError(meta.errors[err.reason]);
				throw err;
			}
		});
	}
}
