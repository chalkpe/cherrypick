<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 参加者のチップ。画面を共有している人のチップは、どこを押してもその画面を見る (もう一度押すとやめる)。見ているチップは枠で示す。
音量などのメニューは別の ⋯ ボタンから開く。チップは参加者の名前のついたまとまりにして、中のボタンが誰のものか読み上げで分かるようにする -->
<div
	:class="[$style.root, { [$style.speaking]: speaking, [$style.watching]: canWatch && watching }]"
	role="group" :aria-label="userName(participant.user)"
>
	<button
		v-if="canWatch"
		type="button" class="_button" :class="[$style.main, $style.watch]"
		:aria-label="i18n.tsx._voiceCall.watchScreenOf({ name: userName(participant.user) })" :aria-pressed="watching"
		:title="watching ? i18n.ts._voiceCall.stopWatching : i18n.ts._voiceCall.watchStream"
		@click="emit('toggleWatch')"
	>
		<MkAvatar :user="participant.user" :class="$style.avatar"/>
		<MkUserName :user="participant.user" :class="$style.name"/>
		<XPreview :identity="participant.identity" :class="$style.preview"/>
	</button>
	<div v-else :class="$style.main">
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
}>(), {
	watchable: false,
	watching: false,
	menuable: false,
});

const emit = defineEmits<{
	(ev: 'toggleWatch'): void;
	(ev: 'openMenu', event: MouseEvent): void;
}>();

const canWatch = computed(() => props.participant.screenSharing && props.watchable);
</script>

<style lang="scss" module>
// 話している人はチップ全体を枠で囲む。話していないときも透明な枠を置いて、切り替わりで大きさが変わらないようにする。
// 見ている共有画面のチップは、その外側に強調色の輪を重ねる (話している枠と同時に出ても見分けられる)
.root {
	display: flex;
	align-items: center;
	gap: 2px;
	min-width: 0;
	padding: 2px; // 枠の 2px 分を差し引いて、以前と同じ大きさに保つ
	border: 2px solid transparent;
	border-radius: 999px;
	background: var(--MI_THEME-panelHighlight);
	transition: border-color 0.1s;

	&.speaking {
		border-color: var(--MI_THEME-success);
	}

	&.watching {
		outline: 2px solid var(--MI_THEME-accent);
		outline-offset: 1px;
	}
}

.main {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	padding-right: 4px;
	color: inherit;
}

.watch {
	border-radius: 999px;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.avatar {
	width: 28px;
	height: 28px;
	flex-shrink: 0;
	border-radius: 100%;
}

.name {
	min-width: 0;
	font-size: 0.9em;
}

.sharing {
	color: var(--MI_THEME-accent);
}

// チップの高さ (アバターと同じ 28px) に収まる小さなプレビュー
.preview {
	flex-shrink: 0;
	height: 28px;
}

.menu {
	display: grid;
	flex-shrink: 0;
	place-items: center;
	width: 24px;
	height: 24px;
	border-radius: 100%;
	color: var(--MI_THEME-fgTransparentWeak);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
		color: var(--MI_THEME-fg);
	}
}
</style>
