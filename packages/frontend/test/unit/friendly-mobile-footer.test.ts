/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { defineComponent, h, nextTick, ref } from 'vue';
import { installFakeResizeObserver } from './fake-resize-observer.js';

vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false }) }));
vi.mock('@/router.js', async () => ({ mainRouter: { currentRoute: (await import('vue')).ref({ name: 'voice-relay' }), push: () => {} } }));
vi.mock('@/store.js', () => ({ store: { s: { showHomeButtonInNavbar: true } } }));
vi.mock('@/i.js', () => ({ $i: null }));
vi.mock('@/accounts.js', () => ({ getAccountMenu: async () => [] }));
vi.mock('@/os.js', () => ({}));
vi.mock('@/utility/haptic.js', () => ({ haptic: () => {} }));

import Footer from '@/ui/friendly/mobile-footer-menu-friendly.vue';
import { globalEvents } from '@/events.js';

installFakeResizeObserver();
afterEach(cleanup);

test('omitted footer preference keeps bottom-event behavior while opt-in reserves flow space', async () => {
	const forceInFlow = ref(true);
	const view = render(defineComponent({
		setup: () => () => h('div', [h(Footer), h(Footer, { forceInFlow: forceInFlow.value })]),
	}));
	const [defaultFooter, optedInFooter] = [...view.container.firstElementChild!.children];
	const fixedClasses = defaultFooter.className;
	const flowClasses = optedInFooter.className;
	expect(fixedClasses).not.toBe(flowClasses);

	globalEvents.emit('isAtBottom', true);
	await nextTick();
	expect(defaultFooter.className).toBe(flowClasses);
	expect(optedInFooter.className).toBe(flowClasses);
	globalEvents.emit('isAtBottom', false);
	await nextTick();
	expect(defaultFooter.className).toBe(fixedClasses);
	expect(optedInFooter.className).toBe(flowClasses);

	forceInFlow.value = false;
	await nextTick();
	expect(optedInFooter.className).toBe(fixedClasses);
});
