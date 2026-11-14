/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from './fixtures.js';
import { api } from './shared.js';
import { BASE_URL, closeUserSetupDialog, registerUser, resetState, signIn } from './utils.js';
import type { ElementHandle, Page } from 'playwright';

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
	// 유일한 체크박스는 첨부 파일 보존 설정 스위치이며 기본값은 켜짐이다.
	const keepDriveFiles = page.getByRole('checkbox', { name: 'Keep attachments of deleted notes in the drive' });
	await expect(keepDriveFiles).toBeChecked();
	await expect(page.locator('input[type="checkbox"]')).toHaveCount(1);
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

test('saves the drive files choice from the list switch', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	await registerUser('alice', 'alice1234');
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	await page.goto(`${BASE_URL}/settings/note-cleanup`);
	const keepDriveFiles = page.getByRole('checkbox', { name: 'Keep attachments of deleted notes in the drive' });
	await expect(keepDriveFiles).toBeChecked();
	const label = page.getByText('Keep attachments of deleted notes in the drive', { exact: true });

	const turnedOff = page.waitForResponse(response => response.url().endsWith('/api/i/note-cleanup/update-settings'));
	await label.click();
	await expect(keepDriveFiles).not.toBeChecked();
	const offResponse = await turnedOff;
	expect(offResponse.status()).toBe(200);
	expect(offResponse.request().postDataJSON()).toMatchObject({ keepDriveFiles: false });

	// 새로고침 뒤에도 꺼진 상태가 유지된다.
	await page.reload();
	const reloaded = page.getByRole('checkbox', { name: 'Keep attachments of deleted notes in the drive' });
	await reloaded.waitFor({ state: 'attached' });
	await expect(reloaded).not.toBeChecked();
});

//#region Drag & editor state helpers
async function markHandle(handle: ElementHandle, token: string): Promise<void> {
	await handle.evaluate((el, t) => (el as Element).setAttribute('data-e2e-mark', t), token);
}

async function intactHandle(handle: ElementHandle, token: string): Promise<boolean> {
	return handle.evaluate((el, t) => el.isConnected && (el as Element).getAttribute('data-e2e-mark') === t, token).catch(() => false);
}

// 실제 마우스 끌기를 먼저 시도하고, 순서 변경가 확인되지 않으면 같은 경로를 실제 DataTransfer를 실은 DragEvent로 흘려보낸다.
// 두 경로 모두 앱의 setDragData/getDragData 직렬화를 그대로 지난다.
async function dragCondition(page: Page, fromPath: string, toPath: string, backward: boolean, reordered: () => Promise<boolean>): Promise<'native' | 'dispatched'> {
	const handle = page.locator(`[data-condition-path="${fromPath}"] button[aria-label="Move to another group"]`);
	const target = page.locator(`[data-condition-path="${toPath}"]`);
	const hb = await handle.boundingBox();
	const tb = await target.boundingBox();
	if (hb && tb) {
		await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
		await page.mouse.down();
		await page.mouse.move(hb.x + hb.width / 2 + 8, hb.y + hb.height / 2 + 8, { steps: 4 });
		// MkDraggable은 dragstart 10ms 뒤에 드롭 영역을 활성화한다.
		await page.waitForTimeout(200);
		await page.mouse.move(tb.x + tb.width / 2, tb.y + (backward ? tb.height * 0.85 : tb.height * 0.15), { steps: 12 });
		await page.waitForTimeout(200);
		await page.mouse.up();
		await page.waitForTimeout(300);
		if (await reordered()) return 'native';
	}
	await page.evaluate(({ fromPath, toPath, backward }) => {
		const from = document.querySelector(`[data-condition-path="${fromPath}"]`)!;
		const to = document.querySelector(`[data-condition-path="${toPath}"]`)!;
		const handle = from.querySelector('button[aria-label="Move to another group"]')!;
		const dataTransfer = new DataTransfer();
		handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
		const wrapper = to.parentElement!.parentElement!;
		const area = backward ? wrapper.nextElementSibling! : wrapper.previousElementSibling!;
		area.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
		area.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
		handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
	}, { fromPath, toPath, backward });
	await page.waitForTimeout(300);
	if (!(await reordered())) throw new Error(`drag did not reorder: ${fromPath} -> ${toPath}`);
	return 'dispatched';
}

const keywordCondition = (value: string) => ({ type: 'keyword', mode: 'literal', value, flags: '', targets: ['text'] });
//#endregion

test('dragging a condition within a group keeps nodes, editor state and saved format', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	const alice = await registerUser('alice', 'alice1234');
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	const condition = { type: 'all', children: [{ type: 'age', seconds: 86400, operator: 'gte' }, keywordCondition('seed')] };
	const { rule } = await api(BASE_URL, 'i/note-cleanup/create', { i: alice.token, name: 'Drag check', action: 'delete', condition });
	await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
	const ageSection = page.locator('[data-condition-path="0"]');
	await ageSection.waitFor();
	// 1일을 시간 단위로 바꾸고 수량 24를 입력하면 24시간이 표시된다.
	await ageSection.locator('[aria-label="Time unit"][role="button"]').click();
	await page.getByRole('menuitem', { name: 'Hours', exact: true }).click();
	const qty = ageSection.locator('input[type="number"]');
	await qty.fill('24');
	await expect(qty).toHaveValue('24');
	// 키워드 조건의 고급 설정을 펼쳐 둔다.
	const kwSection = page.locator('[data-condition-path="1"]');
	await kwSection.getByTestId('folder-header').click();
	await expect(kwSection.getByTestId('switch-toggle')).toBeVisible();
	const ageHandle = (await ageSection.elementHandle())!;
	const kwHandle = (await kwSection.elementHandle())!;
	const qtyHandle = (await qty.elementHandle())!;
	const regexHandle = (await kwSection.getByTestId('switch-toggle').elementHandle())!;
	await markHandle(ageHandle, 'drag');
	await markHandle(kwHandle, 'drag');
	await markHandle(qtyHandle, 'drag');
	await markHandle(regexHandle, 'drag');
	const path = await dragCondition(page, '0', '1', true, async () =>
		(await page.locator('[data-condition-path="0"] textarea').count()) === 1 && (await page.locator('[data-condition-path="1"] input[type="number"]').count()) === 1);
	expect(['native', 'dispatched']).toContain(path);
	// 순서가 바뀌어도 수량·단위 표시와 펼쳐 둔 고급 설정, 노드 정체성이 유지된다.
	await expect(page.locator('[data-condition-path="0"] textarea')).toHaveValue('seed');
	const ageAfter = page.locator('[data-condition-path="1"]');
	await expect(ageAfter.locator('input[type="number"]')).toHaveValue('24');
	await expect(ageAfter.locator('[aria-label="Time unit"][role="button"]')).toHaveText('Hours');
	const kwAfter = page.locator('[data-condition-path="0"]');
	await expect(kwAfter.getByTestId('switch-toggle')).toBeVisible();
	await expect(kwAfter.locator('div[role="group"]')).toHaveAttribute('aria-expanded', 'true');
	expect(await intactHandle(ageHandle, 'drag')).toBe(true);
	expect(await intactHandle(kwHandle, 'drag')).toBe(true);
	expect(await intactHandle(qtyHandle, 'drag')).toBe(true);
	expect(await intactHandle(regexHandle, 'drag')).toBe(true);
	const saved = page.waitForResponse(response => response.url().endsWith('/api/i/note-cleanup/update'));
	await page.getByRole('button', { name: 'Save' }).click();
	const response = await saved;
	expect(response.status()).toBe(200);
	expect(response.request().postDataJSON().condition).toEqual({ type: 'all', children: [keywordCondition('seed'), { type: 'age', seconds: 86400, operator: 'gte' }] });
});

test('editing a keyword inside a group keeps focus and nodes', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	const alice = await registerUser('alice', 'alice1234');
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	const { rule } = await api(BASE_URL, 'i/note-cleanup/create', { i: alice.token, name: 'Focus check', action: 'delete', condition: { type: 'all', children: [keywordCondition('seed')] } });
	await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
	const section = page.locator('[data-condition-path="0"]');
	await section.waitFor();
	const textarea = section.locator('textarea');
	const sectionHandle = (await section.elementHandle())!;
	const textareaHandle = (await textarea.elementHandle())!;
	await markHandle(sectionHandle, 'edit');
	await markHandle(textareaHandle, 'edit');
	await textarea.click();
	await textarea.pressSequentially(' cat');
	await expect(textarea).toHaveValue('seed cat');
	expect(await textareaHandle.evaluate(el => document.activeElement === el)).toBe(true);
	expect(await intactHandle(sectionHandle, 'edit')).toBe(true);
	expect(await intactHandle(textareaHandle, 'edit')).toBe(true);
});

test('preview advances past a range with no matching notes', async ({ page }) => {
	test.setTimeout(120_000);
	await resetState();
	await registerUser('admin', 'pass', true);
	const alice = await registerUser('alice', 'alice1234');
	// 첫 페이지(오래된 100개)에는 일치하는 노트가 없고 그 뒤에 일치하는 노트가 하나 있다.
	for (let batch = 0; batch < 10; batch++) {
		await Promise.all(Array.from({ length: 10 }, (_, j) => api(BASE_URL, 'notes/create', { i: alice.token, text: `plain note ${batch * 10 + j}` })));
	}
	await api(BASE_URL, 'notes/create', { i: alice.token, text: 'needle target' });
	const { rule } = await api(BASE_URL, 'i/note-cleanup/create', { i: alice.token, name: 'Range check', action: 'delete', condition: keywordCondition('needle') });
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
	await page.getByText('Notes to be deleted', { exact: true }).waitFor();
	const more = page.locator('fieldset').getByRole('button', { name: 'Load more', exact: true });
	await expect(more).toBeVisible();
	await more.click();
	await expect(page.getByText('needle target')).toBeVisible();
});

test('first automatic enable waits for a successful preview', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	const alice = await registerUser('alice', 'alice1234');
	const condition = keywordCondition('auto-check');
	const { rule } = await api(BASE_URL, 'i/note-cleanup/create', { i: alice.token, name: 'Auto check', action: 'delete', condition });
	await api(BASE_URL, 'i/note-cleanup/update', { i: alice.token, ruleId: rule.id, action: 'delete', condition, enabled: true, confirmed: true });
	// 서버도 확인 없는 최초 자동 켜기를 거부한다.
	const premature = await fetch(`${BASE_URL}/api/i/note-cleanup/update`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ i: alice.token, ruleId: rule.id, action: 'delete', condition, automatic: true }),
	});
	expect(premature.status).toBe(400);
	expect((await premature.json()).error.info.code).toBe('PREVIEW_REQUIRED');
	// 실제 미리 보기 응답을 늦춰 첫 페이지 도착 전후의 스위치 상태를 관찰한다.
	await page.route('**/api/i/note-cleanup/preview', async route => {
		await new Promise(resolve => setTimeout(resolve, 2000));
		await route.continue();
	});
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
	const autoRoot = page.getByText('Keep cleaning up automatically', { exact: true }).locator('..').locator('..').locator('..');
	const autoInput = autoRoot.locator('input[type="checkbox"]');
	await autoInput.waitFor({ state: 'attached' });
	await expect(autoInput).toBeDisabled();
	await expect(autoInput).toBeEnabled({ timeout: 15_000 });
	const updates: { automatic?: boolean; confirmed?: boolean }[] = [];
	page.on('request', request => { if (request.url().endsWith('/api/i/note-cleanup/update')) updates.push(request.postDataJSON()); });
	await autoRoot.getByTestId('switch-toggle').click();
	await page.getByTestId('modal-dialog-ok').click();
	// 네이티브 체크박스는 접근용이라 checked가 모델과 연결되지 않는다. 저장 결과로 켜짐을 판정한다.
	await expect.poll(async () => {
		const { rules } = await api(BASE_URL, 'i/note-cleanup/list', { i: alice.token });
		return rules.find((r: { id: string; automatic?: boolean }) => r.id === rule.id)?.automatic;
	}, { timeout: 15_000 }).toBe(true);
	expect(updates.some(body => body.automatic === true && body.confirmed === true)).toBe(true);
});
