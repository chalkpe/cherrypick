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
		<template #label><i class="ti ti-volume"></i> {{ i18n.ts._voiceCall.volume }}</template>
	</MkRange>
</div>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import MkRange from '@/components/MkRange.vue';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { setParticipantVolume } from '@/utility/voice-call.js';

const props = defineProps<{
	identity: string;
}>();

const volume = ref(Math.min(1, prefer.s['voiceCall.participantVolumes'][props.identity] ?? 1));

function update(value: number) {
	volume.value = value;
	setParticipantVolume(props.identity, value);
}
</script>

<style lang="scss" module>
.root {
	padding: 6px 16px;
	min-width: 200px;
}
</style>
