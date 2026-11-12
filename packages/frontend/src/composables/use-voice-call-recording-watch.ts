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

	// 録画が始まったり終わったりしたら、音と表示で知らせる。別の通話に移ったときは知らせない
	watch([recordingIdentities, callRoomId], ([now, roomId], [before, roomIdBefore]) => {
		if (roomId == null || roomId !== roomIdBefore) return;
		const started = now.filter(id => !before.includes(id));
		const stopped = before.filter(id => !now.includes(id));
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

	// 持ち主が録画を許さなくなったら、どの画面にいても通話中の録画を止める
	let connection: Misskey.IChannelConnection<Misskey.Channels['chatRoom']> | null = null;

	function onRoomUpdated(ctx: Parameters<Misskey.Channels['chatRoom']['events']['roomUpdated']>[0]) {
		setRecordingAllowed(ctx.roomId, ctx.allowRecording);
	}

	watch(callRoomId, roomId => {
		connection?.dispose();
		connection = null;
		if (roomId == null) return;
		connection = useStream().useChannel('chatRoom', { roomId });
		connection.on('roomUpdated', onRoomUpdated);
	}, { immediate: true });
	onScopeDispose(() => {
		connection?.dispose();
		connection = null;
	});

	return { recordingIdentities, someoneRecording };
}
