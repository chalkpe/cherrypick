/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from './fixtures.js';
import { BASE_URL, closeUserSetupDialogIfVisible, locateMkInput, registerUser, resetState, signIn, visitHome } from './utils.js';

test('opens note cleanup from the production bundle', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	await registerUser('alice', 'alice1234');
	await signIn(page, 'alice', 'alice1234');
	await page.waitForTimeout(1000);
	await closeUserSetupDialogIfVisible(page);
	await page.goto(`${BASE_URL}/settings/note-cleanup`);
	await expect(page.getByRole('heading', { name: 'Note cleanup', exact: true })).toBeVisible();
});

test('rejects invalid regular expressions before saving and accepts corrected input', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	await registerUser('alice', 'alice1234');
	await visitHome(page);
	await page.getByTestId('signin').click();
	await locateMkInput(page, 'signin-username').fill('alice');
	await page.keyboard.press('Enter');
	await locateMkInput(page, 'signin-password').fill('alice1234');
	const reloaded = page.waitForEvent('load');
	await page.keyboard.press('Enter');
	await reloaded;
	await page.getByRole('button', { name: 'Later', exact: true }).waitFor();
	await page.getByTestId('modal-window-close').last().click();
	const setupClosed = page.waitForEvent('load');
	await page.getByTestId('modal-dialog-ok').click();
	await setupClosed;
	await page.goto(`${BASE_URL}/settings/note-cleanup`);
	await page.getByRole('heading', { name: 'Note cleanup', exact: true }).waitFor();
	await page.getByText('Rule name', { exact: true }).locator('..').locator('input').fill('Regex check');
	await page.getByRole('button', { name: 'Search mode' }).click();
	await page.getByText('Advanced: regular expression', { exact: true }).click();
	await page.getByText('Keyword or pattern', { exact: true }).locator('..').locator('textarea').fill('hello');
	await page.getByText('Regex flags', { exact: true }).locator('..').locator('input').fill('z');
	const saves: string[] = [];
	page.on('request', request => { if (request.url().endsWith('/api/i/note-cleanup/create')) saves.push(request.url()); });

	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Regular Expression error', { exact: true })).toBeVisible();
	await expect(page.getByText(/Condition: Root\s*SyntaxError:/)).toBeVisible();
	expect(saves).toEqual([]);
	await page.getByTestId('modal-dialog-ok').click();
	await page.getByText('Regex flags', { exact: true }).locator('..').locator('input').fill('i');
	const saved = page.waitForResponse(response => response.url().endsWith('/api/i/note-cleanup/create'));
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	expect((await saved).status()).toBe(200);
	await expect(page.getByRole('button', { name: 'Regex check', exact: true })).toBeVisible();
});
