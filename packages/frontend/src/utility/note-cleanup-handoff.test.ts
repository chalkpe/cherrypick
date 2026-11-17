/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, expect, test, vi } from 'vitest';
import { handOffSavedRule, peekSavedRule, takeSavedRule } from '@/utility/note-cleanup-handoff.js';
import type { CleanupRule } from '@/utility/note-cleanup-api.js';

afterEach(() => { vi.useRealTimers(); takeSavedRule(''); });

const rule = (id: string) => ({ id }) as CleanupRule;

test('a saved rule is handed over once and only to the same rule', () => {
	handOffSavedRule(rule('a'), 40);
	expect(takeSavedRule('b')).toBeNull();
	// 다른 규칙이 가져가면 값은 지워진다.
	expect(takeSavedRule('a')).toBeNull();
	handOffSavedRule(rule('a'), 40);
	expect(takeSavedRule('a')).toEqual({ rule: rule('a'), scrollTop: 40 });
	expect(takeSavedRule('a')).toBeNull();
});

test('a handed over rule expires when nothing takes it', () => {
	vi.useFakeTimers();
	handOffSavedRule(rule('a'), 0);
	vi.advanceTimersByTime(6000);
	expect(takeSavedRule('a')).toBeNull();
});

test('peeking reads the value without consuming it so only the visible screen takes it', () => {
	handOffSavedRule(rule('a'), 40);
	// 숨은 화면이 먼저 읽어도 슬롯은 그대로 남아 보이는 화면이 가져갈 수 있다.
	expect(peekSavedRule('a')).toEqual({ rule: rule('a'), scrollTop: 40 });
	expect(peekSavedRule('a')).toEqual({ rule: rule('a'), scrollTop: 40 });
	expect(peekSavedRule('b')).toBeNull();
	expect(takeSavedRule('a')).toEqual({ rule: rule('a'), scrollTop: 40 });
	expect(peekSavedRule('a')).toBeNull();
});
