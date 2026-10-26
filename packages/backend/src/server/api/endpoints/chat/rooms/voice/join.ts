/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ms from 'ms';
import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { RoleService } from '@/core/RoleService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:chat',

	limit: {
		duration: ms('1minute'),
		max: 30,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			url: {
				type: 'string',
				optional: false, nullable: false,
			},
			token: {
				type: 'string',
				optional: false, nullable: false,
			},
		},
	},

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: 'ddc7cfd6-56be-41b2-83c6-22ce4e45b52a',
		},
		voiceCallUnavailable: {
			message: 'Voice calls are not available.',
			code: 'VOICE_CALL_UNAVAILABLE',
			id: '6467d072-503a-4ed0-b3ed-36c10637d298',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatVoiceService: ChatVoiceService,
		private liveKitService: LiveKitService,
		private roleService: RoleService,
	) {
		super(meta, paramDef, async (ps, me) => {
			if (!this.liveKitService.isEnabled) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			// 参加すると話せるので、チャットの書き込み権限を要求する
			await this.chatService.checkChatAvailability(me.id, 'write');

			const room = await this.chatService.findRoomById(ps.roomId);
			if (room == null || !(await this.chatService.isRoomMember(room, me.id))) {
				throw new ApiError(meta.errors.noSuchRoom);
			}

			// 他のサーバーが持つルームの通話はそのサーバーで開く (連合対応までは参加させない)
			if (room.isArchived || room.owner?.host != null) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			const policies = await this.roleService.getUserPolicies(me.id);
			if (!policies.canVoiceCall) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			return await this.chatVoiceService.issueJoinToken(me, room, policies.canScreenShare);
		});
	}
}
