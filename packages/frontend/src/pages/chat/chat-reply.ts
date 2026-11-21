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

/** 한 번 이동하려고 이전 글을 최대 몇 번 더 불러오는지. 이보다 먼 원문은 안내하고, 다시 누르면 이어서 찾는다 */
export const MAX_REPLY_JUMP_FETCHES = 10;

export type ReplyJumpResult = 'found' | 'notFound' | 'tooFar' | 'failed' | 'aborted';

/**
 * 인용한 원문이 목록에 들어올 때까지 같은 대화의 이전 글 불러오기를 되풀이한다.
 * 진행 중인 불러오기를 기다리는 것은 횟수에 세지 않고, 불러오기가 실패하면 그 쪽에서 이미 알렸으므로 더 알리지 않는다.
 */
export async function findReplyOriginal(deps: {
	has: () => boolean;
	canFetchMore: () => boolean;
	isBusy: () => boolean;
	/** 이전 글을 한 쪽 불러온다. 실패하면 false */
	fetchMore: () => Promise<boolean>;
	wait: () => Promise<void>;
	/** 대화가 바뀌었거나 화면이 닫힌 경우 */
	aborted: () => boolean;
}, maxFetches = MAX_REPLY_JUMP_FETCHES): Promise<ReplyJumpResult> {
	let fetches = 0;
	for (;;) {
		if (deps.aborted()) return 'aborted';
		if (deps.has()) return 'found';
		if (deps.isBusy()) {
			await deps.wait();
			continue;
		}
		if (!deps.canFetchMore()) return 'notFound';
		if (fetches >= maxFetches) return 'tooFar';
		fetches++;
		if (!await deps.fetchMore()) return deps.aborted() ? 'aborted' : 'failed';
	}
}
