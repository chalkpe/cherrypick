/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { chatReplyAuthorName, chatReplyPreviewText, chatReplyTargetPreview, deletedReplyOf } from '@/pages/chat/chat-reply.js';

test('인용 본문은 줄바꿈을 접고 긴 문장은 잘라서 보인다', () => {
	expect(chatReplyPreviewText('안녕\n\n하세요')).toBe('안녕 하세요');
	const cut = chatReplyPreviewText('가'.repeat(300))!;
	expect(Array.from(cut)).toHaveLength(121);
	expect(cut.endsWith('…')).toBe(true);
});

test('첨부만 있는 원문은 본문이 없고 첨부 수가 남는다', () => {
	expect(chatReplyTargetPreview({ id: 'm1', text: null, fileIds: ['f1', 'f2'] })).toEqual({ id: 'm1', name: null, text: null, fileCount: 2 });
});

test('작성자 이름은 계정, 보관된 작성자 순으로 고른다', () => {
	expect(chatReplyAuthorName({ fromUser: { name: '현찬', username: 'a' } as never })).toBe('현찬');
	expect(chatReplyAuthorName({ fromUser: { name: null, username: 'a' } as never })).toBe('a');
	expect(chatReplyAuthorName({ fromUser: null, archivedAuthor: { name: null, username: 'gone' } })).toBe('gone');
	expect(chatReplyAuthorName({ fromUser: null })).toBeNull();
});

test('지워진 원문의 인용에는 내용이 남지 않는다', () => {
	const reply = { id: 'm1', isDeleted: false, text: '비밀', fileCount: 1, fromUserId: 'u1', fromUser: { id: 'u1' } as never, archivedAuthor: null };

	expect(deletedReplyOf(reply)).toEqual({ id: 'm1', isDeleted: true, text: null, fileCount: 0, fromUserId: null, fromUser: null, archivedAuthor: null });
});
