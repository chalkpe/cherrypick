<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 広い画面のステージに並べる参加者のタイル。画面を共有している人のタイルは、押すとその画面を見る (もう一度押すとやめる)。
キーボードでは中のボタンから同じ操作ができる。タイルは参加者の名前のついたまとまりにして、中のボタンが誰のものか読み上げで分かるようにする -->
<div
	:class="[$style.root, { [$style.speaking]: speaking, [$style.watching]: watching, [$style.small]: small, [$style.clickable]: clickable }]"
	role="group" :aria-label="userName(participant.user)"
	@click="onClick"
>
	<MkAvatar :user="participant.user" :class="$style.avatar"/>
	<MkUserName :user="participant.user" :class="$style.name"/>
	<button
		v-if="participant.screenSharing && watchable"
		class="_button" :class="[$style.badge, $style.watch]"
		:aria-label="watching ? i18n.ts._voiceCall.stopWatching : i18n.ts._voiceCall.watchStream"
		:title="watching ? i18n.ts._voiceCall.stopWatching : i18n.ts._voiceCall.watchStream"
		@click.stop="emit('toggleWatch')"
	>
		<i v-if="watching" class="ti ti-eye-off"></i>
		<i v-else class="ti ti-screen-share"></i>
	</button>
	<i
		v-else-if="participant.screenSharing"
		class="ti ti-screen-share" :class="[$style.badge, $style.sharing]"
		role="img" :aria-label="i18n.ts._voiceCall.sharingScreen" :title="i18n.ts._voiceCall.sharingScreen"
	></i>
	<button
		v-if="menuable"
		class="_button" :class="$style.menu"
		:aria-label="i18n.ts.menu" :title="i18n.ts.menu"
		@click.stop="emit('openMenu', $event)"
	>
		<i class="ti ti-dots"></i>
	</button>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import * as Misskey from 'cherrypick-js';
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
const clickable = computed(() => canWatch.value || props.menuable);

function onClick(ev: MouseEvent) {
	if (canWatch.value) {
		emit('toggleWatch');
	} else if (props.menuable) {
		emit('openMenu', ev);
	}
}
</script>

<style lang="scss" module>
// 話している人はタイル全体を枠で囲む。話していないときも透明な枠を置いて、切り替わりで大きさが変わらないようにする
.root {
	position: relative;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 10px;
	box-sizing: border-box;
	width: 220px;
	max-width: 100%;
	aspect-ratio: 4 / 3;
	padding: 12px;
	border: 3px solid transparent;
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-panel);
	transition: border-color 0.1s;

	&.speaking {
		border-color: var(--MI_THEME-success);
	}

	&.clickable {
		cursor: pointer;

		&:hover {
			background: var(--MI_THEME-panelHighlight);
		}
	}

	&.small {
		flex-shrink: 0;
		width: 120px;
		gap: 4px;
		padding: 6px;
	}
}

.avatar {
	width: 72px;
	height: 72px;

	.small & {
		width: 36px;
		height: 36px;
	}
}

.name {
	max-width: 100%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: bold;

	.small & {
		font-size: 0.8em;
	}
}

.badge {
	position: absolute;
	top: 6px;
	left: 6px;
}

.sharing {
	color: var(--MI_THEME-accent);
}

.watch {
	display: grid;
	place-items: center;
	width: 28px;
	height: 28px;
	border-radius: 100%;
	color: var(--MI_THEME-accent);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	.watching & {
		color: var(--MI_THEME-fgOnAccent);
		background: var(--MI_THEME-accent);
	}
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

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}
</style>
