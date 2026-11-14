/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { parse } from 'node-html-parser';
import { ChatInvitePage } from '@/server/web/views/chat-invite.js';
import type { CommonData } from '@/server/web/views/_.js';

const common = {
	config: { url: 'https://invite.example' },
	instanceName: 'Test',
	instanceUrl: 'https://invite.example',
	langs: [],
	frontendViteFiles: null,
} as unknown as CommonData;

describe('초대 HTML 미리보기', () => {
	test.each([
		['ko-KR', '2 사용자'],
		['en-US', '2 Users'],
		['ja-JP', '2ユーザー'],
	])('%s: 설명과 실제 멤버 수를 OG와 일반 설명에 함께 싣는다', async (language, count) => {
		const html = await ChatInvitePage({
			...common,
			language,
			invite: { url: 'https://invite.example/chat/invite/Ab3dEf6hIj9lMn0p', name: '모임', description: '설명', membersCount: 2, iconUrl: 'https://invite.example/files/icon.png' },
		});
		const document = parse(html);

		expect(document.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(`설명\n${count}`);
		expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(`설명\n${count}`);
		expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
		expect(document.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe('https://invite.example/files/icon.png');
	});

	test('빈 설명과 알 수 없는 언어에서도 멤버 수를 표시하고 입력을 HTML로 실행하지 않는다', async () => {
		const html = await ChatInvitePage({
			...common,
			language: 'unknown',
			invite: { url: 'https://invite.example/chat/invite/Ab3dEf6hIj9lMn0p', name: '"><img src=x onerror=alert(1)>', description: '', membersCount: 1, iconUrl: 'https://invite.example/identicon/group' },
		});
		const document = parse(html);

		expect(document.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe('1ユーザー');
		expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe('"><img src=x onerror=alert(1)>');
		expect(document.querySelector('img[onerror]')).toBeNull();
	});
});
