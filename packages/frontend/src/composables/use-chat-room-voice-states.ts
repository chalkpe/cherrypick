/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onScopeDispose, ref, watch } from 'vue';
import type { Ref } from 'vue';
import * as Misskey from 'cherrypick-js';
import { instance } from '@/instance.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useStream } from '@/stream.js';

/**
 * ルーム一覧に通話中の表示を出すため、指定したルームの通話参加者を取得し、変化を追う。
 */
export function useChatRoomVoiceStates(roomIds: Ref<string[]>): Ref<Map<string, Misskey.entities.ChatRoomVoiceState>> {
	const states = ref(new Map<string, Misskey.entities.ChatRoomVoiceState>());
	// LiveKit を持たないサーバーでも、他のサーバーが持つルーム (ミラー) の通話の現況は届く。
	// どのルームの通話を出すかは呼び出し側がルームごとに決める
	if (instance.features?.voiceCall !== true && instance.features?.remoteVoiceCall !== true) return states;

	// 取得中に届いたイベントの方が新しいので、取得結果で上書きしないよう覚えておく
	let liveDuringLoad: Map<string, Misskey.entities.ChatRoomVoiceState> | null = null;

	function apply(target: Map<string, Misskey.entities.ChatRoomVoiceState>, state: Misskey.entities.ChatRoomVoiceState) {
		if (state.participants.length === 0) {
			target.delete(state.roomId);
		} else {
			target.set(state.roomId, state);
		}
	}

	const connection = useStream().useChannel('main');
	connection.on('chatRoomVoiceState', state => {
		if (!roomIds.value.includes(state.roomId)) return;
		liveDuringLoad?.set(state.roomId, state);
		const next = new Map(states.value);
		apply(next, state);
		states.value = next;
	});

	// 定期的に一覧を取り直す画面では同じ ID の配列が何度も渡されるので、中身が変わったときだけ取得する
	let loadedKey: string | null = null;

	watch(roomIds, async ids => {
		const key = ids.join(',');
		if (key === loadedKey) return;
		loadedKey = key;
		if (ids.length === 0) {
			states.value = new Map();
			return;
		}
		const live = new Map<string, Misskey.entities.ChatRoomVoiceState>();
		liveDuringLoad = live;
		let next: Map<string, Misskey.entities.ChatRoomVoiceState>;
		try {
			const result = await misskeyApi('chat/rooms/voice/states', { roomIds: ids.slice(0, 100) });
			next = new Map(result.map(state => [state.roomId, state]));
		} catch {
			next = new Map();
		}
		if (liveDuringLoad !== live) return;
		liveDuringLoad = null;
		for (const state of live.values()) apply(next, state);
		states.value = next;
	}, { immediate: true });

	onScopeDispose(() => {
		connection.dispose();
	});

	return states;
}
