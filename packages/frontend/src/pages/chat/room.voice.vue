<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="showCard" ref="rootEl" :class="$style.root">
	<div class="_panel" :class="$style.card">
		<div :class="$style.header">
			<i class="ti ti-volume" :class="$style.headerIcon"></i>
			<!-- 参加中は通話の状態 (通話中・接続中・再接続中) を出し、変わったら読み上げる -->
			<span :class="$style.title" :aria-live="announcesStatus ? 'polite' : 'off'">{{ inThisCall ? voiceCallStatusText : room.name }}</span>
			<div :class="$style.actions">
				<XControls v-if="inThisCall"/>
				<MkButton v-else primary rounded small @click="join"><i class="ti ti-phone"></i> {{ i18n.ts._voiceCall.join }}</MkButton>
			</div>
		</div>
		<div v-if="participants.length > 0" :class="$style.participants">
			<XParticipant
				v-for="participant in participants"
				:key="participant.identity"
				:participant="participant"
				:speaking="inThisCall && voiceCall.speakingIdentities.includes(participant.identity)"
				:watchable="inThisCall && participant.identity !== myIdentity"
				:watching="voiceCall.watchingIdentities.includes(participant.identity)"
				:menuable="participant.identity !== myIdentity && (inThisCall || isOwner)"
				@toggleWatch="toggleScreenShareWatch(participant.identity)"
				@openMenu="openParticipantMenu(participant, $event)"
			/>
		</div>
		<XScreens v-if="inThisCall && watchedParticipants.length > 0" :participants="watchedParticipants" :class="$style.screens"/>
	</div>
</div>
</template>

<script lang="ts" setup>
import { useTemplateRef } from 'vue';
import * as Misskey from 'cherrypick-js';
import XParticipant from './room.voice.participant.vue';
import XScreens from './room.voice.screens.vue';
import XControls from './room.voice.controls.vue';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import type { ChatRoomVoiceCall } from '@/composables/use-chat-room-voice-call.js';
import { toggleScreenShareWatch, voiceCall } from '@/utility/voice-call.js';
import { useVoiceCallStatusAnnouncer, voiceCallStatusText } from '@/utility/voice-call-status.js';

const props = defineProps<{
	room: Misskey.entities.ChatRoom;
	call: ChatRoomVoiceCall;
}>();

// カードを出すかどうかと参加の流れ、参加者のメニューはページヘッダーやステージと共有するので、ページ側で作ったものを使う
const { showCard, inThisCall, participants, join, myIdentity, isOwner, openParticipantMenu, watchedParticipants } = props.call;

const rootEl = useTemplateRef('rootEl');
const announcesStatus = useVoiceCallStatusAnnouncer(inThisCall, rootEl);
</script>

<style lang="scss" module>
// メッセージをスクロールしてもページヘッダーの下に貼り付くので、後ろのメッセージが透けないよう背景で覆う。
// 上にも少し余白を取り、貼り付いたときにカードがヘッダーに密着しないようにする (貼り付く前の位置は変えない)
.root {
	margin-top: -8px;
	padding: 8px 0 var(--MI-margin);
	background: var(--MI_THEME-bg);
	// 貼り付く位置はヘッダーの高さを整数に丸めて決まるので、ヘッダーとの間に 1px 未満の隙間ができることがある。
	// 上へ 1px 背景色を伸ばして、その隙間からメッセージが見えないようにする
	box-shadow: 0 -1px 0 var(--MI_THEME-bg);
}

.card {
	padding: 12px 14px;
}

.header {
	display: flex;
	align-items: center;
	gap: 8px;
}

.headerIcon {
	color: var(--MI_THEME-accent);
}

.title {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: bold;
}

.actions {
	display: flex;
	align-items: center;
	gap: 4px;
	flex-shrink: 0;
}

.participants {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-top: 10px;
}

.screens {
	margin-top: 10px;
	// カードはメッセージの上に貼り付いたままになるので、共有画面を見ながらでもチャットが読めるよう、並べた画面全体を低めに抑える。
	// 全画面にした画面は抑えない
	--voiceCallScreensMaxHeight: 35vh;
}
</style>
