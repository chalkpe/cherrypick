<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 通話中の操作。共通バーを隠すモバイルでも、通話カードとステージからすべて操作できる -->
<div :class="[$style.root, { [$style.grouped]: grouped }]">
	<div :class="$style.group">
	<button
		v-if="voiceCall.audioBlocked"
		v-tooltip="i18n.ts._voiceCall.enableAudio" class="_buttonPrimary"
		:class="[$style.action, $style.enableAudio]"
		:aria-label="i18n.ts._voiceCall.enableAudio"
		@click="resumeAudio"
	>
		<i class="ti ti-volume"></i>
	</button>
	<button
		v-tooltip="voiceCall.micEnabled ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute" class="_button"
		:class="[$style.action, { [$style.off]: !voiceCall.micEnabled }]"
		:aria-label="voiceCall.micEnabled ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute"
		@click="setMicEnabled(!voiceCall.micEnabled)"
	>
		<i v-if="voiceCall.micEnabled" class="ti ti-microphone"></i>
		<i v-else class="ti ti-microphone-off"></i>
	</button>
	<button
		v-tooltip="voiceCall.deafened ? i18n.ts._voiceCall.undeafen : i18n.ts._voiceCall.deafen" class="_button"
		:class="[$style.action, { [$style.off]: voiceCall.deafened }]"
		:aria-label="voiceCall.deafened ? i18n.ts._voiceCall.undeafen : i18n.ts._voiceCall.deafen"
		@click="setDeafened(!voiceCall.deafened)"
	>
		<i v-if="voiceCall.deafened" class="ti ti-headphones-off"></i>
		<i v-else class="ti ti-headphones"></i>
	</button>
	<button
		v-if="screenShareAvailable"
		v-tooltip="voiceCall.screenSharing ? i18n.ts._voiceCall.stopSharing : i18n.ts._voiceCall.shareScreen" class="_button"
		:class="[$style.action, { [$style.on]: voiceCall.screenSharing }]"
		:aria-label="voiceCall.screenSharing ? i18n.ts._voiceCall.stopSharing : i18n.ts._voiceCall.shareScreen"
		@click="voiceCall.screenSharing ? stopScreenShare() : startScreenShare()"
	>
		<i v-if="voiceCall.screenSharing" class="ti ti-screen-share-off"></i>
		<i v-else class="ti ti-screen-share"></i>
	</button>
	</div>
	<div :class="$style.group">
	<slot name="leading"></slot>
	<button
		v-tooltip="i18n.ts._voiceCall.settings" class="_button"
		:class="$style.action"
		:aria-label="i18n.ts._voiceCall.settings"
		@click="openVoiceCallSettings"
	>
		<i class="ti ti-settings"></i>
	</button>
	</div>
	<div v-if="!hideLeave" :class="[$style.group, $style.leaveGroup]">
	<button
		v-tooltip="i18n.ts._voiceCall.leave" class="_button"
		:class="[$style.action, $style.leave]"
		:aria-label="i18n.ts._voiceCall.leave"
		@click="leaveVoiceCall()"
	>
		<i class="ti ti-phone-off"></i>
	</button>
	</div>
</div>
</template>

<script lang="ts" setup>
import { i18n } from '@/i18n.js';
import { leaveVoiceCall, resumeAudio, setDeafened, setMicEnabled, startScreenShare, stopScreenShare, voiceCall } from '@/utility/voice-call.js';
import { openVoiceCallSettings, screenShareAvailable } from '@/utility/voice-call-settings.js';

withDefaults(defineProps<{
	hideLeave?: boolean;
	grouped?: boolean;
}>(), { hideLeave: false, grouped: false });
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

	&.on,
	&.enableAudio {
		color: var(--MI_THEME-fgOnAccent);
		background: var(--MI_THEME-accent);
	}

	&.leave {
		color: var(--MI_THEME-fgOnAccent);
		background: var(--MI_THEME-error);
	}
}

.group { display: contents; }
.grouped {
	gap: 12px;
	.group { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 12px; background: var(--MI_THEME-panel); }
	.action { width: 32px; height: 32px; border-radius: 8px; background: transparent; font-size: 16px; line-height: 1; }
	.action:hover { background: var(--MI_THEME-buttonHoverBg); }
	.action.on,
	.action.enableAudio { color: var(--MI_THEME-accent); background: var(--MI_THEME-accentedBg); }
	.leaveGroup { padding: 0; background: transparent; }
	.leave { width: 52px; height: 40px; border-radius: 12px; background: var(--MI_THEME-error); color: #fff; }
	.leave:hover { background: color-mix(in srgb, var(--MI_THEME-error) 90%, #fff); }
}
</style>
