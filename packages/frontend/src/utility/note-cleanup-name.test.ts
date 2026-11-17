/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { cleanupRuleName } from './note-cleanup-name.js';

test('제품 이름은 현재 세 언어를 따르고 같은 한국어 사용자 문구는 그대로 둔다', () => {
 const names = ['pinned', 'favorite', 'clip', 'selfReaction', 'age'] as const;
 for (const language of ['ko-KR', 'ja-JP', 'en-US']) {
 const locale = yaml.load(readFileSync(`../../locales/${language}.yml`, 'utf8')) as any;
 for (const defaultName of names) {
 expect(cleanupRuleName({ name: '저장 이름', defaultName }, locale._noteCleanup)).toBe(locale._noteCleanup._defaultNames[defaultName]);
 expect(locale._noteCleanup._defaultNames[defaultName]).toBeTruthy();
 }
 expect(cleanupRuleName({ name: '고정한 내 글', defaultName: null }, locale._noteCleanup)).toBe('고정한 내 글');
 }
});
