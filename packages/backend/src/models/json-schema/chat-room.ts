/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { packedUserLiteSchema } from './user.js';

export const packedChatRoomSchema = {
	type: 'object',
	properties: {
		iconId: { type: 'string', optional: true, nullable: true },
		iconUrl: { type: 'string', optional: true, nullable: false },
		iconBlurhash: { type: 'string', optional: true, nullable: true },
		iconDecorations: { ...packedUserLiteSchema.properties.avatarDecorations, optional: true },
		id: {
			type: 'string',
			optional: false, nullable: false,
		},
		createdAt: {
			type: 'string',
			format: 'date-time',
			optional: false, nullable: false,
		},
		ownerId: {
			type: 'string',
			optional: false, nullable: false,
		},
		owner: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'UserLite',
		},
		name: {
			type: 'string',
			optional: false, nullable: false,
		},
		description: {
			type: 'string',
			optional: false, nullable: false,
		},
		isMuted: {
			type: 'boolean',
			optional: true, nullable: false,
		},
		invitationExists: {
			type: 'boolean',
			optional: true, nullable: false,
		},
		notificationLevel: { type: 'string', enum: ['all', 'mentions', 'none'], optional: true, nullable: false },
		hasChannels: { type: 'boolean', optional: true, nullable: false },
		legacyChannelId: { type: 'string', optional: true, nullable: true },
		// 다른 서버가 소유한 그룹에서 과거 기록을 가져오는 상태. 그룹 하나를 조회할 때만 싣는다
		historyImportStatus: { type: 'string', enum: ['running', 'completed', 'unavailable'], optional: true, nullable: true },
		isArchived: {
			type: 'boolean',
			optional: false, nullable: false,
		},
	},
} as const;
