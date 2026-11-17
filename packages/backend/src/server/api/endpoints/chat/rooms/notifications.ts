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
	tags: ['chat'], requireCredential: true, kind: 'write:chat',
	limit: { duration: 60000, max: 500 },
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			roomId: { type: 'string', optional: false, nullable: false },
			channelId: { type: 'string', optional: false, nullable: true },
			level: { type: 'string', enum: ['all', 'mentions', 'none', 'inherit'], optional: false, nullable: false },
			effectiveLevel: { type: 'string', enum: ['all', 'mentions', 'none'], optional: false, nullable: false },
			channelOverrides: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						channelId: { type: 'string', optional: false, nullable: false },
						level: { type: 'string', enum: ['all', 'mentions', 'none'], optional: false, nullable: false },
					},
				},
			},
		},
	},
	errors: chatChannelApiErrors,
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
		channelId: { type: 'string', format: 'misskey:id' },
		level: { type: 'string', enum: ['all', 'mentions', 'none', 'inherit'] },
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private chat: ChatService, private notifications: ChatRoomNotificationService) {
		super(meta, paramDef, async (ps, me) => {
			await this.chat.checkChatAvailability(me.id, ps.level != null ? 'write' : 'read');
			try {
				const result = await this.notifications.setLevel(me.id, ps.roomId, ps.level, ps.channelId);
				if (ps.level != null) await this.notifications.notify([me.id]);
				return result;
			} catch (err) {
				if (err instanceof ChatChannelError) throw new ApiError(meta.errors[err.reason]);
				throw err;
			}
		});
	}
}
