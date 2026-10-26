/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { ChatRoomMembershipsRepository, ChatRoomsRepository } from '@/models/_.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { RemoteVoiceCallService } from '@/core/RemoteVoiceCallService.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'read:chat',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'ChatRoomVoiceState',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomIds: {
			type: 'array',
			minItems: 1,
			maxItems: 100,
			uniqueItems: true,
			items: { type: 'string', format: 'misskey:id' },
		},
	},
	required: ['roomIds'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		private chatService: ChatService,
		private chatVoiceService: ChatVoiceService,
		private liveKitService: LiveKitService,
		private remoteVoiceCallService: RemoteVoiceCallService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// 他のサーバーが持つルーム (ミラー) の現況は、このサーバーに LiveKit が無くても保存される
			if (!this.liveKitService.isEnabled && !this.remoteVoiceCallService.isEnabled) return [];

			await this.chatService.checkChatAvailability(me.id, 'read');

			// 参加していないルームは黙って除外する
			const [ownedRooms, memberships] = await Promise.all([
				this.chatRoomsRepository.findBy({ id: In(ps.roomIds), ownerId: me.id }),
				this.chatRoomMembershipsRepository.findBy({ roomId: In(ps.roomIds), userId: me.id }),
			]);
			const accessible = new Set([...ownedRooms.map(room => room.id), ...memberships.map(membership => membership.roomId)]);

			return await this.chatVoiceService.getStates(me, ps.roomIds.filter(roomId => accessible.has(roomId)));
		});
	}
}
