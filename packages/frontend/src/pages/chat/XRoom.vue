<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkA :to="`/chat/room/${room.id}`" class="_panel _gaps_s" :class="$style.root">
	<div :class="$style.header">
		<div style="font-weight: bold;"><Mfm :text="room.name" :plain="true" :nowrap="true" :author="room.owner"/></div>
		<MkAvatar :user="room.owner" :link="false" :class="$style.headerAvatar"/>
	</div>
	<hr>
	<div><Mfm :text="room.description" :author="room.owner"/></div>
	<div v-if="voiceState != null" :class="$style.voice" role="img" :aria-label="i18n.tsx._voiceCall.inCallCount({ n: voiceState.participants.length })" :title="i18n.tsx._voiceCall.inCallCount({ n: voiceState.participants.length })">
		<i class="ti ti-volume" :class="$style.voiceIcon"></i>
		<MkAvatar v-for="participant in voiceState.participants.slice(0, 3)" :key="participant.identity" :user="participant.user" :link="false" :class="$style.voiceAvatar"/>
		<span v-if="voiceState.participants.length > 3" :class="$style.voiceMore">+{{ voiceState.participants.length - 3 }}</span>
	</div>
</MkA>
</template>

<script lang="ts" setup>
import * as Misskey from 'cherrypick-js';

import { i18n } from '@/i18n.js';

const props = defineProps<{
	room: Misskey.entities.ChatRoom;
	voiceState?: Misskey.entities.ChatRoomVoiceState;
}>();

</script>

<style lang="scss" module>
.root {
	padding: 16px;
}

.header {
	display: flex;
	align-items: center;
}

.headerAvatar {
	width: 30px;
	height: 30px;
	margin-left: auto;
}

.voice {
	display: flex;
	align-items: center;
	gap: 4px;
}

.voiceIcon {
	color: var(--MI_THEME-accent);
}

.voiceAvatar {
	width: 22px;
	height: 22px;
}

.voiceMore {
	font-size: 0.85em;
	opacity: 0.7;
}
</style>
