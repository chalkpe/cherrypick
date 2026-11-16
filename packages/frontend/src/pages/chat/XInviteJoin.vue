<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<MkButton v-if="state?.status === 'joined' || state?.status === 'invited'" :small="true" inline primary @click.stop="openRoom">
		<i class="ti ti-door-enter"></i> {{ i18n.ts._chat._inviteLink.openRoom }}
	</MkButton>
	<MkButton v-else-if="state?.status === 'pending'" :small="true" inline disabled>
		<i class="ti ti-clock"></i> {{ i18n.ts._chat._inviteLink.pendingButton }}
	</MkButton>
	<MkButton v-else :small="true" inline primary :disabled="state?.joining" @click.stop="join">
		<i class="ti ti-plus"></i> {{ i18n.ts._chat.join }}
	</MkButton>
	<span v-if="message != null" :class="$style.message" aria-live="polite">{{ message }}</span>
</div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted } from 'vue';
import type { ChatInviteSummary } from './chat-invite-link.js';
import { chatInviteJoinState, joinChatInvite, refreshChatInviteJoinStatus, subscribeChatInviteJoinResults } from './chat-invite-link.js';
import { chatInviteJoinErrorText, chatInviteRefusalText } from './chat-errors.js';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { $i } from '@/i.js';
import { useRouter } from '@/router.js';
import { pleaseLogin } from '@/utility/please-login.js';

const props = defineProps<{
	invite: ChatInviteSummary;
}>();

const router = useRouter();

const state = computed(() => chatInviteJoinState(props.invite.url));

const message = computed(() => {
	switch (state.value?.status) {
		case 'pending': return i18n.ts._chat._inviteLink.pending;
		case 'invited': return i18n.ts._chat._inviteLink.invited;
		case 'refused': return chatInviteRefusalText(state.value.reason);
		default: return null;
	}
});

let mounted = false;
let unsubscribe: (() => void) | null = null;

onMounted(() => {
	mounted = true;
	if ($i == null) return;
	unsubscribe = subscribeChatInviteJoinResults();
	refreshChatInviteJoinStatus(props.invite.url);
});

onBeforeUnmount(() => {
	mounted = false;
	unsubscribe?.();
});

function openRoom() {
	const roomId = state.value?.roomId;
	if (roomId == null) return;
	router.push('/chat/room/:roomId', { params: { roomId } });
}

async function join() {
	// 원격 계정 입력 같은 다른 절차 없이, 이 서버 계정으로 로그인하도록만 안내한다
	if ($i == null) {
		await pleaseLogin();
		return;
	}

	const outcome = await joinChatInvite(props.invite.url);
	switch (outcome.kind) {
		case 'joined':
			// 누른 카드가 아직 화면에 있을 때만 그 그룹으로 옮긴다. 기존 그룹 주소가 맨 위 채널을 연다
			if (mounted) router.push('/chat/room/:roomId', { params: { roomId: outcome.roomId } });
			break;
		case 'failed':
			os.alert({ type: 'error', text: chatInviteJoinErrorText(outcome.error) });
			break;
	}
}
</script>

<style lang="scss" module>
.root {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
	align-items: center;
	margin-top: 6px;
}

.message {
	font-size: 0.85em;
	opacity: 0.8;
}
</style>
