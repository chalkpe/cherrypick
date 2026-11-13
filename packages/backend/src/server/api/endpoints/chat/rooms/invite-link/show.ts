/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { ChatInviteLinkService } from '@/core/ChatInviteLinkService.js';
import { ChatRoomAccessError, ChatService } from '@/core/ChatService.js';
import { chatInviteLinkApiErrors, chatRoomInviteLinkSchema } from '@/server/api/chat-invite-link-errors.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'read:chat',

	limit: { duration: 60000, max: 500 },

	res: { ...chatRoomInviteLinkSchema, nullable: true },

	errors: {
		noSuchRoom: chatInviteLinkApiErrors.NO_SUCH_ROOM,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId'],
} as const;

/** 그룹장만 쓸 수 있다. 활성 링크가 없으면 null */
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatInviteLinkService: ChatInviteLinkService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'read');
			try {
				const link = await this.chatInviteLinkService.findLink(me, ps.roomId);
				return link != null ? this.chatInviteLinkService.packLink(link) : null;
			} catch (err) {
				if (err instanceof ChatRoomAccessError) throw new ApiError(meta.errors.noSuchRoom);
				throw err;
			}
		});
	}
}
