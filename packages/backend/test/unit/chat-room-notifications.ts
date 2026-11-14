/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { chatMentionedUserIds, effectiveChatNotificationLevel, newlyMentionedUserIds } from '@/core/chat-room-notifications.js';
import type { ChatNotificationLevel } from '@/core/chat-room-notifications.js';

describe('그룹·채널 공통 알림 정책', () => {
	const levels: ChatNotificationLevel[] = ['all', 'mentions', 'none'];
	for (const group of levels) {
		test.each([null, ...levels])(`그룹 ${group}, 채널 %s의 우선순위`, channel => {
			const expected = group === 'none' ? 'none' : channel ?? group;

			expect(effectiveChatNotificationLevel(group, channel)).toBe(expected);
		});
	}
});

describe('기존 계정 멘션 해석', () => {
	const members = [
		{ id: 'author', username: 'author', host: null },
		{ id: 'local', username: 'Alice', host: null },
		{ id: 'remote', username: 'Alice', host: 'remote.example' },
		{ id: 'idn', username: 'bob', host: 'xn--3e0b707e.example' },
	];
	const author = members[0];
	const localHost = 'local.example';

	test('로컬 멘션과 명시한 계정 도메인을 구분하고 중복을 제거한다', () => {
		const ids = chatMentionedUserIds('@alice @ALICE@LOCAL.EXAMPLE @alice@remote.example @author @outsider', author, members, localHost);

		expect(ids.sort()).toEqual(['local', 'remote']);
	});

	test('원격 작성자의 도메인 없는 멘션은 작성자 서버 계정이다', () => {
		const ids = chatMentionedUserIds('@Alice @alice@local.example', { id: 'remote-author', host: 'remote.example' }, members, localHost);

		expect(ids.sort()).toEqual(['local', 'remote']);
	});

	test('코드·일반 문자열·everyone으로 전체 멤버를 호출하지 않는다', () => {
		const ids = chatMentionedUserIds('`@Alice`\n```\n@Alice@remote.example\n```\n@everyone', author, members, localHost);

		expect(ids).toEqual([]);
	});

	test('국제 도메인은 기존 MFM이 해석하는 계정 주소를 따른다', () => {
		const ids = chatMentionedUserIds('@bob@xn--3e0b707e.example', author, members, localHost);

		expect(ids).toEqual(['idn']);
	});

	test('수정은 새 대상만 반환하며 기존 대상을 재알림하지 않는다', () => {
		expect(newlyMentionedUserIds(['local', 'remote', 'remote'], ['local'])).toEqual(['remote']);
		expect(newlyMentionedUserIds(['local'], ['local', 'remote'])).toEqual([]);
	});
});
