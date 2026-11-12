/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { domainToASCII } from 'node:url';
import * as mfm from 'mfc-js';
import { extractMentions } from '@/misc/extract-mentions.js';

export type ChatNotificationLevel = 'all' | 'mentions' | 'none';
export type ChatMentionAccount = { id: string; username: string; host: string | null };

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
