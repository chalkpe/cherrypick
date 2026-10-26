/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';
import { nextTick } from 'vue';

vi.mock('@/router.js', () => ({ mainRouter: { currentRoute: { value: { name: 'chat-room' } } } }));
vi.mock('@/accounts.js', () => ({ getAccountMenu: vi.fn() }));
vi.mock('@/os.js', () => ({ popupMenu: vi.fn() }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: null }));

import MkPageHeader from '@/components/global/MkPageHeader.vue';
import CPPageHeader from '@/components/global/CPPageHeader.vue';

const stubs = {
	MkAvatar: { template: '<span></span>' },
	MkFollowButton: { template: '<span></span>' },
	MkUserName: { template: '<span></span>' },
};
// ツールチップは表示の補助なので、ここでは何もしないものにする
const directives = { tooltip: {} };

afterEach(() => {
	cleanup();
});

// アイコンだけのボタンなので、ツールチップと同じ文言を読み上げ用のラベルにする
describe.each([
	['MkPageHeader', MkPageHeader],
	['CPPageHeader', CPPageHeader],
])('%s actions', (_, component) => {
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
