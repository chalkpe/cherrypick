/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { ChatInviteInvalidUrlError, ChatInviteLinkService } from '@/core/ChatInviteLinkService.js';
import { ChatService } from '@/core/ChatService.js';
import { chatInviteLinkApiErrors } from '@/server/api/chat-invite-link-errors.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'read:chat',

	limit: {
		duration: ms('1hour'),
		max: 300,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			status: { type: 'string', optional: false, nullable: false, enum: ['none', 'pending', 'joined', 'invited', 'refused'] },
			roomId: { type: 'string', optional: false, nullable: true, format: 'misskey:id' },
			reason: { type: 'string', optional: false, nullable: true, enum: ['revoked', 'archived', 'banned', 'blocked', 'full', 'unknown', null] },
		},
	},

	errors: {
		invalidInviteLink: chatInviteLinkApiErrors.INVALID_INVITE_LINK,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		url: { type: 'string', minLength: 1, maxLength: 2048 },
	},
	required: ['url'],
} as const;

/** 초대 링크 참여의 현재 상태. 아무것도 바꾸지 않는다 */
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatInviteLinkService: ChatInviteLinkService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'read');
			try {
				return await this.chatInviteLinkService.joinStatus(me, ps.url);
			} catch (err) {
				if (err instanceof ChatInviteInvalidUrlError) throw new ApiError(meta.errors.invalidInviteLink);
				throw err;
			}
		});
	}
}
