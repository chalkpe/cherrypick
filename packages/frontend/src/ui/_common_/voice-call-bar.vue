<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="voiceCall.room != null" :class="$style.root" class="_panel _shadow" role="region" :aria-label="i18n.ts._voiceCall.inCall">
	<MkA :to="`/chat/room/${voiceCall.room.id}`" :class="$style.room" :title="i18n.ts._voiceCall.backToRoom">
		<i class="ti ti-volume" :class="$style.roomIcon"></i>
		<div :class="$style.roomText">
			<div :class="$style.roomName">{{ voiceCall.room.name }}</div>
			<div :class="$style.status" aria-live="polite">{{ statusText }}</div>
		</div>
	</MkA>
	<button v-if="voiceCall.audioBlocked" class="_buttonPrimary" :class="$style.enableAudio" @click="resumeAudio()">
		{{ i18n.ts._voiceCall.enableAudio }}
	</button>
	<div :class="$style.actions">
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
			v-if="screenShareAvailable"
			class="_button" :class="[$style.action, { [$style.on]: voiceCall.screenSharing }]"
			:aria-label="voiceCall.screenSharing ? i18n.ts._voiceCall.stopSharing : i18n.ts._voiceCall.shareScreen"
			:title="voiceCall.screenSharing ? i18n.ts._voiceCall.stopSharing : i18n.ts._voiceCall.shareScreen"
			@click="voiceCall.screenSharing ? stopScreenShare() : startScreenShare()"
		>
			<i v-if="voiceCall.screenSharing" class="ti ti-screen-share-off"></i>
			<i v-else class="ti ti-screen-share"></i>
		</button>
		<button
			class="_button" :class="$style.action"
			:aria-label="i18n.ts._voiceCall.settings"
			:title="i18n.ts._voiceCall.settings"
			@click="openSettings"
		>
			<i class="ti ti-settings"></i>
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
</div>
</template>

<script lang="ts" setup>
import { computed, watch } from 'vue';
import type { MenuItem } from '@/types/menu.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { $i } from '@/i.js';
import { canShareScreen, leaveVoiceCall, resumeAudio, selectAudioDevice, setDeafened, setMicEnabled, startScreenShare, stopScreenShare, voiceCall } from '@/utility/voice-call.js';

const zIndex = os.claimZIndex('middle');

const screenShareAvailable = computed(() => canShareScreen() && $i?.policies.canScreenShare === true);

const statusText = computed(() => {
	switch (voiceCall.status) {
		case 'connecting': return i18n.ts._voiceCall.connecting;
		case 'reconnecting': return i18n.ts._voiceCall.reconnecting;
		default: return i18n.ts._voiceCall.inCall;
	}
});

// 音声処理の設定はマイクを入れ直したときに反映されるので、通話中に変えたら入れ直す
watch(() => [
	prefer.s['voiceCall.echoCancellation'],
	prefer.s['voiceCall.noiseSuppression'],
	prefer.s['voiceCall.autoGainControl'],
], async () => {
	if (!voiceCall.micEnabled) return;
	await setMicEnabled(false);
	await setMicEnabled(true);
});

async function deviceItems(kind: 'audioinput' | 'audiooutput'): Promise<MenuItem[]> {
	const devices = (await window.navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === kind && device.deviceId !== '');
	const selected = prefer.s[kind === 'audioinput' ? 'voiceCall.inputDeviceId' : 'voiceCall.outputDeviceId'];
	return devices.map(device => ({
		type: 'radioOption',
		text: device.label || device.deviceId,
		active: device.deviceId === selected,
		action: () => {
			selectAudioDevice(kind, device.deviceId);
		},
	}));
}

function openSettings(ev: MouseEvent) {
	const items: MenuItem[] = [{
		type: 'parent',
		icon: 'ti ti-microphone',
		text: i18n.ts._voiceCall.inputDevice,
		children: () => deviceItems('audioinput'),
	}];
	if ('setSinkId' in HTMLMediaElement.prototype) {
		items.push({
			type: 'parent',
			icon: 'ti ti-headphones',
			text: i18n.ts._voiceCall.outputDevice,
			children: () => deviceItems('audiooutput'),
		});
	}
	if (screenShareAvailable.value) {
		items.push({ type: 'divider' }, {
			type: 'radio',
			icon: 'ti ti-screen-share',
			text: i18n.ts._voiceCall.screenShareQuality,
			ref: prefer.model('voiceCall.screenShareQuality'),
			options: [
				{ label: i18n.ts._voiceCall._quality.sharp, value: 'sharp' },
				{ label: i18n.ts._voiceCall._quality.smooth, value: 'smooth' },
				{ label: i18n.ts._voiceCall._quality.high, value: 'high' },
			],
		}, {
			type: 'switch',
			text: i18n.ts._voiceCall.shareAudio,
			ref: prefer.model('voiceCall.screenShareAudio'),
		});
	}
	items.push({ type: 'divider' }, {
		type: 'switch',
		text: i18n.ts._voiceCall.echoCancellation,
		ref: prefer.model('voiceCall.echoCancellation'),
	}, {
		type: 'switch',
		text: i18n.ts._voiceCall.noiseSuppression,
		ref: prefer.model('voiceCall.noiseSuppression'),
	}, {
		type: 'switch',
		text: i18n.ts._voiceCall.autoGainControl,
		ref: prefer.model('voiceCall.autoGainControl'),
	});
	os.popupMenu(items, ev.currentTarget ?? ev.target);
}
</script>

<style lang="scss" module>
.root {
	position: fixed;
	z-index: v-bind(zIndex);
	left: 50%;
	bottom: calc(var(--MI-minBottomSpacing) + var(--MI-margin));
	transform: translateX(-50%);
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px;
	max-width: calc(100% - (var(--MI-margin) * 2));
	padding: 8px 10px;
}

.room {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	color: inherit;
	text-decoration: none;
}

.roomIcon {
	color: var(--MI_THEME-accent);
}

.roomText {
	min-width: 0;
}

.roomName {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: bold;
	font-size: 0.9em;
}

.status {
	font-size: 0.8em;
	opacity: 0.7;
}

.enableAudio {
	padding: 6px 12px;
	border-radius: 999px;
	font-size: 0.85em;
}

.actions {
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

	&.on {
		color: var(--MI_THEME-fgOnAccent);
		background: var(--MI_THEME-accent);
	}

	&.leave {
		color: var(--MI_THEME-fgOnAccent);
		background: var(--MI_THEME-error);
	}
}
</style>
