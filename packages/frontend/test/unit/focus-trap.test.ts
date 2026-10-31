/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test } from 'vitest';
import { focusTrap } from '@/utility/focus-trap.js';

function el(parent: HTMLElement, zIndex?: number): HTMLElement {
	const child = document.createElement('div');
	if (zIndex != null) {
		child.style.position = 'fixed';
		child.style.zIndex = String(zIndex);
	}
	parent.append(child);
	return child;
}

function inertCount(): number {
	return document.querySelectorAll('[inert]').length;
}

// ページ (nav と、ステージとチャットのシートを持つ部屋) と、body 直下に出るポップアップ
function setup() {
	const app = el(document.body);
	const nav = el(app);
	const page = el(app);
	const stage = el(page);
	const sheet = el(page, 1100);
	const popupHost = el(document.body);
	return { app, nav, page, stage, sheet, popupHost };
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('focusTrap', () => {
	test('makes the siblings inert and restores them on release', () => {
		const { app, nav, stage, sheet, popupHost } = setup();
		const trap = focusTrap(sheet);
		expect(stage.inert).toBe(true);
		expect(nav.inert).toBe(true);
		expect(popupHost.inert).toBe(true);
		expect(app.inert).toBe(false);
		trap.release();
		expect(inertCount()).toBe(0);
	});

	test('keeps the page usable outside the boundary', () => {
		const { nav, page, stage, sheet, popupHost } = setup();
		const trap = focusTrap(sheet, false, page);
		expect(stage.inert).toBe(true);
		expect(nav.inert).toBe(false);
		expect(popupHost.inert).toBe(false);
		trap.release();
		expect(inertCount()).toBe(0);
	});

	test.each([true, false])('leaves nothing inert when the sheet closes under an open popup (boundary: %s)', (bounded) => {
		const { page, stage, sheet, popupHost } = setup();
		const sheetTrap = focusTrap(sheet, true, bounded ? page : null);
		const popup = el(popupHost, 2000000);
		const popupTrap = focusTrap(popup);
		// ポップアップが開いているあいだは、ポップアップの外はすべて触れない
		expect(page.parentElement!.inert).toBe(true);

		// 通話から外されるなどして、ポップアップが開いたままシートが閉じる
		sheetTrap.release();
		expect(page.parentElement!.inert).toBe(true);
		popupTrap.release();
		popup.remove();

		expect(inertCount()).toBe(0);
		expect(stage.inert).toBe(false);
	});

	test('re-applies the lower trap after the popup above it closes', () => {
		const { nav, page, stage, sheet, popupHost } = setup();
		const sheetTrap = focusTrap(sheet, true, page);
		const popup = el(popupHost, 2000000);
		const popupTrap = focusTrap(popup);
		popupTrap.release();
		popup.remove();
		expect(stage.inert).toBe(true);
		expect(nav.inert).toBe(false);
		expect(popupHost.inert).toBe(false);
		sheetTrap.release();
		expect(inertCount()).toBe(0);
	});

	test('restores the page even when the trapped host was removed first', () => {
		const { stage, sheet } = setup();
		const trap = focusTrap(sheet);
		sheet.remove();
		trap.release();
		expect(stage.inert).toBe(false);
		expect(inertCount()).toBe(0);
	});

	test('ignores a second release', () => {
		const { app, sheet, popupHost } = setup();
		const first = focusTrap(sheet);
		first.release();
		const popup = el(popupHost, 2000000);
		const second = focusTrap(popup);
		first.release();
		expect(app.inert).toBe(true);
		second.release();
		expect(inertCount()).toBe(0);
	});
});
