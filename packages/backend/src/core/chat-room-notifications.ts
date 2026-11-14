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
/** 일반 그룹의 두 표식이 모두 없으면 전체 목록에서 뺀다. 경계 읽음과 새 글 쓰기가 겹쳐도 원자적으로 판단한다. */
export const CHAT_UNREAD_PRUNE_ROOM = `if redis.call('GET', KEYS[1]) == false and redis.call('GET', KEYS[2]) == false then redis.call('SREM', KEYS[3], ARGV[1]) end`;
/**
 * 표식은 `순번:메시지ID`다. 생성·수정이 뒤섞여 도착해도 더 큰 순번만 남긴다(원자적 CAS).
 * 순번은 0 없는 십진수라 자리수 비교가 곧 크기 비교다. 같으면 먼저 온 표식을 유지한다.
 * 순번 없는 옛 표식은 어떤 순번 표식보다 오래된 것으로 본다.
 */
export const CHAT_UNREAD_MARK = `local marker = redis.call('GET', KEYS[1]); if marker == false then redis.call('SET', KEYS[1], ARGV[1]); return 1 end; local current = string.match(marker, '^(%d+):'); local incoming = string.match(ARGV[1], '^(%d+):'); if incoming == nil then return 0 end; if current == nil or #incoming > #current or (#incoming == #current and incoming > current) then redis.call('SET', KEYS[1], ARGV[1]); return 1 end; return 0`;
/**
 * 읽음 경계는 순번 그 자체다. 표식과 따로 남아 표식이 더 새 글로 옮겨져도 수정 알림의 읽음 판단에 쓴다.
 * 더 큰 순번만 남긴다(원자적 CAS). 순번은 0 없는 십진수라 자리수 비교가 곧 크기 비교다.
 */
export const CHAT_UNREAD_READ_BOUNDARY = `local current = redis.call('GET', KEYS[1]); if current == false then redis.call('SET', KEYS[1], ARGV[1]); return 1 end; if #ARGV[1] > #current or (#ARGV[1] == #current and ARGV[1] > current) then redis.call('SET', KEYS[1], ARGV[1]); return 1 end; return 0`;
/** 전체 읽음은 표식·채널 목록 지우기와 전체 목록 빼기를 한 번에 끝낸다. 그 사이 새 글의 표식 쓰기가 끼어들어도 원자적이다. */
export const CHAT_UNREAD_READ_ALL = `for i = 1, #KEYS - 1 do redis.call('DEL', KEYS[i]) end; return redis.call('SREM', KEYS[#KEYS], ARGV[1])`;

/** 미읽음 표식 값. 순번이 없는 글(가져온 과거 기록)은 0으로 둔다. */
export function chatUnreadMarker(sequence: string | null | undefined, messageId: string): string {
	return `${sequence ?? '0'}:${messageId}`;
}

/** 표식이 가리키는 메시지 ID. 표식이 없으면 null. */
export function chatUnreadMarkerMessageId(marker: string | null): string | null {
	if (marker == null) return null;
	const index = marker.indexOf(':');
	return index < 0 ? marker : marker.slice(index + 1);
}

/** 표식에 실린 순번. 순번 없는 옛 표식은 0으로 본다. */
export function chatUnreadMarkerSequence(marker: string): string {
	const index = marker.indexOf(':');
	return index < 0 ? '0' : marker.slice(0, index);
}

/** 두 읽음 경계 중 더 큰 쪽. 경계는 0 없는 십진수 순번이라 자리수 비교가 곧 크기 비교다. */
export function maxChatReadBoundary(a: string | null, b: string | null): string | null {
	if (a == null) return b;
	if (b == null) return a;
	return b.length > a.length || (b.length === a.length && b > a) ? b : a;
}

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
