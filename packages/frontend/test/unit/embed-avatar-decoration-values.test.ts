/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import type * as Misskey from 'cherrypick-js';
import EmAvatar from '../../../frontend-embed/src/components/EmAvatar.vue';

vi.mock('../../../frontend-embed/src/components/EmA.vue', () => ({ default: { template: '<a><slot /></a>' } }));
vi.mock('../../../frontend-embed/src/components/EmImgWithBlurhash.vue', () => ({ default: { template: '<span />' } }));

const selector = 'img[src="https://example.com/decoration.png"]';

function renderWith(values: Record<string, unknown>) {
	const user = {
		id: 'alice', username: 'alice', host: null, avatarUrl: 'https://example.com/avatar.png',
		avatarDecorations: [{ id: 'decoration', url: 'https://example.com/decoration.png', ...values }],
	} as unknown as Misskey.entities.User;
	const view = render(EmAvatar, { props: { user } });
	return view.container.querySelector<HTMLElement>(selector)!;
}

afterEach(cleanup);

describe('埋め込み画面のアバター装飾の数値の適用', () => {
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
