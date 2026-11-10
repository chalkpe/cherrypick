/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';
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
	vi.useRealTimers();
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

let notifyResize: (target: Element) => void;

function stubLayoutEvents() {
	vi.useFakeTimers();
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16) as unknown as number);
	vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
	vi.stubGlobal('ResizeObserver', class {
		private targets = new Set<Element>();
		constructor(callback: ResizeObserverCallback) {
			notifyResize = target => {
				if (this.targets.has(target)) callback([], this as unknown as ResizeObserver);
			};
		}
		observe(target: Element) { this.targets.add(target); }
		disconnect() { this.targets.clear(); }
	});
}

function renderChild(parentLeft: number, parentWidth: number) {
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, CHILD_WIDTH));
	stubLayoutEvents();
	const root = element(parentLeft, parentWidth);
	const { container, unmount } = render(MkMenuChild, {
		props: { items: [], anchorElement: element(parentLeft, parentWidth), rootElement: root },
	});
	return { el: container.firstElementChild as HTMLElement, root, unmount };
}

test('repositions after the first measurement when the parent size changes', async () => {
	vi.stubGlobal('innerWidth', 1280);
	const { el, root } = renderChild(144, 230);
	await nextTick();

	expect(parseFloat(el.style.left)).toBe(230);

	vi.stubGlobal('innerWidth', 390);
	notifyResize(root);
	vi.advanceTimersByTime(16);

	expect(144 + parseFloat(el.style.left) + CHILD_WIDTH).toBeLessThanOrEqual(390 - SCROLLBAR_THICKNESS);
});

test('repositions when the window is resized after it settled', async () => {
	vi.stubGlobal('innerWidth', 1280);
	const { el } = renderChild(144, 230);
	await nextTick();
	vi.runAllTimers();

	expect(parseFloat(el.style.left)).toBe(230);

	vi.stubGlobal('innerWidth', 390);
	window.dispatchEvent(new Event('resize'));
	vi.advanceTimersByTime(16);

	expect(144 + parseFloat(el.style.left) + CHILD_WIDTH).toBeLessThanOrEqual(390 - SCROLLBAR_THICKNESS);
});

test('cancels pending position work on unmount even when resize precedes the next tick', async () => {
	vi.stubGlobal('innerWidth', 1280);
	const { unmount } = renderChild(144, 230);
	window.dispatchEvent(new Event('resize'));
	await nextTick();

	unmount();

	expect(vi.getTimerCount()).toBe(0);
});

test('does not schedule position work after unmount before the next tick', async () => {
	const { unmount } = renderChild(144, 230);

	unmount();
	await nextTick();

	expect(vi.getTimerCount()).toBe(0);
});

test('coalesces a resize and the initial positioning frame', async () => {
	const { root } = renderChild(144, 230);
	const measure = vi.spyOn(root, 'getBoundingClientRect');
	window.dispatchEvent(new Event('resize'));
	await nextTick();
	measure.mockClear();

	vi.advanceTimersByTime(16);

	expect(measure).toHaveBeenCalledTimes(1);
});
