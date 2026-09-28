/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import * as mfm from 'mfc-js';
import { HTML_TAGS } from '@@/js/const.js';
import { insertMfmFunction, mfmFunctionPicker } from '@/utility/mfm-function-picker.js';
import * as os from '@/os.js';

vi.mock('@/os.js', () => ({ popupMenu: vi.fn() }));

describe('MFM function picker', () => {
	test('offers every HTML function through the callback menu', () => {
		const chosen = vi.fn();
		mfmFunctionPicker(null, chosen);
		const menu = vi.mocked(os.popupMenu).mock.calls[0][0];
		for (const tag of HTML_TAGS) {
			const item = menu.find(item => typeof item === 'object' && item !== null && 'text' in item && item.text === tag);
			if (typeof item !== 'object' || item == null || !('action' in item)) throw new Error(`Missing ${tag}`);
			item.action(new PointerEvent('click'));
			expect(chosen).toHaveBeenLastCalledWith(tag);
		}
	});

	test.each([
		['bold', 'bold'], ['strike', 'strike'], ['italic', 'italic'], ['small', 'small'], ['center', 'center'], ['plain', 'plain'],
		['inlinecode', 'inlineCode'], ['blockcode', 'blockCode'], ['mathinline', 'mathInline'], ['mathblock', 'mathBlock'], ['tada', 'fn'],
	])('inserts parseable %s markup while preserving the selected text', (tag, nodeType) => {
		const inserted = insertMfmFunction('hello', 0, 5, tag);
		expect(inserted.text.slice(inserted.start, inserted.end)).toBe('hello');
		expect(mfm.parse(inserted.text)[0].type).toBe(nodeType);
	});

	test('places an empty selection inside the inserted syntax without altering surrounding text', () => {
		const inserted = insertMfmFunction('beforeafter', 6, 6, 'bold');
		expect(inserted).toEqual({ text: 'before<b></b>after', start: 9, end: 9 });
	});
});
