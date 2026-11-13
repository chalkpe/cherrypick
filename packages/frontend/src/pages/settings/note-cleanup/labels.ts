/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NoteCleanupCondition as Condition, NoteCleanupFlag } from 'cherrypick-js/entities.js';
import { i18n } from '@/i18n.js';
import { childrenOf } from '@/utility/note-cleanup-editor.js';

export const flagNames: Record<NoteCleanupFlag, string> = {
	pinned: i18n.ts._noteCleanup.pinned, favorite: i18n.ts._noteCleanup.favorite,
	selfReaction: i18n.ts._noteCleanup.selfReaction, selfRenote: i18n.ts._noteCleanup.selfRenote,
	reply: i18n.ts._noteCleanup.reply, quote: i18n.ts._noteCleanup.quote,
	poll: i18n.ts._noteCleanup.poll, files: i18n.ts._noteCleanup.files,
	cw: i18n.ts._noteCleanup.cw, localOnly: i18n.ts._noteCleanup.localOnly,
};
export const conditionNames: Record<Condition['type'], string> = {
	all: i18n.ts._noteCleanup.all, any: i18n.ts._noteCleanup.any, not: i18n.ts._noteCleanup.not,
	keyword: i18n.ts._noteCleanup.keyword, age: i18n.ts._noteCleanup.age, count: i18n.ts._noteCleanup.count,
	flag: i18n.ts._noteCleanup.flag, visibility: i18n.ts._noteCleanup.visibility,
	channel: i18n.ts._noteCleanup.channel, clip: i18n.ts._noteCleanup.clip, hashtag: i18n.ts._noteCleanup.hashtag,
};
export const targetNames = {
	text: i18n.ts._noteCleanup.text, cw: i18n.ts._noteCleanup.cw, poll: i18n.ts._noteCleanup.poll,
	fileComment: i18n.ts._noteCleanup.fileComment, fileName: i18n.ts._noteCleanup.fileName,
};
const visibilityNames = i18n.ts._visibility;
// 조건 입력란과 같은 기준으로 나누어떨어지는 가장 큰 단위를 고르며, 저장된 초 값은 반올림하지 않는다.
export function ageUnit(seconds: number): number {
	return [86400, 3600, 60, 1].find(unit => seconds % unit === 0) ?? 1;
}

// 값·단위·비교의 어순은 언어마다 다르므로 locale의 매개변수 문구에 맡긴다.
function durationSummary(seconds: number): string {
	const unit = ageUnit(seconds);
	const keys = { 86400: 'days', 3600: 'hours', 60: 'minutes', 1: 'seconds' } as const;
	return i18n.tsx._noteCleanup._duration[keys[unit as keyof typeof keys]]({ n: seconds / unit });
}

export function summary(node: Condition): string {
	switch (node.type) {
		case 'all': case 'any': return `${conditionNames[node.type]} (${node.children.length})`;
		case 'not': return `${conditionNames.not}: ${summary(node.child)}`;
		case 'keyword': return `${node.mode === 'literal' ? i18n.ts._noteCleanup.literal : i18n.ts._noteCleanup.regex}: ${node.value} [${node.targets.map(v => targetNames[v]).join(', ')}]${node.mode === 'regex' ? ` (${node.flags})` : ''}`;
		case 'flag': return `${flagNames[node.field]}: ${node.value ? i18n.ts._noteCleanup.yes : i18n.ts._noteCleanup.no}`;
		case 'age': return i18n.tsx._noteCleanup._ageSummary[node.operator]({ duration: durationSummary(node.seconds) });
		case 'count': return i18n.tsx._noteCleanup._countSummary[node.operator]({ field: i18n.ts._noteCleanup[node.field], value: node.value });
		case 'clip': return node.ids === null ? i18n.ts._noteCleanup.allClips : `${conditionNames.clip}: ${i18n.tsx._noteCleanup.selectedReferences({ n: node.ids.length })}`;
		case 'channel': return `${conditionNames.channel}: ${i18n.tsx._noteCleanup.selectedReferences({ n: node.ids.length })}`;
		case 'hashtag': return `#${node.value.replace(/^#/, '')}`;
		case 'visibility': return `${conditionNames.visibility}: ${node.values.map(v => visibilityNames[v as keyof typeof visibilityNames]).join(', ')}`;
	}
}
export function fullSummary(node: Condition): string {
	return [summary(node), ...childrenOf(node).map(fullSummary)].join(' / ');
}
