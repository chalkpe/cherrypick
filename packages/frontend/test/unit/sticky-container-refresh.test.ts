/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { defineComponent, h, nextTick, ref } from 'vue';
import { installFakeResizeObserver, resizeObserved } from './fake-resize-observer.js';

vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/router.js', async () => ({ mainRouter: { currentRoute: (await import('vue')).ref({ name: 'chat' }) } }));
vi.mock('@/utility/scroll-to-visibility.js', async () => {
	const { ref } = await import('vue');
	return { scrollToVisibility: () => ({ showEl: ref(true) }) };
});
vi.mock('@/utility/detect-scrolling.js', () => ({ detectScrolling: () => {} }));
vi.mock('@/utility/is-friendly.js', async () => {
	const { ref } = await import('vue');
	return { isFriendly: () => ref(false) };
});

import MkStickyContainer from '@/components/global/MkStickyContainer.vue';

installFakeResizeObserver();
afterEach(cleanup);

test('allows a layout switch to refresh sticky heights before the debounced observer runs', async () => {
	const sticky = ref<InstanceType<typeof MkStickyContainer>>();
	const { getByText, container } = render(defineComponent({
		setup: () => () => h(MkStickyContainer, { ref: sticky }, { header: () => h('span', 'header'), default: () => h('span', 'body'), footer: () => h('span', 'footer') }),
	}));
	await nextTick();
	const footer = getByText('footer').parentElement!;
	Object.defineProperty(footer, 'offsetHeight', { configurable: true, value: 80 });
	sticky.value!.refresh();
	await nextTick();
	expect(container.querySelector('[data-sticky-container-footer-height]')!.getAttribute('data-sticky-container-footer-height')).toBe('80');
	Object.defineProperty(footer, 'offsetHeight', { configurable: true, value: 0 });
	resizeObserved(100, footer);
	sticky.value!.refresh();
	await nextTick();
	expect(container.querySelector('[data-sticky-container-footer-height]')!.getAttribute('data-sticky-container-footer-height')).toBe('0');
});
