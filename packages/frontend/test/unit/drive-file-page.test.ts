/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, assert, test, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/vue';

vi.mock('@/router.js', async () => {
	const { ref } = await import('vue');
	return {
		mainRouter: { currentRoute: ref({ name: 'drive-file', path: '/my/drive/file/file-1' }) },
		useRouter: () => ({ useListener: vi.fn() }),
	};
});
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ enableHorizontalSwipe: false, animation: false, mobileHeaderChange: false, showPageTabBarBottom: false }) }));
vi.mock('@/utility/is-friendly.js', async () => {
	const friendly = (await import('vue')).ref(true);
	return { isFriendly: () => friendly };
});
// タブの中身は API を叩くので、ここでは置き換える
vi.mock('@/pages/drive.file.info.vue', () => ({ default: { template: '<div>info</div>' } }));
vi.mock('@/pages/drive.file.notes.vue', () => ({ default: { template: '<div>notes</div>' } }));

import { components } from '@/components/index.js';
import { directives } from '@/directives/index.js';
import { globalEvents } from '@/events.js';
import { installFakeResizeObserver } from './fake-resize-observer.js';
import DriveFilePage from '@/pages/drive.file.vue';

const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
installFakeResizeObserver();

const stubs = {
	MkPageHeader: { template: '<header></header>' },
	CPPageHeader: { template: '<header></header>' },
	MkTabs: { template: '<nav></nav>' },
};

afterEach(cleanup);

afterAll(() => {
	if (resizeObserverDescriptor) Object.defineProperty(globalThis, 'ResizeObserver', resizeObserverDescriptor);
	else Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

// Friendly UI のモバイル下部バーは、ページ自身のスクロール領域が末尾に達したという通知 (isAtBottom) でだけ内容の下から退く。
// その通知はページが持つ _pageScrollable のスクロールから送られるので、他のページと同じくこのページもそれを持つ必要がある。
test('scrolling the file page to its end notifies the bottom bar', async () => {
	const atBottom = vi.fn();
	globalEvents.on('isAtBottom', atBottom);
	try {
		const { container } = render(DriveFilePage, {
			props: { fileId: 'file-1' },
			global: { components, directives: { ...directives, panel: {} }, stubs },
		});
		const scroller = container.querySelector<HTMLElement>('._pageScrollable');
		assert.exists(scroller, 'the page owns its scroll container like every other routed page');

		Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
		Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true });
		Object.defineProperty(scroller, 'scrollTop', { value: 1200, configurable: true });
		scroller!.dispatchEvent(new Event('scroll'));

		await waitFor(() => assert.isTrue(atBottom.mock.calls.some(([value]) => value === true), 'isAtBottom is emitted'));
	} finally {
		globalEvents.off('isAtBottom', atBottom);
	}
});
