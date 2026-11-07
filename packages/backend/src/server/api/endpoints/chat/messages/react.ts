/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ChatService, ChatMessageAccessError, ChatReactionInvalidError, ChatRoomArchivedError, ChatTooManyReactionsError } from '@/core/ChatService.js';
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

	errors: {
		noSuchMessage: {
			message: 'No such message.',
			code: 'NO_SUCH_MESSAGE',
			id: '9b5839b9-0ba0-4351-8c35-37082093d200',
		},
		roomIsArchived: {
			message: 'This room is archived.',
			code: 'ROOM_IS_ARCHIVED',
			id: '3d8c5e91-0f47-4a2b-86d3-c94e1b7a5f08',
		},
		invalidReaction: {
			message: 'That reaction is not an emoji available on this server.',
			code: 'INVALID_REACTION',
			id: '140ddc7a-276d-42b5-80ef-7aae6c0a8114',
		},
		tooManyReactions: {
			message: 'This message cannot have any more reactions.',
			code: 'TOO_MANY_REACTIONS',
			id: '635702f5-0dfd-40c3-b669-1d6922055b20',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		messageId: { type: 'string', format: 'misskey:id' },
		reaction: { type: 'string' },
	},
	required: ['messageId', 'reaction'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');

			// メッセージの存在有無をエラー内容から判別できないようにする
			try {
				await this.chatService.react(ps.messageId, me.id, ps.reaction);
			} catch (e) {
				if (e instanceof ChatMessageAccessError) throw new ApiError(meta.errors.noSuchMessage);
				if (e instanceof ChatRoomArchivedError) throw new ApiError(meta.errors.roomIsArchived);
				if (e instanceof ChatReactionInvalidError) throw new ApiError(meta.errors.invalidReaction);
				if (e instanceof ChatTooManyReactionsError) throw new ApiError(meta.errors.tooManyReactions);
				throw e;
			}
		});
	}
}
