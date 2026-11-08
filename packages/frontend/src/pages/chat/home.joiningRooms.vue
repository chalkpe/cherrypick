<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<div v-if="memberships.length > 0" class="_gaps_s">
		<XRoom v-for="membership in memberships" :key="membership.id" :room="membership.room!" :voiceState="voiceStates.get(membership.roomId)"/>
	</div>
	<MkResult v-if="!fetching && memberships.length == 0" type="empty" :text="i18n.ts._chat.noRooms"/>
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
const { items: memberships, fetching } = useChatRoomList<Misskey.entities.ChatRoomMembership>(() => misskeyApi('chat/rooms/joining'));
const voiceStates = useChatRoomVoiceStates(computed(() => memberships.value.filter(membership => isChatRoomVoiceAvailable(membership.room, $i.policies.canVoiceCall)).map(membership => membership.roomId)));
</script>

<style lang="scss" module>

</style>
