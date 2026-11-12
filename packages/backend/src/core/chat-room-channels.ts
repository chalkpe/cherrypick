/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const MAX_CHAT_ROOM_CHANNELS = 128;
export const MAX_CHAT_ROOM_CHANNEL_NAME_LENGTH = 128;
// 원격 서버의 더 큰 한도를 수용하고 이름을 잘라서 저장하지 않는다.
export const MAX_REMOTE_CHAT_ROOM_CHANNELS = 1024;
export const MAX_REMOTE_CHAT_ROOM_CHANNEL_NAME_LENGTH = 4096;

export type ChatChannelRef = { channelId: string; start: number; length: number; uri?: string };
export type RemoteChatChannelRef = { id: string; start: number; length: number };
export type RemoteChatChannels = { channels: { id: string; name: string }[]; legacyChannel: string | null };

export class ChatChannelError extends Error {
	constructor(public reason: 'NO_SUCH_ROOM' | 'NO_SUCH_CHANNEL' | 'ROOM_IS_ARCHIVED' | 'ALREADY_CONVERTED' | 'INVALID_CHANNEL_NAME' | 'TOO_MANY_CHANNELS' | 'INVALID_CHANNEL_ORDER' | 'LAST_CHANNEL' | 'INVALID_CHANNEL_REFS') {
		super(reason);
	}
}

export function normalizeChatChannelName(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0 || Array.from(trimmed).length > MAX_CHAT_ROOM_CHANNEL_NAME_LENGTH) throw new ChatChannelError('INVALID_CHANNEL_NAME');
	return trimmed;
}

export function chatChannelUri(roomUri: string, channelId: string): string {
	return `${roomUri}/channels/${channelId}`;
}

export function isChatChannelUri(roomUri: string, value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 1024) return false;
	const prefix = `${roomUri}/channels/`;
	if (!value.startsWith(prefix)) return false;
	const suffix = value.slice(prefix.length);
	return suffix.length > 0 && !/[/?#%\\\s]/u.test(suffix);
}

export function parseChatChannels(group: { _misskey_chatChannels?: unknown; _misskey_chatLegacyChannel?: unknown }, roomUri: string): RemoteChatChannels | null {
	const channels = group._misskey_chatChannels;
	if (!Array.isArray(channels) || channels.length === 0 || channels.length > MAX_REMOTE_CHAT_ROOM_CHANNELS) return null;
	const seen = new Set<string>();
	for (const channel of channels) {
		if (channel == null || typeof channel !== 'object' || !isChatChannelUri(roomUri, channel.id) || seen.has(channel.id) ||
			typeof channel.name !== 'string' || channel.name.trim().length === 0 || Array.from(channel.name).length > MAX_REMOTE_CHAT_ROOM_CHANNEL_NAME_LENGTH) return null;
		seen.add(channel.id);
	}
	const legacy = group._misskey_chatLegacyChannel;
	if (legacy !== null && (typeof legacy !== 'string' || !seen.has(legacy))) return null;
	return { channels: channels.map(({ id, name }) => ({ id, name })), legacyChannel: legacy };
}

export function validChatChannelRefRanges(refs: readonly { start: number; length: number }[], text: string): boolean {
	let end = 0;
	for (const ref of refs) {
		if (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.length) || ref.start < end || ref.length < 2 ||
			ref.start + ref.length > text.length || text[ref.start] !== '#') return false;
		end = ref.start + ref.length;
	}
	return true;
}

export const chatChannelRefsParam = {
	type: 'array',
	items: {
		type: 'object',
		properties: {
			channelId: { type: 'string', format: 'misskey:id' },
			start: { type: 'integer', minimum: 0 },
			length: { type: 'integer', minimum: 2 },
		},
		required: ['channelId', 'start', 'length'],
	},
} as const;

export const packedChatChannelRefsSchema = {
	type: 'array', optional: false, nullable: false,
	items: {
		type: 'object', optional: false, nullable: false,
		properties: {
			channelId: { type: 'string', optional: false, nullable: false },
			start: { type: 'number', optional: false, nullable: false },
			length: { type: 'number', optional: false, nullable: false },
		},
	},
} as const;
