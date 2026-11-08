/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/analytics.js', () => ({ analytics: { page: vi.fn() } }));

import { mainRouter } from '@/router.js';
import { canGoBackInApp, pushAppHistory, replaceAppHistory } from '@/utility/app-history.js';

beforeEach(() => {
	window.history.replaceState(null, '', '/chat/room/r1');
});

describe('canGoBackInApp', () => {
	test('is false on an entry this app has not recorded, like a page opened directly in a new tab', () => {
		expect(canGoBackInApp()).toBe(false);
	});

	test('is false on an entry that holds unrelated state', () => {
		window.history.replaceState({ cherrypick: 'loginId' }, '', '/chat/room/r1');

		expect(canGoBackInApp()).toBe(false);
	});

	test('stays false after the first entry is replaced', () => {
		replaceAppHistory('/chat/room/r2');

		expect(canGoBackInApp()).toBe(false);
		expect(window.location.pathname).toBe('/chat/room/r2');
	});

	test('is true after a push', () => {
		pushAppHistory('/chat');

		expect(canGoBackInApp()).toBe(true);
		expect(window.location.pathname).toBe('/chat');
	});

	test('stays true when a pushed entry is replaced', () => {
		pushAppHistory('/chat');
		replaceAppHistory('/chat/room/r2');

		expect(canGoBackInApp()).toBe(true);
	});
});

describe('the main router', () => {
	test('records its pushes, so the page it came from counts as history of this app', () => {
		mainRouter.pushByPath('/chat');

		expect(window.location.pathname).toBe('/chat');
		expect(canGoBackInApp()).toBe(true);
	});

	test('does not count a replace as history', () => {
		mainRouter.replaceByPath('/chat/room/r2');

		expect(window.location.pathname).toBe('/chat/room/r2');
		expect(canGoBackInApp()).toBe(false);
	});
});
