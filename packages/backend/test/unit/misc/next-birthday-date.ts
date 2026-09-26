/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { getNextBirthdayDate } from '@/misc/next-birthday-date.js';

describe('getNextBirthdayDate', () => {
	test('keeps February 29 on a leap day', () => {
		expect(getNextBirthdayDate(2, 29, new Date(2026, 0, 1))).toBe('2028-02-29');
		expect(getNextBirthdayDate(2, 29, new Date(2028, 2, 1))).toBe('2032-02-29');
	});

	test('uses this year for a birthday that has not passed', () => {
		expect(getNextBirthdayDate(12, 31, new Date(2026, 8, 26))).toBe('2026-12-31');
	});

	test('uses next year for a birthday that has passed', () => {
		expect(getNextBirthdayDate(1, 1, new Date(2026, 8, 26))).toBe('2027-01-01');
	});
});
