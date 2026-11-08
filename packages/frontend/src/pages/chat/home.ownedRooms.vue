<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<div v-if="rooms.length > 0" class="_gaps_s">
		<XRoom v-for="room in rooms" :key="room.id" :room="room" :voiceState="voiceStates.get(room.id)"/>
	</div>
	<MkResult v-if="!fetching && rooms.length == 0" type="empty" :text="i18n.ts._chat.noRooms"/>
	<MkLoading v-if="fetching"/>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import * as Misskey from 'cherrypick-js';
import XRoom from './XRoom.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { ensureSignin } from '@/i.js';
import { isChatRoomVoiceAvailable } from '@/utility/chat-room-voice-availability.js';
import { useChatRoomVoiceStates } from '@/composables/use-chat-room-voice-states.js';
import { useChatRoomList } from '@/composables/use-chat-room-list.js';

const $i = ensureSignin();
const { items: rooms, fetching } = useChatRoomList<Misskey.entities.ChatRoom>(() => misskeyApi('chat/rooms/owned', {}));
const voiceStates = useChatRoomVoiceStates(computed(() => rooms.value.filter(room => isChatRoomVoiceAvailable(room, $i.policies.canVoiceCall)).map(room => room.id)));
</script>

<style lang="scss" module>

</style>
