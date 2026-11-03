/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ChatService, ChatMessageAccessError, ChatRoomArchivedError } from '@/core/ChatService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:chat',

	limit: {
		duration: ms('1hour'),
		max: 500,
	},

	errors: {
		noSuchMessage: {
			message: 'No such message.',
			code: 'NO_SUCH_MESSAGE',
			id: 'c39ea42f-e3ca-428a-ad57-390e0a711595',
		},
		roomIsArchived: {
			message: 'This room is archived.',
			code: 'ROOM_IS_ARCHIVED',
			id: '92b7e6c4-5a13-4f80-a7d9-08f3e2c1b6d5',
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
				await this.chatService.unreact(ps.messageId, me.id, ps.reaction);
			} catch (e) {
				if (e instanceof ChatMessageAccessError) throw new ApiError(meta.errors.noSuchMessage);
				if (e instanceof ChatRoomArchivedError) throw new ApiError(meta.errors.roomIsArchived);
				throw e;
			}
		});
	}
}
