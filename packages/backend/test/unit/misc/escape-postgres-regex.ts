/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { escapePostgresRegex } from '@/misc/escape-postgres-regex.js';

describe(escapePostgresRegex, () => {
	it('leaves normal strings unchanged', () => {
		expect(escapePostgresRegex('Tokyo Music Event 2026')).toBe('Tokyo Music Event 2026');
	});

	it('does not alter non-ASCII text', () => {
		expect(escapePostgresRegex('音楽イベント')).toBe('音楽イベント');
	});

	it('escapes regex metacharacters', () => {
		expect(escapePostgresRegex('\\^$.*+?()[]{}|')).toBe('\\\\\\^\\$\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|');
	});

	it('treats metacharacters as literals', () => {
		const pattern = escapePostgresRegex('(a|b)+');
		expect(new RegExp(pattern, 'i').test('(A|B)+')).toBe(true);
		expect(new RegExp(pattern, 'i').test('a')).toBe(false);
	});
});
