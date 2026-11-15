/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const MAX_CHAT_ROOM_CHANNELS = 128;
export const MAX_CHAT_ROOM_CHANNEL_NAME_LENGTH = 128;
// 원격 서버의 더 큰 한도를 수용하고 이름을 잘라서 저장하지 않는다.
export const MAX_REMOTE_CHAT_ROOM_CHANNELS = 1024;
export const MAX_REMOTE_CHAT_ROOM_CHANNEL_NAME_LENGTH = 4096;
// 섹션은 채널과 같은 이름·개수 규칙을 쓴다.
export const MAX_CHAT_ROOM_SECTIONS = 128;
export const MAX_REMOTE_CHAT_ROOM_SECTIONS = 1024;
// 채널·섹션 URI의 유일 색인 항목이 PostgreSQL B-tree 한도(기본 페이지에서 약 2.7KB)를 넘지 않도록 UTF-8 바이트로 묶는다.
export const MAX_CHAT_ROOM_CHANNEL_URI_BYTES = 1024;

export type ChatChannelRef = { channelId: string; start: number; length: number; uri?: string };
export type RemoteChatChannelRef = { id: string; start: number; length: number };
export type RemoteChatChannels = { channels: { id: string; name: string }[]; legacyChannel: string | null };
export type RemoteChatChannelSection = { id: string; name: string; channels: string[] };

export class ChatChannelError extends Error {
	constructor(public reason: 'NO_SUCH_ROOM' | 'NO_SUCH_CHANNEL' | 'NO_SUCH_SECTION' | 'ROOM_IS_ARCHIVED' | 'ALREADY_CONVERTED' | 'INVALID_CHANNEL_NAME' | 'INVALID_SECTION_NAME' | 'TOO_MANY_CHANNELS' | 'TOO_MANY_SECTIONS' | 'INVALID_CHANNEL_ORDER' | 'LAST_CHANNEL' | 'INVALID_CHANNEL_REFS') {
		super(reason);
	}
}

/**
 * DB에 그대로 저장할 수 있는 문자열인지. NUL은 PostgreSQL 문자열에 들어가지 못하고,
 * 짝 없는 surrogate는 UTF-8 변환에서 U+FFFD로 바뀌어 다른 값과 같아진다. maxBytes를 주면 UTF-8 길이도 묶는다.
 * 값을 고쳐 쓰지 않으므로 호출하는 쪽이 해당 필드를 버린다.
 */
export function isStorableText(value: string, maxBytes?: number): boolean {
	return !value.includes('\u0000') && value.isWellFormed() && (maxBytes == null || Buffer.byteLength(value, 'utf8') <= maxBytes);
}

export function normalizeChatChannelName(name: string): string {
	const trimmed = name.trim();
	if (!isStorableText(trimmed) || trimmed.length === 0 || Array.from(trimmed).length > MAX_CHAT_ROOM_CHANNEL_NAME_LENGTH) throw new ChatChannelError('INVALID_CHANNEL_NAME');
	return trimmed;
}

export function normalizeChatSectionName(name: string): string {
	const trimmed = name.trim();
	if (!isStorableText(trimmed) || trimmed.length === 0 || Array.from(trimmed).length > MAX_CHAT_ROOM_CHANNEL_NAME_LENGTH) throw new ChatChannelError('INVALID_SECTION_NAME');
	return trimmed;
}

export function chatChannelUri(roomUri: string, channelId: string): string {
	return `${roomUri}/channels/${channelId}`;
}

export function chatSectionUri(roomUri: string, sectionId: string): string {
	return `${roomUri}/sections/${sectionId}`;
}

function isChatSubUri(roomUri: string, value: unknown, kind: 'channels' | 'sections'): value is string {
	if (typeof value !== 'string' || value.length > 1024 || !isStorableText(value, MAX_CHAT_ROOM_CHANNEL_URI_BYTES)) return false;
	const prefix = `${roomUri}/${kind}/`;
	if (!value.startsWith(prefix)) return false;
	const suffix = value.slice(prefix.length);
	return suffix.length > 0 && !/[/?#%\\\s]/u.test(suffix);
}

export function isChatChannelUri(roomUri: string, value: unknown): value is string {
	return isChatSubUri(roomUri, value, 'channels');
}

export function isChatSectionUri(roomUri: string, value: unknown): value is string {
	return isChatSubUri(roomUri, value, 'sections');
}

export function parseChatChannels(group: { _misskey_chatChannels?: unknown; _misskey_chatLegacyChannel?: unknown }, roomUri: string): RemoteChatChannels | null {
	const channels = group._misskey_chatChannels;
	if (!Array.isArray(channels) || channels.length === 0 || channels.length > MAX_REMOTE_CHAT_ROOM_CHANNELS) return null;
	const seen = new Set<string>();
	for (const channel of channels) {
		if (channel == null || typeof channel !== 'object' || !isChatChannelUri(roomUri, channel.id) || seen.has(channel.id) ||
			typeof channel.name !== 'string' || !isStorableText(channel.name) || channel.name.trim().length === 0 || Array.from(channel.name).length > MAX_REMOTE_CHAT_ROOM_CHANNEL_NAME_LENGTH) return null;
		seen.add(channel.id);
	}
	const legacy = group._misskey_chatLegacyChannel;
	if (legacy !== null && (typeof legacy !== 'string' || !seen.has(legacy))) return null;
	return { channels: channels.map(({ id, name }) => ({ id, name })), legacyChannel: legacy };
}

/**
 * 섹션 필드가 없으면 undefined(섹션을 건드리지 않음), 하나라도 어긋나면 null(지금 섹션 유지)을 돌려준다.
 * 채널 목록 해석과 같은 규칙으로 전체를 검증한다.
 */
export function parseChatChannelSections(value: unknown, roomUri: string, channelUris: ReadonlySet<string>, onReject?: (reason: string) => void): RemoteChatChannelSection[] | null | undefined {
	if (value === undefined) return undefined;
	const reject = (reason: string) => {
		onReject?.(reason);
		return null;
	};
	if (!Array.isArray(value)) return reject('not-an-array');
	if (value.length > MAX_REMOTE_CHAT_ROOM_SECTIONS) return reject('too-many-sections');
	const seenSections = new Set<string>();
	const seenChannels = new Set<string>();
	const sections: RemoteChatChannelSection[] = [];
	for (const section of value) {
		if (section == null || typeof section !== 'object') return reject('not-an-object');
		if (!isChatSectionUri(roomUri, section.id)) return reject('foreign-section-uri');
		if (seenSections.has(section.id)) return reject('duplicate-section');
		if (typeof section.name !== 'string' || !isStorableText(section.name) || section.name.trim().length === 0 || Array.from(section.name).length > MAX_REMOTE_CHAT_ROOM_CHANNEL_NAME_LENGTH) return reject('invalid-name');
		if (!Array.isArray(section.channels)) return reject('invalid-channels');
		seenSections.add(section.id);
		for (const channelUri of section.channels) {
			if (typeof channelUri !== 'string' || !channelUris.has(channelUri)) return reject('unknown-channel');
			if (seenChannels.has(channelUri)) return reject('channel-in-two-sections');
			seenChannels.add(channelUri);
		}
		sections.push({ id: section.id, name: section.name, channels: [...section.channels] });
	}
	return sections;
}

/** 화면 순서: 섹션 없는 채널들(입력 순서) → 섹션 순서대로 각 섹션의 채널들(입력 순서). */
export function chatChannelDisplayOrder<T extends { id: string; sectionId: string | null }>(channels: T[], sectionOrder: string[]): T[] {
	const grouped = new Map<string, T[]>();
	for (const channel of channels) {
		if (channel.sectionId == null) continue;
		const list = grouped.get(channel.sectionId);
		if (list != null) list.push(channel);
		else grouped.set(channel.sectionId, [channel]);
	}
	return [...channels.filter(channel => channel.sectionId == null), ...sectionOrder.flatMap(id => grouped.get(id) ?? [])];
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
