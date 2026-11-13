/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { ChatJoinRefusal } from '@/core/chat-invite-link.js';

export const chatInviteLinkApiErrors = {
	NO_SUCH_ROOM: { message: 'No such room.', code: 'NO_SUCH_ROOM', id: '41e11276-522c-4bfe-a50d-dce942b1118d' },
	ROOM_IS_ARCHIVED: { message: 'This room is archived.', code: 'ROOM_IS_ARCHIVED', id: 'ca0d68b7-046d-406f-abd7-67b43e0eb5e5' },
	INVITE_LINK_ALREADY_EXISTS: { message: 'This room already has an invite link. Revoke it first.', code: 'INVITE_LINK_ALREADY_EXISTS', id: '82dabf24-e5c8-4c54-8fa6-bb9f68e34d24' },
	NO_SUCH_INVITE_LINK: { message: 'No such invite link.', code: 'NO_SUCH_INVITE_LINK', id: 'b35e78ee-ead2-4291-9ce7-93aee4387d95' },
	INVALID_INVITE_LINK: { message: 'This is not an invite link.', code: 'INVALID_INVITE_LINK', id: '7aa4ddfb-20ef-42e3-ac4a-8009ac31bfed' },
	BANNED_FROM_ROOM: { message: 'The owner of this room removed you from it.', code: 'BANNED_FROM_ROOM', id: '6383a4c6-7c6e-4ad3-a8ad-bcf8cb3aa465' },
	BLOCKED_BY_ROOM_OWNER: { message: 'The owner of this room has blocked you.', code: 'BLOCKED_BY_ROOM_OWNER', id: 'd39013ea-91a5-404b-ba80-12ff56c5d204' },
	ROOM_IS_FULL: { message: 'This room is full.', code: 'ROOM_IS_FULL', id: '52e5d516-157e-42d3-b991-6be944f22712' },
	REMOTE_JOIN_UNAVAILABLE: { message: 'The server of this invite link cannot be asked to let you join.', code: 'REMOTE_JOIN_UNAVAILABLE', id: '1f941e60-0392-4df0-a749-b0599c2ecda4' },
} as const;

/** 참여 거절 사유와 API 오류. 다른 서버의 거절 사유(_misskey_chatJoinRefusal)와 같은 값이다 */
export const chatJoinRefusalApiErrors = {
	revoked: chatInviteLinkApiErrors.NO_SUCH_INVITE_LINK,
	archived: chatInviteLinkApiErrors.ROOM_IS_ARCHIVED,
	banned: chatInviteLinkApiErrors.BANNED_FROM_ROOM,
	blocked: chatInviteLinkApiErrors.BLOCKED_BY_ROOM_OWNER,
	full: chatInviteLinkApiErrors.ROOM_IS_FULL,
} as const satisfies Record<ChatJoinRefusal, unknown>;

export const chatRoomInviteLinkSchema = {
	type: 'object',
	optional: false, nullable: false,
	properties: {
		url: { type: 'string', optional: false, nullable: false, format: 'url' },
		code: { type: 'string', optional: false, nullable: false },
		createdAt: { type: 'string', optional: false, nullable: false, format: 'date-time' },
	},
} as const;
