/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
	trustedLinkUrlPatterns: [] as string[],
	warningEnabled: true,
	canceled: true,
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
vi.mock('@/components/MkUrlWarningDialog.vue', () => ({ default: {} }));
vi.mock('@/os.js', () => ({
	popup: (_component: unknown, props: { url: string }, events: { done: (r: { canceled: boolean }) => void; closed: () => void }) => {
		state.popups.push(props.url);
		queueMicrotask(() => events.done({ canceled: state.canceled }));
		return { dispose: () => {} };
	},
}));

import { openExternalUrl } from '@/utility/open-external-url.js';

describe('外部URLを開く', () => {
	const open = vi.fn();

	beforeEach(() => {
		state.trustedLinkUrlPatterns = [];
		state.warningEnabled = true;
		state.canceled = true;
		state.popups = [];
		open.mockReset();
		vi.stubGlobal('open', open);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('信頼されていないURLは警告を表示し、キャンセルすると開かない', async () => {
		await openExternalUrl('https://remote.example/notes/1');

		expect(state.popups).toEqual(['https://remote.example/notes/1']);
		expect(open).not.toHaveBeenCalled();
	});

	test('信頼されていないURLは警告で確認した後に一度だけ開く', async () => {
		state.canceled = false;

		await openExternalUrl('https://remote.example/notes/1');

		expect(state.popups).toEqual(['https://remote.example/notes/1']);
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith('https://remote.example/notes/1', '_blank', 'noopener');
	});

	test('信頼されたURLは警告なしでそのまま開く', async () => {
		state.trustedLinkUrlPatterns = ['remote.example'];

		await openExternalUrl('https://remote.example/notes/1');

		expect(state.popups).toEqual([]);
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith('https://remote.example/notes/1', '_blank', 'noopener');
	});

	test('警告設定が無効ならそのまま開く', async () => {
		state.warningEnabled = false;

		await openExternalUrl('https://remote.example/notes/1');

		expect(state.popups).toEqual([]);
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith('https://remote.example/notes/1', '_blank', 'noopener');
	});
});
