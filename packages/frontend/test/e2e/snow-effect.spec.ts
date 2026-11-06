/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { test, expect } from './fixtures.js';
import { api } from './shared.js';
import { BASE_URL, resetState, registerUser, signIn } from './utils.js';
import type { Page } from 'playwright';

const LAYER = '[data-snow-effect]';
const LABEL = 'Let it snow';

async function openSettings(page: Page): Promise<void> {
	await page.goto(`${BASE_URL}/settings/preferences`);
	await page.getByText('Appearance', { exact: true }).click();
	await page.getByText(LABEL, { exact: true }).waitFor();
}

async function coverPointWithSnowflake(page: Page, x: number, y: number): Promise<void> {
	await page.locator(`${LAYER} > div`).first().evaluate((flake: HTMLElement, point) => {
		for (const animation of flake.getAnimations()) animation.cancel();
		flake.style.left = `${point.x - 30}px`;
		flake.style.top = `${point.y - 30}px`;
		flake.style.width = '60px';
		flake.style.height = '60px';
		flake.style.opacity = '1';
	}, { x, y });
}

test.describe('Snow effect', () => {
	test.beforeEach(async ({ page }) => {
		await resetState();
		const user = await registerUser('alice', 'alice1234', true);
		await api(BASE_URL, 'i/registry/set', { i: user.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
		await signIn(page, 'alice', 'alice1234');
		// 로그인 뒤 다시 불러오기가 끝나야 다음 이동이 끊기지 않는다. 알림 링크는 로그인한 화면에만 있다
		await page.locator('a[href="/my/notifications"]').first().waitFor();
	});

	test('turns on and off from the settings without a reload, and stays on after one', async ({ page }) => {
		const markPage = () => page.evaluate(() => { window.document.documentElement.dataset.notReloaded = ''; });
		const isSamePage = () => page.evaluate(() => window.document.documentElement.dataset.notReloaded != null);
		// 알림 표시처럼 눈과 무관하게 도는 애니메이션은 세지 않도록, 눈 레이어 안의 애니메이션만 붙잡아 둔다.
		// 요소가 지워지면 document.getAnimations()에서 빠지므로 붙잡아 둔 객체의 상태를 본다
		const holdSnowAnimations = () => page.evaluate(() => {
			const animations = window.document.getAnimations()
				.filter(animation => (animation.effect as KeyframeEffect | null)?.target?.closest('[data-snow-effect]') != null);
			(window as unknown as { snowAnimations: Animation[] }).snowAnimations = animations;
			return animations.length;
		});
		const unstoppedSnowAnimationCount = () => page.evaluate(() => (window as unknown as { snowAnimations: Animation[] }).snowAnimations
			.filter(animation => animation.playState !== 'idle')
			.length);

		await openSettings(page);
		await expect(page.locator(LAYER)).toHaveCount(0);

		await markPage();
		await page.getByText(LABEL, { exact: true }).click();
		await expect(page.locator(LAYER)).toHaveCount(1);
		await expect.poll(() => page.locator(`${LAYER} > div`).count()).toBeGreaterThan(0);
		expect(await isSamePage()).toBe(true);

		await page.reload();
		await expect(page.locator(LAYER)).toHaveCount(1);
		await expect.poll(() => page.locator(`${LAYER} > div`).count()).toBeGreaterThan(0);
		expect(await holdSnowAnimations()).toBeGreaterThan(0);

		await page.getByText('Appearance', { exact: true }).click();
		await markPage();
		await page.getByText(LABEL, { exact: true }).click();
		await expect(page.locator(LAYER)).toHaveCount(0);
		expect(await unstoppedSnowAnimationCount()).toBe(0);
		expect(await isSamePage()).toBe(true);
	});

	test('lets clicks reach the link under a snowflake', async ({ page }) => {
		await openSettings(page);
		await page.getByText(LABEL, { exact: true }).click();
		await expect(page.locator(LAYER)).toHaveCount(1);

		// 설정 화면은 스크롤 위치가 바뀔 수 있으므로 고정된 사이드바의 링크를 쓴다
		const link = page.locator('a[href="/my/notifications"]').first();
		const box = (await link.boundingBox())!;
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		await coverPointWithSnowflake(page, x, y);
		expect(await page.locator(`${LAYER} > div`).first().evaluate((flake, point) => {
			const rect = flake.getBoundingClientRect();
			return rect.left <= point.x && point.x <= rect.right && rect.top <= point.y && point.y <= rect.bottom;
		}, { x, y })).toBe(true);
		expect(await page.evaluate(point => window.document.elementFromPoint(point.x, point.y)?.closest('a')?.getAttribute('href'), { x, y })).toBe('/my/notifications');

		await page.mouse.click(x, y);

		await expect(page).toHaveURL(/\/my\/notifications/);
	});

	test('follows the reduced motion setting of the device while on', async ({ page }) => {
		await openSettings(page);
		await page.getByText(LABEL, { exact: true }).click();
		await expect(page.locator(LAYER)).toHaveCount(1);

		await page.emulateMedia({ reducedMotion: 'reduce' });
		await expect(page.locator(LAYER)).toHaveCount(0);

		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await expect(page.locator(LAYER)).toHaveCount(1);
	});

	test('does not change the document size', async ({ page }) => {
		await openSettings(page);
		const documentSize = () => page.evaluate(() => {
			const root = window.document.documentElement;
			return [root.scrollWidth, root.scrollHeight, root.clientWidth, root.clientHeight];
		});
		const before = await documentSize();

		await page.getByText(LABEL, { exact: true }).click();
		await expect(page.locator(LAYER)).toHaveCount(1);

		expect(await documentSize()).toEqual(before);
	});

	test('does not snow in a popout window', async ({ page }) => {
		await openSettings(page);
		await page.getByText(LABEL, { exact: true }).click();
		await expect(page.locator(LAYER)).toHaveCount(1);

		await page.goto(`${BASE_URL}/settings/preferences?zen`);
		await page.getByText('Appearance', { exact: true }).waitFor();

		await expect(page.locator(LAYER)).toHaveCount(0);
	});
});
