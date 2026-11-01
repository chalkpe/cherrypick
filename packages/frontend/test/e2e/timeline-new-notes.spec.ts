/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { test, expect } from './fixtures.js';
import { api } from './shared.js';
import {
	// const
	BASE_URL,
	// utils
	resetState, registerUser,
	// page utils
	signIn,
} from './utils.js';
import type { RegisteredUser } from './utils.js';
import type { Page } from 'playwright';

const NEW_NOTES_INDICATOR = /There are \d+ new notes/;

async function scrollTimelineTo(page: Page, top: number): Promise<void> {
	await page.evaluate((top) => {
		let el = document.querySelector('[data-scroll-anchor]')?.parentElement ?? null;
		while (el != null && !(el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'visible')) {
			el = el.parentElement;
		}
		(el ?? document.scrollingElement!).scrollTo({ top });
	}, top);
}

// 初回ログイン時のセットアップダイアログはアカウントに保存された状態で出るかどうかが決まるので、最初から済ませておく
async function skipUserSetupDialog(user: RegisteredUser): Promise<void> {
	await api(BASE_URL, 'i/registry/set', { i: user.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
}

test.describe('Streaming timeline', () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

	let alice: RegisteredUser;

	test.beforeAll(async () => {
		await resetState();
		await registerUser('admin', 'pass', true);
		alice = await registerUser('alice', 'alice1234');
		await skipUserSetupDialog(alice);
		for (let i = 1; i <= 20; i++) {
			await api(BASE_URL, 'notes/create', { i: alice.token, text: `seed note ${i}` });
		}
	});

	test.beforeEach(async ({ page }) => {
		await signIn(page, 'alice', 'alice1234');
	});

	// 新着ノートの通知が出ると .new2 の負の margin-top がタイムラインの外へ相殺され、
	// 先頭に戻っても isTop() が偽のままになりキューが解放されなかった
	test('releases queued notes when scrolled back to the top', async ({ page }) => {
		await page.getByText('seed note 20').waitFor();

		// タイムラインの上にヒントが出ているとタイムラインの位置が下がって再現しないので閉じておく
		await page.getByRole('button', { name: 'Got it!' }).click();

		await scrollTimelineTo(page, 300);
		await page.waitForTimeout(500);

		await api(BASE_URL, 'notes/create', { i: alice.token, text: 'arrived while scrolled' });
		await expect(page.getByText(NEW_NOTES_INDICATOR)).toBeVisible();

		await scrollTimelineTo(page, 0);

		await expect(page.locator('[data-scroll-anchor]').first()).toContainText('arrived while scrolled');
		await expect(page.getByText(NEW_NOTES_INDICATOR)).toBeHidden();
	});
});
