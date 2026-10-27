/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, ref, shallowRef } from 'vue';
import type { Ref } from 'vue';
import { $i } from '@/i.js';
import { canShareScreen, voiceCall } from '@/utility/voice-call.js';
import { voiceCallStatusAnnouncedInRoom } from '@/utility/voice-call-status.js';
import { observeElementVisibility } from '@/utility/observe-element-visibility.js';
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
	visible: Ref<boolean>;
	focused: Ref<number>;
};

const slots = shallowRef<VoiceCallBarSlot[]>([]);
let focusOrder = 0;

/** 差し込み先を登録する。戻り値で幅を知らせたり、登録を外したりする */
export function registerVoiceCallBarSlot(kind: VoiceCallBarSlotKind, el: HTMLElement, focusWithin: HTMLElement = el): { setWidth: (width: number) => void; unregister: () => void } {
	const entry: VoiceCallBarSlot = { kind, el, width: ref(null), visible: ref(false), focused: ref(0) };
	const visibility = observeElementVisibility(el, value => { entry.visible.value = value; });

	function onFocus() {
		visibility.refresh();
		if (entry.visible.value) entry.focused.value = ++focusOrder;
	}

	focusWithin.addEventListener('focusin', onFocus);
	if (focusWithin.contains(window.document.activeElement)) onFocus();
	slots.value = [...slots.value, entry];
	return {
		setWidth: (width: number) => {
			entry.width.value = width;
			visibility.refresh();
		},
		unregister: () => {
			visibility.dispose();
			focusWithin.removeEventListener('focusin', onFocus);
			slots.value = slots.value.filter(x => x !== entry);
		},
	};
}

// 見えるフォームのうち最後に操作したものを使う。一度も操作していなければ、後から出たものを使う。
function latestSlot(kind: VoiceCallBarSlotKind): VoiceCallBarSlot | null {
	let latest: VoiceCallBarSlot | null = null;
	for (const slot of slots.value) {
		if (slot.kind === kind && slot.visible.value && (latest == null || slot.focused.value >= latest.focused.value)) latest = slot;
	}
	return latest;
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

// 通話中のルームにカードやステージが出ているあいだは、同じ操作を二重に出さない。
// モバイルではいつも隠す。PC では入力欄に収まらず浮かせるときだけ隠す (浮かせたバーはルームの入力欄に重なる)。
// 入力欄に収まるときはそのまま出す
export const voiceCallBarHidden = computed(() => voiceCallStatusAnnouncedInRoom.value && (isMobile.value || voiceCallBarPlacement.value.variant === 'floating'));
