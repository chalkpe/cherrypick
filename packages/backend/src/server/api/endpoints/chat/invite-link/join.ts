/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { ChatInviteInvalidUrlError, ChatInviteJoinRefusedError, ChatInviteLinkService, ChatInviteRemoteUnavailableError } from '@/core/ChatInviteLinkService.js';
import { ChatService } from '@/core/ChatService.js';
import { chatInviteLinkApiErrors, chatJoinRefusalApiErrors } from '@/server/api/chat-invite-link-errors.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:chat',

	prohibitMoved: true,

	limit: {
		duration: ms('1hour'),
		max: 50,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			status: { type: 'string', optional: false, nullable: false, enum: ['joined', 'pending'] },
			roomId: { type: 'string', optional: false, nullable: true, format: 'misskey:id' },
		},
	},

	errors: {
		invalidInviteLink: chatInviteLinkApiErrors.INVALID_INVITE_LINK,
		noSuchInviteLink: chatInviteLinkApiErrors.NO_SUCH_INVITE_LINK,
		roomIsArchived: chatInviteLinkApiErrors.ROOM_IS_ARCHIVED,
		bannedFromRoom: chatInviteLinkApiErrors.BANNED_FROM_ROOM,
		blockedByRoomOwner: chatInviteLinkApiErrors.BLOCKED_BY_ROOM_OWNER,
		roomIsFull: chatInviteLinkApiErrors.ROOM_IS_FULL,
		remoteJoinUnavailable: chatInviteLinkApiErrors.REMOTE_JOIN_UNAVAILABLE,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		url: { type: 'string', minLength: 1, maxLength: 2048 },
	},
	required: ['url'],
} as const;

/**
 * 초대 링크로 참여한다. 이 서버의 링크면 바로 멤버가 되고(joined), 다른 서버의 링크면 그 서버에 참여를 요청한다(pending).
 * 캐시된 미리보기와 무관하게 최신 링크와 참여 자격을 확인한다.
 */
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatInviteLinkService: ChatInviteLinkService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');
			try {
				return await this.chatInviteLinkService.join(me, ps.url);
			} catch (err) {
				if (err instanceof ChatInviteInvalidUrlError) throw new ApiError(meta.errors.invalidInviteLink);
				if (err instanceof ChatInviteRemoteUnavailableError) throw new ApiError(meta.errors.remoteJoinUnavailable);
				if (err instanceof ChatInviteJoinRefusedError) throw new ApiError(chatJoinRefusalApiErrors[err.reason]);
				throw err;
			}
		});
	}
}
