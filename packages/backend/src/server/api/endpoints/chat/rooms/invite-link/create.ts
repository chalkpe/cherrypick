/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { ChatInviteLinkExistsError, ChatInviteLinkService } from '@/core/ChatInviteLinkService.js';
import { ChatRoomAccessError, ChatRoomArchivedError, ChatService } from '@/core/ChatService.js';
import { chatInviteLinkApiErrors, chatRoomInviteLinkSchema } from '@/server/api/chat-invite-link-errors.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:chat',

	prohibitMoved: true,

	limit: {
		duration: ms('1hour'),
		max: 30,
	},

	res: chatRoomInviteLinkSchema,

	errors: {
		noSuchRoom: chatInviteLinkApiErrors.NO_SUCH_ROOM,
		roomIsArchived: chatInviteLinkApiErrors.ROOM_IS_ARCHIVED,
		inviteLinkAlreadyExists: chatInviteLinkApiErrors.INVITE_LINK_ALREADY_EXISTS,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId'],
} as const;

/** 그룹장만 쓸 수 있다. 활성 링크가 없을 때만 발급하고 기존 링크를 바꾸지 않는다 */
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatInviteLinkService: ChatInviteLinkService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');
			try {
				return this.chatInviteLinkService.packLink(await this.chatInviteLinkService.createLink(me, ps.roomId));
			} catch (err) {
				if (err instanceof ChatRoomAccessError) throw new ApiError(meta.errors.noSuchRoom);
				if (err instanceof ChatRoomArchivedError) throw new ApiError(meta.errors.roomIsArchived);
				if (err instanceof ChatInviteLinkExistsError) throw new ApiError(meta.errors.inviteLinkAlreadyExists);
				throw err;
			}
		});
	}
}
