/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { h, nextTick } from 'vue';

vi.mock('@/os.js', () => ({ claimZIndex: () => 3000000 }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false, menuStyle: 'popup' }) }));
vi.mock('@/utility/touch.js', () => ({ isTouchUsing: false }));
vi.mock('@/utility/device-kind.js', () => ({ deviceKind: 'desktop' }));

import MkModal from '@/components/MkModal.vue';

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

test.each([[true, 113], [false, 143]] as const)('updates popup position on resize only when opted in (%s)', async (repositionOnResize, expectedLeft) => {
	vi.stubGlobal('innerWidth', 390);
	vi.stubGlobal('innerHeight', 844);
	vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
	const anchor = document.createElement('button');
	anchor.getBoundingClientRect = () => ({ left: 320, top: 10, right: 340, bottom: 30, width: 20, height: 20, x: 320, y: 10, toJSON: () => ({}) } as DOMRect);
	Object.defineProperty(anchor, 'offsetWidth', { value: 20 });
	Object.defineProperty(anchor, 'offsetHeight', { value: 20 });
	document.body.append(anchor);
	const modal = render(MkModal, {
		props: { anchorElement: anchor, repositionOnResize },
		slots: { default: () => h('div', 'menu') },
		global: { directives: { hotkey: {} } },
	});
	const content = document.querySelector('[data-testid="bg"]')!.nextElementSibling as HTMLElement;
	Object.defineProperty(content, 'offsetWidth', { value: 230 });
	Object.defineProperty(content, 'offsetHeight', { value: 200 });
	await nextTick();

	expect(parseFloat(content.style.left)).toBe(143);

	vi.stubGlobal('innerWidth', 360);
	window.dispatchEvent(new Event('resize'));

	expect(parseFloat(content.style.left)).toBe(expectedLeft);

	const measure = vi.spyOn(anchor, 'getBoundingClientRect');
	modal.unmount();
	measure.mockClear();
	window.dispatchEvent(new Event('resize'));

	expect(measure).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});
