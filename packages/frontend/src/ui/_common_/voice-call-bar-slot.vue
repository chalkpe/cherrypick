<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="el" :class="{ [$style.chatForm]: kind === 'chatForm' }"></div>
</template>

<script lang="ts" setup>
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, useTemplateRef } from 'vue';
import type { VoiceCallBarSlotKind } from '@/utility/voice-call-placement.js';
import { registerVoiceCallBarSlot } from '@/utility/voice-call-placement.js';

// 通話バーの差し込み先。通話バー自体は common.vue に 1 つだけあり、ここへ Teleport してくる
const props = defineProps<{
	kind: VoiceCallBarSlotKind;
}>();

const el = useTemplateRef('el');
let registration: ReturnType<typeof registerVoiceCallBarSlot> | null = null;
let observer: ResizeObserver | null = null;

function attach() {
	// KeepAlive で裏に回ったページの中で作られたとき (読み込みが終わって入力欄が出たときなど) は、
	// どこにも描かれない所なので登録しない。ページが表に戻ったときに onActivated で登録する
	if (registration != null || el.value == null || !el.value.isConnected) return;
	const current = registerVoiceCallBarSlot(props.kind, el.value);
	registration = current;
	// 入力欄では、ボタンが収まる幅があるかどうかで通話バーを置くかを決めるので、幅を測って知らせる
	if (props.kind === 'chatForm' && typeof ResizeObserver !== 'undefined') {
		observer = new ResizeObserver(entries => {
			for (const entry of entries) {
				// どこにも描かれていない要素の幅 (0) は見える幅ではないので無視する
				if (!entry.target.isConnected) continue;
				current.setWidth(entry.contentRect.width);
			}
		});
		observer.observe(el.value);
	}
}

function detach() {
	observer?.disconnect();
	observer = null;
	registration?.unregister();
	registration = null;
}

onMounted(attach);
// KeepAlive で裏に回ったページの中へは出さない
onActivated(attach);
onDeactivated(detach);
onBeforeUnmount(detach);
</script>

<style lang="scss" module>
// 通話バー (voice-call-bar.vue) はこの幅に合わせてコンテナクエリで詰めて表示する
.chatForm {
	container-type: inline-size;
}
</style>
