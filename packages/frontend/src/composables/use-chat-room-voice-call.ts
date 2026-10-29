/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, markRaw, ref, toValue } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import * as Misskey from 'cherrypick-js';
import type { MenuItem } from '@/types/menu.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { ensureSignin } from '@/i.js';
import { userName } from '@/filters/user.js';
import { isChatRoomVoiceAvailable } from '@/utility/chat-room-voice-availability.js';
import { useChatRoomVoiceStates } from '@/composables/use-chat-room-voice-states.js';
import { joinVoiceCall, localIdentityOf, setDeafened, setMicEnabled, toggleScreenShareWatch, voiceCall } from '@/utility/voice-call.js';
import XVolume from '@/pages/chat/room.voice.volume.vue';
import XRoster from '@/pages/chat/room.voice.roster.vue';

type Participant = Misskey.entities.ChatRoomVoiceState['participants'][number];

/**
 * ルーム画面の通話カード・広い画面のステージ・ページヘッダーの参加ボタンが、同じ参加者の情報と参加の流れを使うためのもの。
 */
export function useChatRoomVoiceCall(room: MaybeRefOrGetter<Misskey.entities.ChatRoom | null>) {
	const $i = ensureSignin();
	const myIdentity = localIdentityOf($i.id);

	// 他のサーバーが持つルーム (ミラー) の通話はそのサーバーで開かれるので、連合通話が許可されているときだけ出す
	const available = computed(() => isChatRoomVoiceAvailable(toValue(room), $i.policies.canVoiceCall));
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
	// 参加者の一覧はサーバーを経て届くので、画面共有を始めたりやめたりしても少し遅れて変わる (他のサーバーのルームでは 10 秒以上)。
	// この通話に入っているあいだは、自分の項目の画面共有だけを手元の状態に合わせ、何を共有しているかをすぐ確かめられるようにする
	// (始めればすぐプレビューを出し、やめればすぐ消す)。一覧にまだ自分がいなければ自分の項目は作らず、届いたときに合わせる
	const participants = computed(() => {
		const target = toValue(room);
		const listed = target == null ? [] : states.value.get(target.id)?.participants ?? [];
		if (!inThisCall.value) return listed;
		return listed.map(participant => participant.identity === myIdentity
			? { ...participant, screenSharing: voiceCall.screenSharing, micMuted: !voiceCall.micEnabled, deafened: voiceCall.deafened }
			: participant);
	});

	// 見ている共有画面の持ち主 (見始めた順)。共有画面を受け取れるのはこのルームの通話に入っているときだけ
	const watchedParticipants = computed(() => {
		if (!inThisCall.value) return [];
		return voiceCall.watchingIdentities
			.map(identity => participants.value.find(participant => participant.identity === identity))
			.filter((participant): participant is Participant => participant != null);
	});

	// 誰も通話にいないときはカードを出さず、ページヘッダーの参加ボタンだけにする。
	// 自分が参加した直後は参加者の一覧がまだ届いていないことがあるので、参加中なら一覧を待たずに出す
	const showCard = computed(() => available.value && (inThisCall.value || participants.value.length > 0));

	// 他のサーバーで開かれる通話には相手のサーバーに IP アドレスが見えるので、ホストごとに初回だけ確認する
	let joining = false;
	const prejoinMic = ref(false);

	const prejoinMicEnabled = computed({
		get: () => prejoinMic.value,
		set: value => { prejoinMic.value = value; },
	});

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
			await joinVoiceCall(target, { micEnabled: prejoinMicEnabled.value });
		} finally {
			joining = false;
		}
	}

	const isOwner = computed(() => toValue(room)?.ownerId === $i.id);

	// 参加者ごとのメニュー (自分の手元の音量、ルームの持ち主なら強制ミュートと通話から外す)
	function participantMenuItems(participant: Participant, onWatch?: () => void): MenuItem[] {
		const target = toValue(room);
		if (target == null) return [];
		const items: MenuItem[] = [];
		if (inThisCall.value && participant.screenSharing) {
			items.push({ icon: 'ti ti-screen-share', text: voiceCall.watchingIdentities.includes(participant.identity) ? i18n.ts._voiceCall.stopWatching : i18n.ts._voiceCall.watchStream, action: () => { const wasWatching = voiceCall.watchingIdentities.includes(participant.identity); toggleScreenShareWatch(participant.identity); if (!wasWatching) onWatch?.(); } });
		}
		if (participant.identity === myIdentity) {
			if (inThisCall.value) items.push({ icon: 'ti ti-microphone', text: voiceCall.micEnabled ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute, action: () => { void setMicEnabled(!voiceCall.micEnabled); } }, { icon: 'ti ti-headphones', text: voiceCall.deafened ? i18n.ts._voiceCall.undeafen : i18n.ts._voiceCall.deafen, action: () => setDeafened(!voiceCall.deafened) });
			return items;
		}
		if (inThisCall.value) {
			if (items.length > 0) items.push({ type: 'divider' });
			items.push({ type: 'component', component: XVolume, props: { identity: participant.identity, audio: 'voice' } });
		}
		if (isOwner.value) {
			if (items.length > 0) items.push({ type: 'divider' });
			items.push({
				icon: 'ti ti-microphone-off',
				text: i18n.ts._voiceCall.forceMute,
				danger: true,
				action: () => {
					os.apiWithDialog('chat/rooms/voice/mute', { roomId: target.id, userId: participant.user.id });
				},
			}, {
				icon: 'ti ti-user-x',
				text: i18n.ts._voiceCall.kick,
				danger: true,
				action: async () => {
					const { canceled } = await os.confirm({
						type: 'warning',
						text: i18n.tsx._voiceCall.kickConfirm({ name: userName(participant.user) }),
					});
					if (canceled) return;
					os.apiWithDialog('chat/rooms/voice/kick', { roomId: target.id, userId: participant.user.id });
				},
			});
		}
		return items;
	}

	/** 参加者を押したときにメニューに出すものがあるか。無いときは、押しても何も起きないボタンを出さない */
	function hasParticipantMenu(participant: Participant) {
		return participantMenuItems(participant).length > 0;
	}

	function openParticipantMenu(participant: Participant, ev: MouseEvent, onWatch?: () => void) {
		const items = participantMenuItems(participant, onWatch);
		if (items.length === 0) return;
		return os.popupMenu(items, ev.currentTarget ?? ev.target);
	}

	function openRoster() {
		const { dispose } = os.popup(XRoster, { call: markRaw(call) }, { closed: () => dispose() });
	}

	const call = { available, inThisCall, participants, watchedParticipants, showCard, join, prejoinMicEnabled, myIdentity, isOwner, hasParticipantMenu, openParticipantMenu, openRoster };
	return call;
}

export type ChatRoomVoiceCall = ReturnType<typeof useChatRoomVoiceCall>;
