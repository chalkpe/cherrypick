/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const chatChannelApiErrors = {
	NO_SUCH_ROOM: { message: 'No such room.', code: 'NO_SUCH_ROOM', id: 'ef41ee7c-5e74-48a0-8126-177a2afec201' },
	NO_SUCH_CHANNEL: { message: 'No such channel.', code: 'NO_SUCH_CHANNEL', id: 'ea728d98-6b11-494d-887e-fae0abeec404' },
	ROOM_IS_ARCHIVED: { message: 'This room is archived.', code: 'ROOM_IS_ARCHIVED', id: 'e8f14ab5-aea8-499f-b0ea-cbd7761a7fde' },
	ALREADY_CONVERTED: { message: 'This room already has channels.', code: 'ALREADY_CONVERTED', id: '44c463cc-8b95-4a9d-bb47-ba652f99bf3d' },
	INVALID_CHANNEL_NAME: { message: 'The channel name must contain 1 to 128 characters.', code: 'INVALID_CHANNEL_NAME', id: 'f0f229a6-501f-4fb1-b184-26546cd744da' },
	TOO_MANY_CHANNELS: { message: 'A room can have up to 128 channels.', code: 'TOO_MANY_CHANNELS', id: '35221886-c272-49dd-9719-6be1be204aa6' },
	INVALID_CHANNEL_ORDER: { message: 'The order must contain every channel exactly once.', code: 'INVALID_CHANNEL_ORDER', id: 'cc082514-3667-4609-9138-ef1212789812' },
	LAST_CHANNEL: { message: 'The last channel cannot be deleted.', code: 'LAST_CHANNEL', id: '0011f787-3292-49a5-a3ce-1e84969507f0' },
	INVALID_CHANNEL_REFS: { message: 'Invalid channel references.', code: 'INVALID_CHANNEL_REFS', id: '909567a1-514a-4465-88e2-c78201e3d831' },
} as const;
