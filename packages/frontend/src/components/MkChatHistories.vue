<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="history.length > 0 || emptyRooms.length > 0" class="_gaps_s">
	<MkA
		v-for="item in history"
		:key="item.id"
		:class="[$style.message, { [$style.isMe]: item.isMe, [$style.isRead]: item.message.isRead }]"
		class="_panel"
		:to="item.message.toRoomId ? `/chat/room/${item.message.toRoomId}` : `/chat/user/${item.other!.id}`"
	>
		<MkAvatar v-if="item.message.toRoomId" :class="$style.messageAvatar" :user="item.message.fromUser" indicator :preview="false"/>
		<MkAvatar v-else-if="item.other" :class="$style.messageAvatar" :user="item.other" indicator :preview="false"/>
		<div :class="$style.messageBody">
			<header v-if="item.message.toRoom" :class="$style.messageHeader">
				<span :class="$style.messageHeaderName"><i class="ti ti-users"></i> {{ item.message.toRoom.name }}</span>
				<span
					v-if="voiceStates.has(item.message.toRoom.id)"
					:class="$style.messageHeaderVoice"
					role="img"
					:aria-label="i18n.tsx._voiceCall.inCallCount({ n: voiceStates.get(item.message.toRoom.id)!.participants.length })"
					:title="i18n.tsx._voiceCall.inCallCount({ n: voiceStates.get(item.message.toRoom.id)!.participants.length })"
				><i class="ti ti-volume"></i> {{ voiceStates.get(item.message.toRoom.id)!.participants.length }}</span>
				<MkTime :time="item.message.createdAt" :class="$style.messageHeaderTime"/>
			</header>
			<header v-else :class="$style.messageHeader">
				<MkUserName :class="$style.messageHeaderName" :user="item.other!"/>
				<MkAcct :class="$style.messageHeaderUsername" :user="item.other!"/>
				<MkTime :time="item.message.createdAt" :class="$style.messageHeaderTime"/>
			</header>
			<div :class="$style.messageBodyText"><span v-if="item.isMe" :class="$style.youSaid">{{ i18n.ts.you }}:</span>{{ item.message.text }}</div>
		</div>
	</MkA>
	<MkA
		v-for="room in emptyRooms"
		:key="`empty-${room.id}`"
		:class="$style.message"
		class="_panel"
		:to="`/chat/room/${room.id}`"
	>
		<MkAvatar :class="$style.messageAvatar" :user="room.owner" indicator :preview="false"/>
		<div :class="$style.messageBody">
			<header :class="$style.messageHeader">
				<span :class="$style.messageHeaderName"><i class="ti ti-users"></i> {{ room.name }}</span>
				<span
					v-if="voiceStates.has(room.id)"
					:class="$style.messageHeaderVoice"
					role="img"
					:aria-label="i18n.tsx._voiceCall.inCallCount({ n: voiceStates.get(room.id)!.participants.length })"
					:title="i18n.tsx._voiceCall.inCallCount({ n: voiceStates.get(room.id)!.participants.length })"
				><i class="ti ti-volume"></i> {{ voiceStates.get(room.id)!.participants.length }}</span>
			</header>
			<div :class="$style.messageBodyText">{{ i18n.ts._chat.noMessagesInRoom }}</div>
		</div>
	</MkA>
</div>
<MkResult v-if="!initializing && history.length === 0 && emptyRooms.length === 0" type="empty" :text="i18n.ts._chat.noHistory"/>
<MkLoading v-if="initializing"/>
</template>

<script lang="ts" setup>
import { computed, onActivated, onDeactivated, onMounted, ref } from 'vue';
import * as Misskey from 'cherrypick-js';
import { useInterval } from '@@/js/use-interval.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { ensureSignin } from '@/i.js';
import { useChatRoomVoiceStates } from '@/composables/use-chat-room-voice-states.js';

const $i = ensureSignin();

const history = ref<{
	id: string;
	message: Misskey.entities.ChatMessage;
	other: Misskey.entities.ChatMessage['fromUser'] | Misskey.entities.ChatMessage['toUser'] | null;
	isMe: boolean;
}[]>([]);

// メッセージがまだ無く、履歴に出てこない自分のルーム (所有・参加)
const emptyRooms = ref<Misskey.entities.ChatRoom[]>([]);

const voiceStates = useChatRoomVoiceStates(computed(() => [
	...history.value.flatMap(item => item.message.toRoomId != null ? [item.message.toRoomId] : []),
	...emptyRooms.value.map(room => room.id),
]));

const initializing = ref(true);
const fetching = ref(false);

// 自分のルーム一覧 (所有・参加)。メッセージの無いルームはあまり変わらないので、毎回は取り直さない
let ownedRooms: Misskey.entities.ChatRoom[] = [];
let joiningRooms: Misskey.entities.ChatRoomMembership[] = [];

// マウント・アクティブ化のときと、定期取得の 6 回に 1 回 (約 60 秒) だけルーム一覧を取り直す
const ROOMS_REFRESH_EVERY = 6;
let pollsSinceRooms = 0;

async function fetchRooms() {
	// 失敗しても履歴の表示は止めない。直前に取れた一覧をそのまま使う
	const [owned, joining] = await Promise.all([
		misskeyApi('chat/rooms/owned', { limit: 100 }).catch(() => null),
		misskeyApi('chat/rooms/joining', { limit: 100 }).catch(() => null),
	]);
	if (owned != null) ownedRooms = owned;
	if (joining != null) joiningRooms = joining;
	pollsSinceRooms = 0;
}

async function fetchHistory(withRooms = true) {
	if (fetching.value) return;

	fetching.value = true;

	try {
		const [userMessages, roomMessages] = await Promise.all([
			misskeyApi('chat/history', { room: false }),
			misskeyApi('chat/history', { room: true }),
			withRooms ? fetchRooms() : Promise.resolve(),
		]);

		// 履歴に無いルームだけを、所有ルームは部屋の作成日時・参加ルームは参加日時の新しい順に並べる。
		// 所有かつ参加のルームは一度だけ出す
		const inHistory = new Set(roomMessages.flatMap(m => m.toRoomId != null ? [m.toRoomId] : []));
		const candidates = new Map<string, { room: Misskey.entities.ChatRoom; time: number }>();
		for (const room of ownedRooms) {
			candidates.set(room.id, { room, time: new Date(room.createdAt).getTime() });
		}
		for (const membership of joiningRooms) {
			if (membership.room == null || candidates.has(membership.room.id)) continue;
			candidates.set(membership.room.id, { room: membership.room, time: new Date(membership.createdAt ?? membership.room.createdAt).getTime() });
		}
		emptyRooms.value = [...candidates.values()]
			.filter(c => !inHistory.has(c.room.id))
			.toSorted((a, b) => b.time - a.time)
			.map(c => c.room);

		history.value = [...userMessages, ...roomMessages]
			.toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
			.map(m => ({
				id: m.id,
				message: m,
				other: (!('room' in m) || m.room == null) ? (m.fromUserId === $i.id ? m.toUser : m.fromUser) : null,
				isMe: m.fromUserId === $i.id,
			}));

		initializing.value = false;
	} finally {
		// 失敗しても次の定期取得が走るように必ず戻す
		fetching.value = false;
	}
}

let isActivated = true;

onActivated(() => {
	isActivated = true;
});

onDeactivated(() => {
	isActivated = false;
});

useInterval(() => {
	// TODO: DOM的にバックグラウンドになっていないかどうかも考慮する
	if (isActivated) {
		pollsSinceRooms++;
		fetchHistory(pollsSinceRooms >= ROOMS_REFRESH_EVERY).catch(() => {});
	}
}, 1000 * 10, {
	immediate: false,
	afterMounted: true,
});

onActivated(() => {
	fetchHistory().catch(() => {});
});

onMounted(() => {
	fetchHistory().catch(() => {});
});
</script>

<style lang="scss" module>
.message {
	position: relative;
	display: flex;
	padding: 16px 24px;

	&.isRead,
	&.isMe {
		opacity: 0.8;
	}

	&:not(.isMe):not(.isRead) {
		&::before {
			content: '';
			position: absolute;
			top: 8px;
			right: 8px;
			width: 8px;
			height: 8px;
			border-radius: 100%;
			background-color: var(--MI_THEME-accent);
		}
	}
}

@container (max-width: 500px) {
	.message {
		font-size: 90%;
		padding: 14px 20px;
	}
}

@container (max-width: 450px) {
	.message {
		font-size: 80%;
		padding: 12px 16px;
	}
}

.messageAvatar {
	width: 50px;
	height: 50px;
	margin: 0 16px 0 0;
}

@container (max-width: 500px) {
	.messageAvatar {
		width: 45px;
		height: 45px;
	}
}

@container (max-width: 450px) {
	.messageAvatar {
		width: 40px;
		height: 40px;
	}
}

.messageBody {
	flex: 1;
	min-width: 0;
}

.messageHeader {
	display: flex;
	align-items: center;
	margin-bottom: 2px;
	white-space: nowrap;
	overflow: clip;
}

.messageHeaderVoice {
	flex-shrink: 0;
	margin-left: 6px;
	font-size: 0.85em;
	color: var(--MI_THEME-accent);
}

.messageHeaderName {
	margin: 0;
	padding: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	font-size: 1em;
	font-weight: bold;
}

.messageHeaderUsername {
	margin: 0 8px;
}

.messageHeaderTime {
	margin-left: auto;
}

.messageBodyText {
	overflow: hidden;
	overflow-wrap: break-word;
	font-size: 1.1em;
}

.youSaid {
	font-weight: bold;
	margin-right: 0.5em;
}
</style>
