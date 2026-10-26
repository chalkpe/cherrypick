<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 広いルーム画面で、チャットの横に通話を大きく出す (狭い画面の通話カードの代わり) -->
<div :class="$style.root">
	<div :class="$style.header">
		<i class="ti ti-volume" :class="$style.headerIcon"></i>
		<span :class="$style.title">{{ inThisCall ? i18n.ts._voiceCall.inCall : room.name }}</span>
		<XControls v-if="inThisCall"/>
		<button
			class="_button" :class="$style.swap"
			:aria-label="chatSide === 'right' ? i18n.ts._voiceCall.moveChatLeft : i18n.ts._voiceCall.moveChatRight"
			:title="chatSide === 'right' ? i18n.ts._voiceCall.moveChatLeft : i18n.ts._voiceCall.moveChatRight"
			@click="emit('swapChatSide')"
		>
			<i v-if="chatSide === 'right'" class="ti ti-layout-sidebar"></i>
			<i v-else class="ti ti-layout-sidebar-right"></i>
		</button>
	</div>
	<XScreen v-if="watchedParticipant != null" :key="watchedParticipant.identity" :participant="watchedParticipant" fill :class="$style.screen"/>
	<div :class="[$style.tiles, { [$style.strip]: watchedParticipant != null }]">
		<XTile
			v-for="participant in participants"
			:key="participant.identity"
			:participant="participant"
			:speaking="inThisCall && voiceCall.speakingIdentities.includes(participant.identity)"
			:watchable="inThisCall && participant.identity !== myIdentity"
			:watching="voiceCall.watchingIdentity === participant.identity"
			:menuable="participant.identity !== myIdentity && (inThisCall || isOwner)"
			:small="watchedParticipant != null"
			@toggleWatch="watchScreenShare(voiceCall.watchingIdentity === participant.identity ? null : participant.identity)"
			@openMenu="openParticipantMenu(participant, $event)"
		/>
	</div>
	<div v-if="!inThisCall" :class="$style.join">
		<MkButton primary rounded large @click="join()"><i class="ti ti-phone"></i> {{ i18n.ts._voiceCall.join }}</MkButton>
	</div>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import * as Misskey from 'cherrypick-js';
import XTile from './room.voice.tile.vue';
import XScreen from './room.voice.screen.vue';
import XControls from './room.voice.controls.vue';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import type { ChatRoomVoiceCall } from '@/composables/use-chat-room-voice-call.js';
import { voiceCall, watchScreenShare } from '@/utility/voice-call.js';

const props = defineProps<{
	room: Misskey.entities.ChatRoom;
	call: ChatRoomVoiceCall;
	// チャットをステージのどちら側に置いているか
	chatSide: 'right' | 'left';
}>();

const emit = defineEmits<{
	(ev: 'swapChatSide'): void;
}>();

// 参加の流れと参加者のメニューは通話カードやページヘッダーと共有するので、ページ側で作ったものを使う
const { inThisCall, participants, join, myIdentity, isOwner, openParticipantMenu } = props.call;
const watchedParticipant = computed(() => inThisCall.value ? participants.value.find(participant => participant.identity === voiceCall.watchingIdentity) ?? null : null);
</script>

<style lang="scss" module>
.root {
	display: flex;
	flex-direction: column;
	gap: 12px;
	box-sizing: border-box;
	min-width: 0;
	min-height: 0;
	padding: var(--MI-margin);
}

.header {
	display: flex;
	flex-shrink: 0;
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

.swap {
	display: grid;
	place-items: center;
	width: 34px;
	height: 34px;
	border-radius: 100%;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

// 見ている共有画面は、タイルの列を除いた高さいっぱいに出す
.screen {
	flex: 1;
	min-height: 0;
}

.tiles {
	display: flex;
	flex: 1;
	flex-wrap: wrap;
	// 参加者が多くて溢れたときは上から並べて、上のタイルがスクロールで見えなくならないようにする
	align-content: center;
	align-content: safe center;
	justify-content: center;
	gap: 12px;
	min-height: 0;
	overflow-y: auto;

	&.strip {
		flex: 0 0 auto;
		flex-wrap: nowrap;
		justify-content: center;
		justify-content: safe center;
		gap: 8px;
		overflow-x: auto;
		overflow-y: hidden;
	}
}

.join {
	display: flex;
	flex-shrink: 0;
	justify-content: center;
}
</style>
