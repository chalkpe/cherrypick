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
import type { CDPSession, Page } from 'playwright';

const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
// iPhone의 홈 표시줄이 차지하는 아래 안전 영역
const SAFE_AREA_BOTTOM = 34;
// 소프트웨어 키보드가 올라온 만큼 줄어든 화면 높이
const KEYBOARD_HEIGHT = 300;

test.describe('the bottom of a conversation while the software keyboard is open', () => {
	let alice: RegisteredUser;
	let bob: RegisteredUser;
	let roomId: string;

	test.beforeAll(async () => {
		await resetState();
		await registerUser('admin', 'pass', true);
		alice = await registerUser('alice', 'alice1234');
		bob = await registerUser('bob', 'bob12345');
		for (const user of [alice, bob]) {
			await api(BASE_URL, 'i/registry/set', { i: user.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
			await api(BASE_URL, 'i/update', { i: user.token, chatScope: 'everyone' });
		}
		const room = await api(BASE_URL, 'chat/rooms/create', { i: alice.token, name: 'weekend walk' }) as { id: string };
		await api(BASE_URL, 'chat/rooms/invitations/create', { i: alice.token, roomId: room.id, userId: bob.id });
		await api(BASE_URL, 'chat/rooms/join', { i: bob.token, roomId: room.id });
		roomId = room.id;
		for (let i = 1; i <= 5; i++) {
			await api(BASE_URL, 'chat/messages/create-to-user', { i: alice.token, toUserId: bob.id, text: `message ${i}` });
		}
	});

	test.beforeEach(async ({ page }) => {
		await signIn(page, 'alice', 'alice1234');
		// ログインが終わるとホームタイムラインのヒントが出るので、それまで次の画面へ移らない
		await page.getByRole('button', { name: 'Got it!' }).click();
	});

	test.use({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
		userAgent: iphoneUA,
	});

	// 실제 기기의 안전 영역을 Chromium에 싣는다
	async function loadSafeArea(page: Page): Promise<CDPSession> {
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: SAFE_AREA_BOTTOM, right: 0 } });
		return cdp;
	}

	// 하단 메뉴의 아이콘 줄 아래에 남은 빈 공간과, 입력란과 메뉴 사이의 거리를 잰다
	function measure(page: Page) {
		return page.evaluate(() => {
			const footer = [...window.document.querySelectorAll('i.ti-apps')]
				.map(icon => icon.closest('button')?.parentElement)
				.find(el => el != null && el.querySelectorAll(':scope > button').length >= 4)!;
			const rect = footer.getBoundingClientRect();
			const iconsBottom = Math.max(...[...footer.querySelectorAll(':scope > button')].map(button => button.getBoundingClientRect().bottom));
			const form = window.document.querySelector('textarea')?.parentElement;
			return {
				gapBelowIcons: rect.bottom - iconsBottom,
				footerTop: rect.top,
				formBottom: form?.getBoundingClientRect().bottom ?? null,
				viewportBottom: window.innerHeight,
			};
		});
	}

	// 화면 키보드는 시험에서 띄울 수 없으므로, 입력란에 포커스를 두고 키보드 높이만큼 화면을 줄여 같은 상황을 만든다
	async function openKeyboard(page: Page): Promise<void> {
		const { width, height } = page.viewportSize()!;
		await page.setViewportSize({ width, height: height - KEYBOARD_HEIGHT });
		await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(height - KEYBOARD_HEIGHT);
	}

	async function closeKeyboard(page: Page): Promise<void> {
		await page.evaluate(() => {
			if (window.document.activeElement instanceof HTMLElement) window.document.activeElement.blur();
		});
		const { width, height } = page.viewportSize()!;
		await page.setViewportSize({ width, height: height + KEYBOARD_HEIGHT });
		await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(height + KEYBOARD_HEIGHT);
	}

	function expectHomeIndicatorSpace(gap: number): void {
		expect(gap).toBeGreaterThanOrEqual(SAFE_AREA_BOTTOM - 1);
		expect(gap).toBeLessThanOrEqual(SAFE_AREA_BOTTOM + 1);
	}

	// 키보드를 열고 닫는 동작은 화면 크기 변화 이벤트로 처리되므로 한 박자 늦게 반영될 수 있다. 반영될 때까지 기다리며 잰다
	async function expectGapWhenOpen(page: Page): Promise<void> {
		await expect.poll(async () => (await measure(page)).gapBelowIcons, { timeout: 3000 }).toBeLessThanOrEqual(1);
	}

	async function expectGapWhenClosed(page: Page): Promise<void> {
		await expect.poll(async () => (await measure(page)).gapBelowIcons, { timeout: 3000 }).toBeGreaterThanOrEqual(SAFE_AREA_BOTTOM - 1);
		expect((await measure(page)).gapBelowIcons).toBeLessThanOrEqual(SAFE_AREA_BOTTOM + 1);
	}

	for (const kind of ['user', 'room'] as const) {
		test(`${kind}: the menu and the input sit directly above the keyboard, and regain the home indicator space when it closes`, async ({ page }) => {
			await loadSafeArea(page);
			await page.goto(kind === 'user' ? `${BASE_URL}/chat/user/${bob.id}` : `${BASE_URL}/chat/room/${roomId}`);
			const input = page.getByPlaceholder('Enter message here');
			await expect(input).toBeVisible();

			// 키보드가 닫힌 동안에는 홈 표시줄 여백이 그대로
			expectHomeIndicatorSpace((await measure(page)).gapBelowIcons);

			await input.tap();
			await openKeyboard(page);

			// 키보드가 홈 표시줄 자리를 덮었으므로 메뉴 아래에 빈 공간이 없어야 한다
			await expectGapWhenOpen(page);
			const open = await measure(page);
			// 입력란도 메뉴 바로 위에 붙는다 (메뉴가 줄어든 만큼 함께 줄어야 한다)
			expect(Math.abs(open.footerTop - open.formBottom!)).toBeLessThanOrEqual(2);
			expect(open.viewportBottom - open.footerTop).toBeLessThanOrEqual(52);

			await closeKeyboard(page);

			// 키보드가 닫히면 홈 표시줄 여백이 돌아온다
			await expectGapWhenClosed(page);
		});
	}

	test('the universal UI conversation also sits directly above the keyboard', async ({ page }) => {
		await page.addInitScript(() => window.localStorage.setItem('ui', 'default'));
		await loadSafeArea(page);
		await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
		const input = page.getByPlaceholder('Enter message here');
		await expect(input).toBeVisible();

		expectHomeIndicatorSpace((await measure(page)).gapBelowIcons);

		await input.tap();
		await openKeyboard(page);

		await expectGapWhenOpen(page);
		const open = await measure(page);
		expect(Math.abs(open.footerTop - open.formBottom!)).toBeLessThanOrEqual(2);

		await closeKeyboard(page);
		await expectGapWhenClosed(page);
	});

	test('a screen outside the conversation keeps the home indicator space while its keyboard is open', async ({ page }) => {
		await loadSafeArea(page);
		await page.goto(`${BASE_URL}/`);
		// 홈의 플로팅 버튼은 노트 입력창을 연다. 그 입력란에 키보드를 띄운다
		await page.locator('button:has(i.ti-pencil)').tap();
		const input = page.locator('textarea');
		await expect(input).toBeVisible();
		await input.tap();
		await openKeyboard(page);

		await expectGapWhenClosed(page);

		await closeKeyboard(page);
		await expectGapWhenClosed(page);
	});

	// 스택 라우터: 대화가 뒤에 남은 채 다른 화면으로 SPA 이동해도, 전경 화면의 하단 안전 영역은 그대로여야 한다.
	// page.goto로 새로 로드하면 이전 대화 인스턴스가 사라져 이 경로를 검사할 수 없으므로 SPA 이동을 쓴다.
	test('stacking: a background conversation keeps the foreground home indicator space', async ({ page }) => {
		await loadSafeArea(page);
		// 부팅이 저장한 프로필에서 스택 라우터 설정을 켜고 다시 로드한다
		await page.evaluate(() => {
			const p = JSON.parse(window.localStorage.getItem('preferences')!);
			p.preferences['experimental.stackingRouterView'] = [[{}, true, {}]];
			window.localStorage.setItem('preferences', JSON.stringify(p));
		});
		await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
		const input = page.getByPlaceholder('Enter message here');
		await expect(input).toBeVisible();

		// 대화에서 키보드를 열면 자기 여백을 없앤다 (소유 정상 경로)
		await input.tap();
		await openKeyboard(page);
		await expectGapWhenOpen(page);
		await closeKeyboard(page);
		await expectGapWhenClosed(page);

		// SPA로 홈 이동. 대화는 스택에 남아 언마운트되지 않는다
		await page.locator('button:has(i.ti-home)').tap();
		await expect(page.locator('button:has(i.ti-pencil)')).toBeVisible();
		expect(await page.locator('textarea').count()).toBeGreaterThanOrEqual(1);

		// 홈의 노트 입력창에 키보드를 띄운다. 전경은 쪽지가 아니다
		await page.locator('button:has(i.ti-pencil)').tap();
		const postInput = page.locator('textarea').last();
		await expect(postInput).toBeVisible();
		await postInput.tap();
		await openKeyboard(page);

		// 뒤에 남은 대화가 변수를 쓰지 않으므로 홈은 홈 표시줄 여백을 유지한다
		await expectGapWhenClosed(page);
		const bodyVar = await page.evaluate(() => window.document.body.style.getPropertyValue('--MI-mobileFooterSafeAreaBottom'));
		expect(bodyVar).toBe('');
	});

	// 회전: 키보드가 열린 채 너비가 바뀌어도 감지가 유지되어야 한다 (줄어든 높이를 전체 기준으로 다시 잡으면 감지가 떨어진다)
	test('rotation: the keyboard stays detected when the width changes while it is open', async ({ page }) => {
		await loadSafeArea(page);
		await page.goto(`${BASE_URL}/chat/user/${bob.id}`);
		const input = page.getByPlaceholder('Enter message here');
		await expect(input).toBeVisible();

		await input.tap();
		await openKeyboard(page);
		await expectGapWhenOpen(page);

		// 키보드를 닫지 않은 채 너비만 바꾼다 (회전 모사). 높이는 키보드만큼 줄어든 상태 유지
		const { height } = page.viewportSize()!;
		await page.setViewportSize({ width: 500, height });
		await expectGapWhenOpen(page);

		await closeKeyboard(page);
		await expectGapWhenClosed(page);
	});
});
