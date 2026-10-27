/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed } from 'vue';
import type { MenuItem } from '@/types/menu.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { $i } from '@/i.js';
import { activeAudioDeviceId, canShareScreen, selectAudioDevice } from '@/utility/voice-call.js';

export const screenShareAvailable = computed(() => canShareScreen() && $i?.policies.canScreenShare === true);

async function deviceItems(kind: 'audioinput' | 'audiooutput'): Promise<MenuItem[]> {
	const devices = (await window.navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === kind && device.deviceId !== '');
	return devices.map(device => ({
		type: 'radioOption',
		text: device.label || device.deviceId,
		// メニューは選択後も開いたままなので、設定の変更にチェックが追従するよう computed にする
		active: computed(() => device.deviceId === activeAudioDeviceId(kind)),
		action: () => {
			selectAudioDevice(kind, device.deviceId);
		},
	}));
}

export function openVoiceCallSettings(ev: MouseEvent) {
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
