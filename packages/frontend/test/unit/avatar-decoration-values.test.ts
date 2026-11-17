/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import type * as Misskey from 'cherrypick-js';
import MkAvatar from '@/components/global/MkAvatar.vue';
import { prefer } from '@/preferences.js';

vi.mock('@/os.js', () => ({}));
vi.mock('@/instance.js', () => ({ instance: {} }));
vi.mock('@/preferences.js', async () => {
	const { PreferencesManager } = await import('@/preferences/manager.js');
	return { prefer: new PreferencesManager({
		load: () => null,
		save: () => {},
		cloudGet: async () => null,
		cloudGetBulk: async () => ({}),
		cloudSet: async () => {},
	}, { id: 'viewer' }) };
});
vi.mock('@/components/global/MkA.vue', () => ({ default: { template: '<a><slot /></a>' } }));

const selector = 'img[src="https://example.com/decoration.png"]';

function renderWith(values: Record<string, unknown>) {
	const user = {
		id: 'alice', username: 'alice', host: null, avatarUrl: 'https://example.com/avatar.png',
		avatarDecorations: [{ id: 'decoration', url: 'https://example.com/decoration.png', ...values }],
	} as unknown as Misskey.entities.User;
	const view = render(MkAvatar, { props: { user } });
	return view.container.querySelector<HTMLElement>(selector)!;
}

beforeEach(async () => {
	await prefer.cloudReady;
	prefer.commit('enableHighQualityImagePlaceholders', false);
	prefer.commit('showAvatarDecorations', true);
	prefer.commit('showRemoteAvatarDecorations', true);
});
afterEach(cleanup);

describe('アバター装飾の数値の適用', () => {
	test('範囲内の値はそのまま適用される', () => {
		const img = renderWith({ angle: 0.25, offsetX: 0.1, offsetY: -0.2, scale: 1.5, opacity: 0.5 });
		expect(img.style.rotate).toBe('90deg');
		expect(img.style.translate).toBe('10% -20%');
		expect(img.style.transform).toBe('scale(1.5)');
		expect(img.style.opacity).toBe('0.5');
	});

	test('範囲外の値は範囲内に収められる', () => {
		const img = renderWith({ angle: 80, offsetX: 3, offsetY: -2, scale: 80, opacity: 5 });
		expect(img.style.rotate).toBe('180deg');
		expect(img.style.translate).toBe('25% -25%');
		expect(img.style.transform).toBe('scale(1.5)');
		expect(img.style.opacity).toBe('');
	});

	test('数値でない値は既定値になる', () => {
		const img = renderWith({ angle: '1', offsetX: '3', offsetY: {}, scale: '1) translate(-40vw,-40vh) scale(60', opacity: 'x' });
		expect(img.style.rotate).toBe('');
		expect(img.style.translate).toBe('');
		expect(img.style.transform).toBe('');
		expect(img.style.opacity).toBe('');
	});
});
