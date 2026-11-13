/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { secureRndstr } from '@/misc/secure-rndstr.js';
import { truncate } from '@/misc/truncate.js';
import type { IObject, IReject } from '@/core/activitypub/type.js';

/** 그룹 서버가 링크 참여에 답해 보낸 초대를 찾는다. */
export function chatInviteJoinInvitationKey(roomId: string, userId: string): string {
	return `chatInviteJoinInvitation:${roomId}:${userId}`;
}

/** 발급하는 코드의 길이. 같은 비밀 등급인 네이티브 토큰(secureRndstr(16))과 같다 */
export const CHAT_INVITE_CODE_LENGTH = 16;

/** 다른 서버가 발급한 코드는 넉넉하게 받는다. 저장 컬럼은 64자 */
const INVITE_CODE = /^[0-9A-Za-z]{8,64}$/;
const INVITE_PATH = /^\/chat\/invite\/([0-9A-Za-z]{8,64})$/;
const ROOM_PATH = /^\/chat\/rooms\/[0-9A-Za-z]+$/;
const MAX_INVITE_URL_LENGTH = 2048;

export const CHAT_JOIN_REFUSALS = ['revoked', 'archived', 'banned', 'blocked', 'full'] as const;
export type ChatJoinRefusal = typeof CHAT_JOIN_REFUSALS[number];
/** 사유를 싣지 않은 거절. 이 필드를 모르는 구현이 보낸 것 */
export type ChatJoinRefusalReceived = ChatJoinRefusal | 'unknown';

/** 이 서버가 받아 주는 코드 형식인가 */
export function isChatInviteCode(value: unknown): value is string {
	return typeof value === 'string' && INVITE_CODE.test(value);
}

export function generateChatInviteCode(): string {
	return secureRndstr(CHAT_INVITE_CODE_LENGTH);
}

export function chatInviteUrl(baseUrl: string, code: string): string {
	return `${baseUrl}/chat/invite/${code}`;
}

export type ParsedChatInviteUrl = {
	/** 정규화한 주소. Join의 object와 거절의 대조에 이 값을 쓴다 */
	url: string;
	host: string;
	code: string;
};

/**
 * 초대 주소인지 본다. 쿼리·fragment·자격 정보가 붙었거나 경로가 다르면 일반 링크다.
 * http는 개발 환경의 시험 서버를 위해서만 호출하는 쪽이 허용한다.
 */
export function parseChatInviteUrl(value: unknown, options: { allowHttp?: boolean } = {}): ParsedChatInviteUrl | null {
	if (typeof value !== 'string' || value.length > MAX_INVITE_URL_LENGTH) return null;

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}

	if (url.protocol !== 'https:' && !(options.allowHttp === true && url.protocol === 'http:')) return null;
	if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')) return null;

	const match = INVITE_PATH.exec(url.pathname);
	if (match == null) return null;

	return { url: chatInviteUrl(url.origin, match[1]), host: url.host, code: match[1] };
}

type PreviewRoom = {
	id: string;
	name: string;
	description: string | null;
	isArchived: boolean;
};

/**
 * 서버 간 미리보기 문서. 그룹 URI·보관 여부·받은편지함은 규약에 필요한 값이다.
 * 멤버·채널·그룹장은 싣지 않는다.
 */
export type ChatInvitePreviewDocument = IObject & {
	id: string;
	type: 'Invite';
	object: IObject & {
		id: string;
		type: 'Group';
		name: string;
		summary: string;
		_misskey_chatArchived: boolean;
		_misskey_chatRoomMembersCount: number;
	};
	endpoints: { sharedInbox: string };
};

export function renderChatInvitePreview(params: { baseUrl: string; code: string; room: PreviewRoom; membersCount: number; icon?: { url: string; decorations: unknown[] } }): ChatInvitePreviewDocument {
	const { baseUrl, code, room, membersCount } = params;
	return {
		id: chatInviteUrl(baseUrl, code),
		type: 'Invite',
		object: {
			id: `${baseUrl}/chat/rooms/${room.id}`,
			type: 'Group',
			name: room.name,
			summary: room.description ?? '',
			_misskey_chatArchived: room.isArchived,
			_misskey_chatRoomMembersCount: membersCount,
			...(params.icon != null ? { icon: { type: 'Image', url: params.icon.url }, _misskey_chatIconDecorations: params.icon.decorations } : {}),
		},
		endpoints: { sharedInbox: `${baseUrl}/inbox` },
	};
}

export type ChatInvitePreview = {
	url: string;
	roomUri: string;
	sharedInbox: string;
	name: string;
	description: string;
	membersCount: number;
	isArchived: boolean;
	iconUrl: string | null;
	iconDecorations: unknown;
};

/** 같은 호스트의 https 주소인가. 요청을 보낼 곳과 확인한 곳을 같게 한다 */
function isSameSecureHost(value: unknown, host: string, path?: RegExp): value is string {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.host === host && url.username === '' && url.password === '' && url.search === '' && url.hash === '' && (path == null || path.test(url.pathname));
	} catch {
		return false;
	}
}

/**
 * 다른 서버에서 받은 미리보기 문서를 검증한다. 어긋나면 null이고 호출하는 쪽은 일반 링크로 다룬다.
 * `requestedUrl`은 parseChatInviteUrl로 정규화한 주소여야 한다.
 */
export function parseChatInvitePreview(doc: unknown, requestedUrl: string): ChatInvitePreview | null {
	if (typeof doc !== 'object' || doc == null) return null;
	const { id, type, object, endpoints } = doc as Record<string, unknown>;
	if (id !== requestedUrl || type !== 'Invite') return null;

	const host = new URL(requestedUrl).host;
	if (typeof object !== 'object' || object == null) return null;
	const group = object as Record<string, unknown>;
	if (group.type !== 'Group' || !isSameSecureHost(group.id, host, ROOM_PATH)) return null;
	if (typeof group.name !== 'string') return null;

	const membersCount = group._misskey_chatRoomMembersCount;
	if (typeof membersCount !== 'number' || !Number.isSafeInteger(membersCount) || membersCount < 1) return null;

	const sharedInbox = typeof endpoints === 'object' && endpoints != null ? (endpoints as Record<string, unknown>).sharedInbox : undefined;
	if (!isSameSecureHost(sharedInbox, host)) return null;
	const icon = typeof group.icon === 'object' && group.icon != null ? group.icon as Record<string, unknown> : null;
	let iconUrl: string | null = null;
	if (typeof icon?.url === 'string' && icon.url.length <= 4096) {
		try {
			const url = new URL(icon.url);
			if (url.protocol === 'https:' && url.username === '' && url.password === '') iconUrl = url.href;
		} catch { /* 잘못된 아이콘은 기존 그룹 도트 이미지로 표시한다. */ }
	}

	return {
		url: requestedUrl,
		roomUri: group.id,
		sharedInbox,
		name: truncate(group.name, 256),
		description: typeof group.summary === 'string' ? truncate(group.summary, 2048) : '',
		membersCount,
		isArchived: group._misskey_chatArchived === true,
		iconUrl,
		iconDecorations: group._misskey_chatIconDecorations ?? [],
	};
}

export type ChatJoin = {
	id: string;
	type: 'Join';
	actor: string;
	object: string;
	published: string;
};

/** 참여 권한은 object의 초대 주소(코드) 하나다. 별도 비밀값은 없다 */
export function renderChatJoin(params: { id: string; actor: string; inviteUrl: string; published: string }): ChatJoin {
	return {
		id: params.id,
		type: 'Join',
		actor: params.actor,
		object: params.inviteUrl,
		published: params.published,
	};
}

/** 그룹 서버의 대표 계정이 서명한다. 폐기된 링크처럼 그룹을 특정할 수 없는 거절이 있고, 그룹장을 드러내지 않는다 */
export type ChatJoinRejectActivity = IReject & {
	actor: string;
	object: IObject & { type: 'Join'; id: string; actor: string; object: string };
	_misskey_chatJoinRefusal: ChatJoinRefusal;
};

export function renderChatJoinReject(params: { actor: string; join: Pick<ChatJoin, 'id' | 'actor' | 'object'>; reason: ChatJoinRefusal; published: string }): ChatJoinRejectActivity {
	return {
		type: 'Reject',
		actor: params.actor,
		object: { type: 'Join', id: params.join.id, actor: params.join.actor, object: params.join.object },
		_misskey_chatJoinRefusal: params.reason,
		published: params.published,
	};
}

/**
 * 받은 Reject가 이 서버가 보낸 바로 그 Join에 대한 그룹 서버의 거절인지 본다.
 * 서명자는 초대 주소와 같은 호스트여야 하고, 실린 Join의 id·actor·object가 보낸 것과 같아야 한다.
 */
export function parseChatJoinReject(reject: unknown, expected: { joinId: string; actor: string; inviteUrl: string; signerUri: string }): { reason: ChatJoinRefusalReceived } | null {
	if (typeof reject !== 'object' || reject == null) return null;
	const activity = reject as Record<string, unknown>;
	if (activity.type !== 'Reject') return null;

	let signerHost: string;
	try {
		signerHost = new URL(expected.signerUri).host;
	} catch {
		return null;
	}
	if (signerHost !== new URL(expected.inviteUrl).host) return null;
	if (activity.actor != null && apIdOf(activity.actor) !== expected.signerUri) return null;

	const join = activity.object;
	if (typeof join !== 'object' || join == null || Array.isArray(join)) return null;
	const joinObject = join as Record<string, unknown>;
	if (joinObject.type !== 'Join' || joinObject.id !== expected.joinId) return null;
	if (apIdOf(joinObject.actor) !== expected.actor) return null;
	if (apIdOf(joinObject.object) !== expected.inviteUrl) return null;

	const reason = activity._misskey_chatJoinRefusal;
	return { reason: CHAT_JOIN_REFUSALS.includes(reason as ChatJoinRefusal) ? reason as ChatJoinRefusal : 'unknown' };
}

/** 문자열이나 id가 있는 객체의 id. 그 밖에는 null(예외를 던지지 않는다) */
export function apIdOf(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (typeof value === 'object' && value != null && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id;
	return null;
}

export type ChatJoinFacts = {
	/** 코드의 링크가 지금 유효한가(그룹 행 잠금 아래에서 다시 읽은 값) */
	linkValid: boolean;
	isMember: boolean;
	isArchived: boolean;
	/** 그룹장이 직접 내보내 재참여가 금지된 계정인가 */
	isBanned: boolean;
	/** 그룹장이 참여하려는 계정을 차단했는가. 참여하려는 사람이 그룹장을 차단한 것은 사유가 아니다 */
	blockedByOwner: boolean;
	isFull: boolean;
};

/**
 * 참여 판정. 사유가 겹치면 링크 → 보관 → 금지 → 그룹장 차단 → 정원 순으로 알린다.
 * 이미 멤버면 링크만 확인하고 기존 멤버십을 그대로 둔다(계정 이전으로 금지를 이어받은 기존 멤버 포함).
 */
export function decideChatJoin(facts: ChatJoinFacts): 'join' | 'member' | ChatJoinRefusal {
	if (!facts.linkValid) return 'revoked';
	if (facts.isMember) return 'member';
	if (facts.isArchived) return 'archived';
	if (facts.isBanned) return 'banned';
	if (facts.blockedByOwner) return 'blocked';
	if (facts.isFull) return 'full';
	return 'join';
}
