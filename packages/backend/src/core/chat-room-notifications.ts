/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { domainToASCII } from 'node:url';
import * as mfm from 'mfc-js';
import { extractMentions } from '@/misc/extract-mentions.js';

export type ChatNotificationLevel = 'all' | 'mentions' | 'none';
export type ChatMentionAccount = { id: string; username: string; host: string | null };

/** 읽음 경계 확인 후 표식이 그대로일 때만 지운다. 그 사이 새 글이 표식을 바꾸었으면 지우지 않는다. */
export const CHAT_UNREAD_GUARDED_DEL = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
/** 채널 표식이 모두 없으면 목록에서 뺀다. 마지막 채널이면 그룹 표식과 전체 목록 항목도 지운다. */
export const CHAT_UNREAD_PRUNE_CHANNEL = `if redis.call('GET', KEYS[2]) == false and redis.call('GET', KEYS[3]) == false then redis.call('SREM', KEYS[1], ARGV[1]); if redis.call('SCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[4], KEYS[5]); redis.call('SREM', KEYS[6], ARGV[2]); end end`;

export function effectiveChatNotificationLevel(group: ChatNotificationLevel, channel?: ChatNotificationLevel | null): ChatNotificationLevel {
	return group === 'none' ? 'none' : channel ?? group;
}

export function chatMentionedUserIds(text: string, author: Pick<ChatMentionAccount, 'id' | 'host'>, members: ChatMentionAccount[], localHost: string): string[] {
	const normalizeHost = (host: string | null) => {
		if (host == null) return null;
		const normalized = domainToASCII(host.toLowerCase());
		return normalized === domainToASCII(localHost.toLowerCase()) ? null : normalized;
	};
	const ids = new Set<string>();
	for (const mention of extractMentions(mfm.parse(text))) {
		const host = normalizeHost(mention.host ?? author.host);
		const member = members.find(candidate => candidate.username.toLowerCase() === mention.username.toLowerCase() && normalizeHost(candidate.host) === host);
		if (member != null && member.id !== author.id) ids.add(member.id);
	}
	return [...ids];
}

export function newlyMentionedUserIds(mentioned: string[], previous: string[]): string[] {
	const seen = new Set(previous);
	return [...new Set(mentioned)].filter(id => !seen.has(id));
}
