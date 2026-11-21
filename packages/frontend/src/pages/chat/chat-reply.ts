/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'cherrypick-js';

// 서버가 답장 미리보기에 싣는 본문의 최대 글자 수와 같게 맞춘다 (packages/backend/src/core/chat-reply.ts)
const PREVIEW_LENGTH = 120;

type ReplySource = {
	id: string;
	text?: string | null;
	fileIds?: string[];
	fromUser?: Misskey.entities.UserLite | null;
	archivedAuthor?: { name: string | null; username: string | null } | null;
};

export function chatReplyPreviewText(text: string | null | undefined): string | null {
	if (text == null) return null;
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat === '') return null;
	const chars = Array.from(flat);
	return chars.length > PREVIEW_LENGTH ? `${chars.slice(0, PREVIEW_LENGTH).join('')}…` : flat;
}

export function chatReplyAuthorName(source: Pick<ReplySource, 'fromUser' | 'archivedAuthor'>): string | null {
	if (source.fromUser != null) return source.fromUser.name ?? source.fromUser.username;
	return source.archivedAuthor?.name ?? source.archivedAuthor?.username ?? null;
}

/** 입력창 위에 보이는, 지금 답장하려는 메시지의 작성자와 본문 */
export function chatReplyTargetPreview(source: ReplySource) {
	return {
		id: source.id,
		name: chatReplyAuthorName(source),
		text: chatReplyPreviewText(source.text),
		fileCount: source.fileIds?.length ?? 0,
	};
}

type PackedReply = NonNullable<Misskey.entities.ChatMessageLite['reply']>;

/** 원문이 지워졌을 때 말풍선에 남기는 모양. 내용은 싣지 않는다 */
export function deletedReplyOf(reply: PackedReply): PackedReply {
	return { id: reply.id, isDeleted: true, text: null, fileCount: 0, fromUserId: null, fromUser: null, archivedAuthor: null };
}

/** 원문이 수정되었을 때 그 원문을 인용한 답장의 인용 본문. 해당하지 않으면 그대로 돌려준다 */
export function editedReplyOf(reply: PackedReply, messageId: string, text: string | null | undefined): PackedReply {
	if (reply.id !== messageId || reply.isDeleted) return reply;
	return { ...reply, text: chatReplyPreviewText(text) };
}

/**
 * 아직 불러오지 않은 원문 주변을 같은 대화의 타임라인 조회로 가져온다. 요청은 최대 2번이다.
 * 원문 바로 다음 글을 sinceId로 찾고, 그 글을 untilId로 삼아 원문과 그 앞의 글을 받는다.
 * 대화·방·채널의 접근 검사는 조회하는 타임라인 쪽에서 그대로 적용된다.
 * 원문이 응답에 없으면 (삭제 표식도 없는 경우 등) null.
 */
export async function loadReplyOriginalWindow<T extends { id: string }>(
	fetchPage: (query: { sinceId?: string; untilId?: string; limit: number }) => Promise<T[]>,
	originalId: string,
	contextSize = REPLY_ORIGINAL_CONTEXT,
): Promise<T[] | null> {
	const [next] = await fetchPage({ sinceId: originalId, limit: 1 });
	const page = await fetchPage({ ...(next != null ? { untilId: next.id } : {}), limit: contextSize + 1 });
	return page.some(m => m.id === originalId) ? page : null;
}

/** 원문 보기에 함께 보이는, 원문 앞의 글 수 */
export const REPLY_ORIGINAL_CONTEXT = 10;
