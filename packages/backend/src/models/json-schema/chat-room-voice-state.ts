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
					micMuted: { type: 'boolean', optional: true, nullable: false },
					deafened: { type: 'boolean', optional: true, nullable: false },
					screenSharing: {
						type: 'boolean',
						optional: false, nullable: false,
					},
				},
			},
		},
		// 現況の時刻 (エポックミリ秒)。このサーバーのルームはこのサーバーの時計、他のサーバーが持つルーム (ミラー) はそのサーバーの時計。
		// 現況は届く順が前後しうるので、受け取る側はルームごとにこれが新しいものを残す
		updatedAt: {
			type: 'number',
			optional: false, nullable: false,
		},
	},
} as const;
