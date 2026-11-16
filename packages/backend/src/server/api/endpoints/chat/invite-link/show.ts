/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { ChatInviteLinkService } from '@/core/ChatInviteLinkService.js';
import { chatInviteLinkApiErrors } from '@/server/api/chat-invite-link-errors.js';
import { packedChatRoomSchema } from '@/models/json-schema/chat-room.js';

export const meta = {
	tags: ['chat'],

	requireCredential: false,

	// 로그인 없이 부를 수 있으므로 코드를 추측하는 요청을 제한한다
	limit: {
		duration: ms('1hour'),
		max: 300,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			name: { type: 'string', optional: false, nullable: false },
			description: { type: 'string', optional: false, nullable: false },
			membersCount: { type: 'integer', optional: false, nullable: false },
			iconUrl: { ...packedChatRoomSchema.properties.iconUrl, optional: false },
			iconBlurhash: { ...packedChatRoomSchema.properties.iconBlurhash, optional: false },
			iconDecorations: { ...packedChatRoomSchema.properties.iconDecorations, optional: false },
			joinedRoomId: { type: 'string', optional: false, nullable: true, format: 'misskey:id' },
		},
	},

	errors: {
		noSuchInviteLink: chatInviteLinkApiErrors.NO_SUCH_INVITE_LINK,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		code: { type: 'string', minLength: 1, maxLength: 64 },
	},
	required: ['code'],
} as const;

/**
 * 이 서버가 발급한 초대 링크의 공개 정보. 멤버·채널·그룹장 정보는 주지 않는다.
 * joinedRoomId는 로그인한 사람이 이미 그 그룹의 그룹장·멤버일 때만 있다.
 */
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatInviteLinkService: ChatInviteLinkService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const preview = await this.chatInviteLinkService.previewForViewer(ps.code, me);
			if (preview == null) throw new ApiError(meta.errors.noSuchInviteLink);
			return preview;
		});
	}
}
