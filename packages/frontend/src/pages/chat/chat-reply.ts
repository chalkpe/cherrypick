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
