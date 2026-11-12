/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { defineComponent, h, nextTick, ref } from 'vue';
import type { PageMetadata } from '@/page.js';

vi.mock('@/components/MkDrive.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/composables/use-scroll-position-keeper.js', () => ({ useScrollPositionKeeper: () => {} }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false }) }));
vi.mock('@/router.js', async () => ({ mainRouter: { currentRoute: (await import('vue')).ref({ name: 'my-drive' }), push: () => {} } }));
vi.mock('@/store.js', () => ({ store: { s: { showHomeButtonInNavbar: true } } }));
vi.mock('@/i.js', () => ({ $i: null }));
vi.mock('@/accounts.js', () => ({ getAccountMenu: async () => [] }));
vi.mock('@/os.js', () => ({}));
vi.mock('@/utility/haptic.js', () => ({ haptic: () => {} }));

import DrivePage from '@/pages/drive.vue';
import Footer from '@/ui/friendly/mobile-footer-menu-friendly.vue';
import { definePage, provideMetadataReceiver } from '@/page.js';
import { globalEvents } from '@/events.js';
import { installFakeResizeObserver } from './fake-resize-observer.js';

installFakeResizeObserver();
afterEach(cleanup);

test('drive reserves mobile navigation space on entry and releases its preference on another page', async () => {
	const inDrive = ref(true);
	const metadata = ref<PageMetadata | null>(null);
	const OtherPage = defineComponent({
		setup() {
			definePage({ title: 'Home' });
			return () => h('div');
		},
	});
	const view = render(defineComponent({
		setup() {
			provideMetadataReceiver(getter => { metadata.value = getter(); });
			return () => h('div', [
				inDrive.value ? h(DrivePage) : h(OtherPage),
				h(Footer, { forceInFlow: metadata.value?.mobileFooterInFlow }),
				h(Footer, { forceInFlow: true, 'data-testid': 'flow-reference' }),
			]);
		},
	}));
	await nextTick();
	const footer = view.container.firstElementChild!.children[1];
	const flowClasses = view.getByTestId('flow-reference').className;
	expect(footer.className).toBe(flowClasses);

	globalEvents.emit('isAtBottom', false);
	await nextTick();
	expect(footer.className).toBe(flowClasses);

	inDrive.value = false;
	await nextTick();
	expect(footer.className).not.toBe(flowClasses);
	inDrive.value = true;
	await nextTick();
	expect(footer.className).toBe(flowClasses);
});
