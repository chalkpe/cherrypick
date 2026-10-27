<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 広い画面のステージに並べる参加者のタイル。画面を共有している人のタイルは、どこを押してもその画面を見る (もう一度押すとやめる)。
共有している画面は小さなプレビューで見せ、見ているタイルは枠で示す (ボタンの名前とツールチップは変えず、aria-pressed で伝える)。音量などのメニューは別の ⋯ ボタンから開く。
タイルは参加者の名前のついたまとまりにして、中のボタンが誰のものか読み上げで分かるようにする -->
<div
	:class="[$style.root, { [$style.speaking]: speaking, [$style.watching]: canWatch && watching, [$style.small]: small }]"
	role="group" :aria-label="userName(participant.user)"
>
	<button
		v-if="canWatch"
		type="button" class="_button" :class="[$style.body, $style.watch]"
		:aria-label="i18n.tsx._voiceCall.watchScreenOf({ name: userName(participant.user) })" :aria-pressed="watching"
		:title="i18n.tsx._voiceCall.watchScreenOf({ name: userName(participant.user) })"
		:data-voice-call-watch-toggle="participant.identity"
		@click="emit('toggleWatch')"
	>
		<XPreview :identity="participant.identity" :class="$style.preview"/>
		<span :class="$style.who">
			<MkAvatar :user="participant.user" :class="$style.smallAvatar"/>
			<MkUserName :user="participant.user" :class="$style.name"/>
		</span>
	</button>
	<div v-else :class="$style.body">
		<MkAvatar :user="participant.user" :class="$style.avatar"/>
		<MkUserName :user="participant.user" :class="$style.name"/>
		<i
			v-if="participant.screenSharing"
			class="ti ti-screen-share" :class="$style.sharing"
			role="img" :aria-label="i18n.ts._voiceCall.sharingScreen" :title="i18n.ts._voiceCall.sharingScreen"
		></i>
	</div>
	<button
		v-if="menuable"
		type="button" class="_button" :class="$style.menu"
		:aria-label="i18n.ts.menu" :title="i18n.ts.menu"
		@click="emit('openMenu', $event)"
	>
		<i class="ti ti-dots"></i>
	</button>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import * as Misskey from 'cherrypick-js';
import XPreview from './room.voice.preview.vue';
import { i18n } from '@/i18n.js';
import { userName } from '@/filters/user.js';

const props = withDefaults(defineProps<{
	participant: Misskey.entities.ChatRoomVoiceState['participants'][number];
	speaking: boolean;
	watchable?: boolean;
	watching?: boolean;
	menuable?: boolean;
	// 共有画面を大きく出しているあいだは、タイルを小さくして画面の下に一列に並べる
	small?: boolean;
}>(), {
	watchable: false,
	watching: false,
	menuable: false,
	small: false,
});

const emit = defineEmits<{
	(ev: 'toggleWatch'): void;
	(ev: 'openMenu', event: MouseEvent): void;
}>();

const canWatch = computed(() => props.participant.screenSharing && props.watchable);
</script>

<style lang="scss" module>
// 話している人はタイル全体を枠で囲む。話していないときも透明な枠を置いて、切り替わりで大きさが変わらないようにする。
// 見ている共有画面のタイルは、その外側に強調色の輪を重ねる (話している枠と同時に出ても見分けられる)
.root {
	position: relative;
	display: flex;
	flex-direction: column;
	box-sizing: border-box;
	width: 220px;
	max-width: 100%;
	aspect-ratio: 4 / 3;
	border: 3px solid transparent;
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-panel);
	transition: border-color 0.1s;

	&.speaking {
		border-color: var(--MI_THEME-success);
	}

	&.watching {
		outline: 3px solid var(--MI_THEME-accent);
		outline-offset: 2px;
	}

	&.small {
		flex-shrink: 0;
		width: 120px;
	}
}

// タイルの中身。共有している人のタイルではタイル全体が押せるボタンになる
.body {
	display: flex;
	flex: 1;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 10px;
	box-sizing: border-box;
	width: 100%;
	min-height: 0;
	padding: 12px;
	border-radius: calc(var(--MI-radius) - 3px);
	color: inherit;

	.small & {
		gap: 4px;
		padding: 6px;
	}
}

.watch {
	gap: 6px;
	padding: 6px;

	&:hover {
		background: var(--MI_THEME-panelHighlight);
	}
}

// タイルの名前の上の残りいっぱいに映す (プレビューの映像ははみ出す分を切って埋める)
.watch .preview {
	flex: 1 1 0;
	width: 100%;
	min-height: 0;
	aspect-ratio: auto;
}

.who {
	display: flex;
	flex-shrink: 0;
	align-items: center;
	gap: 6px;
	max-width: 100%;
	min-width: 0;
}

.avatar {
	width: 72px;
	height: 72px;

	.small & {
		width: 36px;
		height: 36px;
	}
}

.smallAvatar {
	flex-shrink: 0;
	width: 24px;
	height: 24px;

	.small & {
		width: 16px;
		height: 16px;
	}
}

.name {
	max-width: 100%;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: bold;

	.small & {
		font-size: 0.8em;
	}
}

.sharing {
	position: absolute;
	top: 6px;
	left: 6px;
	color: var(--MI_THEME-accent);
}

.menu {
	position: absolute;
	top: 6px;
	right: 6px;
	display: grid;
	place-items: center;
	width: 28px;
	height: 28px;
	border-radius: 100%;
	background: var(--MI_THEME-panel);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	.small & {
		top: 2px;
		right: 2px;
		width: 24px;
		height: 24px;
	}
}
</style>
