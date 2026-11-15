/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { CleanupRule } from '@/utility/note-cleanup-api.js';

// 새 규칙을 처음 저장하면 경로가 바뀌며 편집 화면이 다시 만들어진다. 저장된 규칙과 스크롤 위치를 한 번만 넘겨 다시 읽지 않고 바로 그린다.
let pending: { rule: CleanupRule; scrollTop: number; expires: number } | null = null;

export function handOffSavedRule(rule: CleanupRule, scrollTop: number): void {
	pending = { rule, scrollTop, expires: Date.now() + 5000 };
}

export function takeSavedRule(ruleId: string): { rule: CleanupRule; scrollTop: number } | null {
	const value = pending;
	pending = null;
	if (value == null || value.rule.id !== ruleId || value.expires < Date.now()) return null;
	return { rule: value.rule, scrollTop: value.scrollTop };
}
