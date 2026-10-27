<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 見ている共有画面の一つ。いくつも並ぶので、中の操作が誰の画面のものか読み上げで分かるよう、名前のついたまとまりにする。
置き場所 (root) の中に、映像の縦横比に合わせた枠 (frame) を置き、操作の列はその枠の映像のすぐ下に付ける。
枠は操作の列より狭くしない (狭い置き場所では映像の方を縮めて上下か左右を空ける) ので、全画面・PiP・✕ は切れない -->
<div
	ref="rootEl"
	:class="[$style.root, { [$style.fill]: fill, [$style.compact]: compact }]"
	:style="{ '--voiceCallScreenRatio': ratio }"
	role="group" :aria-label="i18n.tsx._voiceCall.screenShareOf({ name: userName(participant.user) })"
>
	<div :class="$style.frame" :style="compact ? undefined : { minWidth: `${barMinWidth}px` }">
		<div :class="$style.view">
			<video ref="videoEl" :class="$style.video" autoplay playsinline muted @loadedmetadata="updateRatio" @resize="updateRatio"></video>
			<!-- ステージで並べているときは、画面を押すと大きくする (大きくしている画面を押すと並べた形に戻す)。
			押せるかどうかが変わっても video 要素を作り直さないよう、映像の上に重ねたボタンにする。
			全画面のあいだは置かない (押すと並べ方が変わり、全画面が解けてしまう) -->
			<button
				v-if="focusable && !fullscreen"
				type="button" class="_button" :class="[$style.focusButton, focused ? $style.zoomOut : $style.zoomIn]"
				:aria-label="i18n.ts._voiceCall.focusScreen" :aria-pressed="focused" :title="i18n.ts._voiceCall.focusScreen"
				@click="toggleFocus"
			></button>
			<!-- 下の帯の小さな形と狭い画面のカードでは、誰の画面かを映像の左上に重ねる (操作の列に並べると名前が一文字ほどに縮む) -->
			<span v-if="!fill || compact" :class="$style.overlay"><i class="ti ti-screen-share" role="img" :aria-label="i18n.ts._voiceCall.sharingScreen"></i> <MkUserName :user="participant.user"/></span>
		</div>
		<div v-if="!compact" :class="[$style.bar, { [$style.controlsOnly]: !fill }]">
			<span v-if="fill" :class="$style.label"><i class="ti ti-screen-share" role="img" :aria-label="i18n.ts._voiceCall.sharingScreen"></i> <MkUserName :user="participant.user"/></span>
			<button
				type="button" class="_button" :class="$style.control"
				:aria-label="i18n.ts._voiceCall.fullscreen" :title="i18n.ts._voiceCall.fullscreen"
				@click="requestFullscreen"
			>
				<i class="ti ti-maximize"></i>
			</button>
			<button
				v-if="pictureInPictureSupported"
				type="button" class="_button" :class="$style.control"
				:aria-label="i18n.ts._voiceCall.pictureInPicture" :title="i18n.ts._voiceCall.pictureInPicture"
				@click="requestPictureInPicture"
			>
				<i class="ti ti-picture-in-picture"></i>
			</button>
			<button
				type="button" class="_button" :class="$style.control"
				:aria-label="i18n.ts._voiceCall.stopWatching" :title="i18n.ts._voiceCall.stopWatching"
				@click="stopWatching"
			>
				<i class="ti ti-x"></i>
			</button>
		</div>
	</div>
</div>
</template>

<script lang="ts" setup>
import { nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import { i18n } from '@/i18n.js';
import { userName } from '@/filters/user.js';
import { requestFullscreen as enterFullscreen } from '@/utility/fullscreen.js';
import { attachScreenShare, unwatchScreenShare } from '@/utility/voice-call.js';

const props = withDefaults(defineProps<{
	participant: Misskey.entities.ChatRoomVoiceState['participants'][number];
	// 与えられた広さいっぱいに映す (広い画面のステージ)。指定しなければ高さの上限 (--voiceCallScreenMaxHeight) までに収める
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

// 操作の列が収まる幅。CSS の .bar (左右の余白 8px、間隔 4px) と .control (32px) に合わせる
const barMinWidth = (() => {
	const controls = pictureInPictureSupported ? 3 : 2;
	return 8 * 2 + controls * 32 + (controls - 1) * 4;
})();

// 共有されている映像の縦横比。届くまでは画面共有でよくある 16:9 とみなす
const ratio = ref(16 / 9);

function updateRatio() {
	const video = videoEl.value;
	if (video == null || video.videoWidth <= 0 || video.videoHeight <= 0) return;
	ratio.value = video.videoWidth / video.videoHeight;
}

// この画面が全画面になっているか
const fullscreen = ref(false);

function onFullscreenChange() {
	fullscreen.value = rootEl.value != null && window.document.fullscreenElement === rootEl.value;
}

window.document.addEventListener('fullscreenchange', onFullscreenChange);

let detach: (() => void) | null = null;

watch([() => props.participant.identity, videoEl], ([identity, element]) => {
	detach?.();
	detach = element != null ? attachScreenShare(identity, element) : null;
}, { immediate: true });

onBeforeUnmount(() => {
	window.document.removeEventListener('fullscreenchange', onFullscreenChange);
	detach?.();
	detach = null;
});

function toggleFocus() {
	// 全画面のあいだに届いたクリックでは並べ方を変えない
	if (rootEl.value != null && window.document.fullscreenElement === rootEl.value) return;
	emit('toggleFocus');
}

function requestFullscreen() {
	if (rootEl.value == null || videoEl.value == null) return;
	// iPhone の Safari は video 要素の webkitEnterFullscreen しか持たないので共通ヘルパーに任せる
	enterFullscreen({ videoEl: videoEl.value, playerEl: rootEl.value });
}

function requestPictureInPicture() {
	videoEl.value?.requestPictureInPicture().catch(() => {});
}

// 見るのをやめると押したボタンごとこの画面が消え、キーボードのフォーカスがページの先頭に戻ってしまう。
// その人のチップやタイル (見る・やめるを切り替えるボタン) へ、無ければ隣の画面へフォーカスを移す
function stopWatching() {
	const identity = props.participant.identity;
	const root = rootEl.value;
	const neighbour = root?.nextElementSibling ?? root?.previousElementSibling ?? null;
	unwatchScreenShare(identity);
	nextTick(() => {
		const toggle = [...window.document.querySelectorAll<HTMLElement>('[data-voice-call-watch-toggle]')]
			.find(el => el.dataset.voiceCallWatchToggle === identity);
		const target = toggle ?? neighbour?.querySelector<HTMLElement>('button') ?? null;
		if (target == null) return;
		target.focus({ preventScroll: true });
		// タイルの帯は横にスクロールするので、帯の外に隠れたタイルにフォーカスが移ることがある。見える位置まで最小限だけ動かす
		target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});
}
</script>

<style lang="scss" module>
// 置き場所。広い画面のステージ・下の帯・全画面では与えられた広さ (コンテナ) に、狭い画面のカードでは横幅と高さの上限に、
// 映像の縦横比の枠 (frame) を収める。操作の列は枠の中で映像のすぐ下に付くので、背の高い置き場所でも映像と操作の列が離れない。
// 枠はカードやステージの中の一段下の要素なので、角の丸みは --MI-radius より 4px 小さくする (映像に重ねる名前は枠から 4px 内側で、さらに 4px 小さい)
.root {
	--voiceCallScreenBarHeight: 44px;
	position: relative;
	display: flex;
	justify-content: center;
	align-self: start;
	min-width: 0;
	min-height: 0;
}

.frame {
	display: flex;
	flex-direction: column;
	// 横幅いっぱい、ただし映像と操作の列の高さが上限を超えない幅まで
	width: min(100%, calc((var(--voiceCallScreenMaxHeight, 70vh) - var(--voiceCallScreenBarHeight)) * var(--voiceCallScreenRatio)));
	overflow: clip;
	border-radius: max(0px, calc(var(--MI-radius) - 4px));
	background: var(--MI_THEME-bg);
}

.view {
	position: relative;
	aspect-ratio: var(--voiceCallScreenRatio);
	// 枠が操作の列の幅まで広げられたときは、映像の方を上限の高さに収めて、上下か左右を空ける
	max-height: calc(var(--voiceCallScreenMaxHeight, 70vh) - var(--voiceCallScreenBarHeight));
}

.video {
	position: absolute;
	inset: 0;
	display: block;
	width: 100%;
	height: 100%;
	object-fit: contain;
}

// 与えられた広さいっぱいに、縦横比を保って置く (広い画面のステージ、大きくした画面の下の帯、全画面)
.fill,
.compact,
.root:fullscreen {
	container-type: size;
	display: grid;
	place-items: center;
	align-self: stretch;

	.frame {
		width: min(100cqw, calc((100cqh - var(--voiceCallScreenBarHeight)) * var(--voiceCallScreenRatio)));
	}

	.view {
		max-height: calc(100cqh - var(--voiceCallScreenBarHeight));
	}
}

.compact {
	--voiceCallScreenBarHeight: 0px;
}

.root:fullscreen {
	background: var(--MI_THEME-bg);

	.frame {
		border-radius: 0;
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

	// 映像の上でも見えるよう、内側に太めの輪を出す
	&:focus-visible {
		outline: 3px solid var(--MI_THEME-focus);
		outline-offset: -3px;
	}
}

// 誰の画面かを映像の左上に重ねて出す。押すのは下のボタンに通す
.overlay {
	pointer-events: none;
	position: absolute;
	top: 4px;
	left: 4px;
	max-width: calc(100% - 8px);
	padding: 2px 6px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	border-radius: max(0px, calc(var(--MI-radius) - 8px));
	font-size: 0.8em;
	background: var(--MI_THEME-panel);
}

.bar {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	gap: 4px;
	box-sizing: border-box;
	height: var(--voiceCallScreenBarHeight);
	padding: 6px 8px;
	// カードの地と同じ色だと枠の下の角が見えず、映像の上だけが丸く見えるので、チップと同じ一段濃い地にして映像とひとまとまりに見せる
	background: var(--MI_THEME-panelHighlight);
}

// 狭い画面のカードでは名前を映像に重ねるので、操作の列はボタンだけを右に寄せる
.controlsOnly {
	justify-content: flex-end;
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
