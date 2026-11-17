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

// 실제 마우스 끌기를 먼저 시도하고, 순서 변경이 확인되지 않으면 같은 경로를 실제 DataTransfer를 실은 DragEvent로 흘려보낸다.
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

test('switching a group between match all and match any keeps its conditions', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	const alice = await registerUser('alice', 'alice1234');
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	const { rule } = await api(BASE_URL, 'i/note-cleanup/create', { i: alice.token, name: 'Switch check', action: 'delete', condition: keywordCondition('apple') });
	await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
	const root = page.locator('[data-condition-path=""]');
	await root.locator('textarea').waitFor();
	await page.getByRole('button', { name: 'Add condition' }).click();
	const first = page.locator('[data-condition-path="0"]');
	const second = page.locator('[data-condition-path="1"]');
	await expect(second.locator('textarea')).toBeVisible();
	await second.locator('textarea').fill('pear');
	const firstHandle = (await first.elementHandle())!;
	const secondHandle = (await second.elementHandle())!;
	await markHandle(firstHandle, 'switch');
	await markHandle(secondHandle, 'switch');
	const typeSelect = root.locator('> div:first-child [aria-label="Condition"][role="button"]');
	await typeSelect.click();
	const anyItem = page.getByRole('menuitem', { name: 'Match any', exact: true });
	await expect(anyItem).toHaveCount(1);
	await anyItem.click();
	await expect(typeSelect).toHaveText('Match any');
	await expect(first.locator('textarea')).toHaveValue('apple');
	await expect(second.locator('textarea')).toHaveValue('pear');
	await typeSelect.click();
	const allItem = page.getByRole('menuitem', { name: 'Match all', exact: true });
	await expect(allItem).toHaveCount(1);
	await allItem.click();
	await expect(typeSelect).toHaveText('Match all');
	await expect(first.locator('textarea')).toHaveValue('apple');
	await expect(second.locator('textarea')).toHaveValue('pear');
	expect(await intactHandle(firstHandle, 'switch')).toBe(true);
	expect(await intactHandle(secondHandle, 'switch')).toBe(true);
	await dragCondition(page, '1', '0', false, async () => (await page.locator('[data-condition-path="0"] textarea').inputValue()) === 'pear');
	const saved = page.waitForResponse(response => response.url().endsWith('/api/i/note-cleanup/update'));
	await page.getByRole('button', { name: 'Save' }).click();
	const response = await saved;
	expect(response.status()).toBe(200);
	const target = { mode: 'literal', flags: '', targets: ['text', 'cw', 'poll'] };
	expect(response.request().postDataJSON().condition).toEqual({
		type: 'all',
		children: [{ type: 'keyword', value: 'pear', ...target }, { type: 'keyword', value: 'apple', mode: 'literal', flags: '', targets: ['text'] }],
	});
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

test('preview reads on past a range with no matching notes', async ({ page }) => {
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
	// 첫 범위가 비어 있으면 후보가 나올 때까지 이어 읽는다.
	await expect(page.getByText('needle target')).toBeVisible();
});

test('preview stops auto-reading after a few empty ranges and continues from the cursor after a failure', async ({ page }) => {
	test.setTimeout(180_000);
	await resetState();
	await registerUser('admin', 'pass', true);
	const alice = await registerUser('alice', 'alice1234');
	// 첫 후보 앞에 일치하지 않는 노트가 자동으로 이어 읽는 범위보다 많다.
	for (let batch = 0; batch < 35; batch++) {
		await Promise.all(Array.from({ length: 10 }, (_, j) => api(BASE_URL, 'notes/create', { i: alice.token, text: `plain note ${batch * 10 + j}` })));
	}
	await api(BASE_URL, 'notes/create', { i: alice.token, text: 'needle target' });
	const { rule } = await api(BASE_URL, 'i/note-cleanup/create', { i: alice.token, name: 'Cap check', action: 'delete', condition: keywordCondition('needle') });
	const afterIds: (string | null)[] = [];
	let failed = false;
	await page.route('**/api/i/note-cleanup/preview', async route => {
		const afterId = route.request().postDataJSON().afterId ?? null;
		afterIds.push(afterId);
		// 네 번째 요청은 요청 한도에 걸린 것처럼 한 번 실패시킨다.
		if (afterIds.length === 4 && !failed) {
			failed = true;
			await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED', id: 'd5e5b2a5-f0cd-4f6b-9cb6-9b6a6a8a1d11' } }) });
			return;
		}
		await route.continue();
	});
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
	const section = page.getByText('Notes to be deleted', { exact: true }).locator('..');
	const more = section.getByRole('button', { name: 'Load more' });
	await expect(more).toBeVisible();
	// 자동으로는 3번까지만 읽고, 빈 문구 없이 더 보기만 보인다.
	expect(afterIds).toHaveLength(3);
	// 빈 문구는 타임라인이 마운트된 채 DOM에 남아 있되 숨겨져 있어야 한다.
	await expect(section.getByText('No notes', { exact: true })).toBeAttached();
	await expect(section.getByText('No notes', { exact: true })).toBeHidden();
	await more.click();
	await expect(section.getByRole('button', { name: 'Retry' })).toBeVisible();
	await section.getByRole('button', { name: 'Retry' }).click();
	// 다시 시도는 처음이 아니라 실패한 요청의 커서에서 이어 읽는다.
	await expect(page.getByText('needle target')).toBeVisible();
	expect(afterIds[4]).toBe(afterIds[3]);
	expect(afterIds[3]).not.toBeNull();
});

test('first save moves the current router to the edit path in the page and in an app window', async ({ page }) => {
	test.setTimeout(120_000);
	await resetState();
	await registerUser('admin', 'pass', true);
	await registerUser('alice', 'alice1234');
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	const fillAndSave = async () => {
		await page.getByText('Rule name', { exact: true }).locator('..').locator('input').fill('Router check');
		await page.locator('textarea').fill('apple');
		await page.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByRole('button', { name: 'Clean up now' })).toBeVisible();
	};
	// 본 화면: 주소와 라우터의 현재 경로가 편집 경로가 되고, 뒤로 가기는 목록으로 간다.
	await page.goto(`${BASE_URL}/settings/note-cleanup`);
	await page.getByRole('link', { name: 'Create rule' }).first().click();
	await fillAndSave();
	await expect(page).toHaveURL(/\/settings\/note-cleanup\/(?!new)[^/?]+$/);
	const editPath = new URL(page.url()).pathname;
	await page.getByText('Notes to be deleted', { exact: true }).click({ button: 'right' });
	await expect(page.getByText(editPath, { exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.goBack();
	await expect(page).toHaveURL(`${BASE_URL}/settings/note-cleanup`);
	// 앱 안 창: 뒤의 본 화면 주소는 그대로이고 창의 경로가 편집 경로가 되어 다시 읽어도 저장된 규칙이 열린다.
	await page.getByRole('link', { name: 'Router check' }).first().waitFor();
	await page.getByRole('link', { name: 'Create rule' }).first().click({ modifiers: ['Shift'] });
	await page.locator('textarea').waitFor();
	await fillAndSave();
	await expect(page).toHaveURL(`${BASE_URL}/settings/note-cleanup`);
	await page.locator('i.ti-reload').first().click();
	await expect(page.getByRole('button', { name: 'Clean up now' })).toBeVisible();
	await expect(page.getByText('Rule name', { exact: true }).locator('..').locator('input')).toHaveValue('Router check');
});

test('saving an existing rule keeps the scroll position and the editor nodes', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	const alice = await registerUser('alice', 'alice1234');
	const condition = { type: 'all', children: [keywordCondition('seed'), { type: 'age', seconds: 86400, operator: 'gte' }, { type: 'count', field: 'reactions', operator: 'gte', value: 0 }] };
	const { rule } = await api(BASE_URL, 'i/note-cleanup/create', { i: alice.token, name: 'Scroll check', action: 'delete', condition });
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
	await page.locator('textarea').first().waitFor();
	await page.getByText('Notes to be deleted', { exact: true }).waitFor();
	// 미리 보기 첫 읽기가 끝나 빈 문구가 자리 잡은 뒤 위치를 잰다.
	await page.getByText('No notes', { exact: true }).waitFor();
	await page.locator('textarea').first().fill('seed edited');
	// 저장 버튼이 보이는 편집 화면 아래쪽으로 스크롤한 상태에서 저장한다.
	await page.evaluate(() => {
		const sc = document.querySelector('._pageScrollable')!;
		const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent ?? '').trim() === 'Save')!;
		sc.scrollTop = btn.getBoundingClientRect().top + sc.scrollTop - sc.getBoundingClientRect().top - 200;
		document.querySelector('textarea')!.setAttribute('data-mark', '1');
	});
	// 클릭이 저장 버튼을 보이게 하려고 스스로 스크롤하지 않도록, 먼저 같은 조작으로 버튼을 가리는 것 없이 보이는 위치에 둔다.
	await page.getByRole('button', { name: 'Save' }).hover();
	await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	const before = await page.evaluate(() => document.querySelector('._pageScrollable')!.scrollTop);
	expect(before).toBeGreaterThan(100);
	// 저장 뒤 목록 응답이 늦어도 화면 갱신(applyRule)이 끝난 뒤에 위치와 노드를 비교하도록 목록 응답을 길게 보류한다.
	let listFinishedAt = 0;
	await page.route('**/api/i/note-cleanup/list', async route => {
		await new Promise(resolve => setTimeout(resolve, 1500));
		await route.continue();
		listFinishedAt = Date.now();
	});
	const saved = page.waitForResponse(response => response.url().endsWith('/api/i/note-cleanup/update'));
	const listed = page.waitForResponse(response => response.url().endsWith('/api/i/note-cleanup/list'));
	const previewed = page.waitForResponse(response => response.url().endsWith('/api/i/note-cleanup/preview'));
	await page.getByRole('button', { name: 'Save' }).click();
	expect((await saved).status()).toBe(200);
	expect((await listed).status()).toBe(200);
	// 목록 응답 뒤 applyRule이 끝나 저장 완료 알림이 뜨고, 미리 보기 다시 읽기가 끝나 빈 결과가 화면에 자리 잡은 뒤에 위치와 노드를 비교한다.
	await expect(page.getByText('Saved', { exact: true })).toBeVisible();
	expect((await previewed).status()).toBe(200);
	const previewSection = page.getByText('Notes to be deleted', { exact: true }).locator('..');
	await expect(previewSection.getByText('No notes', { exact: true })).toBeVisible();
	await expect(previewSection.locator('svg[viewBox="0 0 50 50"]')).toHaveCount(0);
	expect(listFinishedAt).toBeGreaterThan(0);
	const after = await page.evaluate(() => ({ top: document.querySelector('._pageScrollable')!.scrollTop, markAlive: document.querySelector('textarea[data-mark="1"]')?.isConnected ?? false }));
	expect(Math.abs(after.top - before)).toBeLessThanOrEqual(2);
	expect(after.markAlive).toBe(true);
});

test('the rule editor shows an error and retry when loading fails instead of a blank screen', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	const alice = await registerUser('alice', 'alice1234');
	const { rule } = await api(BASE_URL, 'i/note-cleanup/create', { i: alice.token, name: 'Load check', action: 'delete', condition: keywordCondition('seed') });
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	let failList = true;
	await page.route('**/api/i/note-cleanup/list', async route => {
		if (failList) {
			await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Internal error.', code: 'INTERNAL_ERROR', id: '5d37db75-3b73-4f9b-9a8e-2c1f4a6b8d0e' } }) });
			return;
		}
		await route.continue();
	});
	await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
	// 빈 화면이 아니라 목록과 같은 방식의 오류와 다시 시도를 보인다.
	await expect(page.getByRole('alert')).toContainText('Could not confirm the operation. Please retry.');
	await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
	expect(await page.locator('textarea').count()).toBe(0);
	failList = false;
	await page.getByRole('button', { name: 'Retry' }).click();
	await page.locator('textarea').first().waitFor();
	await expect(page.getByText('Notes to be deleted', { exact: true })).toBeVisible();
});

test('busy errors show the right message without a retry button', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	const alice = await registerUser('alice', 'alice1234');
	const { rule } = await api(BASE_URL, 'i/note-cleanup/create', { i: alice.token, name: 'Busy check', action: 'delete', condition: keywordCondition('seed') });
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	// 읽기 화면 혼잡(첫 방문 초기화 예외): 다시 시도 버튼 없이 문구만 보인다.
	await page.route('**/api/i/note-cleanup/list', async route => {
		await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'x', code: 'CLEANUP_BUSY', id: 'x', kind: 'server' } }) });
	});
	await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
	await expect(page.getByRole('alert')).toContainText('Note cleanup is busy. Please wait a moment and try again.');
	expect(await page.getByRole('button', { name: 'Retry' }).count()).toBe(0);
	await page.unroute('**/api/i/note-cleanup/list');
	// 쓰기 혼잡: 같은 계정 진행 중과 서버 전체 상한을 구분해 알리고 둘 다 다시 시도 버튼이 없다.
	for (const [code, message] of [
		['CLEANUP_IN_PROGRESS', 'Note cleanup is running now. You can do this once it finishes.'],
		['CLEANUP_BUSY', 'Note cleanup is busy. Please wait a moment and try again.'],
	] as const) {
		await page.route('**/api/i/note-cleanup/update', async route => {
			await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'x', code, id: 'x', kind: 'server' } }) });
		});
		await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
		await page.locator('textarea').first().waitFor();
		await page.getByRole('button', { name: 'Save' }).click();
		// 혼잡 오류는 조건 구역이 아니라 오류 대화상자로 한 번 보이고, 다시 시도 버튼이 없다.
		await expect(page.getByTestId('modal-dialog-ok')).toBeVisible();
		await expect(page.getByText(message, { exact: true })).toBeVisible();
		expect(await page.getByRole('alert').count()).toBe(0);
		await page.getByTestId('modal-dialog-ok').click();
		await page.unroute('**/api/i/note-cleanup/update');
	}
});

test('condition errors stay in the condition section while other write failures alert', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	const alice = await registerUser('alice', 'alice1234');
	const { rule } = await api(BASE_URL, 'i/note-cleanup/create', { i: alice.token, name: 'Condition check', action: 'delete', condition: keywordCondition('seed') });
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	// 조건 오류(사라진 클립 참조)는 조건 구역 경고로 보이고 대화상자는 뜨지 않는다.
	await page.route('**/api/i/note-cleanup/update', async route => {
		await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVALID_CLEANUP', info: { code: 'MISSING_CLIP', path: 'condition.children.0', referenceId: 'secret' } } }) });
	});
	await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
	await page.locator('textarea').first().waitFor();
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('alert')).toContainText('A selected clip is unavailable.');
	expect(await page.getByTestId('modal-dialog-ok').count()).toBe(0);
	await page.unroute('**/api/i/note-cleanup/update');
	// 조건과 무관한 일반 실패는 대화상자로 한 번 보인다.
	await page.route('**/api/i/note-cleanup/update', async route => {
		await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'x', id: 'x' } }) });
	});
	await page.goto(`${BASE_URL}/settings/note-cleanup/${rule.id}`);
	await page.locator('textarea').first().waitFor();
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByTestId('modal-dialog-ok')).toBeVisible();
	await expect(page.getByText('Could not confirm the operation. Please retry.', { exact: true })).toBeVisible();
	expect(await page.getByRole('alert').count()).toBe(0);
	await page.getByTestId('modal-dialog-ok').click();
});

test('the rule list hides retry for busy errors', async ({ page }) => {
	await resetState();
	await registerUser('admin', 'pass', true);
	await registerUser('alice', 'alice1234');
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	await page.route('**/api/i/note-cleanup/list', async route => {
		await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'x', code: 'CLEANUP_BUSY', id: 'x', kind: 'server' } }) });
	});
	await page.goto(`${BASE_URL}/settings/note-cleanup`);
	await expect(page.getByRole('alert')).toContainText('Note cleanup is busy. Please wait a moment and try again.');
	expect(await page.getByRole('button', { name: 'Retry' }).count()).toBe(0);
});

test('first save keeps scroll when a cached settings page sits behind the notification link', async ({ page }) => {
	test.setTimeout(120_000);
	await resetState();
	await registerUser('admin', 'pass', true);
	const alice = await registerUser('alice', 'alice1234');
	// 완료 알림을 만들어 알림 화면에서 노트 정리 목록으로 들어가는 링크를 둔다.
	for (let i = 0; i < 6; i++) await api(BASE_URL, 'notes/create', { i: alice.token, text: `alpha plain ${i}` });
	const { rule: seed } = await api(BASE_URL, 'i/note-cleanup/create', { i: alice.token, name: 'alpha seed', action: 'delete', condition: keywordCondition('alpha') });
	await api(BASE_URL, 'i/note-cleanup/update', { i: alice.token, ruleId: seed.id, action: 'delete', condition: keywordCondition('alpha'), enabled: true, confirmed: true });
	await api(BASE_URL, 'i/note-cleanup/request', { i: alice.token, ruleIds: [seed.id] });
	await expect.poll(async () => {
		const notes = await api(BASE_URL, 'i/notifications', { i: alice.token, limit: 20 });
		return notes.some((n: { type: string }) => n.type === 'noteCleanupCompleted');
	}, { timeout: 60_000 }).toBe(true);
	await signIn(page, 'alice', 'alice1234');
	await closeUserSetupDialog(page);
	// 설정을 한 번 연 뒤 알림으로 나갔다가 완료 알림 링크로 목록에 들어가면 설정 부모가 둘 캐시된다.
	await page.goto(`${BASE_URL}/settings`);
	await page.locator('a[href="/my/notifications"]').first().click();
	await page.getByText('Note cleanup finished', { exact: true }).first().waitFor();
	await page.locator('a[href="/settings/note-cleanup"]').first().click();
	await page.getByRole('heading', { name: 'Note cleanup', exact: true }).waitFor();
	await page.getByRole('link', { name: 'Create rule' }).first().click();
	await page.locator('textarea').first().waitFor();
	await page.getByText('Rule name', { exact: true }).locator('..').locator('input').fill('Cached parent');
	await page.locator('textarea').first().fill('beta');
	for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Add condition' }).last().click();
	const textareas = page.locator('textarea');
	const count = await textareas.count();
	for (let i = 1; i < count; i++) await textareas.nth(i).fill(`beta ${i}`);
	await page.evaluate(() => { const sc = document.querySelector('._pageScrollable')!; sc.scrollTop = sc.scrollHeight; });
	await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	const before = await page.evaluate(() => document.querySelector('._pageScrollable')!.scrollTop);
	expect(before).toBeGreaterThan(100);
	const listRequests: number[] = [];
	page.on('request', request => { if (request.url().endsWith('/api/i/note-cleanup/list')) listRequests.push(Date.now()); });
	const saveAt = Date.now();
	// 첫 저장 뒤 같은 화면의 미리 보기 첫 응답을 받고, 로딩이 빈 결과로 바뀌는 렌더까지 끝난 뒤에 스크롤과 목록 요청을 본다.
	const previewed = page.waitForResponse(response => response.url().endsWith('/api/i/note-cleanup/preview'));
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('button', { name: 'Clean up now' })).toBeVisible();
	expect((await previewed).status()).toBe(200);
	const previewSection = page.getByText('Notes to be deleted', { exact: true }).locator('..');
	await expect(previewSection.getByText('No notes', { exact: true })).toBeVisible();
	await expect(previewSection.locator('svg[viewBox="0 0 50 50"]')).toHaveCount(0);
	const after = await page.evaluate(() => document.querySelector('._pageScrollable')!.scrollTop);
	// 보이는 편집 화면이 전달값을 받아 스크롤이 유지되고 목록을 다시 읽지 않는다.
	expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
	expect(listRequests.filter(t => t >= saveAt)).toHaveLength(0);
});

test.describe('phone', () => {
	test.use({
		viewport: { width: 390, height: 844 },
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
		hasTouch: true,
	});

	test('the settings top screen keeps its footer layout after leaving the rule editor', async ({ page }) => {
		test.setTimeout(120_000);
		await resetState();
		await registerUser('admin', 'pass', true);
		await registerUser('alice', 'alice1234');
		await signIn(page, 'alice', 'alice1234');
		await closeUserSetupDialog(page);
		const bodyHeight = () => page.evaluate(() => document.querySelector('._pageScrollable')?.clientHeight ?? -1);
		await page.goto(`${BASE_URL}/settings`);
		await page.locator('a[href="/settings/note-cleanup"]').first().waitFor();
		const fresh = await bodyHeight();
		await page.locator('a[href="/settings/note-cleanup"]').first().click();
		await page.getByRole('link', { name: 'Create rule' }).first().click();
		await page.locator('textarea').waitFor();
		// 편집 화면은 하단 메뉴를 흐름 안에 둬 본문이 그만큼 줄어든다.
		expect(await bodyHeight()).toBeLessThan(fresh);
		await page.evaluate(() => history.go(-2));
		await expect(page).toHaveURL(`${BASE_URL}/settings`);
		await expect.poll(bodyHeight).toBe(fresh);
	});
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
