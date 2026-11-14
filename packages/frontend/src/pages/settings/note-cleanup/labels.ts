/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NoteCleanupCondition as Condition, NoteCleanupFlag } from 'cherrypick-js/entities.js';
import { i18n } from '@/i18n.js';

export const flagNames: Record<NoteCleanupFlag, string> = {
	pinned: i18n.ts._noteCleanup.pinned, favorite: i18n.ts._noteCleanup.favorite,
	selfReaction: i18n.ts._noteCleanup.selfReaction, selfRenote: i18n.ts._noteCleanup.selfRenote,
	reply: i18n.ts._noteCleanup.reply, quote: i18n.ts._noteCleanup.quote,
	poll: i18n.ts._noteCleanup.poll, files: i18n.ts._noteCleanup.files,
	cw: i18n.ts._noteCleanup.cw, localOnly: i18n.ts._noteCleanup.localOnly,
};
export const conditionNames: Record<Condition['type'], string> = {
	all: i18n.ts._noteCleanup.all, any: i18n.ts._noteCleanup.any,
	keyword: i18n.ts._noteCleanup.keyword, age: i18n.ts._noteCleanup.age, count: i18n.ts._noteCleanup.count,
	flag: i18n.ts._noteCleanup.flag, visibility: i18n.ts._noteCleanup.visibility,
	channel: i18n.ts._noteCleanup.channel, clip: i18n.ts._noteCleanup.clip, hashtag: i18n.ts._noteCleanup.hashtag,
};
export const targetNames = {
	text: i18n.ts._noteCleanup.text, cw: i18n.ts._noteCleanup.cw, poll: i18n.ts._noteCleanup.poll,
	fileComment: i18n.ts._noteCleanup.fileComment, fileName: i18n.ts._noteCleanup.fileName,
};
// 조건 입력란과 같은 기준으로 나누어떨어지는 가장 큰 단위를 고르며, 저장된 초 값은 반올림하지 않는다.
export function ageUnit(seconds: number): number {
	return [86400, 3600, 60, 1].find(unit => seconds % unit === 0) ?? 1;
}
