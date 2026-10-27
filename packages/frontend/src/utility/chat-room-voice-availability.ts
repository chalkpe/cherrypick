/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { entities } from 'cherrypick-js';
import { instance } from '@/instance.js';

/** ルーム画面と一覧で、ローカル・連合通話とアカウントの利用可否を同じ規則で判定する。 */
export function isChatRoomVoiceAvailable(room: entities.ChatRoom | null | undefined, canVoiceCall: boolean): boolean {
	if (room == null || !canVoiceCall) return false;
	return room.owner.host == null ? instance.features?.voiceCall === true : instance.features?.remoteVoiceCall === true;
}
