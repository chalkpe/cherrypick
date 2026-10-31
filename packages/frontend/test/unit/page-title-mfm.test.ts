/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/vue';
import { defineComponent, h } from 'vue';
import type { PageMetadata } from '@/page.js';

vi.mock('@/router.js', async () => {
	const { ref } = await import('vue');
	const router = {
		currentRoute: ref({ name: 'chat', path: '/chat' }),
		getCurrentFullPath: () => '/chat',
		addListener: vi.fn(),
		init: vi.fn(),
		replaceByPath: vi.fn(),
		pushByPath: vi.fn(),
	};
	return { mainRouter: router, createRouter: () => router };
});
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ 'deck.alwaysShowMainColumn': true, 'experimental.stackingRouterView': false, 'deck.profile': 'default', 'deck.profiles': [{ name: 'default', columns: [], layout: [] }] }) }));
vi.mock('@/os.js', async () => ({ openingWindowsCount: (await import('vue')).ref(0), pageWindow: vi.fn(), contextMenu: vi.fn() }));
vi.mock('@/analytics.js', () => ({ analytics: { page: vi.fn() } }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/popout.js', () => ({ popout: vi.fn() }));
vi.mock('@/utility/copy-to-clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import { definePage } from '@/page.js';
import XMainColumn from '@/ui/deck/main-column.vue';
import MkPageWindow from '@/components/MkPageWindow.vue';

const owner = { id: 'owner', username: 'owner', host: null } as any;

// ルーターの中身の代わりに、ページの見出しを決めるだけのページ
const pageWith = (metadata: PageMetadata) => defineComponent({
	props: { router: { type: Object, default: null } },
	setup() {
		definePage(metadata);
		return () => h('div', 'page');
	},
});

const stubsFor = (page: ReturnType<typeof pageWith>) => ({
	XColumn: { template: '<div><slot name="header"/><slot/></div>' },
	MkWindow: { template: '<div><slot name="header"/><slot/></div>' },
	RouterView: page,
	StackingRouterView: page,
	Mfm: { props: ['text', 'plain', 'nowrap', 'author'], template: '<span data-testid="mfm" :data-plain="plain" :data-author="author?.id">{{ text }}</span>' },
});

afterEach(() => cleanup());

describe.each([
	['deck main column', (page: ReturnType<typeof pageWith>) => render(XMainColumn, { props: { column: { id: 'c', type: 'main', name: 'main' } as any, isStacked: false }, global: { stubs: stubsFor(page), components: { RouterView: page } } })],
	['page window', (page: ReturnType<typeof pageWith>) => render(MkPageWindow, { props: { initialPath: '/chat' }, global: { stubs: stubsFor(page), components: { RouterView: page } } })],
])('%s title', (_name, renderWith) => {
	// 部屋の名前のカスタム絵文字は、メインのヘッダーと同じくここでも絵文字として描く
	test('renders a title marked as MFM through Mfm, plainly and with its author', async () => {
		renderWith(pageWith({ title: 'dev :blobcat:', titleAsMfm: true, titleMfmAuthor: owner }));
		await screen.findByTestId('mfm');
		const mfm = screen.getByTestId('mfm');
		expect(mfm.textContent).toBe('dev :blobcat:');
		expect(mfm.getAttribute('data-plain')).toBe('true');
		expect(mfm.getAttribute('data-author')).toBe('owner');
	});

	test('keeps a plain title as text', async () => {
		renderWith(pageWith({ title: 'plain :notemoji:' }));
		await screen.findByText('plain :notemoji:');
		expect(screen.queryByTestId('mfm')).toBeNull();
	});
});
