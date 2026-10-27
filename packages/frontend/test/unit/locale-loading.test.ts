/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { locale } from '@@/js/locale.js';

test('serves the import-time locale asset through the unit fetch mock', () => {
	expect(locale?._lang_).toBe('English');
});
