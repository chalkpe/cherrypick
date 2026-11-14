/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, watch } from 'vue';
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

	// 参加者の名前は覚えている。一覧から抜けた人の終了も名前で知らせられるように
	const participantNames = new Map<string, string>();
	watch(participants, list => {
		for (const participant of list) {
			participantNames.set(participant.identity, userName(participant.user));
		}
	}, { immediate: true });

	// 録画が始まったり終わったりしたら、音と表示で知らせる。同じ一覧の変化で始まりと終わりが重なったら、一つの知らせにまとめる。
	// 音は一度だけ: 録画が続くなら開始音、全部終わったら終了音 (続けて呼ぶと再生ガードに埋もれる)。
	// 別の通話に移ったときは知らせない
	watch([recordingIdentities, callRoomId], ([now, roomId], [before, roomIdBefore]) => {
		if (roomId == null || roomId !== roomIdBefore) return;
		const started = now.filter(id => !before.includes(id));
		const stopped = before.filter(id => !now.includes(id));
		if (started.length === 0 && stopped.length === 0) return;
		if (started.length > 0) {
			void playMisskeySfxFile({ type: 'syuilo/up', volume: 1 });
		} else {
			void playMisskeySfxFile({ type: 'syuilo/down', volume: 1 });
		}
		const startedOthers = started.filter(id => id !== myIdentity);
		const stoppedOthers = stopped.filter(id => id !== myIdentity);
		const namesOf = (ids: string[]) => ids.map(id => participantNames.get(id)).filter((name): name is string => name != null).join(', ');
		if (startedOthers.length > 0 && stoppedOthers.length > 0) {
			os.toast(i18n.tsx._voiceCall.recordingStoppedAndStarted({ stopped: namesOf(stoppedOthers), started: namesOf(startedOthers) }));
		} else if (startedOthers.length > 0) {
			os.toast(i18n.tsx._voiceCall.recordingStartedBy({ name: namesOf(startedOthers) }));
		} else if (stoppedOthers.length > 0) {
			os.toast(i18n.ts._voiceCall.recordingStopped);
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
