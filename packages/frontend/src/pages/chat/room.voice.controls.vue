<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 通話中のマイク・スピーカー・退出のボタン。通話カードとステージで使う -->
<div :class="$style.root">
	<button
		class="_button" :class="[$style.action, { [$style.off]: !voiceCall.micEnabled }]"
		:aria-label="voiceCall.micEnabled ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute"
		:title="voiceCall.micEnabled ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute"
		@click="setMicEnabled(!voiceCall.micEnabled)"
	>
		<i v-if="voiceCall.micEnabled" class="ti ti-microphone"></i>
		<i v-else class="ti ti-microphone-off"></i>
	</button>
	<button
		class="_button" :class="[$style.action, { [$style.off]: voiceCall.deafened }]"
		:aria-label="voiceCall.deafened ? i18n.ts._voiceCall.undeafen : i18n.ts._voiceCall.deafen"
		:title="voiceCall.deafened ? i18n.ts._voiceCall.undeafen : i18n.ts._voiceCall.deafen"
		@click="setDeafened(!voiceCall.deafened)"
	>
		<i v-if="voiceCall.deafened" class="ti ti-headphones-off"></i>
		<i v-else class="ti ti-headphones"></i>
	</button>
	<button
		class="_button" :class="[$style.action, $style.leave]"
		:aria-label="i18n.ts._voiceCall.leave"
		:title="i18n.ts._voiceCall.leave"
		@click="leaveVoiceCall()"
	>
		<i class="ti ti-phone-off"></i>
	</button>
</div>
</template>

<script lang="ts" setup>
import { i18n } from '@/i18n.js';
import { leaveVoiceCall, setDeafened, setMicEnabled, voiceCall } from '@/utility/voice-call.js';
</script>

<style lang="scss" module>
.root {
	display: flex;
	align-items: center;
	gap: 4px;
}

.action {
	display: grid;
	place-items: center;
	width: 34px;
	height: 34px;
	border-radius: 100%;
	background: var(--MI_THEME-buttonBg);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&.off {
		color: var(--MI_THEME-error);
	}

	&.leave {
		color: var(--MI_THEME-fgOnAccent);
		background: var(--MI_THEME-error);
	}
}
</style>
