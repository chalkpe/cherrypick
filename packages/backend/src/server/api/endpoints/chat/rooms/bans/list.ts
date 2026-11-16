/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatRoomBanService } from '@/core/ChatRoomBanService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'read:chat',

	description: 'The accounts the owner removed from the room, which cannot join it again until pardoned. Only the owner can see them.',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'ChatRoomBan',
		},
	},

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: '900cae65-7a8d-443f-98f0-ea040539595d',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatRoomBanService: ChatRoomBanService,
		private chatEntityService: ChatEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'read');

			// 그룹장이 아니면 그룹장만 보는 다른 정보처럼 그룹이 없다고 답한다.
			const room = await this.chatService.findMyRoomById(me.id, ps.roomId);
			if (room == null) throw new ApiError(meta.errors.noSuchRoom);

			const bans = await this.chatRoomBanService.list(room.id, ps.limit, ps.sinceId, ps.untilId);
			return await this.chatEntityService.packRoomBans(bans, me);
		});
	}
}
