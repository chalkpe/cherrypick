/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, ref, shallowRef } from 'vue';
import type { Ref } from 'vue';
import { deviceKind } from '@/utility/device-kind.js';

/**
 * 通話バーを差し込める場所。
 * - chatForm: チャットの入力欄の下 (絵文字ボタンと送信ボタンの間)。PC ではここに収める
 * - top: レイアウトの上端 (お知らせなどのバナーが並ぶ所)。モバイルではここに置く
 */
export type VoiceCallBarSlotKind = 'chatForm' | 'top';

export type VoiceCallBarVariant = 'docked' | 'top' | 'floating';

/**
 * 入力欄に収めるのに要る差し込み先の幅 (px)。これより狭ければ入力欄には置かず、画面下に浮かせる。
 * 入力欄では狭くなるほど文言とアイコンを隠し、最後はボタンだけになる (voice-call-bar.vue の .docked)。
 * ボタンが最も多いとき (マイク・スピーカー・画面共有・設定・退出の 5 個) に、28px のボタンと 4px の隙間、
 * 左右 3px ずつの余白がちょうど収まる幅にする: 5 * 28 + 4 * 4 + 3 * 2 = 162。
 * デッキの既定の幅 (330px) の列では入力欄のボタン 3 個 (50px ずつ) を除いた 180px が残るので、ボタンだけの形で収まる
 */
export const MIN_DOCKED_SLOT_WIDTH = 5 * 28 + 4 * 4 + 3 * 2;

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
	if (chatForm == null || (chatForm.width.value != null && chatForm.width.value < MIN_DOCKED_SLOT_WIDTH)) {
		return { variant: 'floating', target: null };
	}
	return { variant: 'docked', target: chatForm.el };
});
