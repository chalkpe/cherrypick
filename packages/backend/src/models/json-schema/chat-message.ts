/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { packedChatChannelRefsSchema } from '@/core/chat-room-channels.js';
import { chatDiceResultSchema } from '@/core/chat-dice.js';

/** 계정이 없어지거나 지워진 작성자의 과거 기록용 정보. 계정이 아니므로 프로필로 연결하지 않는다. host가 null이면 이 서버의 계정이었다 */
const chatMessageArchivedAuthorSchema = {
	type: 'object',
	optional: true, nullable: true,
	properties: {
		name: { type: 'string', optional: false, nullable: true },
		username: { type: 'string', optional: false, nullable: true },
		host: { type: 'string', optional: false, nullable: true },
	},
} as const;

export const packedChatMessageSchema = {
	type: 'object',
	properties: {
		id: {
			type: 'string',
			optional: false, nullable: false,
		},
		createdAt: {
			type: 'string',
			format: 'date-time',
			optional: false, nullable: false,
		},
		editedAt: {
			type: 'string',
			format: 'date-time',
			optional: true, nullable: true,
		},
		deletedAt: {
			type: 'string',
			format: 'date-time',
			optional: true, nullable: true,
		},
		// 그룹 메시지는 작성자 계정이 없어진 뒤에도 남는다. 그때는 archivedAuthor로 글자만 보인다
		fromUserId: {
			type: 'string',
			optional: false, nullable: true,
		},
		fromUser: {
			type: 'object',
			optional: false, nullable: true,
			ref: 'UserLite',
		},
		toUserId: {
			type: 'string',
			optional: true, nullable: true,
		},
		toUser: {
			type: 'object',
			optional: true, nullable: true,
			ref: 'UserLite',
		},
		toRoomId: {
			type: 'string',
			optional: true, nullable: true,
		},
		toRoom: {
			type: 'object',
			optional: true, nullable: true,
			ref: 'ChatRoom',
		},
		toRoomChannelId: { type: 'string', optional: true, nullable: true },
		toRoomChannel: {
			type: 'object', optional: true, nullable: true,
			properties: {
				id: { type: 'string', optional: false, nullable: false },
				name: { type: 'string', optional: false, nullable: false },
			},
		},
		channelRefs: { ...packedChatChannelRefsSchema, optional: true },
		dice: { ...chatDiceResultSchema, optional: true, nullable: true },
		text: {
			type: 'string',
			optional: true, nullable: true,
		},
		fileId: {
			type: 'string',
			optional: true, nullable: true,
		},
		file: {
			type: 'object',
			optional: true, nullable: true,
			ref: 'DriveFile',
		},
		fileIds: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'string',
				optional: false, nullable: false,
			},
		},
		files: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'object',
				optional: false, nullable: false,
				ref: 'DriveFile',
			},
		},
		isRead: {
			type: 'boolean',
			optional: true, nullable: false,
		},
		archivedAuthor: chatMessageArchivedAuthorSchema,
		unavailableFileCount: { type: 'number', optional: true, nullable: false },
		reactions: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'object',
				optional: false, nullable: false,
				properties: {
					reaction: {
						type: 'string',
						optional: false, nullable: false,
					},
					user: {
						type: 'object',
						optional: false, nullable: false,
						ref: 'UserLite',
					},
				},
			},
		},
		emojis: {
			type: 'object',
			optional: true, nullable: false,
			additionalProperties: {
				type: 'string',
			},
		},
	},
} as const;

export const packedChatMessageLiteSchema = {
	type: 'object',
	properties: {
		id: {
			type: 'string',
			optional: false, nullable: false,
		},
		createdAt: {
			type: 'string',
			format: 'date-time',
			optional: false, nullable: false,
		},
		editedAt: {
			type: 'string',
			format: 'date-time',
			optional: true, nullable: true,
		},
		deletedAt: {
			type: 'string',
			format: 'date-time',
			optional: true, nullable: true,
		},
		// 그룹 메시지는 작성자 계정이 없어진 뒤에도 남는다. 그때는 archivedAuthor로 글자만 보인다
		fromUserId: {
			type: 'string',
			optional: false, nullable: true,
		},
		fromUser: {
			type: 'object',
			optional: true, nullable: true,
			ref: 'UserLite',
		},
		toUserId: {
			type: 'string',
			optional: true, nullable: true,
		},
		toRoomId: {
			type: 'string',
			optional: true, nullable: true,
		},
		toRoomChannelId: { type: 'string', optional: true, nullable: true },
		toRoomChannel: {
			type: 'object', optional: true, nullable: true,
			properties: {
				id: { type: 'string', optional: false, nullable: false },
				name: { type: 'string', optional: false, nullable: false },
			},
		},
		channelRefs: { ...packedChatChannelRefsSchema, optional: true },
		dice: { ...chatDiceResultSchema, optional: true, nullable: true },
		text: {
			type: 'string',
			optional: true, nullable: true,
		},
		fileId: {
			type: 'string',
			optional: true, nullable: true,
		},
		file: {
			type: 'object',
			optional: true, nullable: true,
			ref: 'DriveFile',
		},
		fileIds: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'string',
				optional: false, nullable: false,
			},
		},
		files: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'object',
				optional: false, nullable: false,
				ref: 'DriveFile',
			},
		},
		archivedAuthor: chatMessageArchivedAuthorSchema,
		unavailableFileCount: { type: 'number', optional: true, nullable: false },
		reactions: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'object',
				optional: false, nullable: false,
				properties: {
					reaction: {
						type: 'string',
						optional: false, nullable: false,
					},
					user: {
						type: 'object',
						optional: true, nullable: true,
						ref: 'UserLite',
					},
				},
			},
		},
		emojis: {
			type: 'object',
			optional: true, nullable: false,
			additionalProperties: {
				type: 'string',
			},
		},
	},
} as const;

export const packedChatMessageLiteFor1on1Schema = {
	type: 'object',
	properties: {
		id: {
			type: 'string',
			optional: false, nullable: false,
		},
		createdAt: {
			type: 'string',
			format: 'date-time',
			optional: false, nullable: false,
		},
		editedAt: {
			type: 'string',
			format: 'date-time',
			optional: true, nullable: true,
		},
		deletedAt: {
			type: 'string',
			format: 'date-time',
			optional: true, nullable: true,
		},
		fromUserId: {
			type: 'string',
			optional: false, nullable: false,
		},
		toUserId: {
			type: 'string',
			optional: false, nullable: false,
		},
		dice: { ...chatDiceResultSchema, optional: true, nullable: true },
		text: {
			type: 'string',
			optional: true, nullable: true,
		},
		fileId: {
			type: 'string',
			optional: true, nullable: true,
		},
		file: {
			type: 'object',
			optional: true, nullable: true,
			ref: 'DriveFile',
		},
		fileIds: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'string',
				optional: false, nullable: false,
			},
		},
		files: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'object',
				optional: false, nullable: false,
				ref: 'DriveFile',
			},
		},
		reactions: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'object',
				optional: false, nullable: false,
				properties: {
					reaction: {
						type: 'string',
						optional: false, nullable: false,
					},
				},
			},
		},
		emojis: {
			type: 'object',
			optional: true, nullable: false,
			additionalProperties: {
				type: 'string',
			},
		},
	},
} as const;

export const packedChatMessageLiteForRoomSchema = {
	type: 'object',
	properties: {
		shouldNotify: { type: 'boolean', optional: true, nullable: false },
		id: {
			type: 'string',
			optional: false, nullable: false,
		},
		createdAt: {
			type: 'string',
			format: 'date-time',
			optional: false, nullable: false,
		},
		editedAt: {
			type: 'string',
			format: 'date-time',
			optional: true, nullable: true,
		},
		deletedAt: {
			type: 'string',
			format: 'date-time',
			optional: true, nullable: true,
		},
		// 그룹 메시지는 작성자 계정이 없어진 뒤에도 남는다. 그때는 archivedAuthor로 글자만 보인다
		fromUserId: {
			type: 'string',
			optional: false, nullable: true,
		},
		fromUser: {
			type: 'object',
			optional: false, nullable: true,
			ref: 'UserLite',
		},
		toRoomId: {
			type: 'string',
			optional: false, nullable: false,
		},
		toRoomChannelId: { type: 'string', optional: true, nullable: true },
		toRoomChannel: {
			type: 'object', optional: true, nullable: true,
			properties: {
				id: { type: 'string', optional: false, nullable: false },
				name: { type: 'string', optional: false, nullable: false },
			},
		},
		channelRefs: { ...packedChatChannelRefsSchema, optional: true },
		dice: { ...chatDiceResultSchema, optional: true, nullable: true },
		text: {
			type: 'string',
			optional: true, nullable: true,
		},
		fileId: {
			type: 'string',
			optional: true, nullable: true,
		},
		file: {
			type: 'object',
			optional: true, nullable: true,
			ref: 'DriveFile',
		},
		fileIds: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'string',
				optional: false, nullable: false,
			},
		},
		files: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'object',
				optional: false, nullable: false,
				ref: 'DriveFile',
			},
		},
		archivedAuthor: chatMessageArchivedAuthorSchema,
		unavailableFileCount: { type: 'number', optional: true, nullable: false },
		reactions: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'object',
				optional: false, nullable: false,
				properties: {
					reaction: {
						type: 'string',
						optional: false, nullable: false,
					},
					user: {
						type: 'object',
						optional: false, nullable: false,
						ref: 'UserLite',
					},
				},
			},
		},
		emojis: {
			type: 'object',
			optional: true, nullable: false,
			additionalProperties: {
				type: 'string',
			},
		},
	},
} as const;
