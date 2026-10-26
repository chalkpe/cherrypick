/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed } from 'vue';
import { i18n } from '@/i18n.js';
import { voiceCall } from '@/utility/voice-call.js';

/**
 * 参加中の通話の状態 (通話中・接続中・再接続中) を表す文言。
 * 通話バーと、ルーム画面の通話カード・ステージの見出しで同じものを出す
 */
export const voiceCallStatusText = computed(() => {
	switch (voiceCall.status) {
		case 'connecting': return i18n.ts._voiceCall.connecting;
		case 'reconnecting': return i18n.ts._voiceCall.reconnecting;
		default: return i18n.ts._voiceCall.inCall;
	}
});
