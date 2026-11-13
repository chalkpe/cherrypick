/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import {
	buildChatHistoryPage,
	chatHistoryNoteFields,
	chatHistoryPageUri,
	isChatHistoryCursor,
	parseChatHistoryItem,
	parseChatHistoryPage,
} from '@/core/activitypub/misc/chat-history.js';
import type { ChatHistoryItemContext } from '@/core/activitypub/misc/chat-history.js';
import type { IPost } from '@/core/activitypub/type.js';

const roomUri = 'https://owner.example/chat/rooms/room1';
const now = Date.parse('2026-11-13T00:00:00.000Z');

const context: ChatHistoryItemContext = {
	roomUri,
	now,
	hostOf: uri => {
		try {
			return new URL(uri).host.toLowerCase();
		} catch {
			return null;
		}
	},
	isLocalHost: host => host === 'here.example',
	isSafeTime: time => time > Date.parse('2000-01-01T00:00:00.000Z'),
	text: note => typeof note._misskey_content === 'string' ? note._misskey_content : null,
};

function note(overrides: Record<string, unknown> = {}): IPost {
	return {
		id: 'https://member.example/chat/messages/m1',
		type: 'Note',
		attributedTo: 'https://member.example/users/u1',
		_misskey_content: 'hello',
		_misskey_talk: true,
		published: '2026-11-01T00:00:00.000Z',
		context: roomUri,
		_misskey_chatRoom: roomUri,
		...overrides,
	} as IPost;
}

function skipped(value: unknown): string | null {
	const result = parseChatHistoryItem(value, context);
	return 'skip' in result ? result.skip : null;
}

describe('과거 기록 페이지 주소', () => {
	test('첫 페이지와 다음 페이지 주소는 그룹 URI 아래의 history이다', () => {
		expect(chatHistoryPageUri(roomUri, null)).toBe(`${roomUri}/history`);
		expect(chatHistoryPageUri(roomUri, 'abc123')).toBe(`${roomUri}/history?until=abc123`);
	});

	test('커서는 영숫자 32자 이하만 받는다', () => {
		expect(isChatHistoryCursor('abc123XYZ')).toBe(true);
		expect(isChatHistoryCursor('')).toBe(false);
		expect(isChatHistoryCursor('a'.repeat(33))).toBe(false);
		expect(isChatHistoryCursor('abc/../x')).toBe(false);
		expect(isChatHistoryCursor('abc&until=1')).toBe(false);
		expect(isChatHistoryCursor(['abc'])).toBe(false);
	});

	test('소유 서버의 페이지는 요청 주소를 id로, 다음 커서를 next로 싣는다', () => {
		const page = buildChatHistoryPage(roomUri, 'abc', [note()], 'xyz');

		expect(page).toMatchObject({
			id: `${roomUri}/history?until=abc`,
			type: 'OrderedCollectionPage',
			partOf: `${roomUri}/history`,
			next: `${roomUri}/history?until=xyz`,
		});
		expect(buildChatHistoryPage(roomUri, null, [], null)).not.toHaveProperty('next');
	});

	test('작성자 정보가 없으면 싣지 않고 리액션은 빈 배열로 싣는다', () => {
		expect(chatHistoryNoteFields(null, [])).toEqual({ _misskey_chatReactions: [] });
		expect(chatHistoryNoteFields({ name: '이름', username: 'u1', host: 'member.example' }, [{ actor: 'https://x.example/users/a', reaction: '👍' }])).toEqual({
			_misskey_chatAuthor: { name: '이름', username: 'u1', host: 'member.example' },
			_misskey_chatReactions: [{ actor: 'https://x.example/users/a', reaction: '👍' }],
		});
	});
});

describe('받은 페이지 검증', () => {
	const requested = `${roomUri}/history`;

	test('요청한 그룹의 페이지만 받는다', () => {
		const page = buildChatHistoryPage(roomUri, null, [note()], 'next1');

		expect(parseChatHistoryPage(page, roomUri, requested)).toEqual({ items: [note()], next: `${roomUri}/history?until=next1` });
	});

	test.each([
		['다른 주소의 응답', { id: `${roomUri}/history?until=other` }],
		['다른 그룹의 모음', { partOf: 'https://owner.example/chat/rooms/room2/history' }],
		['페이지가 아닌 형식', { type: 'Note' }],
		['배열이 아닌 항목', { orderedItems: 'x' }],
		['너무 많은 항목', { orderedItems: Array.from({ length: 101 }, () => note()) }],
		['다른 서버를 가리키는 next', { next: 'https://evil.example/chat/rooms/room1/history?until=a' }],
		['다른 그룹을 가리키는 next', { next: 'https://owner.example/chat/rooms/room2/history?until=a' }],
		['형식이 틀린 next 커서', { next: `${roomUri}/history?until=a/b` }],
		['자기 자신을 가리키는 next', { next: requested }],
	])('%s는 거부한다', (_, overrides) => {
		const page = { ...buildChatHistoryPage(roomUri, null, [note()], null), ...overrides };

		expect(parseChatHistoryPage(page, roomUri, requested)).toBeNull();
	});

	test('다음 페이지가 더 최근 커서로 돌아가 기록 가져오기를 반복시키면 거부한다', () => {
		const requestedPage = `${roomUri}/history?until=b2`;
		const page = buildChatHistoryPage(roomUri, 'b2', [note()], 'c3');

		expect(parseChatHistoryPage(page, roomUri, requestedPage)).toBeNull();
	});

	test('다음 페이지는 현재 커서보다 오래된 기록으로 진행할 수 있다', () => {
		const requestedPage = `${roomUri}/history?until=b2`;
		const page = buildChatHistoryPage(roomUri, 'b2', [note()], 'a1');

		expect(parseChatHistoryPage(page, roomUri, requestedPage)).toEqual({ items: [note()], next: `${roomUri}/history?until=a1` });
	});
});

describe('받은 항목 검증', () => {
	test('정상 항목은 작성 시각과 작성자 정보, 리액션을 돌려준다', () => {
		const result = parseChatHistoryItem(note({
			updated: '2026-11-02T00:00:00.000Z',
			_misskey_chatAuthor: { name: '이름', username: 'u1', host: 'MEMBER.example' },
			_misskey_chatReactions: [{ actor: 'https://third.example/users/r1', reaction: ':blob:', tag: { type: 'Emoji', id: 'https://third.example/emojis/blob', name: ':blob:' } }],
		}), context);

		expect(result).toMatchObject({
			uri: 'https://member.example/chat/messages/m1',
			authorUri: 'https://member.example/users/u1',
			published: new Date('2026-11-01T00:00:00.000Z'),
			editedAt: new Date('2026-11-02T00:00:00.000Z'),
			text: 'hello',
			author: { name: '이름', username: 'u1', host: 'member.example' },
			reactions: [{ actor: 'https://third.example/users/r1', reaction: ':blob:' }],
		});
	});

	test.each([
		['Note가 아님', { type: 'Question' }],
		['쪽지 표시가 없음', { _misskey_talk: undefined }],
		['다른 그룹의 글', { context: 'https://owner.example/chat/rooms/room2', _misskey_chatRoom: 'https://owner.example/chat/rooms/room2' }],
		['서로 다른 그룹 문맥', { context: 'https://owner.example/chat/rooms/room2' }],
		['다른 그룹을 섞은 문맥 배열', { context: [roomUri, 'https://owner.example/chat/rooms/room2'] }],
		['그룹 표시가 없는 글', { context: undefined, _misskey_chatRoom: undefined }],
		['받는 서버 자신의 주소', { id: 'https://here.example/chat/messages/m1', attributedTo: 'https://here.example/users/u1' }],
		['작성자와 글 주소의 호스트 불일치', { attributedTo: 'https://other.example/users/u1' }],
		['작성자가 없음', { attributedTo: undefined }],
		['미래 시각', { published: '2026-11-13T01:00:00.000Z' }],
		['작성 시각이 없음', { published: undefined }],
		['ID를 만들 수 없는 옛 시각', { published: '1999-12-31T00:00:00.000Z' }],
		['너무 긴 주소', { id: `https://member.example/chat/messages/${'a'.repeat(600)}` }],
		['너무 긴 본문', { _misskey_content: 'あ'.repeat(4097) }],
		['주소가 아닌 id', { id: 'not a url' }],
	])('%s는 버린다', (_, overrides) => {
		expect(skipped(note(overrides))).not.toBeNull();
	});

	test('5분 안의 시계 차이는 받는다', () => {
		expect(skipped(note({ published: '2026-11-13T00:04:00.000Z' }))).toBeNull();
	});

	test('작성자 정보의 호스트가 작성자와 다르거나 받는 서버면 쓰지 않는다', () => {
		const other = parseChatHistoryItem(note({ _misskey_chatAuthor: { name: 'x', username: 'u1', host: 'other.example' } }), context);
		const self = parseChatHistoryItem(note({ _misskey_chatAuthor: { name: 'x', username: 'u1', host: 'here.example' } }), context);

		expect(other).toMatchObject({ author: null });
		expect(self).toMatchObject({ author: null });
	});

	test('형식이 틀린 작성자 정보는 쓰지 않고 글은 받는다', () => {
		const result = parseChatHistoryItem(note({ _misskey_chatAuthor: { name: 1, username: ['u1'], host: 'member.example' } }), context);

		expect(result).toMatchObject({ author: null, text: 'hello' });
	});

	test('받는 서버 계정의 리액션과 형식이 틀린 리액션만 버린다', () => {
		const result = parseChatHistoryItem(note({
			_misskey_chatReactions: [
				{ actor: 'https://here.example/users/me', reaction: '👍' },
				{ actor: 'https://third.example/users/r1', reaction: 1 },
				{ actor: 42, reaction: '👍' },
				{ actor: 'https://third.example/users/r1', reaction: 'x'.repeat(257) },
				{ actor: 'https://third.example/users/r2', reaction: '🎉' },
			],
		}), context);

		expect(result).toMatchObject({ reactions: [{ actor: 'https://third.example/users/r2', reaction: '🎉' }] });
	});

	test('지나치게 긴 리액션 목록은 통째로 버리고 글은 받는다', () => {
		const reactions = Array.from({ length: 1001 }, (_, i) => ({ actor: `https://third.example/users/r${i}`, reaction: '👍' }));

		expect(parseChatHistoryItem(note({ _misskey_chatReactions: reactions }), context)).toMatchObject({ reactions: [], text: 'hello' });
	});
});
