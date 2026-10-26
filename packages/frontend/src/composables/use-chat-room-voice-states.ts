/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, getCurrentInstance, onActivated, onDeactivated, onScopeDispose, ref, watch } from 'vue';
import type { Ref } from 'vue';
import * as Misskey from 'cherrypick-js';
import { instance } from '@/instance.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useStream } from '@/stream.js';

// ホストのサーバーが落ちると通話の終わりは届かず、サーバー側の現況だけが寿命 (ミラーは 600 秒、このサーバーのルームは 120 秒) で消える。
// 通話を出している間はこの間隔で取り直し、寿命の切れた通話を寿命 + この時間のうちに消す
const REFRESH_INTERVAL_MS = 30 * 1000;

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

	// 後から始めた取得があれば、先の取得の結果は捨てる。
	// 取り直し (refresh) に失敗しただけなら、出している通話は消さない
	async function load(ids: string[], { keepOnError }: { keepOnError: boolean }) {
		const live = new Map<string, Misskey.entities.ChatRoomVoiceState>();
		liveDuringLoad = live;
		let next: Map<string, Misskey.entities.ChatRoomVoiceState>;
		try {
			const result = await misskeyApi('chat/rooms/voice/states', { roomIds: ids.slice(0, 100) });
			next = new Map(result.map(state => [state.roomId, state]));
		} catch {
			if (keepOnError) {
				if (liveDuringLoad === live) liveDuringLoad = null;
				return;
			}
			next = new Map();
		}
		if (liveDuringLoad !== live) return;
		liveDuringLoad = null;
		for (const state of live.values()) apply(next, state);
		states.value = next;
	}

	// 定期的に一覧を取り直す画面では同じ ID の配列が何度も渡されるので、中身が変わったときだけ取得する
	let loadedKey: string | null = null;

	watch(roomIds, async ids => {
		const key = ids.join(',');
		if (key === loadedKey) return;
		loadedKey = key;
		if (ids.length === 0) {
			liveDuringLoad = null;
			states.value = new Map();
			return;
		}
		await load(ids, { keepOnError: false });
	}, { immediate: true });

	// 同じルームのままでも取り直す (上の ID の比較は通さない)
	function refresh() {
		const ids = roomIds.value;
		if (ids.length === 0) return;
		load(ids, { keepOnError: true });
	}

	// 画面に出ていない間 (タブが隠れている・KeepAlive で裏に回っている) は取り直さず、戻ってきたときに一度取り直す
	const visible = ref(window.document.visibilityState === 'visible');
	const active = ref(true);
	const shown = computed(() => visible.value && active.value);

	function onVisibilityChange() {
		const next = window.document.visibilityState === 'visible';
		if (next === visible.value) return;
		visible.value = next;
		if (shown.value && states.value.size > 0) refresh();
	}

	window.document.addEventListener('visibilitychange', onVisibilityChange);

	// KeepAlive の中で初めて表示されたときにも onActivated は呼ばれるので、裏に回った後だけ取り直す
	if (getCurrentInstance() != null) {
		onDeactivated(() => {
			active.value = false;
		});
		onActivated(() => {
			if (active.value) return;
			active.value = true;
			if (shown.value && states.value.size > 0) refresh();
		});
	}

	let timer: number | null = null;

	function stopPolling() {
		if (timer == null) return;
		window.clearInterval(timer);
		timer = null;
	}

	watch(() => shown.value && states.value.size > 0, polling => {
		if (!polling) {
			stopPolling();
		} else if (timer == null) {
			timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
		}
	}, { immediate: true });

	onScopeDispose(() => {
		stopPolling();
		window.document.removeEventListener('visibilitychange', onVisibilityChange);
		connection.dispose();
	});

	return states;
}
