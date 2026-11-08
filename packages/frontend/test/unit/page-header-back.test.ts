/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';

const mocks = vi.hoisted(() => ({ pushByPath: vi.fn() }));

vi.mock('@/router.js', async () => ({ mainRouter: { currentRoute: (await import('vue')).ref({ name: 'chat-room' }), pushByPath: mocks.pushByPath } }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/utility/is-friendly.js', async () => {
	const friendly = (await import('vue')).ref(false);
	return { isFriendly: () => friendly };
});
vi.mock('@/accounts.js', () => ({ getAccountMenu: vi.fn() }));
vi.mock('@/os.js', () => ({ popupMenu: vi.fn() }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: null }));

import { installFakeResizeObserver } from './fake-resize-observer.js';
import MkPageHeader from '@/components/global/MkPageHeader.vue';
import CPPageHeader from '@/components/global/CPPageHeader.vue';
import { pushAppHistory } from '@/utility/app-history.js';

const stubs = {
	MkAvatar: { template: '<span></span>' },
	MkFollowButton: { template: '<span></span>' },
	MkUserName: { template: '<span></span>' },
};
const directives = { tooltip: {} };
const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
installFakeResizeObserver();

afterAll(() => {
	if (resizeObserverDescriptor) Object.defineProperty(globalThis, 'ResizeObserver', resizeObserverDescriptor);
	else Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

describe.each([
	['MkPageHeader', MkPageHeader],
	['CPPageHeader', CPPageHeader],
])('%s back button', (_, component) => {
	const back = vi.spyOn(window.history, 'back');

	beforeEach(() => {
		mocks.pushByPath.mockReset();
		back.mockReset();
		// 新しいタブで直接開いたときと同じく、アプリの履歴がない状態にする
		window.history.replaceState(null, '', '/chat/room/r1');
	});
	afterEach(cleanup);

	async function clickBack(props: Record<string, unknown>) {
		const { container } = render(component, {
			props: { title: 'room', overridePageMetadata: { title: 'room' }, ...props },
			global: { stubs, directives },
		});
		await fireEvent.click(container.querySelector('.ti-arrow-left')!.closest('button')!);
	}

	test('goes to the fallback when going back would leave the app', async () => {
		await clickBack({ backFallback: '/chat' });

		expect(mocks.pushByPath).toHaveBeenCalledWith('/chat');
		expect(back).not.toHaveBeenCalled();
	});

	test('goes back through the history when the app has an earlier entry', async () => {
		pushAppHistory('/chat/room/r1');

		await clickBack({ backFallback: '/chat' });

		expect(back).toHaveBeenCalledOnce();
		expect(mocks.pushByPath).not.toHaveBeenCalled();
	});

	test('keeps following the browser history on a page without a fallback', async () => {
		await clickBack({});

		expect(back).toHaveBeenCalledOnce();
		expect(mocks.pushByPath).not.toHaveBeenCalled();
	});
});
