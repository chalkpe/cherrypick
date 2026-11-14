/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import {
	CHAT_INVITE_CODE_LENGTH,
	chatInviteUrl,
	decideChatJoin,
	generateChatInviteCode,
	isChatInviteCode,
	parseChatInvitePreview,
	parseChatInviteUrl,
	parseChatJoinReject,
	renderChatInvitePreview,
	renderChatJoin,
	renderChatJoinReject,
} from '@/core/chat-invite-link.js';
import type { ChatJoinFacts } from '@/core/chat-invite-link.js';

const code = 'Ab3dEf6hIj9lMn0p';
const inviteUrl = `https://a.example/chat/invite/${code}`;

describe('초대 주소', () => {
	test('발급 코드는 영문 대소문자와 숫자 16자이고 매번 다르다', () => {
		const first = generateChatInviteCode();
		const second = generateChatInviteCode();

		expect(first).toMatch(/^[0-9A-Za-z]{16}$/);
		expect(CHAT_INVITE_CODE_LENGTH).toBe(16);
		expect(first).not.toBe(second);
	});

	test('정확한 경로의 https 주소만 초대 주소로 본다', () => {
		expect(parseChatInviteUrl(inviteUrl)).toEqual({ url: inviteUrl, host: 'a.example', code });
		expect(parseChatInviteUrl('https://A.Example/chat/invite/' + code)).toEqual({ url: inviteUrl, host: 'a.example', code });
		expect(parseChatInviteUrl('https://a.example:8443/chat/invite/' + code)).toEqual({ url: `https://a.example:8443/chat/invite/${code}`, host: 'a.example:8443', code });
	});

	test.each([
		['http 주소', `http://a.example/chat/invite/${code}`],
		['쿼리', `${inviteUrl}?join=1`],
		['fragment', `${inviteUrl}#secret`],
		['자격 정보', `https://user:pass@a.example/chat/invite/${code}`],
		['하위 경로', `${inviteUrl}/join`],
		['끝 슬래시', `${inviteUrl}/`],
		['다른 경로', `https://a.example/chat/rooms/${code}`],
		['짧은 코드', 'https://a.example/chat/invite/Ab3dEf6'],
		['긴 코드', `https://a.example/chat/invite/${'a'.repeat(65)}`],
		['기호가 든 코드', 'https://a.example/chat/invite/Ab3d-f6hIj9lMn0p'],
		['주소가 아님', 'chat/invite/' + code],
		['문자열이 아님', 42],
	])('%s는 초대 주소가 아니다', (_, value) => {
		expect(parseChatInviteUrl(value)).toBeNull();
	});

	test('코드 형식만 따로 확인할 수 있다', () => {
		expect(isChatInviteCode(code)).toBe(true);
		expect(isChatInviteCode('abc')).toBe(false);
		expect(isChatInviteCode('a'.repeat(65))).toBe(false);
		expect(isChatInviteCode('../rooms')).toBe(false);
		expect(isChatInviteCode(undefined)).toBe(false);
	});

	test('받을 때는 8자와 64자 코드도 인정한다', () => {
		expect(parseChatInviteUrl('https://a.example/chat/invite/abcdEFG8')?.code).toBe('abcdEFG8');
		expect(parseChatInviteUrl(`https://a.example/chat/invite/${'a'.repeat(64)}`)?.code).toHaveLength(64);
	});

	test('개발 환경에서만 http 주소를 허용할 수 있다', () => {
		expect(parseChatInviteUrl(`http://a.example/chat/invite/${code}`, { allowHttp: true })).toEqual({ url: `http://a.example/chat/invite/${code}`, host: 'a.example', code });
	});

	test('발급 서버 주소와 코드로 초대 주소를 만든다', () => {
		expect(chatInviteUrl('https://a.example', code)).toBe(inviteUrl);
	});
});

describe('미리보기 문서', () => {
	const room = { id: 'room1', name: '모임', description: '설명', isArchived: false };

	test('그룹 이름·설명·멤버 수와 규약 값만 싣는다', () => {
		const doc = renderChatInvitePreview({ baseUrl: 'https://a.example', code, room, membersCount: 3 });

		expect(doc).toEqual({
			id: inviteUrl,
			type: 'Invite',
			object: {
				id: 'https://a.example/chat/rooms/room1',
				type: 'Group',
				name: '모임',
				summary: '설명',
				_misskey_chatArchived: false,
				_misskey_chatRoomMembersCount: 3,
			},
			endpoints: { sharedInbox: 'https://a.example/inbox' },
		});
		expect(JSON.stringify(doc)).not.toMatch(/attributedTo|actor|_misskey_chatRoomMembers"|_misskey_chatChannels|target/);
	});

	test('설명이 없으면 빈 문자열을 싣는다', () => {
		const doc = renderChatInvitePreview({ baseUrl: 'https://a.example', code, room: { ...room, description: null }, membersCount: 1 });

		expect((doc.object as { summary: string }).summary).toBe('');
	});

	function preview(overrides: Record<string, unknown> = {}, object: Record<string, unknown> = {}) {
		return {
			'@context': ['https://www.w3.org/ns/activitystreams'],
			id: inviteUrl,
			type: 'Invite',
			object: {
				id: 'https://a.example/chat/rooms/room1',
				type: 'Group',
				name: '모임',
				summary: '설명',
				_misskey_chatArchived: false,
				_misskey_chatRoomMembersCount: 3,
				...object,
			},
			endpoints: { sharedInbox: 'https://a.example/inbox' },
			...overrides,
		};
	}

	test('요청한 주소의 같은 HTTPS 호스트 문서만 받아들인다', () => {
		expect(parseChatInvitePreview(preview(), inviteUrl)).toEqual({
			url: inviteUrl,
			roomUri: 'https://a.example/chat/rooms/room1',
			sharedInbox: 'https://a.example/inbox',
			name: '모임',
			description: '설명',
			membersCount: 3,
			isArchived: false,
			iconUrl: null,
			iconDecorations: [],
		});
	});

	test.each([
		['다른 id', preview({ id: `https://a.example/chat/invite/${'b'.repeat(16)}` })],
		['Invite가 아님', preview({ type: 'Note' })],
		['그룹이 아님', preview({}, { type: 'Person' })],
		['그룹 URI가 다른 호스트', preview({}, { id: 'https://evil.example/chat/rooms/room1' })],
		['그룹 URI가 http', preview({}, { id: 'http://a.example/chat/rooms/room1' })],
		['그룹 URI 경로가 다름', preview({}, { id: 'https://a.example/users/room1' })],
		['받은편지함이 다른 호스트', preview({ endpoints: { sharedInbox: 'https://evil.example/inbox' } })],
		['받은편지함이 http', preview({ endpoints: { sharedInbox: 'http://a.example/inbox' } })],
		['받은편지함 없음', preview({ endpoints: undefined })],
		['이름 없음', preview({}, { name: 42 })],
		['멤버 수가 정수가 아님', preview({}, { _misskey_chatRoomMembersCount: 1.5 })],
		['멤버 수가 0', preview({}, { _misskey_chatRoomMembersCount: 0 })],
		['객체가 문자열', preview({ object: 'https://a.example/chat/rooms/room1' })],
		['문서가 아님', 'Invite'],
	])('%s이면 거부한다', (_, doc) => {
		expect(parseChatInvitePreview(doc, inviteUrl)).toBeNull();
	});

	test('긴 이름과 설명은 그룹 사본과 같은 길이로 잘라서 받는다', () => {
		const parsed = parseChatInvitePreview(preview({}, { name: '가'.repeat(300), summary: '나'.repeat(3000) }), inviteUrl);

		expect(parsed?.name).toHaveLength(256);
		expect(parsed?.description).toHaveLength(2048);
	});
});

describe('Join과 거절', () => {
	const join = renderChatJoin({ id: 'https://b.example/activities/join1', actor: 'https://b.example/users/u1', inviteUrl, published: '2026-11-13T00:00:00.000Z' });

	test('Join은 초대 주소 하나만 참여 권한으로 싣는다', () => {
		expect(join).toEqual({
			id: 'https://b.example/activities/join1',
			type: 'Join',
			actor: 'https://b.example/users/u1',
			object: inviteUrl,
			published: '2026-11-13T00:00:00.000Z',
		});
	});

	test('거절은 보낸 Join을 그대로 싣고 사유를 붙인다', () => {
		const reject = renderChatJoinReject({ actor: 'https://a.example/users/instance', join, reason: 'banned', published: '2026-11-13T00:00:01.000Z' });

		expect(reject).toEqual({
			type: 'Reject',
			actor: 'https://a.example/users/instance',
			object: { type: 'Join', id: join.id, actor: join.actor, object: inviteUrl },
			_misskey_chatJoinRefusal: 'banned',
			published: '2026-11-13T00:00:01.000Z',
		});
	});

	const expected = { joinId: join.id, actor: join.actor, inviteUrl, signerUri: 'https://a.example/users/instance' };

	test('발급 서버가 서명한, 보낸 Join과 같은 거절만 받는다', () => {
		const reject = renderChatJoinReject({ actor: expected.signerUri, join, reason: 'full', published: '2026-11-13T00:00:01.000Z' });

		expect(parseChatJoinReject(reject, expected)).toEqual({ reason: 'full' });
	});

	test.each([
		['다른 서버의 서명', { signerUri: 'https://evil.example/users/x' }, {}],
		['다른 Join id', {}, { object: { type: 'Join', id: 'https://b.example/activities/join0', actor: join.actor, object: inviteUrl } }],
		['다른 사람', {}, { object: { type: 'Join', id: join.id, actor: 'https://b.example/users/u2', object: inviteUrl } }],
		['다른 코드', {}, { object: { type: 'Join', id: join.id, actor: join.actor, object: `https://a.example/chat/invite/${'c'.repeat(16)}` } }],
		['Join이 아님', {}, { object: { type: 'Follow', id: join.id, actor: join.actor, object: inviteUrl } }],
		['Join id만 있음', {}, { object: join.id }],
		['Join actor가 id 없는 객체', {}, { object: { type: 'Join', id: join.id, actor: { type: 'Person' }, object: inviteUrl } }],
		['거절 actor가 다름', {}, { actor: 'https://a.example/users/other' }],
	])('%s이면 받지 않는다', (_, signer, override) => {
		const reject = { ...renderChatJoinReject({ actor: expected.signerUri, join, reason: 'full', published: '2026-11-13T00:00:01.000Z' }), ...override };

		expect(parseChatJoinReject(reject, { ...expected, ...signer })).toBeNull();
	});

	test('사유 필드가 없거나 모르는 값이면 알 수 없는 거절이다', () => {
		const reject = renderChatJoinReject({ actor: expected.signerUri, join, reason: 'full', published: '2026-11-13T00:00:01.000Z' });
		const { _misskey_chatJoinRefusal: _, ...withoutReason } = reject;

		expect(parseChatJoinReject(withoutReason, expected)).toEqual({ reason: 'unknown' });
		expect(parseChatJoinReject({ ...reject, _misskey_chatJoinRefusal: 'other' }, expected)).toEqual({ reason: 'unknown' });
	});
});

describe('참여 판정', () => {
	const allowed: ChatJoinFacts = { linkValid: true, isMember: false, isArchived: false, isBanned: false, blockedByOwner: false, isFull: false };

	test('조건을 모두 지나면 참여한다', () => {
		expect(decideChatJoin(allowed)).toBe('join');
	});

	test('사유가 겹치면 링크 → 보관 → 금지 → 그룹장 차단 → 정원 순으로 알린다', () => {
		expect(decideChatJoin({ linkValid: false, isMember: false, isArchived: true, isBanned: true, blockedByOwner: true, isFull: true })).toBe('revoked');
		expect(decideChatJoin({ ...allowed, isArchived: true, isBanned: true, blockedByOwner: true, isFull: true })).toBe('archived');
		expect(decideChatJoin({ ...allowed, isBanned: true, blockedByOwner: true, isFull: true })).toBe('banned');
		expect(decideChatJoin({ ...allowed, blockedByOwner: true, isFull: true })).toBe('blocked');
		expect(decideChatJoin({ ...allowed, isFull: true })).toBe('full');
	});

	test('이미 멤버면 링크만 확인하고 기존 멤버십을 그대로 둔다', () => {
		expect(decideChatJoin({ ...allowed, isMember: true, isArchived: true, isBanned: true, blockedByOwner: true, isFull: true })).toBe('member');
		expect(decideChatJoin({ ...allowed, linkValid: false, isMember: true })).toBe('revoked');
	});
});
