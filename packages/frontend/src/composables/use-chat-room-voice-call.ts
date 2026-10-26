/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, toValue } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import * as Misskey from 'cherrypick-js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { instance } from '@/instance.js';
import { prefer } from '@/preferences.js';
import { ensureSignin } from '@/i.js';
import { useChatRoomVoiceStates } from '@/composables/use-chat-room-voice-states.js';
import { joinVoiceCall, voiceCall } from '@/utility/voice-call.js';

/**
 * ルーム画面の通話カードとページヘッダーの参加ボタンが、同じ参加者の情報と参加の流れを使うためのもの。
 */
export function useChatRoomVoiceCall(room: MaybeRefOrGetter<Misskey.entities.ChatRoom | null>) {
	const $i = ensureSignin();

	// 他のサーバーが持つルーム (ミラー) の通話はそのサーバーで開かれるので、連合通話が許可されているときだけ出す
	const available = computed(() => {
		const target = toValue(room);
		if (target == null) return false;
		const allowed = target.owner.host == null ? instance.features?.voiceCall === true : instance.features?.remoteVoiceCall === true;
		return allowed && $i.policies.canVoiceCall;
	});
	const inThisCall = computed(() => {
		const target = toValue(room);
		return target != null && voiceCall.room?.id === target.id && voiceCall.status !== 'idle';
	});

	// ルーム画面は既に chatRoom チャンネルを開いているので、共有の main チャンネル経由で受け取る
	const roomIds = computed(() => {
		const target = toValue(room);
		return available.value && target != null ? [target.id] : [];
	});
	const states = useChatRoomVoiceStates(roomIds);
	const participants = computed(() => {
		const target = toValue(room);
		return target == null ? [] : states.value.get(target.id)?.participants ?? [];
	});

	// 誰も通話にいないときはカードを出さず、ページヘッダーの参加ボタンだけにする。
	// 自分が参加した直後は参加者の一覧がまだ届いていないことがあるので、参加中なら一覧を待たずに出す
	const showCard = computed(() => available.value && (inThisCall.value || participants.value.length > 0));

	// 他のサーバーで開かれる通話には相手のサーバーに IP アドレスが見えるので、ホストごとに初回だけ確認する
	let joining = false;

	async function join() {
		const target = toValue(room);
		if (target == null || joining) return;
		joining = true;
		try {
			const host = target.owner.host;
			if (host != null && !prefer.s['voiceCall.acknowledgedRemoteHosts'].includes(host)) {
				const { canceled } = await os.confirm({
					type: 'info',
					text: i18n.tsx._voiceCall.remoteHostNotice({ host }),
				});
				if (canceled) return;
				prefer.commit('voiceCall.acknowledgedRemoteHosts', [...prefer.s['voiceCall.acknowledgedRemoteHosts'], host]);
			}
			await joinVoiceCall(target);
		} finally {
			joining = false;
		}
	}

	return { available, inThisCall, participants, showCard, join };
}

export type ChatRoomVoiceCall = ReturnType<typeof useChatRoomVoiceCall>;
