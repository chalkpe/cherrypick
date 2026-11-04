/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';

vi.mock('@/components/MkMenu.vue', () => ({ default: { template: '<div></div>' } }));

import MkMenuChild from '@/components/MkMenu.child.vue';

const SCROLLBAR_THICKNESS = 16;
const CHILD_WIDTH = 230;

function rect(left: number, width: number) {
	return { left, width, top: 100, height: 100, right: left + width, bottom: 200, x: left, y: 100, toJSON: () => ({}) } as DOMRect;
}

function element(left: number, width: number) {
	const el = document.createElement('div');
	el.getBoundingClientRect = () => rect(left, width);
	Object.defineProperty(el, 'offsetWidth', { value: width });
	return el;
}

function childLeft(windowWidth: number, parentLeft: number, parentWidth: number) {
	vi.stubGlobal('innerWidth', windowWidth);
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, CHILD_WIDTH));
	vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
	const { container } = render(MkMenuChild, {
		props: { items: [], anchorElement: element(parentLeft, parentWidth), rootElement: element(parentLeft, parentWidth) },
	});
	return parseFloat((container.firstElementChild as HTMLElement).style.left);
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test('opens to the right of the parent when there is room', () => {
	expect(childLeft(1280, 100, 300)).toBe(300);
});

test('opens to the left of the parent when only the left has room', () => {
	expect(childLeft(1280, 900, 300)).toBe(-CHILD_WIDTH);
});

test.each([[412, 6, 400], [320, 0, 320], [360, 10, 340]])('stays on screen when the parent fills a window %i wide', (windowWidth, parentLeft, parentWidth) => {
	const left = childLeft(windowWidth, parentLeft, parentWidth);

	expect(parentLeft + left).toBeGreaterThanOrEqual(0);
	expect(parentLeft + left + CHILD_WIDTH).toBeLessThanOrEqual(windowWidth - SCROLLBAR_THICKNESS);
});
