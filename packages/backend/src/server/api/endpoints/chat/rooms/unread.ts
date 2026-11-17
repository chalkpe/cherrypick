/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomNotificationService } from '@/core/ChatRoomNotificationService.js';
import { ChatRoomChannelService } from '@/core/ChatRoomChannelService.js';
import { ChatChannelError } from '@/core/chat-room-channels.js';
import { chatChannelApiErrors } from '@/server/api/chat-channel-errors.js';

export const meta = {
	tags: ['chat'], requireCredential: true, kind: 'read:chat',
	limit: { duration: 60000, max: 500 },
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			hasUnread: { type: 'boolean', optional: false, nullable: false },
			hasUnreadNotification: { type: 'boolean', optional: false, nullable: false },
			unreadChannelIds: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
			notificationChannelIds: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
		},
	},
	errors: chatChannelApiErrors,
} as const;

export const paramDef = {
	type: 'object', properties: { roomId: { type: 'string', format: 'misskey:id' } }, required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private chat: ChatService, private notifications: ChatRoomNotificationService, private channels: ChatRoomChannelService) {
		super(meta, paramDef, async (ps, me) => {
			await this.chat.checkChatAvailability(me.id, 'read');
			try {
				return await this.notifications.state(me.id, await this.channels.memberRoom(me.id, ps.roomId));
			} catch (err) {
				if (err instanceof ChatChannelError) throw new ApiError(meta.errors[err.reason]);
				throw err;
			}
		});
	}
}
