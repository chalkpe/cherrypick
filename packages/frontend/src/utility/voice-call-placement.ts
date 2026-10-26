/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, ref, shallowRef } from 'vue';
import { deviceKind } from '@/utility/device-kind.js';

/**
 * 通話バーを差し込める場所。
 * - chatForm: チャットの入力欄の下 (絵文字ボタンと送信ボタンの間)。PC ではここに収める
 * - top: レイアウトの上端 (お知らせなどのバナーが並ぶ所)。モバイルではここに置く
 */
export type VoiceCallBarSlotKind = 'chatForm' | 'top';

export type VoiceCallBarVariant = 'docked' | 'top' | 'floating';

// room.vue / universal.vue と同じモバイル判定
const MOBILE_THRESHOLD = 500;

function checkMobile(): boolean {
	return deviceKind === 'smartphone' || window.innerWidth <= MOBILE_THRESHOLD;
}

const isMobile = ref(checkMobile());
window.addEventListener('resize', () => {
	isMobile.value = checkMobile();
});

const slots = shallowRef<{ kind: VoiceCallBarSlotKind; el: HTMLElement }[]>([]);

/** 差し込み先を登録する。戻り値を呼ぶと登録を外す */
export function registerVoiceCallBarSlot(kind: VoiceCallBarSlotKind, el: HTMLElement): () => void {
	const entry = { kind, el };
	slots.value = [...slots.value, entry];
	return () => {
		slots.value = slots.value.filter(x => x !== entry);
	};
}

// 同じ種類が複数あるとき (ページウィンドウでチャットを開いたときなど) は後から出たほうを使う
function latestSlot(kind: VoiceCallBarSlotKind): HTMLElement | null {
	return slots.value.findLast(x => x.kind === kind)?.el ?? null;
}

/** 通話バーをどこにどの見た目で出すか。target が null なら画面下に浮かせる */
export const voiceCallBarPlacement = computed<{ variant: VoiceCallBarVariant; target: HTMLElement | null }>(() => {
	const target = latestSlot(isMobile.value ? 'top' : 'chatForm');
	if (target == null) return { variant: 'floating', target: null };
	return { variant: isMobile.value ? 'top' : 'docked', target };
});
