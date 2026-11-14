/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { toArray } from '@/misc/prelude/array.js';
import { getApType, getOneApId } from '../type.js';
import { parseRemoteChatDate } from './chat-remote-date.js';
import type { IObject, IPost } from '../type.js';

/** 소유 서버가 한 페이지에 싣는 글 수. 전체 기록의 상한이 아니라 한 응답의 크기를 묶는 값이다. */
export const CHAT_HISTORY_PAGE_SIZE = 20;
/** 받는 쪽이 한 페이지에서 받아들이는 글 수. 소유 서버가 더 큰 페이지를 써도 한 응답의 처리량은 이 안으로 묶는다. */
export const MAX_CHAT_HISTORY_PAGE_ITEMS = 100;
/** 메시지 하나의 리액션 목록 길이. 소유 서버의 한도(100)보다 넉넉하게 받되 이보다 길면 목록 전체를 버린다. */
export const MAX_CHAT_HISTORY_REACTIONS = 1000;

const CURSOR_PATTERN = /^[0-9A-Za-z]{1,32}$/;
// 메시지 URI 칸의 길이. 실시간 수신과 같다.
const MAX_MESSAGE_URI_LENGTH = 512;
const MAX_MESSAGE_TEXT_LENGTH = 4096;
const MAX_ACTOR_URI_LENGTH = 2048;
// 보류 리액션과 같은 길이 제한
const MAX_REACTION_LENGTH = 256;
const MAX_AUTHOR_NAME_LENGTH = 512;
const MAX_AUTHOR_USERNAME_LENGTH = 128;

/** 과거 기록용 작성자 정보. 계정이 아니라 소유 서버가 보관한 이름과 계정 주소이다. */
export type ChatHistoryAuthor = {
	name: string | null;
	username: string | null;
	host: string;
};

export type ChatHistoryReaction = {
	actor: string;
	reaction: string;
	tag?: IObject;
};

export type ChatHistoryPage = {
	items: unknown[];
	next: string | null;
};

export type ChatHistoryItem = {
	uri: string;
	authorUri: string;
	published: Date;
	editedAt: Date | null;
	text: string | null;
	note: IPost;
	author: ChatHistoryAuthor | null;
	reactions: ChatHistoryReaction[];
};

export type ChatHistoryItemContext = {
	roomUri: string;
	now: number;
	/** 표준 파서로 읽은 소문자 호스트. 주소가 아니면 null */
	hostOf: (uri: string) => string | null;
	/** 받는 서버 자신의 호스트인지 */
	isLocalHost: (host: string) => boolean;
	/** 이 시각으로 메시지 ID를 만들 수 있는지 */
	isSafeTime: (time: number) => boolean;
	/** 실시간 수신과 같은 본문 추출 */
	text: (note: IPost) => string | null;
};

export function chatHistoryUri(roomUri: string): string {
	return `${roomUri}/history`;
}

/** 보관 사본의 로컬 URI. 원래 URI를 선점하지 않도록 이 서버의 그룹과 원본 주소로 만든다. */
export function chatHistoryCopyUri(localUrl: string, roomId: string, sourceUri: string): string {
	return `${localUrl}/chat/history/${createHash('sha256').update(`${roomId}\n${sourceUri}`).digest('hex').slice(0, 32)}`;
}

export function chatHistoryPageUri(roomUri: string, until: string | null): string {
	return until == null ? chatHistoryUri(roomUri) : `${chatHistoryUri(roomUri)}?until=${until}`;
}

export function isChatHistoryCursor(value: unknown): value is string {
	return typeof value === 'string' && CURSOR_PATTERN.test(value);
}

/** 소유 서버의 응답. id는 요청 주소와 정확히 같아야 받는 쪽의 조회 검증을 통과한다. */
export function buildChatHistoryPage(roomUri: string, until: string | null, items: IObject[], nextUntil: string | null): IObject {
	return {
		id: chatHistoryPageUri(roomUri, until),
		type: 'OrderedCollectionPage',
		partOf: chatHistoryUri(roomUri),
		orderedItems: items,
		...(nextUntil != null ? { next: chatHistoryPageUri(roomUri, nextUntil) } : {}),
	} as IObject;
}

export function chatHistoryNoteFields(author: ChatHistoryAuthor | null, reactions: ChatHistoryReaction[], archived = false): Pick<IObject, '_misskey_chatAuthor' | '_misskey_chatAuthorArchived' | '_misskey_chatReactions'> {
	return {
		...(author != null ? { _misskey_chatAuthor: author } : {}),
		...(archived ? { _misskey_chatAuthorArchived: true } : {}),
		_misskey_chatReactions: reactions,
	};
}

/** 다음 페이지 주소에서 커서를 읽는다. 같은 그룹의 history가 아니면 null */
function cursorOf(roomUri: string, uri: unknown): string | null {
	if (typeof uri !== 'string') return null;
	const prefix = `${chatHistoryUri(roomUri)}?until=`;
	if (!uri.startsWith(prefix)) return null;
	const cursor = uri.slice(prefix.length);
	return isChatHistoryCursor(cursor) ? cursor : null;
}

/** 그룹 URI의 호스트에서 서명 조회로 받은 응답을 검사한다. 어긋나면 그 응답 전체를 쓰지 않는다. */
export function parseChatHistoryPage(page: unknown, roomUri: string, requestedUri: string): ChatHistoryPage | null {
	if (page == null || typeof page !== 'object') return null;
	const object = page as IObject & { partOf?: unknown; orderedItems?: unknown; next?: unknown };
	if (getApType(object) !== 'OrderedCollectionPage') return null;
	if (object.id !== requestedUri || object.partOf !== chatHistoryUri(roomUri)) return null;
	if (!Array.isArray(object.orderedItems) || object.orderedItems.length > MAX_CHAT_HISTORY_PAGE_ITEMS) return null;

	let next: string | null = null;
	if (object.next != null) {
		const nextCursor = cursorOf(roomUri, object.next);
		const currentCursor = cursorOf(roomUri, requestedUri);
		// 소유 서버의 메시지 ID를 커서로 쓰므로 다음 페이지는 반드시 더 오래된 ID로 진행한다.
		// 전체 기록의 개수는 제한하지 않으면서 같은 페이지를 순환하는 응답은 막는다.
		if (nextCursor == null || (currentCursor != null && nextCursor >= currentCursor)) return null;
		next = object.next as string;
	}

	return { items: object.orderedItems, next };
}

export function roomUriOf(note: IPost): string | null {
	const values = [note._misskey_chatRoom, ...toArray(note.context)].filter(value => value != null);
	const roomUri = values[0];
	// 두 표현이 서로 다른 그룹을 가리키면 어느 하나를 우선해서 받아들이지 않는다.
	return typeof roomUri === 'string' && values.every(value => value === roomUri) ? roomUri : null;
}

function parseAuthor(value: unknown, authorHost: string, ctx: ChatHistoryItemContext): ChatHistoryAuthor | null {
	if (value == null || typeof value !== 'object') return null;
	const { name, username, host } = value as { name?: unknown; username?: unknown; host?: unknown };
	if (typeof host !== 'string' || host.toLowerCase() !== authorHost || ctx.isLocalHost(authorHost)) return null;
	if (name != null && (typeof name !== 'string' || Array.from(name).length > MAX_AUTHOR_NAME_LENGTH)) return null;
	if (username != null && (typeof username !== 'string' || username.length === 0 || username.length > MAX_AUTHOR_USERNAME_LENGTH || /[\s@]/u.test(username))) return null;
	return { name: name ?? null, username: username ?? null, host: authorHost };
}

function parseReactions(value: unknown, ctx: ChatHistoryItemContext): ChatHistoryReaction[] {
	if (!Array.isArray(value) || value.length > MAX_CHAT_HISTORY_REACTIONS) return [];
	const reactions: ChatHistoryReaction[] = [];
	for (const entry of value) {
		if (entry == null || typeof entry !== 'object') continue;
		const { actor, reaction, tag } = entry as { actor?: unknown; reaction?: unknown; tag?: unknown };
		if (typeof actor !== 'string' || actor.length > MAX_ACTOR_URI_LENGTH) continue;
		if (typeof reaction !== 'string' || reaction.length === 0 || reaction.length > MAX_REACTION_LENGTH) continue;
		const host = ctx.hostOf(actor);
		// 받는 서버의 사용자는 자기 리액션을 원본으로 갖고 있다. 다른 서버가 대신 말할 수 없다.
		if (host == null || ctx.isLocalHost(host)) continue;
		reactions.push({ actor, reaction, ...(tag != null && typeof tag === 'object' && !Array.isArray(tag) ? { tag: tag as IObject } : {}) });
	}
	return reactions;
}

/** 페이지의 글 하나를 검사한다. 어긋나면 그 글만 버리고 이유를 돌려준다. */
export function parseChatHistoryItem(value: unknown, ctx: ChatHistoryItemContext): ChatHistoryItem | { skip: string } {
	if (value == null || typeof value !== 'object') return { skip: 'not an object' };
	const note = value as IPost;
	if (getApType(note) !== 'Note' || note._misskey_talk !== true) return { skip: 'not a chat message' };
	if (typeof note.id !== 'string' || note.id.length > 1024 || Array.from(note.id).length > MAX_MESSAGE_URI_LENGTH) return { skip: 'invalid id' };
	if (roomUriOf(note) !== ctx.roomUri) return { skip: 'another room' };

	const host = ctx.hostOf(note.id);
	if (host == null) return { skip: 'invalid id' };
	if (ctx.isLocalHost(host)) return { skip: 'message of this server' };

	let authorUri: string;
	try {
		if (note.attributedTo == null) return { skip: 'no author' };
		authorUri = getOneApId(note.attributedTo);
	} catch {
		return { skip: 'no author' };
	}
	if (ctx.hostOf(authorUri) !== host) return { skip: 'author is on another server' };

	const published = parseRemoteChatDate(note.published, ctx.now);
	if (published == null || !ctx.isSafeTime(published.getTime())) return { skip: 'invalid published' };

	const text = ctx.text(note);
	if (text != null && Array.from(text.trim()).length > MAX_MESSAGE_TEXT_LENGTH) return { skip: 'too long' };

	return {
		uri: note.id,
		authorUri,
		published,
		editedAt: parseRemoteChatDate(note.updated, ctx.now),
		text,
		note: { ...note, attachment: toArray(note.attachment) },
		author: parseAuthor(note._misskey_chatAuthor, host, ctx),
		reactions: parseReactions(note._misskey_chatReactions, ctx),
	};
}
