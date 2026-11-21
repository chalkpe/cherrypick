/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { acceptReplyEdit, chatReplyAuthorName, chatReplyPreviewText, chatReplyTargetPreview, deletedReplyOf, editedReplyOf, loadReplyOriginalWindow } from '@/pages/chat/chat-reply.js';

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

const quoted = { id: 'm1', isDeleted: false, text: '옛 본문', fileCount: 0, fromUserId: 'u1', fromUser: null, archivedAuthor: null };

test('수정된 원문을 인용한 답장만 새 본문으로 바뀐다', () => {
	expect(editedReplyOf(quoted, 'm1', '새\n본문').text).toBe('새 본문');
	expect(editedReplyOf(quoted, 'other', '새 본문')).toBe(quoted);
	const deleted = deletedReplyOf(quoted);
	expect(editedReplyOf(deleted, 'm1', '새 본문')).toBe(deleted);
});

type Q = { sinceId?: string; untilId?: string; limit: number };

test('불러오지 않은 원문은 다음 글을 찾은 뒤 원문까지 두 번의 조회로 가져온다', async () => {
	const fetchPage = vi.fn(async (q: Q) => q.sinceId != null ? [{ id: 'm6' }] : [{ id: 'm5' }, { id: 'm4' }]);

	await expect(loadReplyOriginalWindow(fetchPage, 'm5', 1)).resolves.toEqual([{ id: 'm5' }, { id: 'm4' }]);
	expect(fetchPage).toHaveBeenCalledTimes(2);
	expect(fetchPage).toHaveBeenNthCalledWith(1, { sinceId: 'm5', limit: 1 });
	expect(fetchPage).toHaveBeenNthCalledWith(2, { untilId: 'm6', limit: 2 });
});

test('원문이 가장 새 글이면 기준 없이 최신부터 받는다', async () => {
	const fetchPage = vi.fn(async (q: Q) => q.sinceId != null ? [] : [{ id: 'm5' }]);

	await expect(loadReplyOriginalWindow(fetchPage, 'm5')).resolves.toEqual([{ id: 'm5' }]);
	expect(fetchPage).toHaveBeenNthCalledWith(2, { limit: 11 });
});

test('조회 결과에 원문이 없으면 null이다 (삭제 표식도 없는 보이지 않는 글)', async () => {
	const fetchPage = vi.fn(async (q: Q) => q.sinceId != null ? [{ id: 'm6' }] : [{ id: 'm4' }]);

	await expect(loadReplyOriginalWindow(fetchPage, 'm5')).resolves.toBeNull();
});

test('조회가 실패하면 오류가 그대로 올라간다', async () => {
	await expect(loadReplyOriginalWindow(async () => { throw new Error('x'); }, 'm5')).rejects.toThrow('x');
});

test('목록 밖 원문의 수정 이벤트가 뒤바뀌어 와도 늦은 수정의 본문이 남는다', () => {
	const seen = new Map<string, number>();
	const reply = { id: 'm1', isDeleted: false, text: '처음', fileCount: 0, fromUserId: 'u1', fromUser: null, archivedAuthor: null };
	let quote: Parameters<typeof editedReplyOf>[0] = reply;
	for (const e of [{ at: '2026-01-01T00:00:02Z', text: '둘째' }, { at: '2026-01-01T00:00:01Z', text: '첫째' }]) {
		if (acceptReplyEdit(seen, 'm1', e.at)) quote = editedReplyOf(quote, 'm1', e.text);
	}
	expect(quote.text).toBe('둘째');
	expect(acceptReplyEdit(seen, 'm1', '2026-01-01T00:00:02Z')).toBe(false);
	expect(acceptReplyEdit(seen, 'm2', '2026-01-01T00:00:01Z')).toBe(true);
});
