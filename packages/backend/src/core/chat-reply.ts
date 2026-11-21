/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiChatMessage } from '@/models/ChatMessage.js';
import { localChatMessageIdFromUri } from '@/core/activitypub/misc/chat-payloads.js';

/** 답장 말풍선에 싣는 원문 미리보기의 최대 글자 수 */
export const CHAT_REPLY_PREVIEW_LENGTH = 120;

/** 답장을 쓰는 대화. 1:1은 두 계정, 그룹은 그룹과 채널(채널이 없으면 null)이다. */
export type ChatReplyScope =
	| { kind: 'user'; userIds: [string, string] }
	| { kind: 'room'; roomId: string; channelId: string | null };

type ReplyTargetShape = Pick<MiChatMessage, 'toRoomId' | 'toRoomChannelId' | 'toUserId' | 'fromUserId' | 'deletedAt'>;

/**
 * 원문이 답장과 같은 대화에 있고 지워지지 않았는지. 보내는 쪽이 무엇을 주장하든 저장한 기록만으로 판단한다.
 * 1:1 대화에서는 원문의 작성자와 수신자가 정확히 그 두 계정이어야 한다.
 */
export function isReplyTargetInScope(target: ReplyTargetShape, scope: ChatReplyScope): boolean {
	return target.deletedAt == null && isReplyTargetInConversation(target, scope);
}

/** 지워졌는지는 보지 않고 원문이 같은 대화의 글인지만 본다. 지워진 원문을 "삭제된 메시지"로 보이게 할 때 쓴다. */
export function isReplyTargetInConversation(target: ReplyTargetShape, scope: ChatReplyScope): boolean {
	if (scope.kind === 'room') {
		return target.toRoomId === scope.roomId && (target.toRoomChannelId ?? null) === scope.channelId;
	}
	if (target.toRoomId != null || target.fromUserId == null || target.toUserId == null) return false;
	const [a, b] = scope.userIds;
	return (target.fromUserId === a && target.toUserId === b) || (target.fromUserId === b && target.toUserId === a);
}

/** 답장 말풍선에 싣는 본문. 줄바꿈은 공백으로 줄이고 길면 자른다. 본문이 없으면 null. */
export function chatReplyPreviewText(text: string | null | undefined): string | null {
	if (text == null) return null;
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat === '') return null;
	const chars = Array.from(flat);
	return chars.length > CHAT_REPLY_PREVIEW_LENGTH ? `${chars.slice(0, CHAT_REPLY_PREVIEW_LENGTH).join('')}…` : flat;
}

/** 연합으로 받은 원문 주소. 문자열이 아니거나 너무 길면 버린다. */
export function parseChatReplyUri(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

type ReplyLookup = { findOneBy(where: Record<string, unknown>): Promise<MiChatMessage | null> };

/**
 * 연합으로 받은 원문 주소로 이 서버에 저장된 글을 찾는다. 원래 주소, 이 서버가 붙인 주소, 보관 사본의 출처 주소 순이다.
 * 저장된 기록만 보며 외부에는 요청하지 않는다. 찾은 글이 같은 대화인지는 부르는 쪽이 isReplyTargetInScope로 확인한다.
 */
export async function findReplyTargetByUri(repository: ReplyLookup, uri: string, baseUrl: string, scope: ChatReplyScope): Promise<MiChatMessage | null> {
	const direct = await repository.findOneBy({ uri });
	if (direct != null) return direct;
	const localId = localChatMessageIdFromUri(uri, baseUrl);
	if (localId != null) return repository.findOneBy({ id: localId });
	return scope.kind === 'room' ? repository.findOneBy({ sourceUri: uri, toRoomId: scope.roomId }) : null;
}
