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

test.describe('Chat', () => {
	let alice: RegisteredUser;
	let bob: RegisteredUser;

	test.beforeAll(async () => {
		await resetState();
		await registerUser('admin', 'pass', true);
		alice = await registerUser('alice', 'alice1234');
		bob = await registerUser('bob', 'bob12345');
		for (const user of [alice, bob]) {
			await api(BASE_URL, 'i/registry/set', { i: user.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
			await api(BASE_URL, 'i/update', { i: user.token, chatScope: 'everyone' });
		}
		for (let i = 1; i <= 60; i++) {
			const [from, to] = i % 2 ? [alice, bob] : [bob, alice];
			await api(BASE_URL, 'chat/messages/create-to-user', { i: from.token, toUserId: to.id, text: `message ${i}` });
		}
	});

	test.beforeEach(async ({ page }) => {
		await signIn(page, 'alice', 'alice1234');
		// ログインが終わるとホームタイムラインのヒントが出るので、それまで次の画面へ移らない
		await page.getByRole('button', { name: 'Got it!' }).click();
	});

	test.describe('on a laptop', () => {
		test.use({ viewport: { width: 1280, height: 720 } });

		test('keeps the place when earlier messages load', async ({ page }) => {
			await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
			// 最初に読み込まれるのは新しい 20 件で、続きの 30 件はボタンで読み込む
			const oldestLoaded = page.getByText('message 41', { exact: true });
			await oldestLoaded.waitFor();
			const more = page.getByRole('button', { name: 'Load more', exact: true });
			await more.scrollIntoViewIfNeeded();
			const before = (await oldestLoaded.boundingBox())!.y;

			await more.click();
			await page.getByText('message 11', { exact: true }).waitFor({ state: 'attached' });

			await expect.poll(async () => Math.abs((await oldestLoaded.boundingBox())!.y - before)).toBeLessThan(4);
		});
	});

	test.describe('in a narrow window', () => {
		test.use({ viewport: { width: 412, height: 915 } });

		test('opens the second level of a menu on screen', async ({ page }) => {
			await page.goto(`${BASE_URL}/chat`);
			await page.locator('button:has(i.ti-plus)').first().click();
			await page.getByText('Room Chat', { exact: true }).click();

			await expect(page.getByText('Create Room', { exact: true })).toBeInViewport();
		});
	});
});
