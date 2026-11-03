/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '@/server/api/error.js';
import { ChatRoomAccessError, ChatRoomArchivedError, ChatRoomFullError, ChatRoomInvitationRefusedError, ChatService } from '@/core/ChatService.js';
import { ChatEntityService } from '@/core/entities/ChatEntityService.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	prohibitMoved: true,

	kind: 'write:chat',

	limit: {
		duration: ms('1day'),
		max: 50,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		ref: 'ChatRoomInvitation',
	},

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: '916f9507-49ba-4e90-b57f-1fd4deaa47a5',
		},
		roomIsArchived: {
			message: 'This room is archived.',
			code: 'ROOM_IS_ARCHIVED',
			id: 'b41cd32a-8b2a-4662-ae54-bc5cbb057afa',
		},
		roomIsFull: {
			message: 'This room is full.',
			code: 'ROOM_IS_FULL',
			id: '579fc80c-985c-45d1-b7f2-8022083dfa40',
		},
		yourself: {
			message: 'You cannot invite yourself.',
			code: 'CANNOT_INVITE_YOURSELF',
			id: '88605621-e640-4d2d-a96d-168b598f0c67',
		},
		noSuchUser: {
			message: 'No such user.',
			code: 'NO_SUCH_USER',
			id: '167a1ccf-d9ab-415e-941d-d08f28b2ca07',
		},
		alreadyMember: {
			message: 'That user is already a member of this room.',
			code: 'ALREADY_MEMBER',
			id: 'a10a39b2-9ecb-4c77-8827-028bc550f977',
		},
		alreadyInvited: {
			message: 'That user has already been invited to this room.',
			code: 'ALREADY_INVITED',
			id: '20ec0050-1c71-4cd9-b246-67772af61bbf',
		},
		blocked: {
			message: 'You cannot invite this user because you have been blocked by them.',
			code: 'YOU_HAVE_BEEN_BLOCKED',
			id: 'a3fc0535-5d74-4106-8b78-3f6ee467baca',
		},
		blocking: {
			message: 'You cannot invite a user you are blocking.',
			code: 'YOU_ARE_BLOCKING',
			id: '9f802721-ad05-411c-806a-e9367ab1facf',
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

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatEntityService: ChatEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');

			const room = await this.chatService.findMyRoomById(me.id, ps.roomId);
			if (room == null) {
				throw new ApiError(meta.errors.noSuchRoom);
			}
			try {
				const invitation = await this.chatService.createRoomInvitation(me.id, room.id, ps.userId);
				return await this.chatEntityService.packRoomInvitation(invitation, me);
			} catch (e) {
				if (e instanceof ChatRoomAccessError) throw new ApiError(meta.errors.noSuchRoom);
				if (e instanceof ChatRoomArchivedError) throw new ApiError(meta.errors.roomIsArchived);
				if (e instanceof ChatRoomFullError) throw new ApiError(meta.errors.roomIsFull);
				if (e instanceof ChatRoomInvitationRefusedError) throw new ApiError(meta.errors[e.reason]);
				throw e;
			}
		});
	}
}
