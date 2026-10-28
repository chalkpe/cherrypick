<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<div v-if="call.available.value && !call.inThisCall.value" :class="$style.root">
	<div ref="avatarsEl" :class="$style.avatars">
		<button v-for="p in visible" :key="p.identity" v-tooltip.mfm="userName(p.user)" type="button" class="_button" :class="$style.person" :aria-label="userName(p.user)" @click="call.openParticipantMenu(p, $event)" @contextmenu.prevent="call.openParticipantMenu(p, $event)"><MkAvatar :user="p.user" :link="false" :class="$style.avatar"/><span v-if="p.micMuted || p.deafened" v-tooltip="p.deafened ? i18n.ts._voiceCall.deafened : i18n.ts._voiceCall.micMuted" :class="$style.dot"></span></button>
		<button v-if="hidden > 0" type="button" class="_button" :class="$style.more" :aria-label="i18n.ts._chat.members" @click="call.openRoster()">+{{ hidden }}</button>
	</div>
	<button v-tooltip="call.prejoinMicEnabled.value ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute" type="button" class="_button" :class="[$style.mic, { [$style.muted]: !call.prejoinMicEnabled.value }]" :aria-label="call.prejoinMicEnabled.value ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute" :aria-pressed="!call.prejoinMicEnabled.value" @click="call.prejoinMicEnabled.value = !call.prejoinMicEnabled.value"><i :class="call.prejoinMicEnabled.value ? 'ti ti-microphone' : 'ti ti-microphone-off'"></i></button>
	<MkButton primary :class="$style.join" @click="call.join()"><i class="ti ti-phone"></i> {{ i18n.ts._voiceCall.join }}</MkButton>
</div>
</template>
<script lang="ts" setup>
import { computed, useTemplateRef } from 'vue';
import type { ChatRoomVoiceCall } from '@/composables/use-chat-room-voice-call.js';
import { useElementWidth } from '@/composables/use-element-width.js';
import MkButton from '@/components/MkButton.vue';
import { userName } from '@/filters/user.js';
import { i18n } from '@/i18n.js';
const props = defineProps<{ call: ChatRoomVoiceCall }>();
const avatarsEl = useTemplateRef('avatarsEl');
const width = useElementWidth(avatarsEl);
const capacity = computed(() => Math.max(1, Math.floor(((width.value ?? 0) + 8) / 36)));
const visible = computed(() => props.call.participants.value.slice(0, capacity.value >= props.call.participants.value.length ? capacity.value : capacity.value - 1));
const hidden = computed(() => props.call.participants.value.length - visible.value.length);
</script>
<style lang="scss" module>
.root { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--MI_THEME-panel); border: 1px solid var(--MI_THEME-divider); border-radius: var(--MI-radius); }
.join { border-radius: var(--MI-radius); }
.avatars { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; height: 44px; overflow: clip; }
.person { position: relative; display: grid; place-items: center; flex: 0 0 28px; width: 28px; height: 28px; }
.avatar { width: 28px; height: 28px; }
.dot { position: absolute; z-index: 2; bottom: 0; left: 0; width: 20%; height: 20%; border-radius: 120%; background: #888; box-shadow: 0 0 0 3px var(--MI_THEME-panel); }
.more { flex: 0 0 28px; height: 28px; border-radius: 50%; background: var(--MI_THEME-buttonBg); font-size: 11px; }
.mic { display: grid; place-items: center; width: 36px; height: 36px; flex: 0 0 36px; border-radius: 50%; background: var(--MI_THEME-buttonBg); font-size: 18px; }
.mic.muted { color: var(--MI_THEME-error); }
.mic:hover, .more:hover { background: var(--MI_THEME-buttonHoverBg); }
</style>
