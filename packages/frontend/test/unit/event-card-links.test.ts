/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { defineComponent } from 'vue';

const state = vi.hoisted(() => ({
	trustedLinkUrlPatterns: [] as string[],
	warningEnabled: true,
	popups: [] as string[],
}));

vi.mock('@@/js/config.js', () => ({ url: 'https://cp.example' }));
vi.mock('@/instance.js', () => ({ instance: { get trustedLinkUrlPatterns() { return state.trustedLinkUrlPatterns; } } }));
vi.mock('@/preferences.js', () => ({
	prefer: {
		s: { get externalNavigationWarning() { return state.warningEnabled; } },
		r: { trustedDomains: { value: [] as string[] } },
	},
}));
vi.mock('@/i18n.js', () => ({ i18n: { ts: new Proxy({ _event: {} }, { get: (t: any, k) => t[k] ?? new Proxy({}, { get: (_t, kk) => String(kk) }) }) } }));
vi.mock('@/components/MkUrlWarningDialog.vue', () => ({ default: {} }));
vi.mock('@/os.js', () => ({
	popup: (_component: unknown, props: { url: string }, events: { done: (r: { canceled: boolean }) => void; closed: () => void }) => {
		state.popups.push(props.url);
		queueMicrotask(() => events.done({ canceled: true }));
		return { dispose: () => {} };
	},
}));

import MkEvent from '@/components/MkEvent.vue';

const note = {
	id: 'note',
	event: {
		title: 'event',
		start: '2030-01-01T00:00:00.000Z',
		end: null,
		metadata: {
			url: 'https://event.example/page',
			offers: { url: 'https://tickets.example/buy' },
		},
	},
} as any;

// ブラウザの画面遷移は行わせず、コンポーネントのハンドラ実行後(同じ要素の後続リスナー)の状態だけを記録する
const defaultPreventedAtDocument: boolean[] = [];
const recordClick = (ev: Event) => {
	defaultPreventedAtDocument.push(ev.defaultPrevented);
	ev.preventDefault();
};

function renderEvent() {
	return render(MkEvent, {
		props: { note },
		global: { stubs: { MkTime: defineComponent({ template: '<span/>' }) } },
	});
}

describe('イベントカードのリンク', () => {
	beforeEach(() => {
		state.trustedLinkUrlPatterns = [];
		state.warningEnabled = true;
		state.popups = [];
		defaultPreventedAtDocument.length = 0;
	});

	afterEach(() => {
		cleanup();
	});

	test.each([
		['URL', 'https://event.example/page'],
		['チケットURL', 'https://tickets.example/buy'],
	])('信頼されていない%sは警告を経由し、確認前には開かない', async (_name, href) => {
		const { container } = renderEvent();
		const anchor = container.querySelector(`a[href="${href}"]`) as HTMLAnchorElement;
		expect(anchor).not.toBeNull();

		const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
		anchor.addEventListener('click', recordClick);
		anchor.dispatchEvent(ev);
		await Promise.resolve();

		expect(state.popups).toEqual([href]);
		expect(defaultPreventedAtDocument).toEqual([true]);
	});

	test('信頼されたURLは警告なしで通常のリンクとして動く', async () => {
		state.trustedLinkUrlPatterns = ['event.example', 'tickets.example'];
		const { container } = renderEvent();

		for (const href of ['https://event.example/page', 'https://tickets.example/buy']) {
			const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
			const anchor = container.querySelector(`a[href="${href}"]`) as HTMLAnchorElement;
			anchor.addEventListener('click', recordClick);
			anchor.dispatchEvent(ev);
			await Promise.resolve();
		}
		expect(defaultPreventedAtDocument).toEqual([false, false]);
		expect(state.popups).toEqual([]);
	});

	test('警告設定が無効なら警告なしで通常のリンクとして動く', async () => {
		state.warningEnabled = false;
		const { container } = renderEvent();

		const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
		const anchor = container.querySelector('a[href="https://event.example/page"]') as HTMLAnchorElement;
		anchor.addEventListener('click', recordClick);
		anchor.dispatchEvent(ev);
		await Promise.resolve();

		expect(state.popups).toEqual([]);
		expect(defaultPreventedAtDocument).toEqual([false]);
	});
});
