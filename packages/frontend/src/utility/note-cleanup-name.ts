/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NoteCleanupDefaultName } from 'cherrypick-js/entities.js';

// 문자열·조건·legacy로 기본 이름을 추정하지 않는다. 알 수 없는 출처는 저장한 이름으로 표시한다.
export function cleanupRuleName(rule: { name: string; defaultName?: NoteCleanupDefaultName | null }, locale: { _defaultNames: Record<NoteCleanupDefaultName, string> }): string {
 return rule.defaultName && Object.hasOwn(locale._defaultNames, rule.defaultName) ? locale._defaultNames[rule.defaultName] : rule.name;
}
