<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="rootEl" :class="$style.root">
	<video ref="videoEl" :class="$style.video" autoplay playsinline muted></video>
	<div :class="$style.bar">
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
			@click="watchScreenShare(null)"
		>
			<i class="ti ti-eye-off"></i>
		</button>
	</div>
</div>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, useTemplateRef, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import { i18n } from '@/i18n.js';
import { requestFullscreen as enterFullscreen } from '@/utility/fullscreen.js';
import { attachScreenShare, watchScreenShare } from '@/utility/voice-call.js';

const props = defineProps<{
	participant: Misskey.entities.ChatRoomVoiceState['participants'][number];
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
.root {
	position: relative;
	overflow: clip;
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-bg);
}

.video {
	display: block;
	width: 100%;
	max-height: 70vh;
	object-fit: contain;
}

.bar {
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
