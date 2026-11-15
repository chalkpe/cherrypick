/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const packedChatRoomChannelSectionSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', optional: false, nullable: false },
		roomId: { type: 'string', optional: false, nullable: false },
		name: { type: 'string', optional: false, nullable: false },
	},
} as const;
