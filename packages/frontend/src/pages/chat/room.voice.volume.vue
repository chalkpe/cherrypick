<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<MkRange
		:modelValue="volume"
		:min="0"
		:max="1"
		:step="0.05"
		:textConverter="v => `${Math.round(v * 100)}%`"
		continuousUpdate
		@update:modelValue="update"
	>
		<template v-if="audio === 'screenShare'" #label><i class="ti ti-screen-share"></i> {{ i18n.ts._voiceCall.screenShareVolume }}</template>
		<template v-else #label><i class="ti ti-microphone"></i> {{ i18n.ts._voiceCall.voiceVolume }}</template>
	</MkRange>
</div>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import MkRange from '@/components/MkRange.vue';
import { i18n } from '@/i18n.js';
import { participantVolume, setParticipantVolume } from '@/utility/voice-call.js';
import type { ParticipantAudio } from '@/utility/voice-call.js';

const props = defineProps<{
	identity: string;
	audio: ParticipantAudio;
}>();

const volume = ref(participantVolume(props.identity, props.audio));

function update(value: number) {
	volume.value = value;
	setParticipantVolume(props.identity, props.audio, value);
}
</script>

<style lang="scss" module>
.root {
	padding: 6px 16px;
	min-width: 200px;
}
</style>
