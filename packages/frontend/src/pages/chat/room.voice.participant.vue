<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 参加者のチップ。画面を共有している人のチップは、どこを押してもその画面を見る (もう一度押すとやめる)。見ているチップはプレビューを囲む輪と名前の色で示す。
ボタンの名前 (とツールチップ) は見ているあいだも変えず、見ているかどうかは aria-pressed と輪で伝える。
アバターの装飾は 2 倍の大きさで描かれ、小さなチップでは枠や隣のチップに重なるので描かない。
音量などのメニューは別の ⋯ ボタンから開く。チップは参加者の名前のついたまとまりにして、中のボタンが誰のものか読み上げで分かるようにする -->
<div
	:class="[$style.root, { [$style.squareAvatar]: squareAvatar, [$style.speaking]: speaking, [$style.watching]: canWatch && watching }]"
	role="group" :aria-label="userName(participant.user)"
>
	<button
		v-if="canWatch"
		type="button" class="_button" :class="[$style.main, $style.watch]"
		:aria-label="i18n.tsx._voiceCall.watchScreenOf({ name: userName(participant.user) })" :aria-pressed="watching"
		:title="i18n.tsx._voiceCall.watchScreenOf({ name: userName(participant.user) })"
		:data-voice-call-watch-toggle="participant.identity"
		@click="emit('toggleWatch')"
	>
		<MkAvatar :user="participant.user" :decorations="[]" :class="$style.avatar"/>
		<MkUserName :user="participant.user" :class="$style.name"/>
		<XPreview :identity="participant.identity" :class="$style.preview"/>
	</button>
	<div v-else :class="$style.main">
		<MkAvatar :user="participant.user" :decorations="[]" :class="$style.avatar"/>
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
import { isSquareAvatar } from '@/utility/avatar-shape.js';

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
const squareAvatar = computed(() => isSquareAvatar(props.participant.user));
</script>

<style lang="scss" module>
// 話している人はチップ全体を枠で囲む。話していないときも透明な枠を置いて、切り替わりで大きさが変わらないようにする。
// 見ている共有画面は、チップではなくその画面のプレビューを強調色の輪で囲み、名前も強調色にする。
// 話している枠は人 (チップ) を、見ている輪は画面 (プレビュー) を囲むので、線が二重にならず、押せる地の色 (ホバー) とも紛れない。
// 角の丸みは中のアバターの形から決める: チップの丸み = アバターの丸み + 枠と余白 (4px)。アバターが円ならチップは両端が丸い形、
// 角丸の四角ならチップも同じ中心の角丸になる。押したときの地やプレビュー、⋯ ボタンはアバターと同じ段の丸みを使う
.root {
	--voiceChipAvatar: 28px;
	--voiceChipInset: 4px; // 枠 2px + 余白 2px
	--voiceChipInnerRadius: calc(var(--voiceChipAvatar) / 2);

	display: flex;
	align-items: center;
	gap: 2px;
	min-width: 0;
	padding: 2px;
	border: 2px solid transparent;
	border-radius: calc(var(--voiceChipInnerRadius) + var(--voiceChipInset));
	background: var(--MI_THEME-panelHighlight);
	transition: border-color 0.1s;

	&.squareAvatar {
		--voiceChipInnerRadius: calc(var(--voiceChipAvatar) * 0.2); // MkAvatar の角丸と同じ 20%
	}

	&.speaking {
		border-color: var(--MI_THEME-success);
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
	border-radius: var(--voiceChipInnerRadius);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.avatar {
	width: var(--voiceChipAvatar);
	height: var(--voiceChipAvatar);
	flex-shrink: 0;
}

.name {
	min-width: 0;
	font-size: 0.9em;
}

.sharing {
	color: var(--MI_THEME-accent);
}

// チップの高さ (アバターと同じ 28px) に収まる小さなプレビュー。映像なので、アバターが円でも角丸の四角 (20%) にする。
// 子 (XPreview) の .root の丸みに必ず勝つよう、クラス 2 つで書く (1 つだと読み込み順で負けることがある)
.main .preview {
	flex-shrink: 0;
	height: var(--voiceChipAvatar);
	border-radius: calc(var(--voiceChipAvatar) * 0.2);
}

// 輪は映像の内側に、映像の上へ重ねて描く (外に出すとチップの枠に重なり、outline では上に置いた映像に隠れる)
.watching .preview::after {
	content: '';
	position: absolute;
	inset: 0;
	border: 2px solid var(--MI_THEME-accent);
	border-radius: inherit;
	pointer-events: none;
}

.watching .name {
	color: var(--MI_THEME-accent);
}

// 丸みが辺の半分を超えると円になるので、アバターが円のチップでは円、角丸の四角のチップでは角丸の四角になる
.menu {
	display: grid;
	flex-shrink: 0;
	place-items: center;
	width: 24px;
	height: 24px;
	border-radius: var(--voiceChipInnerRadius);
	color: var(--MI_THEME-fgTransparentWeak);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
		color: var(--MI_THEME-fg);
	}
}
</style>
