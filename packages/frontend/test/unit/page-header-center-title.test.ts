/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
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
const directives = { tooltip: {} };

afterEach(() => cleanup());

afterAll(() => {
	if (resizeObserverDescriptor) Object.defineProperty(globalThis, 'ResizeObserver', resizeObserverDescriptor);
	else Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

async function renderNarrow(component: typeof MkPageHeader | typeof CPPageHeader, centerTitle: boolean) {
	const result = render(component, {
		props: { overridePageMetadata: { title: 'room' }, actions: [{ icon: 'ti ti-dots', text: 'Menu', handler: vi.fn() }], centerTitle },
		global: { stubs, directives },
	});
	const title = result.getByText('room').closest('[class*="titleContainer"]')!;
	const host = title.closest('[class*="root"]')!.parentElement!;
	Object.defineProperty(host, 'offsetWidth', { configurable: true, value: 400 });
	resizeObserved(400, host);
	await nextTick();
	return result.getByText('room').closest('[class*="titleContainer"]')!.parentElement!;
}

// 通話ボタンの出入りで見出しが動かないよう、狭い画面では centerTitle で見出しを中央に固定する。どちらのヘッダーでも同じに
describe.each([
	['MkPageHeader', MkPageHeader],
	['CPPageHeader', CPPageHeader],
])('%s centerTitle', (_, component) => {
	test('marks the narrow header so the title is centered', async () => {
		const upper = await renderNarrow(component, true);
		expect([...upper.classList].some(c => c.includes('centerTitle'))).toBe(true);
	});

	test('leaves the title where it is without centerTitle', async () => {
		const upper = await renderNarrow(component, false);
		expect([...upper.classList].some(c => c.includes('centerTitle'))).toBe(false);
	});
});
