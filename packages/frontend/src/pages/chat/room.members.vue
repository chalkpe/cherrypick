<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<MkButton v-if="isOwner && !room.isArchived" primary rounded style="margin: 0 auto;" @click="emit('inviteUser')"><i class="ti ti-plus"></i> {{ i18n.ts._chat.inviteUser }}</MkButton>

	<div>{{ i18n.ts._chat.roomOwner }}</div>

	<MkA :class="$style.membershipBody" :to="`${userPage(room.owner)}`">
		<MkUserCardMini :user="room.owner"/>
	</MkA>

	<template v-if="memberships.length > 0">
		<hr>

		<div>{{ i18n.ts._chat.members }}</div>
	</template>

	<div v-for="membership in memberships" :key="membership.id" :class="$style.membership">
		<MkA :class="$style.membershipBody" :to="`${userPage(membership.user!)}`">
			<MkUserCardMini :user="membership.user!"/>
		</MkA>
		<MkButton v-if="isOwner && membership.userId !== $i.id" danger :disabled="removingMemberId != null" @click="kickMember(membership)">
			<i class="ti ti-user-minus" aria-hidden="true"></i> {{ i18n.ts._chat.kickMember }}
		</MkButton>
	</div>

	<template v-if="isOwner">
		<hr>

		<div>{{ i18n.ts._chat.sentInvitations }}</div>

		<div v-for="invitation in invitations" :key="invitation.id" :class="$style.invitation">
			<MkA :class="$style.invitationBody" :to="`${userPage(invitation.user)}`">
				<MkUserCardMini :user="invitation.user"/>
			</MkA>
			<button :class="$style.cancelButton" :title="i18n.tsx._chat.cancelInvitationTo({ x: invitation.user.name || invitation.user.username })" :aria-label="i18n.tsx._chat.cancelInvitationTo({ x: invitation.user.name || invitation.user.username })" @click="cancelInvitation(invitation)">
				<i class="ti ti-x"></i>
			</button>
		</div>
	</template>
</div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import * as Misskey from 'cherrypick-js';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import MkUserCardMini from '@/components/MkUserCardMini.vue';
import { userPage } from '@@/js/user.js';
import { ensureSignin } from '@/i.js';
import * as os from '@/os.js';
import { chatCancelInvitationErrors, chatKickErrors } from './chat-errors.js';

const $i = ensureSignin();

const props = defineProps<{
	room: Misskey.entities.ChatRoom;
}>();

const emit = defineEmits<{
	(ev: 'inviteUser'): void,
}>();

const isOwner = computed(() => {
	return props.room.ownerId === $i.id;
});

const memberships = ref<Misskey.entities.ChatRoomMembership[]>([]);
const invitations = ref<Misskey.entities.ChatRoomInvitation[]>([]);
const removingMemberId = ref<string | null>(null);

async function kickMember(membership: Misskey.entities.ChatRoomMembership) {
	if (!isOwner.value || membership.userId === $i.id || removingMemberId.value != null) return;
	removingMemberId.value = membership.userId;
	try {
		const { canceled } = await os.confirm({
			type: 'warning',
			text: i18n.tsx._chat.kickMemberConfirm({ name: membership.user?.name || membership.user?.username || membership.userId, room: props.room.name }),
		});
		if (canceled) return;
		await os.apiWithDialog('chat/rooms/kick', { roomId: props.room.id, userId: membership.userId }, undefined, chatKickErrors);
		memberships.value = memberships.value.filter(member => member.id !== membership.id);
	} catch {
		// apiWithDialog already displays the request error; keep the member visible.
	} finally {
		removingMemberId.value = null;
	}
}

async function cancelInvitation(invitation: Misskey.entities.ChatRoomInvitation) {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.tsx._chat.invitationCancelAreYouSure({ x: invitation.user.name || invitation.user.username }),
	});
	if (canceled) return;

	try {
		await os.apiWithDialog('chat/rooms/invitations/cancel', {
			invitationId: invitation.id,
		}, undefined, chatCancelInvitationErrors);
	} catch {
		// apiWithDialog already displays the request error. The list was out of date, so read it again.
		invitations.value = await misskeyApi('chat/rooms/invitations/outbox', { roomId: props.room.id, limit: 50 }).catch(() => invitations.value);
		return;
	}

	// Remove from local state
	invitations.value = invitations.value.filter(i => i.id !== invitation.id);
}

onMounted(async () => {
	memberships.value = await misskeyApi('chat/rooms/members', {
		roomId: props.room.id,
		limit: 50,
	});

	if (isOwner.value) {
		invitations.value = await misskeyApi('chat/rooms/invitations/outbox', {
			roomId: props.room.id,
			limit: 50,
		});
	}
});
</script>

<style lang="scss" module>
.membership {
	display: flex;
	align-items: center;
}

.membershipBody {
	flex: 1;
	min-width: 0;
	margin-right: 8px;
}

.invitation {
	display: flex;
}

.invitationBody {
	flex: 1;
	min-width: 0;
	margin-right: 8px;
}

.cancelButton {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	border: none;
	border-radius: 100%;
	background: var(--MI_THEME-error);
	color: var(--MI_THEME-fgOnAccent);
	margin: auto 8px auto auto;
	cursor: pointer;
	transition: opacity 0.2s;

	&:hover {
		opacity: 0.8;
	}
}
</style>
