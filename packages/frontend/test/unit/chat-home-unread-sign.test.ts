/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({
	me: { id: 'me', policies: { chatAvailability: 'available' }, hasUnreadChatMessages: true },
	updateCurrentAccount: vi.fn(),
}));

vi.mock('@/i.js', () => ({ $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/accounts.js', () => ({ updateCurrentAccount: mocks.updateCurrentAccount }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(async () => []) }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/os.js', () => ({ popupMenu: vi.fn(), selectUser: vi.fn(), inputText: vi.fn() }));
// 一覧と吹き出しは、未読の印を消すかどうかと関係ないので空にする
vi.mock('@/components/MkChatHistories.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/XMessage.vue', () => ({ default: { render: () => null } }));

import XHome from '@/pages/chat/home.home.vue';

const stubs = {
	MkAd: true,
	MkInfo: true,
	MkInput: true,
	MkButton: true,
	MkFoldableSection: { template: '<div><slot name="header" /><slot /></div>' },
};

describe('the chat home and the unread sign', () => {
	afterEach(() => {
		cleanup();
		mocks.updateCurrentAccount.mockReset();
	});

	// 未読の印は、読んだとサーバーが知らせたときにだけ消える。一覧を開いただけでは、どの会話も読んでいない
	test('opening the chat home does not clear the unread sign', async () => {
		render(XHome, { global: { stubs } });
		await nextTick();

		expect(mocks.updateCurrentAccount).not.toHaveBeenCalled();
		expect(mocks.me.hasUnreadChatMessages).toBe(true);
	});
});
