/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from './fixtures.js';
import { BASE_URL, closeUserSetupDialogIfVisible, registerUser, resetState, signIn } from './utils.js';

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
