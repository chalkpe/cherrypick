/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { defineComponent, h, nextTick, ref } from 'vue';
import { installFakeResizeObserver, resizeObserved } from './fake-resize-observer.js';
import { useMobileFooterHeight } from '@/composables/use-mobile-footer-height.js';

installFakeResizeObserver();

afterEach(() => {
	cleanup();
	window.document.body.style.removeProperty('--MI-mobileFooterHeight');
});

const footerHeight = () => window.document.body.style.getPropertyValue('--MI-mobileFooterHeight');

function renderFooter(shown = ref(true)) {
	const rootEl = ref<HTMLElement | null>(null);
	const result = render(defineComponent({
		setup() {
			useMobileFooterHeight(rootEl);
			return () => shown.value ? h('div', { ref: rootEl }) : h('span');
		},
	}));
	return { ...result, rootEl };
}

// happy-dom は大きさを計算しないので、要素の高さはテストから決める
function setHeight(el: HTMLElement, height: number) {
	el.getBoundingClientRect = () => ({ height } as DOMRect);
}

describe('useMobileFooterHeight', () => {
	test('publishes the footer height on the body as soon as the footer appears and whenever it is resized', async () => {
		const shown = ref(false);
		const { rootEl } = renderFooter(shown);
		expect(footerHeight()).toBe('0px');

		shown.value = true;
		await nextTick();
		setHeight(rootEl.value!, 56);
		resizeObserved(320, rootEl.value!);
		expect(footerHeight()).toBe('56px');

		setHeight(rootEl.value!, 72);
		resizeObserved(320, rootEl.value!);
		expect(footerHeight()).toBe('72px');
	});

	test('clears the height when the footer is gone', async () => {
		const { rootEl, unmount } = renderFooter();
		await nextTick();
		setHeight(rootEl.value!, 56);
		resizeObserved(320, rootEl.value!);
		expect(footerHeight()).toBe('56px');

		unmount();
		expect(footerHeight()).toBe('');
	});
});
