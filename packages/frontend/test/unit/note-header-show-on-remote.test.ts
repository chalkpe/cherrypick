/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { defineComponent } from 'vue';

const state = vi.hoisted(() => ({
	trusted: [] as string[],
	popups: [] as string[],
}));

vi.mock('@@/js/config.js', () => ({ url: 'https://cp.example', instanceName: 'local' }));
vi.mock('@/instance.js', () => ({ instance: { get trustedLinkUrlPatterns() { return state.trusted; } } }));
vi.mock('@/preferences.js', () => ({
	prefer: {
		s: { externalNavigationWarning: true, instanceTicker: 'always', enableAbsoluteTime: false },
		r: { trustedDomains: { value: [] } },
	},
}));
vi.mock('@/router.js', () => ({ useRouter: () => ({ pushByPath: vi.fn() }) }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: new Proxy({}, { get: (_t, k) => String(k) }) } }));
vi.mock('@/components/MkUrlWarningDialog.vue', () => ({ default: {} }));
vi.mock('@/os.js', () => ({
	popup: (_component: unknown, props: { url: string }, events: { done: (r: { canceled: boolean }) => void; closed: () => void }) => {
		state.popups.push(props.url);
		queueMicrotask(() => events.done({ canceled: true }));
		return { dispose: () => {} };
	},
}));

import { directives } from '@/directives/index.js';
import MkNoteHeader from '@/components/MkNoteHeader.vue';

const note = {
	id: 'note',
	createdAt: '2020-01-01T00:00:00.000Z',
	url: 'https://remote.example/@user/1',
	uri: 'https://remote.example/notes/1',
	user: { id: 'u', username: 'user', host: 'remote.example', instance: { name: 'remote', faviconUrl: null, themeColor: null } },
} as any;

const Stub = defineComponent({ template: '<span/>' });

function renderHeader() {
	return render(MkNoteHeader, {
		props: { note },
		global: { directives, stubs: { MkA: Stub, MkUserName: Stub, MkAcct: Stub, MkTime: Stub, MkNoteHeaderInfo: Stub } },
	});
}

describe('ノートヘッダーのインスタンスティッカー', () => {
	const open = vi.fn();

	beforeEach(() => {
		state.trusted = [];
		state.popups = [];
		open.mockReset();
		vi.stubGlobal('open', open);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	test('信頼されていないURLはクリックで警告を表示し、確認前には開かない', async () => {
		const { getByText } = renderHeader();
		getByText('remote').click();

		await vi.waitFor(() => expect(state.popups).toEqual(['https://remote.example/@user/1']));
		expect(open).not.toHaveBeenCalled();
	});

	test('信頼されたURLは警告なしでそのまま開く', async () => {
		state.trusted = ['remote.example'];
		const { getByText } = renderHeader();
		getByText('remote').click();

		await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://remote.example/@user/1', '_blank', 'noopener'));
		expect(state.popups).toEqual([]);
	});
});
