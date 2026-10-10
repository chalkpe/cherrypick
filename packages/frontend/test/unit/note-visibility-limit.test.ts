/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { clampNoteVisibility, getNoteVisibilityLockReason, nextNoteVisibility } from '@/utility/note-visibility-limit.js';

describe('note visibility limits', () => {
	test('preserves narrower visibility and combines role and personal limits', () => {
		expect(clampNoteVisibility('public', 'none', true)).toBe('home');
		expect(clampNoteVisibility('public', 'followers', true)).toBe('followers');
		expect(clampNoteVisibility('home', 'followers', false)).toBe('followers');
		expect(clampNoteVisibility('followers', 'home', false)).toBe('followers');
		expect(clampNoteVisibility('specified', 'followers', true)).toBe('specified');
		expect(clampNoteVisibility('public', 'none', false)).toBe('public');
	});

	test('cycles only through allowed options', () => {
		expect(nextNoteVisibility('specified', 'home', false)).toBe('home');
		expect(nextNoteVisibility('specified', 'followers', false)).toBe('followers');
		expect(nextNoteVisibility('specified', 'none', true)).toBe('home');
		expect(nextNoteVisibility('followers', 'followers', true)).toBe('specified');
		expect(nextNoteVisibility('specified', 'none', false, true)).toBe('specified');
	});

	test('explains role locks before personal locks and preserves direct reply restrictions', () => {
		expect(getNoteVisibilityLockReason('public', 'followers', true)).toBe('role');
		expect(getNoteVisibilityLockReason('home', 'followers', true)).toBe('personal');
		expect(getNoteVisibilityLockReason('public', 'home', false)).toBe('personal');
		expect(getNoteVisibilityLockReason('followers', 'none', false, true)).toBe('reply');
		expect(getNoteVisibilityLockReason('specified', 'followers', true, true)).toBeNull();
	});
});
