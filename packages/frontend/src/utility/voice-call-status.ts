/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, onActivated, onDeactivated, onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { Ref } from 'vue';
import { i18n } from '@/i18n.js';
import { observeElementVisibility } from '@/utility/observe-element-visibility.js';
import { voiceCall } from '@/utility/voice-call.js';

/**
 * 参加中の通話の状態 (通話中・接続中・再接続中) を表す文言。
 * 通話バーと、ルーム画面の通話カード・ステージの見出しで同じものを出す
 */
export const voiceCallStatusText = computed(() => {
	switch (voiceCall.status) {
		case 'connecting': return i18n.ts._voiceCall.connecting;
		case 'reconnecting': return i18n.ts._voiceCall.reconnecting;
		default: return i18n.ts._voiceCall.inCall;
	}
});

// ルーム内の見出しが読み上げるあいだは、共通の通話バーで同じ状態を二重に読み上げない。
const roomAnnouncers = shallowRef(new Set<symbol>());
export const voiceCallStatusAnnouncedInRoom = computed(() => roomAnnouncers.value.size > 0);

export function useVoiceCallStatusAnnouncer(inThisCall: Readonly<Ref<boolean>>, target: Readonly<Ref<HTMLElement | null>>) {
	const key = Symbol();
	const active = ref(true);
	const visible = ref(false);
	let visibility: ReturnType<typeof observeElementVisibility> | null = null;
	watch(target, el => {
		visibility?.dispose();
		visibility = el == null ? null : observeElementVisibility(el, value => { visible.value = value; });
		if (el == null) visible.value = false;
	}, { immediate: true, flush: 'post' });

	function update(announces: boolean) {
		const next = new Set(roomAnnouncers.value);
		if (announces) next.add(key);
		else next.delete(key);
		roomAnnouncers.value = next;
	}

	watch(() => active.value && visible.value && inThisCall.value, update, { immediate: true, flush: 'sync' });
	onDeactivated(() => { active.value = false; });
	onActivated(() => {
		visibility?.refresh();
		active.value = true;
	});
	onScopeDispose(() => {
		visibility?.dispose();
		update(false);
	});
	return computed(() => [...roomAnnouncers.value].at(-1) === key);
}
