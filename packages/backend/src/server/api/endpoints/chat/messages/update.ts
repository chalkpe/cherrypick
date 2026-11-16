/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ChatChannelError, chatChannelRefsParam } from '@/core/chat-room-channels.js';
import { chatChannelApiErrors } from '@/server/api/chat-channel-errors.js';
import { Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ChatMessageAccessError, ChatMessageInvalidTextError, ChatRoomArchivedError, ChatService, MAX_CHAT_MESSAGE_TEXT_LENGTH } from '@/core/ChatService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	prohibitMoved: true,

	kind: 'write:chat',

	limit: {
		duration: ms('1hour'),
		max: 500,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		ref: 'ChatMessage',
	},

	errors: {
		...chatChannelApiErrors,
		noSuchMessage: {
			message: 'No such message.',
			code: 'NO_SUCH_MESSAGE',
			id: '31846552-b85d-4908-808f-64bf91000151',
		},
		invalidText: {
			message: 'Invalid text.',
			code: 'INVALID_TEXT',
			id: 'f6f8f5d4-1f37-4d3f-9e3b-4e1b4f8a2c71',
		},
		roomIsArchived: {
			message: 'This room is archived.',
			code: 'ROOM_IS_ARCHIVED',
			id: 'a1c94d37-2e58-4b06-8f1d-6d0b9e47c352',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		messageId: { type: 'string', format: 'misskey:id' },
		channelRefs: chatChannelRefsParam,
		text: { type: 'string', maxLength: MAX_CHAT_MESSAGE_TEXT_LENGTH },
	},
	required: ['messageId', 'text'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatEntityService: ChatEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');

			try {
				const updated = await this.chatService.updateMessage(me.id, ps.messageId, ps.text, ps.channelRefs);
				return this.chatEntityService.packMessageDetailed(updated, me);
			} catch (e) {
				if (e instanceof ChatChannelError) throw new ApiError(meta.errors[e.reason]);
				if (e instanceof ChatMessageInvalidTextError) throw new ApiError(meta.errors.invalidText);
				if (e instanceof ChatMessageAccessError) throw new ApiError(meta.errors.noSuchMessage);
				if (e instanceof ChatRoomArchivedError) throw new ApiError(meta.errors.roomIsArchived);
				throw e;
			}
		});
	}
}
