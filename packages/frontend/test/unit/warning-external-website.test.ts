/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';

const state = vi.hoisted(() => ({
	trustedLinkUrlPatterns: [] as string[],
	trustedDomains: [] as string[],
	popups: 0,
}));

vi.mock('@@/js/config.js', () => ({ url: 'https://cp.example' }));
vi.mock('@/instance.js', () => ({ instance: { get trustedLinkUrlPatterns() { return state.trustedLinkUrlPatterns; } } }));
vi.mock('@/preferences.js', () => ({
	prefer: {
		s: { externalNavigationWarning: true },
		r: { trustedDomains: { get value() { return state.trustedDomains; } } },
	},
}));
vi.mock('@/components/MkUrlWarningDialog.vue', () => ({ default: {} }));
vi.mock('@/os.js', () => ({
	popup: (_component: unknown, _props: unknown, events: { done: (r: { canceled: boolean }) => void; closed: () => void }) => {
		state.popups++;
		queueMicrotask(() => events.done({ canceled: true }));
		return { dispose: () => {} };
	},
}));

import { warningExternalWebsite } from '@/utility/warning-external-website.js';
import MkRemoteCaution from '@/components/MkRemoteCaution.vue';
import { i18n } from '@/i18n.js';

afterEach(cleanup);

test.each([['click', 0], ['auxclick', 1]] as const)('the remote profile link can be canceled on %s', async (type, button) => {
	state.trustedLinkUrlPatterns = [];
	state.trustedDomains = [];
	state.popups = 0;
	const { getByRole } = render(MkRemoteCaution, { props: { href: 'https://remote.example/@account' } });
	const link = getByRole('link', { name: i18n.ts.showOnRemote });

	const click = new MouseEvent(type, { button, cancelable: true });
	await fireEvent(link, click);

	expect(click.defaultPrevented).toBe(true);
	expect(link.getAttribute('target')).toBe('_blank');
	expect(state.popups).toBe(1);
});

async function warned(url: string): Promise<boolean> {
	state.popups = 0;
	const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent;
	await warningExternalWebsite(ev, url);
	return state.popups > 0;
}

describe('外部サイト移動の警告判定', () => {
	beforeEach(() => {
		state.trustedLinkUrlPatterns = [];
		state.trustedDomains = [];
	});

	test.each([
		['サーバーのURLで始まる別ホスト', 'https://cp.example.other.net/login'],
		['サーバーのURLで始まる別ホスト(ポート付き)', 'https://cp.example:8443/login'],
		['?の後ろに信頼ドメインを置いたURL', 'https://other.example?@github.com/'],
		['#の後ろに信頼ドメインを置いたURL', 'https://other.example#@github.com/'],
		['バックスラッシュを使ったURL', 'https://other.example\\@github.com/'],
		['信頼ドメインを名前の末尾に含む別ドメイン', 'https://notexample.com/'],
		['解釈できないURL', 'https://'],
	])('警告を表示する: %s', async (_name, url) => {
		state.trustedLinkUrlPatterns = ['github.com', 'example.com'];
		state.trustedDomains = ['github.com'];
		expect(await warned(url)).toBe(true);
	});

	test.each([
		['同じサーバーのURL', 'https://cp.example/notes/abc'],
		['相対パス', '/notes/abc'],
		['サーバー信頼リストのドメイン', 'https://example.com/a'],
		['サーバー信頼リストのサブドメイン', 'https://sub.example.com/a'],
		['サーバー信頼リストのドメイン(www付き)', 'https://www.example.com/a'],
		['利用者信頼リストのドメイン', 'https://trusted.example.org/a'],
	])('警告を表示しない: %s', async (_name, url) => {
		state.trustedLinkUrlPatterns = ['example.com'];
		state.trustedDomains = ['trusted.example.org'];
		expect(await warned(url)).toBe(false);
	});

	test.each([
		['先頭に.を付けた項目', '.example.com', 'https://sub.example.com/a'],
		['先頭に.を付けた項目(ドメイン自身)', '.example.com', 'https://example.com/a'],
		['大文字で書いた項目', 'Example.COM', 'https://sub.example.com/a'],
	])('ドメイン形式の信頼設定は正規化して比較する: %s', async (_name, pattern, url) => {
		state.trustedLinkUrlPatterns = [pattern];
		expect(await warned(url)).toBe(false);
		expect(await warned('https://notexample.com/')).toBe(true);
	});

	test('正規表現形式と空白区切り形式の信頼設定は従来どおり動く', async () => {
		state.trustedLinkUrlPatterns = ['/^https:\\/\\/docs\\.example\\.net\\//', 'wiki.example.net /w/'];
		expect(await warned('https://docs.example.net/a')).toBe(false);
		expect(await warned('https://wiki.example.net/w/page')).toBe(false);
		expect(await warned('https://other.example.net/a')).toBe(true);
	});

	test('invalid stored expressions leave the remaining trust rules active', async () => {
		state.trustedLinkUrlPatterns = ['/[/', '/docs/invalid', 'docs.example.net'];

		expect(await warned('https://docs.example.net/a')).toBe(false);
		expect(await warned('https://other.example.net/a')).toBe(true);
	});
});
