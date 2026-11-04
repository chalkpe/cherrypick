<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<div v-if="invitations.length > 0" class="_gaps_s">
		<MkFolder v-for="invitation in invitations" :key="invitation.id" :defaultOpen="true">
			<template #icon><i class="ti ti-users-group"></i></template>
			<template #label><Mfm :text="invitation.room.name" :plain="true" :author="invitation.room.owner"/></template>
			<template #suffix><MkTime :time="invitation.createdAt"/></template>
			<template #footer>
				<div class="_buttons">
					<MkButton v-if="!invitation.room.isArchived" primary @click="join(invitation)"><i class="ti ti-plus"></i> {{ i18n.ts._chat.join }}</MkButton>
					<MkButton danger @click="reject(invitation)"><i class="ti ti-ban"></i> {{ i18n.ts._chat.reject }}</MkButton>
				</div>
			</template>

			<div :class="$style.invitationBody">
				<MkAvatar :user="invitation.room.owner" :class="$style.invitationBodyAvatar" link/>
				<div style="flex: 1;" class="_gaps_s">
					<MkUserName :user="invitation.room.owner"/>
					<hr>
					<div><Mfm v-if="invitation.room.description" :text="invitation.room.description" :author="invitation.room.owner"/><template v-else>{{ i18n.ts.noDescription }}</template></div>
				</div>
			</div>
		</MkFolder>
	</div>
	<MkResult v-if="!fetching && invitations.length == 0" type="empty" :text="i18n.ts._chat.noInvitations"/>
	<MkLoading v-if="fetching"/>
</div>
</template>

<script lang="ts" setup>
import * as Misskey from 'cherrypick-js';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useRouter } from '@/router.js';
import MkFolder from '@/components/MkFolder.vue';
import * as os from '@/os.js';
import { useChatRoomList } from '@/composables/use-chat-room-list.js';
import { globalEvents } from '@/events.js';
import { chatJoinErrors } from './chat-errors.js';

const router = useRouter();

const { items: invitations, fetching } = useChatRoomList<Misskey.entities.ChatRoomInvitation>(() => misskeyApi('chat/rooms/invitations/inbox'));

async function join(invitation: Misskey.entities.ChatRoomInvitation) {
	await os.apiWithDialog('chat/rooms/join', {
		roomId: invitation.room.id,
	}, undefined, chatJoinErrors);
	globalEvents.emit('chatRoomInvitationHandled', invitation.room.id, 'joined');

	router.push('/chat/room/:roomId', {
		params: {
			roomId: invitation.room.id,
		},
	});
}

async function reject(invitation: Misskey.entities.ChatRoomInvitation) {
	await os.apiWithDialog('chat/rooms/invitations/reject', {
		roomId: invitation.room.id,
	});
	globalEvents.emit('chatRoomInvitationHandled', invitation.room.id, 'rejected');

	invitations.value = invitations.value.filter(i => i.id !== invitation.id);
}
</script>

<style lang="scss" module>
.invitationBody {
	display: flex;
	align-items: center;
}

.invitationBodyAvatar {
	margin-right: 12px;
	width: 45px;
	height: 45px;
}
</style>
