<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 参加者のチップやタイルに出す、共有画面の小さなプレビュー。映像が届くまでは共有のアイコンが見える。
押したときの意味はチップやタイルのボタンの名前で伝えるので、読み上げからは隠す -->
<span :class="$style.root" aria-hidden="true">
	<i class="ti ti-screen-share" :class="$style.icon"></i>
	<video ref="videoEl" :class="$style.video" autoplay playsinline muted disablepictureinpicture></video>
</span>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, useTemplateRef, watch } from 'vue';
import { attachScreenShare } from '@/utility/voice-call.js';

const props = defineProps<{
	identity: string;
}>();

const videoEl = useTemplateRef('videoEl');

let detach: (() => void) | null = null;

// プレビューとして映しているあいだは、見ていない共有画面も低い層だけ受け取る
watch([() => props.identity, videoEl], ([identity, element]) => {
	detach?.();
	detach = element != null ? attachScreenShare(identity, element, { preview: true }) : null;
}, { immediate: true });

onBeforeUnmount(() => {
	detach?.();
	detach = null;
});
</script>

<style lang="scss" module>
.root {
	position: relative;
	display: grid;
	place-items: center;
	overflow: clip;
	aspect-ratio: 16 / 9;
	border-radius: 4px;
	background: var(--MI_THEME-bg);
	color: var(--MI_THEME-accent);
}

.icon {
	grid-area: 1 / 1;
}

// 映像が届くまでは透明なので、下のアイコンが見える
.video {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: cover;
}
</style>
