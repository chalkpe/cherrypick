/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ms from 'ms';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { UsersRepository } from '@/models/_.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { ChatService } from '@/core/ChatService.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:chat',

	limit: {
		duration: ms('1minute'),
		max: 30,
	},

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: '443c708f-1a6d-47a2-8b42-32f61a27e55f',
		},
		noSuchUser: {
			message: 'No such user.',
			code: 'NO_SUCH_USER',
			id: '7e9abd6f-d009-44e9-979b-7dde0326ec30',
		},
		accessDenied: {
			message: 'Only the room owner can do this.',
			code: 'ACCESS_DENIED',
			id: '44aea3f8-61c7-438b-ba60-182024e074ec',
		},
		voiceCallUnavailable: {
			message: 'Voice calls are not available.',
			code: 'VOICE_CALL_UNAVAILABLE',
			id: '1ae71d25-3167-47d2-83a3-d2a41e0b80c6',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
		userId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId', 'userId'],
} as const;

// ルームのオーナーが通話参加者のマイクをミュートする。本人は再びミュートを解除できる
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private chatService: ChatService,
		private liveKitService: LiveKitService,
		private chatVoiceService: ChatVoiceService,
	) {
		super(meta, paramDef, async (ps, me) => {
			if (!this.liveKitService.isEnabled) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			await this.chatService.checkChatAvailability(me.id, 'write');

			const room = await this.chatService.findRoomById(ps.roomId);
			if (room == null) {
				throw new ApiError(meta.errors.noSuchRoom);
			}
			if (room.ownerId !== me.id) {
				throw new ApiError(meta.errors.accessDenied);
			}

			const user = await this.usersRepository.findOneBy({ id: ps.userId });
			if (user == null) {
				throw new ApiError(meta.errors.noSuchUser);
			}

			await this.liveKitService.muteMicrophone(room.id, this.liveKitService.identityOf(user));
			await this.chatVoiceService.refresh(room.id);
		});
	}
}
