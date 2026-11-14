/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from './fixtures.js';
import { BASE_URL, closeUserSetupDialog, registerUser, resetState, signIn } from './utils.js';

test('opens note cleanup from the production bundle', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	await registerUser('alice', 'alice1234');
	await signIn(page, 'alice', 'alice1234');
	// 새 계정의 초기 설정 마법사는 비동기로 뜨므로 나타난 것을 기다려 닫는다.
	await closeUserSetupDialog(page);
	await page.goto(`${BASE_URL}/settings/note-cleanup`);
	await expect(page.getByRole('heading', { name: 'Note cleanup', exact: true })).toBeVisible();
	await expect(page.getByText('Delete rules', { exact: true })).toBeVisible();
	await expect(page.getByText('Keep rules', { exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'My pinned notes' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Create rule' })).toHaveCount(2);
	// 목록에는 정리 실행·선택 수단이 없고 편집 화면으로만 들어간다.
	await expect(page.getByRole('button', { name: 'Clean up now' })).toHaveCount(0);
	await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
});

test('creates a rule from the list and rejects invalid regular expressions before saving', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	await registerUser('alice', 'alice1234');
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	await page.goto(`${BASE_URL}/settings/note-cleanup`);
	await page.getByRole('heading', { name: 'Note cleanup', exact: true }).waitFor();
	await page.getByRole('link', { name: 'Create rule' }).first().click();
	const nameInput = page.getByText('Rule name', { exact: true }).locator('..').locator('input');
	await nameInput.waitFor();
	await nameInput.fill('Regex check');
	await page.locator('textarea').fill('hello');
	await page.getByTestId('folder-header').click();
	await page.getByTestId('switch-toggle').click();
	const flagsInput = page.getByText('Regex flags', { exact: true }).locator('..').locator('input');
	await flagsInput.fill('z');
	const saves: string[] = [];
	page.on('request', request => { if (request.url().endsWith('/api/i/note-cleanup/create')) saves.push(request.url()); });

	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Regular Expression error', { exact: true })).toBeVisible();
	expect(saves).toEqual([]);
	await page.getByTestId('modal-dialog-ok').click();
	await flagsInput.fill('i');
	const saved = page.waitForResponse(response => response.url().endsWith('/api/i/note-cleanup/create'));
	await page.getByRole('button', { name: 'Save' }).click();
	expect((await saved).status()).toBe(200);
	// 생성 뒤에는 새 규칙의 편집 화면으로 이동하고 실행 구획이 보인다.
	await expect(page).toHaveURL(/\/settings\/note-cleanup\/[^/]+$/);
	await expect(nameInput).toHaveValue('Regex check');
	await expect(page.getByText('Notes to be deleted', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Clean up now' })).toBeVisible();
	await expect(page.getByText('Keep cleaning up automatically', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
	await page.goto(`${BASE_URL}/settings/note-cleanup`);
	await expect(page.getByRole('link', { name: 'Regex check' })).toBeVisible();
});
