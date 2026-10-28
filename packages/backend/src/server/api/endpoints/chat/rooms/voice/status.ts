/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import type { ChatRoomMembershipsRepository } from '@/models/_.js';
import type { MiRemoteUser } from '@/models/User.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { RemoteVoiceCallService } from '@/core/RemoteVoiceCallService.js';

export const meta = {
	tags: ['chat'],
	requireCredential: true,
	kind: 'write:chat',
	limit: { duration: 60_000, max: 30 },
	errors: {
		accessDenied: { message: 'The voice call session is unavailable.', code: 'ACCESS_DENIED', id: '3040789a-82fd-4ac3-a4fd-7d2d623dd547' },
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
		sessionId: { type: 'string', minLength: 1, maxLength: 128 },
		micMuted: { type: 'boolean' },
		deafened: { type: 'boolean' },
	},
	required: ['roomId', 'sessionId', 'micMuted', 'deafened'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatVoiceService: ChatVoiceService,
		private remoteVoiceCallService: RemoteVoiceCallService,
		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');
			const [room, member] = await Promise.all([
				this.chatService.findRoomById(ps.roomId),
				this.chatRoomMembershipsRepository.exists({ where: { roomId: ps.roomId, userId: me.id } }),
			]);
			if (room == null || room.isArchived || me.isSuspended || me.isDeleted || (room.ownerId !== me.id && !member)) throw new ApiError(meta.errors.accessDenied);
			const status = { micMuted: ps.micMuted, deafened: ps.deafened };
			if (room.owner?.host != null) {
				await this.remoteVoiceCallService.reportStatus(me, room, room.owner as MiRemoteUser, ps.sessionId, status);
			} else if (!await this.chatVoiceService.reportStatus(me, room.id, ps.sessionId, status)) {
				throw new ApiError(meta.errors.accessDenied);
			}
		});
	}
}
