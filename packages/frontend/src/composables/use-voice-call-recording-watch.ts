/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, onScopeDispose, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import { useStream } from '@/stream.js';
import { userName } from '@/filters/user.js';
import { useChatRoomVoiceStates } from '@/composables/use-chat-room-voice-states.js';
import { localIdentityOf, setRecordingAllowed, voiceCall } from '@/utility/voice-call.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { isApiError } from '@/utility/api-error.js';
import { playMisskeySfxFile } from '@/utility/sound.js';

/**
 * 通話の録画を見張る。通話バー (通話しているあいだずっとある) から一度だけ使う。
 * ルーム画面を離れても通話は続くので、録画の知らせと「持ち主が録画を許さなくなったら止める」はルーム画面ではなく通話に付ける
 */
export function useVoiceCallRecordingWatch() {
	const myIdentity = $i != null ? localIdentityOf($i.id) : null;
	const callRoomId = computed(() => voiceCall.status !== 'idle' ? voiceCall.room?.id ?? null : null);
	const states = useChatRoomVoiceStates(computed(() => callRoomId.value != null ? [callRoomId.value] : []));
	const participants = computed(() => callRoomId.value != null ? states.value.get(callRoomId.value)?.participants ?? [] : []);

	// 録画している人。自分の分は手元の状態に合わせ、届くのを待たずに知らせる
	const recordingIdentities = computed(() => {
		const ids = participants.value.filter(participant => participant.recording === true && participant.identity !== myIdentity).map(participant => participant.identity);
		if (voiceCall.recording && myIdentity != null) ids.push(myIdentity);
		return ids;
	});
	const someoneRecording = computed(() => recordingIdentities.value.length > 0);

	// 녹화 이벤트는 현황과 독립적으로 처리한다. 시작과 종료가 같은 tick에 와도 각각 고지한다.
	const eventIdentities = new Set<string>();
	const seenEvents = new Set<string>();
	const recordingConnection = useStream().useChannel('main');
	let recordingWatchDisposed = false;
	recordingConnection.on('chatRoomRecording', event => {
		if (recordingWatchDisposed || event.roomId !== callRoomId.value || event.identity === myIdentity) return;
		const key = `${event.identity}:${event.id}:${event.recording}`;
		if (seenEvents.has(key)) return;
		seenEvents.add(key);
		eventIdentities.add(event.identity);
		void playMisskeySfxFile({ type: event.recording ? 'syuilo/up' : 'syuilo/down', volume: 1 });
		os.toast(event.recording ? i18n.tsx._voiceCall.recordingStartedBy({ name: userName(event.user) }) : i18n.ts._voiceCall.recordingStopped);
	});
	watch(callRoomId, () => { eventIdentities.clear(); seenEvents.clear(); }, { flush: 'sync' });
	onScopeDispose(() => { recordingWatchDisposed = true; recordingConnection.dispose(); });

	// 録画が始まったり終わったりしたら、音と表示で知らせる。別の通話に移ったときは知らせない
	watch([recordingIdentities, callRoomId], ([now, roomId], [before, roomIdBefore]) => {
		if (roomId == null || roomId !== roomIdBefore) return;
		const started = now.filter(id => !before.includes(id) && !eventIdentities.has(id));
		const stopped = before.filter(id => !now.includes(id) && !eventIdentities.has(id));
		if (started.length > 0) {
			void playMisskeySfxFile({ type: 'syuilo/up', volume: 1 });
			for (const id of started) {
				const participant = participants.value.find(p => p.identity === id);
				if (participant != null && id !== myIdentity) os.toast(i18n.tsx._voiceCall.recordingStartedBy({ name: userName(participant.user) }));
			}
		} else if (stopped.length > 0) {
			void playMisskeySfxFile({ type: 'syuilo/down', volume: 1 });
			if (stopped.some(id => id !== myIdentity)) os.toast(i18n.ts._voiceCall.recordingStopped);
		}
	});

	// 방 화면의 수명이나 탭 표시 여부와 관계없이 재구독 후 최신 허용 설정을 확인한다.
	watch(callRoomId, (roomId, _before, onCleanup) => {
		if (roomId == null) return;
		const stream = useStream();
		const connection = stream.useChannel('chatRoom', { roomId });
		let disposed = false;
		let revision = 0;
		let timer: number | null = null;
		let retryDelay = 1000;

		async function refreshAllowed() {
			if (disposed) return;
			if (timer != null) window.clearTimeout(timer);
			timer = null;
			const request = ++revision;
			try {
				const room = await misskeyApi('chat/rooms/show', { roomId: roomId! });
				if (disposed || request !== revision) return;
				retryDelay = 1000;
				setRecordingAllowed(roomId!, room.allowRecording === true);
			} catch (err) {
				if (disposed || request !== revision) return;
				if (isApiError(err) && (err.code === 'ACCESS_DENIED' || err.code === 'NO_SUCH_ROOM')) {
					setRecordingAllowed(roomId!, false);
					return;
				}
				timer = window.setTimeout(() => { timer = null; void refreshAllowed(); }, retryDelay);
				retryDelay = Math.min(retryDelay * 2, 30_000);
			}
		}

		function onRoomUpdated(ctx: Parameters<Misskey.Channels['chatRoom']['events']['roomUpdated']>[0]) {
			if (disposed || ctx.roomId !== roomId) return;
			revision++;
			setRecordingAllowed(ctx.roomId, ctx.allowRecording);
		}

		connection.on('roomUpdated', onRoomUpdated);
		connection.on('_subscribed_', refreshAllowed);
		stream.on('_connected_', refreshAllowed);
		void refreshAllowed();
		onCleanup(() => {
			disposed = true;
			if (timer != null) window.clearTimeout(timer);
			stream.off('_connected_', refreshAllowed);
			connection.dispose();
		});
	}, { immediate: true });

	return { recordingIdentities, someoneRecording };
}
