<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="available" class="_panel" :class="$style.root">
	<div :class="$style.header">
		<i class="ti ti-volume" :class="$style.headerIcon"></i>
		<span :class="$style.title">{{ inThisCall ? i18n.ts._voiceCall.inCall : participants.length === 0 ? i18n.ts._voiceCall.noOneInCall : room.name }}</span>
		<div :class="$style.actions">
			<template v-if="inThisCall">
				<button
					class="_button" :class="[$style.action, { [$style.off]: !voiceCall.micEnabled }]"
					:aria-label="voiceCall.micEnabled ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute"
					:title="voiceCall.micEnabled ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute"
					@click="setMicEnabled(!voiceCall.micEnabled)"
				>
					<i v-if="voiceCall.micEnabled" class="ti ti-microphone"></i>
					<i v-else class="ti ti-microphone-off"></i>
				</button>
				<button
					class="_button" :class="[$style.action, { [$style.off]: voiceCall.deafened }]"
					:aria-label="voiceCall.deafened ? i18n.ts._voiceCall.undeafen : i18n.ts._voiceCall.deafen"
					:title="voiceCall.deafened ? i18n.ts._voiceCall.undeafen : i18n.ts._voiceCall.deafen"
					@click="setDeafened(!voiceCall.deafened)"
				>
					<i v-if="voiceCall.deafened" class="ti ti-headphones-off"></i>
					<i v-else class="ti ti-headphones"></i>
				</button>
				<button
					class="_button" :class="[$style.action, $style.leave]"
					:aria-label="i18n.ts._voiceCall.leave"
					:title="i18n.ts._voiceCall.leave"
					@click="leaveVoiceCall()"
				>
					<i class="ti ti-phone-off"></i>
				</button>
			</template>
			<MkButton v-else primary rounded small @click="joinVoiceCall(room)"><i class="ti ti-phone"></i> {{ i18n.ts._voiceCall.join }}</MkButton>
		</div>
	</div>
	<div v-if="participants.length > 0" :class="$style.participants">
		<XParticipant
			v-for="participant in participants"
			:key="participant.identity"
			:participant="participant"
			:speaking="inThisCall && voiceCall.speakingIdentities.includes(participant.identity)"
			:watchable="inThisCall && participant.identity !== myIdentity"
			:watching="voiceCall.watchingIdentity === participant.identity"
			:menuable="participant.identity !== myIdentity && (inThisCall || isOwner)"
			@toggleWatch="watchScreenShare(voiceCall.watchingIdentity === participant.identity ? null : participant.identity)"
			@openMenu="openMenu(participant, $event)"
		/>
	</div>
	<XScreen v-if="inThisCall && watchedParticipant != null" :key="watchedParticipant.identity" :participant="watchedParticipant" :class="$style.screen"/>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import * as Misskey from 'cherrypick-js';
import XParticipant from './room.voice.participant.vue';
import XScreen from './room.voice.screen.vue';
import XVolume from './room.voice.volume.vue';
import type { MenuItem } from '@/types/menu.js';
import * as os from '@/os.js';
import { userName } from '@/filters/user.js';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import { instance } from '@/instance.js';
import { ensureSignin } from '@/i.js';
import { useChatRoomVoiceStates } from '@/composables/use-chat-room-voice-states.js';
import { joinVoiceCall, leaveVoiceCall, localIdentityOf, setDeafened, setMicEnabled, voiceCall, watchScreenShare } from '@/utility/voice-call.js';

const props = defineProps<{
	room: Misskey.entities.ChatRoom;
}>();

const $i = ensureSignin();

// 他のサーバーが持つルームの通話はそのサーバーで開くので、連合対応までは出さない
const available = computed(() => instance.features?.voiceCall === true && $i.policies.canVoiceCall && props.room.owner.host == null);
const inThisCall = computed(() => voiceCall.room?.id === props.room.id && voiceCall.status !== 'idle');

// ルーム画面は既に chatRoom チャンネルを開いているので、共有の main チャンネル経由で受け取る
const roomIds = computed(() => available.value ? [props.room.id] : []);
const states = useChatRoomVoiceStates(roomIds);
const participants = computed(() => states.value.get(props.room.id)?.participants ?? []);
const myIdentity = localIdentityOf($i.id);
const watchedParticipant = computed(() => participants.value.find(participant => participant.identity === voiceCall.watchingIdentity) ?? null);
const isOwner = computed(() => props.room.ownerId === $i.id);

type Participant = Misskey.entities.ChatRoomVoiceState['participants'][number];

function menuItemsFor(participant: Participant): MenuItem[] {
	if (participant.identity === myIdentity) return [];
	const items: MenuItem[] = [];
	if (inThisCall.value) {
		items.push({ type: 'component', component: XVolume, props: { identity: participant.identity } });
	}
	if (isOwner.value) {
		if (items.length > 0) items.push({ type: 'divider' });
		items.push({
			icon: 'ti ti-microphone-off',
			text: i18n.ts._voiceCall.forceMute,
			action: () => {
				os.apiWithDialog('chat/rooms/voice/mute', { roomId: props.room.id, userId: participant.user.id });
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
				os.apiWithDialog('chat/rooms/voice/kick', { roomId: props.room.id, userId: participant.user.id });
			},
		});
	}
	return items;
}

function openMenu(participant: Participant, ev: MouseEvent) {
	const items = menuItemsFor(participant);
	if (items.length === 0) return;
	os.popupMenu(items, ev.currentTarget ?? ev.target);
}
</script>

<style lang="scss" module>
.root {
	padding: 12px 14px;
}

.header {
	display: flex;
	align-items: center;
	gap: 8px;
}

.headerIcon {
	color: var(--MI_THEME-accent);
}

.title {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: bold;
}

.actions {
	display: flex;
	align-items: center;
	gap: 4px;
	flex-shrink: 0;
}

.action {
	display: grid;
	place-items: center;
	width: 34px;
	height: 34px;
	border-radius: 100%;
	background: var(--MI_THEME-buttonBg);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&.off {
		color: var(--MI_THEME-error);
	}

	&.leave {
		color: var(--MI_THEME-fgOnAccent);
		background: var(--MI_THEME-error);
	}
}

.participants {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-top: 10px;
}

.screen {
	margin-top: 10px;
}
</style>
