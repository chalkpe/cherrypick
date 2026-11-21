/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { chatReplyAuthorName, chatReplyPreviewText, chatReplyTargetPreview, deletedReplyOf, editedReplyOf, findReplyOriginal } from '@/pages/chat/chat-reply.js';

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

function jumpDeps(overrides: Partial<Parameters<typeof findReplyOriginal>[0]> & { loaded?: () => boolean } = {}) {
	let pages = 0;
	return {
		pages: () => pages,
		deps: {
			has: () => false,
			canFetchMore: () => true,
			isBusy: () => false,
			fetchMore: vi.fn(async () => { pages++; return true; }),
			wait: vi.fn(async () => undefined),
			aborted: () => false,
			...overrides,
		},
	};
}

test('원문 이동은 상한만큼만 이전 글을 불러오고 더 먼 원문은 따로 알린다', async () => {
	const { deps } = jumpDeps();

	await expect(findReplyOriginal(deps, 3)).resolves.toBe('tooFar');
	expect(deps.fetchMore).toHaveBeenCalledTimes(3);
});

test('불러오기를 기다리는 동안은 횟수에 세지 않는다', async () => {
	let busy = 5;
	let loaded = false;
	const { deps } = jumpDeps({
		has: () => loaded,
		isBusy: () => busy-- > 0,
		fetchMore: vi.fn(async () => { loaded = true; return true; }),
	});

	await expect(findReplyOriginal(deps, 1)).resolves.toBe('found');
	expect(deps.wait).toHaveBeenCalledTimes(5);
	expect(deps.fetchMore).toHaveBeenCalledTimes(1);
});

test('불러오기가 실패하면 더 알리지 않고 멈춘다', async () => {
	const { deps } = jumpDeps({ fetchMore: vi.fn(async () => false) });

	await expect(findReplyOriginal(deps)).resolves.toBe('failed');
	expect(deps.fetchMore).toHaveBeenCalledTimes(1);
});

test('더 불러올 글이 없으면 원문이 없는 것으로 본다', async () => {
	await expect(findReplyOriginal(jumpDeps({ canFetchMore: () => false }).deps)).resolves.toBe('notFound');
});

test('대화가 바뀌거나 화면이 닫히면 이어 가지 않는다', async () => {
	let closed = false;
	const { deps } = jumpDeps({ fetchMore: vi.fn(async () => { closed = true; return true; }), aborted: () => closed });

	await expect(findReplyOriginal(deps)).resolves.toBe('aborted');
	expect(deps.fetchMore).toHaveBeenCalledTimes(1);
});
