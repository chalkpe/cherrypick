/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { Splash } from '@/server/web/views/_splash.js';

describe('スプラッシュ文言の出力', () => {
	it('HTMLとして解釈されず文字のまま出力される', () => {
		const text = '<b>太字</b> & "引用"';
		const html = String(Splash({ customSplashText: [text] }));

		expect(html).not.toContain('<b>太字</b>');
		expect(html).toContain('&lt;b>太字&lt;/b> &amp; &#34;引用&#34;');
	});

	it('通常の文言はそのまま出力される', () => {
		const html = String(Splash({ customSplashText: ['読み込み中'] }));

		expect(html).toContain('<span id="splashText">読み込み中</span>');
	});
});
