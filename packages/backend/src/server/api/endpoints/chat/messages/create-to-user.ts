/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GetterService } from '@/server/api/GetterService.js';
import { ApiError } from '@/server/api/error.js';
import { ChatMessageAccessError, ChatMessageBlockedError, ChatMessageRecipientSuspendedError, ChatService, MAX_CHAT_MESSAGE_FILES, MAX_CHAT_MESSAGE_TEXT_LENGTH } from '@/core/ChatService.js';

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
		ref: 'ChatMessageLiteFor1on1',
	},

	errors: {
		recipientIsYourself: {
			message: 'You can not send a message to yourself.',
			code: 'RECIPIENT_IS_YOURSELF',
			id: '17e2ba79-e22a-4cbc-bf91-d327643f4a7e',
		},

		noSuchUser: {
			message: 'No such user.',
			code: 'NO_SUCH_USER',
			id: '11795c64-40ea-4198-b06e-3c873ed9039d',
		},

		noSuchFile: {
			message: 'No such file.',
			code: 'NO_SUCH_FILE',
			id: '4372b8e2-185d-4146-8749-2f68864a3e5f',
		},

		tooManyFiles: {
			message: 'A message can have up to 4 files.',
			code: 'TOO_MANY_FILES',
			id: 'e577e5c3-5cae-4251-ba3c-d3a8f8e25c5f',
		},

		contentRequired: {
			message: 'Content required. You need to set text or fileId.',
			code: 'CONTENT_REQUIRED',
			id: '25587321-b0e6-449c-9239-f8925092942c',
		},

		youHaveBeenBlocked: {
			message: 'You cannot send a message because you have been blocked by this user.',
			code: 'YOU_HAVE_BEEN_BLOCKED',
			id: 'c15a5199-7422-4968-941a-2a462c478f7d',
		},

		recipientIsSuspended: {
			message: 'You cannot send a message because this user is suspended.',
			code: 'RECIPIENT_IS_SUSPENDED',
			id: 'b9febcb3-1b46-4b4a-b8ce-8d695d3bd474',
		},

		cannotChatWithUser: {
			message: 'This user does not accept your messages.',
			code: 'CANNOT_CHAT_WITH_USER',
			id: 'fcaaed42-3f5a-4246-a08d-18736819e76b',
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
		toUserId: { type: 'string', format: 'misskey:id' },
	},
	required: ['toUserId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private getterService: GetterService,
		private chatService: ChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');

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

			// Myself
			if (ps.toUserId === me.id) {
				throw new ApiError(meta.errors.recipientIsYourself);
			}

			const toUser = await this.getterService.getUser(ps.toUserId).catch(err => {
				if (err.id === '15348ddd-432d-49c2-8a5a-8069753becff') throw new ApiError(meta.errors.noSuchUser);
				throw err;
			});

			try {
				return await this.chatService.createMessageToUser(me, toUser, {
					text: ps.text,
					files,
				});
			} catch (e) {
				if (e instanceof ChatMessageBlockedError) throw new ApiError(meta.errors.youHaveBeenBlocked);
				if (e instanceof ChatMessageRecipientSuspendedError) throw new ApiError(meta.errors.recipientIsSuspended);
				if (e instanceof ChatMessageAccessError) throw new ApiError(meta.errors.cannotChatWithUser);
				throw e;
			}
		});
	}
}
