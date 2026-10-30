/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';

vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ enableHorizontalSwipe: true, animation: false }) }));

import MkSwiper from '@/components/MkSwiper.vue';

afterEach(cleanup);

const tabs = [{ key: 'chat', title: 'chat' }, { key: 'members', title: 'members' }, { key: 'info', title: 'info' }];

function touch(screenX: number) {
	return { touches: [{ screenX, screenY: 0 }], changedTouches: [{ screenX, screenY: 0 }] };
}

// メニューから開いた画面 (チャットの検索など) はタブに無い。隣のタブを探して tabs[-2] を読まない
test('ignores a horizontal swipe while the current view is not one of the tabs', async () => {
	const swiped = vi.fn();
	const { container } = render(MkSwiper, { props: { tabs, tab: 'search', onSwiped: swiped }, slots: { default: '<p>search</p>' } });
	const root = container.firstElementChild!;
	const errors: unknown[] = [];
	const onError = (ev: ErrorEvent) => { errors.push(ev.error); ev.preventDefault(); };
	window.addEventListener('error', onError);
	try {
		await fireEvent.touchStart(root, touch(200));
		await fireEvent.touchMove(root, touch(150));
		await fireEvent.touchMove(root, touch(100));
		await fireEvent.touchEnd(root, { touches: [], changedTouches: [{ screenX: 100, screenY: 0 }] });
	} finally {
		window.removeEventListener('error', onError);
	}
	expect(errors).toEqual([]);
	expect(swiped).not.toHaveBeenCalled();
});
