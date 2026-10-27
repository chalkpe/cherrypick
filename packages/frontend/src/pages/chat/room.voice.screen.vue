<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 見ている共有画面の一つ。いくつも並ぶので、中の操作が誰の画面のものか読み上げで分かるよう、名前のついたまとまりにする -->
<div
	ref="rootEl"
	:class="[$style.root, { [$style.fill]: fill, [$style.compact]: compact }]"
	role="group" :aria-label="i18n.tsx._voiceCall.screenShareOf({ name: userName(participant.user) })"
>
	<div :class="$style.view">
		<video ref="videoEl" :class="$style.video" autoplay playsinline muted></video>
		<!-- ステージで並べているときは、画面を押すと大きくする (大きくしている画面を押すと並べた形に戻す)。
		押せるかどうかが変わっても video 要素を作り直さないよう、映像の上に重ねたボタンにする -->
		<button
			v-if="focusable"
			type="button" class="_button" :class="[$style.focusButton, focused ? $style.zoomOut : $style.zoomIn]"
			:aria-label="i18n.ts._voiceCall.focusScreen" :aria-pressed="focused" :title="i18n.ts._voiceCall.focusScreen"
			@click="emit('toggleFocus')"
		></button>
		<span v-if="compact" :class="$style.overlay"><MkUserName :user="participant.user"/></span>
	</div>
	<div v-if="!compact" :class="$style.bar">
		<span :class="$style.label"><i class="ti ti-screen-share" role="img" :aria-label="i18n.ts._voiceCall.sharingScreen"></i> <MkUserName :user="participant.user"/></span>
		<button
			class="_button" :class="$style.control"
			:aria-label="i18n.ts._voiceCall.fullscreen" :title="i18n.ts._voiceCall.fullscreen"
			@click="requestFullscreen"
		>
			<i class="ti ti-maximize"></i>
		</button>
		<button
			v-if="pictureInPictureSupported"
			class="_button" :class="$style.control"
			:aria-label="i18n.ts._voiceCall.pictureInPicture" :title="i18n.ts._voiceCall.pictureInPicture"
			@click="requestPictureInPicture"
		>
			<i class="ti ti-picture-in-picture"></i>
		</button>
		<button
			class="_button" :class="$style.control"
			:aria-label="i18n.ts._voiceCall.stopWatching" :title="i18n.ts._voiceCall.stopWatching"
			@click="unwatchScreenShare(participant.identity)"
		>
			<i class="ti ti-x"></i>
		</button>
	</div>
</div>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, useTemplateRef, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import { i18n } from '@/i18n.js';
import { userName } from '@/filters/user.js';
import { requestFullscreen as enterFullscreen } from '@/utility/fullscreen.js';
import { attachScreenShare, unwatchScreenShare } from '@/utility/voice-call.js';

const props = withDefaults(defineProps<{
	participant: Misskey.entities.ChatRoomVoiceState['participants'][number];
	// 与えられた高さいっぱいに映す (広い画面のステージ)。指定しなければ高さの上限までに収める
	fill?: boolean;
	// 押すと大きくする (ステージで複数の画面を並べているとき)
	focusable?: boolean;
	// 大きくしている画面
	focused?: boolean;
	// 大きくした画面の下の帯に並べる小さな形。操作の列は出さず、名前を画面に重ねる
	compact?: boolean;
}>(), {
	fill: false,
	focusable: false,
	focused: false,
	compact: false,
});

const emit = defineEmits<{
	(ev: 'toggleFocus'): void;
}>();

const rootEl = useTemplateRef('rootEl');
const videoEl = useTemplateRef('videoEl');
const pictureInPictureSupported = window.document.pictureInPictureEnabled === true;

let detach: (() => void) | null = null;

watch([() => props.participant.identity, videoEl], ([identity, element]) => {
	detach?.();
	detach = element != null ? attachScreenShare(identity, element) : null;
}, { immediate: true });

onBeforeUnmount(() => {
	detach?.();
	detach = null;
});

function requestFullscreen() {
	if (rootEl.value == null || videoEl.value == null) return;
	// iPhone の Safari は video 要素の webkitEnterFullscreen しか持たないので共通ヘルパーに任せる
	enterFullscreen({ videoEl: videoEl.value, playerEl: rootEl.value });
}

function requestPictureInPicture() {
	videoEl.value?.requestPictureInPicture().catch(() => {});
}
</script>

<style lang="scss" module>
// 置き場所が決める高さの上限 (--voiceCallScreenMaxHeight) に、操作の列も含めた全体を収める。
// 収まらないときは映像の方が縮む (縦横比はそのまま、object-fit: contain)
.root {
	position: relative;
	display: flex;
	flex-direction: column;
	min-width: 0;
	min-height: 0;
	max-height: var(--voiceCallScreenMaxHeight, 70vh);
	overflow: clip;
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-bg);
}

.view {
	position: relative;
	display: flex;
	flex-direction: column;
	flex: 0 1 auto;
	min-height: 0;
	width: 100%;
}

.video {
	display: block;
	flex: 0 1 auto;
	width: 100%;
	min-height: 0;
	object-fit: contain;
}

// 与えられた高さいっぱいに映す: 広い画面のステージ、大きくした画面の下の帯、全画面
.fill,
.compact,
.root:fullscreen {
	max-height: none;

	.view,
	.video {
		flex: 1 1 0;
	}
}

.focusButton {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;

	&.zoomIn {
		cursor: zoom-in;
	}

	&.zoomOut {
		cursor: zoom-out;
	}
}

// 帯の小さな形で、誰の画面かを映像に重ねて出す。押すのは下のボタンに通す
.overlay {
	pointer-events: none;
	position: absolute;
	left: 4px;
	bottom: 4px;
	max-width: calc(100% - 8px);
	padding: 2px 6px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	border-radius: 4px;
	font-size: 0.8em;
	background: var(--MI_THEME-panel);
}

.bar {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 6px 8px;
	background: var(--MI_THEME-panel);
}

.label {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 0.9em;
}

.control {
	flex-shrink: 0;
	display: grid;
	place-items: center;
	width: 32px;
	height: 32px;
	border-radius: 100%;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}
</style>
