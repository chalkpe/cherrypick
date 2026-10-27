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

type VoiceState = Misskey.entities.ChatRoomVoiceState;
type Subscription = { roomIds: Ref<string[]>; active: Ref<boolean> };
const REFRESH_INTERVAL_MS = 30 * 1000;
let shared: ReturnType<typeof createVoiceStateStore> | null = null;

// 一覧・履歴・ルーム画面で同じ main 接続と取得処理を使う。最後の利用者が外れたら現況も破棄する。
function createVoiceStateStore() {
	const states = ref(new Map<string, VoiceState>());
	const subscriptions = new Set<Subscription>();
	const newest = new Map<string, number>();
	const stream = useStream();
	const connection = stream.useChannel('main');
	let ids: string[] = [];
	let loading: { live: Map<string, VoiceState> } | null = null;
	let refreshPending = false;
	let queued = false;
	let disposed = false;
	let timer: number | null = null;

	function apply(target: Map<string, VoiceState>, state: VoiceState) {
		if (state.participants.length === 0) target.delete(state.roomId);
		else target.set(state.roomId, state);
	}

	function isOutdated(state: VoiceState) {
		const held = newest.get(state.roomId);
		if (held != null && state.updatedAt < held) return true;
		newest.set(state.roomId, state.updatedAt);
		return false;
	}

	connection.on('chatRoomVoiceState', state => {
		if (disposed || !ids.includes(state.roomId) || isOutdated(state)) return;
		loading?.live.set(state.roomId, state);
		const next = new Map(states.value);
		apply(next, state);
		states.value = next;
		updatePolling();
	});

	function shown() {
		return window.document.visibilityState === 'visible' && [...subscriptions].some(sub => sub.active.value);
	}

	async function load(keepOnError: boolean) {
		const request = { live: new Map<string, VoiceState>() };
		loading = request;
		const requestedIds = ids;
		let next = new Map<string, VoiceState>();
		try {
			// 一つの API 要求は 100 ルームまで。複数の一覧の和集合も取りこぼさない。
			const batches: Promise<VoiceState[]>[] = [];
			for (let offset = 0; offset < requestedIds.length; offset += 100) {
				batches.push(misskeyApi('chat/rooms/voice/states', { roomIds: requestedIds.slice(offset, offset + 100) }));
			}
			const results = (await Promise.all(batches)).flat();
			if (loading !== request || disposed) return;
			for (const state of results) {
				if (!requestedIds.includes(state.roomId)) continue;
				if (!isOutdated(state)) apply(next, state);
				else {
					const held = states.value.get(state.roomId);
					if (held != null) next.set(state.roomId, held);
				}
			}
		} catch {
			if (keepOnError) next = new Map(states.value);
		}
		if (loading !== request || disposed) return;
		loading = null;
		// 取得中のイベントも、応答より古ければ使わない。
		for (const state of request.live.values()) {
			if (!isOutdated(state)) apply(next, state);
		}
		states.value = next;
		updatePolling();
		if (refreshPending) {
			refreshPending = false;
			refresh();
		}
	}

	// tick は ID 変更の取得を追い越さない。再接続だけは取得後にもう一度確認する。
	function refresh(afterLoad = false) {
		if (ids.length === 0 || !shown()) return;
		if (loading != null) {
			refreshPending ||= afterLoad;
			return;
		}
		void load(true);
	}

	function updatePolling() {
		const polling = shown() && states.value.size > 0;
		if (!polling && timer != null) {
			window.clearInterval(timer);
			timer = null;
		} else if (polling && timer == null) {
			timer = window.setInterval(() => refresh(), REFRESH_INTERVAL_MS);
		}
	}

	function reconcile() {
		if (queued) return;
		queued = true;
		// 同じ描画で増えた利用者をまとめ、一度だけ和集合を取得する。
		void Promise.resolve().then(() => {
			queued = false;
			if (disposed) return;
			const nextIds = [...new Set([...subscriptions].flatMap(sub => sub.roomIds.value))].sort();
			if (ids.join(',') !== nextIds.join(',')) {
				ids = nextIds;
				loading = null;
				refreshPending = false;
				states.value = new Map([...states.value].filter(([id]) => ids.includes(id)));
				for (const id of newest.keys()) if (!ids.includes(id)) newest.delete(id);
				if (ids.length > 0) void load(false);
			}
			updatePolling();
		});
	}

	function onVisibilityChange() {
		updatePolling();
		if (shown()) refresh(true);
	}

	function onConnected() { refresh(true); }

	window.document.addEventListener('visibilitychange', onVisibilityChange);
	stream.on('_connected_', onConnected);

	return {
		states,
		add(sub: Subscription) { subscriptions.add(sub); reconcile(); },
		changed: reconcile,
		activated() { updatePolling(); refresh(true); },
		deactivated: updatePolling,
		remove(sub: Subscription) {
			subscriptions.delete(sub);
			if (subscriptions.size > 0) { reconcile(); return; }
			disposed = true;
			loading = null;
			ids = [];
			newest.clear();
			states.value = new Map();
			if (timer != null) window.clearInterval(timer);
			window.document.removeEventListener('visibilitychange', onVisibilityChange);
			stream.off('_connected_', onConnected);
			connection.dispose();
			shared = null;
		},
	};
}

/** 指定したルームの現況だけを返す。取得と通知はクライアント内で共有する。 */
export function useChatRoomVoiceStates(roomIds: Ref<string[]>): Ref<Map<string, VoiceState>> {
	if (instance.features?.voiceCall !== true && instance.features?.remoteVoiceCall !== true) return ref(new Map());
	const store = shared ??= createVoiceStateStore();
	const sub: Subscription = { roomIds, active: ref(true) };
	store.add(sub);
	watch(roomIds, store.changed);
	if (getCurrentInstance() != null) {
		onDeactivated(() => { sub.active.value = false; store.deactivated(); });
		onActivated(() => {
			if (sub.active.value) return;
			sub.active.value = true;
			store.activated();
		});
	}
	onScopeDispose(() => store.remove(sub));
	return computed(() => new Map([...store.states.value].filter(([id]) => roomIds.value.includes(id))));
}
