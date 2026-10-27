/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, ref, shallowRef } from 'vue';
import type { Ref } from 'vue';
import { $i } from '@/i.js';
import { canShareScreen, voiceCall } from '@/utility/voice-call.js';
import { deviceKind } from '@/utility/device-kind.js';

/**
 * 通話バーを差し込める場所。
 * - chatForm: チャットの入力欄の下 (絵文字ボタンと送信ボタンの間)。PC ではここに収める
 * - top: レイアウトの上端 (お知らせなどのバナーが並ぶ所)。モバイルではここに置く
 */
export type VoiceCallBarSlotKind = 'chatForm' | 'top';

export type VoiceCallBarVariant = 'docked' | 'top' | 'floating';

/** 5 個の操作ボタン、戻るアイコン、余白が収まる幅。音声の再生ボタンは別に確保する。 */
export const MIN_DOCKED_SLOT_WIDTH = 5 * 28 + 4 * 4 + 16 + 6 + 3 * 2;

// room.vue / universal.vue と同じモバイル判定
const MOBILE_THRESHOLD = 500;

function checkMobile(): boolean {
	return deviceKind === 'smartphone' || window.innerWidth <= MOBILE_THRESHOLD;
}

const isMobile = ref(checkMobile());
window.addEventListener('resize', () => {
	isMobile.value = checkMobile();
});

type VoiceCallBarSlot = {
	kind: VoiceCallBarSlotKind;
	el: HTMLElement;
	// 差し込み先の中身の幅。まだ測っていなければ null (収まるものとして扱う)
	width: Ref<number | null>;
};

const slots = shallowRef<VoiceCallBarSlot[]>([]);

/** 差し込み先を登録する。戻り値で幅を知らせたり、登録を外したりする */
export function registerVoiceCallBarSlot(kind: VoiceCallBarSlotKind, el: HTMLElement): { setWidth: (width: number) => void; unregister: () => void } {
	const entry: VoiceCallBarSlot = { kind, el, width: ref(null) };
	slots.value = [...slots.value, entry];
	return {
		setWidth: (width: number) => {
			entry.width.value = width;
		},
		unregister: () => {
			slots.value = slots.value.filter(x => x !== entry);
		},
	};
}

// 同じ種類が複数あるとき (ページウィンドウでチャットを開いたときなど) は後から出たほうを使う
function latestSlot(kind: VoiceCallBarSlotKind): VoiceCallBarSlot | null {
	return slots.value.findLast(x => x.kind === kind) ?? null;
}

/** 通話バーをどこにどの見た目で出すか。target が null なら画面下に浮かせる */
export const voiceCallBarPlacement = computed<{ variant: VoiceCallBarVariant; target: HTMLElement | null }>(() => {
	if (isMobile.value) {
		const top = latestSlot('top');
		return top == null ? { variant: 'floating', target: null } : { variant: 'top', target: top.el };
	}
	const chatForm = latestSlot('chatForm');
	// 入力欄が狭すぎてボタンが収まらないときは、切れたボタンを出すより浮かせる
	const sharing = canShareScreen() && $i?.policies.canScreenShare === true;
	const requiredWidth = MIN_DOCKED_SLOT_WIDTH - (sharing ? 0 : 28 + 4) + (voiceCall.audioBlocked ? 28 + 6 : 0);
	if (chatForm == null || (chatForm.width.value != null && chatForm.width.value < requiredWidth)) {
		return { variant: 'floating', target: null };
	}
	return { variant: 'docked', target: chatForm.el };
});
