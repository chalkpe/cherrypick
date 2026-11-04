/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GetterService } from '@/server/api/GetterService.js';
import { ApiError } from '@/server/api/error.js';
import { ChatMessageAccessError, ChatRoomArchivedError, ChatService, MAX_CHAT_MESSAGE_FILES, MAX_CHAT_MESSAGE_TEXT_LENGTH } from '@/core/ChatService.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	prohibitMoved: true,

	kind: 'write:chat',

	limit: {
		duration: ms('1hour'),
		max: 500,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		ref: 'ChatMessageLiteForRoom',
	},

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: '8098520d-2da5-4e8f-8ee1-df78b55a4ec6',
		},

		noSuchFile: {
			message: 'No such file.',
			code: 'NO_SUCH_FILE',
			id: 'b6accbd3-1d7b-4d9f-bdb7-eb185bac06db',
		},

		tooManyFiles: {
			message: 'A message can have up to 4 files.',
			code: 'TOO_MANY_FILES',
			id: 'c202ecbf-65fe-402a-8dd6-d257ea82cf70',
		},

		contentRequired: {
			message: 'Content required. You need to set text or fileId.',
			code: 'CONTENT_REQUIRED',
			id: '340517b7-6d04-42c0-bac1-37ee804e3594',
		},

		roomIsArchived: {
			message: 'This room is archived.',
			code: 'ROOM_IS_ARCHIVED',
			id: '5b6e1f2a-7c0d-4e39-9a41-2f8d3c6b7e10',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		text: { type: 'string', nullable: true, maxLength: MAX_CHAT_MESSAGE_TEXT_LENGTH },
		fileId: { type: 'string', format: 'misskey:id' },
		fileIds: {
			type: 'array',
			uniqueItems: true,
			minItems: 1,
			maxItems: MAX_CHAT_MESSAGE_FILES,
			items: { type: 'string', format: 'misskey:id' },
		},
		toRoomId: { type: 'string', format: 'misskey:id' },
	},
	required: ['toRoomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private getterService: GetterService,
		private chatService: ChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');

			const room = await this.chatService.findRoomById(ps.toRoomId);
			// The checks below answer differently, so an outsider must stop here or they could tell the room exists.
			if (room == null || !await this.chatService.isRoomMember(room, me.id)) {
				throw new ApiError(meta.errors.noSuchRoom);
			}

			// fileId is what clients from before there could be several still send.
			const fileIds = Array.from(new Set([...(ps.fileId != null ? [ps.fileId] : []), ...(ps.fileIds ?? [])]));
			if (fileIds.length > MAX_CHAT_MESSAGE_FILES) {
				throw new ApiError(meta.errors.tooManyFiles);
			}

			const files = await this.chatService.findOwnFilesForMessage(me.id, fileIds);
			if (files == null) {
				throw new ApiError(meta.errors.noSuchFile);
			}

			// テキストが無いかつ添付ファイルも無かったらエラー
			if (ps.text == null && files.length === 0) {
				throw new ApiError(meta.errors.contentRequired);
			}

			try {
				return await this.chatService.createMessageToRoom(me, room, {
					text: ps.text,
					files,
				});
			} catch (e) {
				if (e instanceof ChatRoomArchivedError) throw new ApiError(meta.errors.roomIsArchived);
				if (e instanceof ChatMessageAccessError) throw new ApiError(meta.errors.noSuchRoom);
				throw e;
			}
		});
	}
}
