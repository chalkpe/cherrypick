/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';
import { nextTick } from 'vue';

vi.mock('@/router.js', async () => ({ mainRouter: { currentRoute: (await import('vue')).ref({ name: 'chat' }) } }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/utility/is-friendly.js', async () => {
	const friendly = (await import('vue')).ref(false);
	return { isFriendly: () => friendly };
});
vi.mock('@/accounts.js', () => ({ getAccountMenu: vi.fn() }));
vi.mock('@/os.js', () => ({ popupMenu: vi.fn() }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: null }));

import { isFriendly } from '@/utility/is-friendly.js';
import { installFakeResizeObserver, resizeObserved } from './fake-resize-observer.js';
import MkPageHeader from '@/components/global/MkPageHeader.vue';
import CPPageHeader from '@/components/global/CPPageHeader.vue';

const stubs = {
	MkAvatar: { template: '<span></span>' },
	MkFollowButton: { template: '<span></span>' },
	MkUserName: { template: '<span></span>' },
};
const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
installFakeResizeObserver();

// ツールチップは表示の補助なので、ここでは何もしないものにする
const directives = { tooltip: {} };

afterEach(() => {
	cleanup();
	isFriendly().value = false;
});

afterAll(() => {
	if (resizeObserverDescriptor) Object.defineProperty(globalThis, 'ResizeObserver', resizeObserverDescriptor);
	else Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

// アイコンだけのボタンなので、ツールチップと同じ文言を読み上げ用のラベルにする
describe.each([
	['MkPageHeader', MkPageHeader],
	['CPPageHeader', CPPageHeader],
])('%s actions', (_, component) => {

	test.each([{ friendly: false, width: 400 }, { friendly: true, width: 400 }, { friendly: false, width: 800 }, { friendly: true, width: 800 }])('keeps the left spacing stable between one and two actions ($friendly, $width px)', async ({ friendly, width }) => {
		isFriendly().value = friendly;
		const actions = [{ icon: 'ti ti-dots', text: 'Menu', handler: vi.fn() }];
		const result = render(component, {
			props: { title: 'room', overridePageMetadata: { title: 'room' }, actions },
			global: { stubs, directives },
		});
		const header = result.getByText('room').closest('[class*="titleContainer"]')!;
		const host = header.closest('[class*="root"]')!.parentElement!;
		Object.defineProperty(host, 'offsetWidth', { configurable: true, value: width });
		resizeObserved(width, host);
		await nextTick();
		const beforeTitle = () => {
			const title = result.getByText('room').closest('[class*="titleContainer"]')!;
			const siblings = [...title.parentElement!.children];
			return siblings.slice(0, siblings.indexOf(title)).map(el => el.outerHTML);
		};
		const one = beforeTitle();
		await result.rerender({ actions: [{ icon: 'ti ti-phone', text: 'Call', handler: vi.fn() }, ...actions] });
		expect(beforeTitle()).toEqual(one);
		await result.rerender({ actions });
		expect(beforeTitle()).toEqual(one);
	});

	test('names each icon-only action button after its text', async () => {
		const handler = vi.fn();
		render(component, {
			props: { title: 'room', actions: [{ icon: 'ti ti-phone', text: 'Join the call', handler }, { icon: 'ti ti-dots', handler: vi.fn() }] },
			global: { stubs, directives },
		});
		await nextTick();

		await fireEvent.click(screen.getByRole('button', { name: 'Join the call' }));
		expect(handler).toHaveBeenCalledTimes(1);
	});
});
