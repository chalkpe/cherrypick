/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const packedChatRoomVoiceStateSchema = {
	type: 'object',
	properties: {
		roomId: {
			type: 'string',
			format: 'id',
			optional: false, nullable: false,
		},
		participants: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'object',
				optional: false, nullable: false,
				properties: {
					identity: {
						type: 'string',
						optional: false, nullable: false,
					},
					user: {
						type: 'object',
						optional: false, nullable: false,
						ref: 'UserLite',
					},
					screenSharing: {
						type: 'boolean',
						optional: false, nullable: false,
					},
				},
			},
		},
	},
} as const;
