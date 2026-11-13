<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<div>
		<MkAvatar :room="room" style="width: 72px; height: 72px;"/>
		<div v-if="isOwner && !room.isArchived" class="_buttons" style="margin-top: 16px;">
			<MkButton @click="changeIcon">{{ i18n.ts._profile.changeAvatar }}</MkButton>
			<MkButton @click="decorationEditorOpen = !decorationEditorOpen">{{ i18n.ts.decorate }} <i class="ti ti-sparkles"></i></MkButton>
		</div>
	</div>
	<XDecorationEditor v-if="isOwner && !room.isArchived && decorationEditorOpen" :room="room" @updated="updated => emit('updated', updated)"/>

	<template v-if="isOwner">
		<MkInput v-model="name_" :mfmAutocomplete="['emoji']" :disabled="room.isArchived">
			<template #label>{{ i18n.ts.name }}</template>
			<template #caption>{{ i18n.ts.preview }}: <Mfm :text="name_" :plain="true" :author="room.owner"/></template>
		</MkInput>

		<MkTextarea v-model="description_" :mfmAutocomplete="['emoji']" mfmPreview :disabled="room.isArchived">
			<template #label>{{ i18n.ts.description }}</template>
		</MkTextarea>
		<MkButton v-if="!room.isArchived" primary @click="save">{{ i18n.ts.save }}</MkButton>
	</template>
	<template v-else>
		<MkKeyValue><template #key>{{ i18n.ts.name }}</template><template #value><Mfm :text="room.name" :plain="true" :author="room.owner"/></template></MkKeyValue>
		<MkKeyValue><template #key>{{ i18n.ts.description }}</template><template #value><Mfm v-if="room.description" :text="room.description" :author="room.owner"/><template v-else>{{ i18n.ts.noDescription }}</template></template></MkKeyValue>
	</template>

	<XChannelManagement :room="room" :channels="channels" @updated="emit('updated', $event)" @channelsUpdated="emit('channelsUpdated')"/>

	<hr>

	<!-- 활성 초대 링크는 하나뿐이다. 발급과 폐기는 서로 다른 동작이며 자동으로 바꾸거나 다시 발급하지 않는다 -->
	<div v-if="isOwner" class="_gaps_s">
		<MkKeyValue>
			<template #key>{{ i18n.ts._chat._inviteLink.title }}</template>
			<template #value>
				<MkEllipsis v-if="inviteLink === undefined && inviteLinkError == null"/>
				<template v-else-if="inviteLinkError != null">{{ inviteLinkError }}</template>
				<span v-else-if="inviteLink != null" :class="$style.inviteLinkUrl">{{ inviteLink.url }}</span>
				<template v-else>{{ i18n.ts._chat._inviteLink.none }}</template>
			</template>
		</MkKeyValue>
		<div class="_buttons">
			<template v-if="inviteLink != null">
				<MkButton @click="copyInviteLink"><i class="ti ti-copy"></i> {{ i18n.ts.copyLink }}</MkButton>
				<MkButton danger :disabled="room.isArchived || inviteLinkBusy" @click="revokeInviteLink"><i class="ti ti-link-off"></i> {{ i18n.ts._chat._inviteLink.revoke }}</MkButton>
			</template>
			<MkButton v-else-if="inviteLink === null" primary :disabled="room.isArchived || inviteLinkBusy" @click="createInviteLink"><i class="ti ti-link"></i> {{ i18n.ts._chat._inviteLink.create }}</MkButton>
		</div>
		<MkInfo v-if="room.isArchived" warn>{{ i18n.ts._chat._inviteLink.archivedNote }}</MkInfo>
		<MkInfo v-else>{{ i18n.ts._chat._inviteLink.description }}</MkInfo>
	</div>

	<MkButton v-if="isOwner" @click="setArchived(!room.isArchived)"><i :class="room.isArchived ? 'ti ti-archive-off' : 'ti ti-archive'"></i> {{ room.isArchived ? i18n.ts.unarchive : i18n.ts.archive }}</MkButton>

	<MkButton v-if="isOwner || ($i.isAdmin || $i.isModerator)" danger @click="del">{{ i18n.ts._chat.deleteRoom }}</MkButton>

	<MkSelect :modelValue="notificationLevel" :items="groupNotificationItems" :disabled="savingNotification" @update:modelValue="setNotificationLevel">
		<template #label>{{ i18n.ts.notificationSetting }}</template>
	</MkSelect>
	<template v-if="room.hasChannels">
		<MkSelect v-for="channel in notificationChannels" :key="channel.id" :modelValue="channelLevels[channel.id] ?? 'inherit'" :items="channelNotificationItems" :disabled="savingNotification" @update:modelValue="level => setChannelNotification(channel.id, level)">
			<template #label>#{{ channel.name }}</template>
		</MkSelect>
	</template>
	<MkButton @click="readAll"><i class="ti ti-checks"></i> {{ i18n.ts._chat.readAllRoom }}</MkButton>
</div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import XChannelManagement from './room.channels.manage.vue';
import { chooseAvatar } from '@/utility/choose-avatar.js';
import XDecorationEditor from '@/pages/settings/avatar-decoration.vue';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { ensureSignin } from '@/i.js';
import MkInput from '@/components/MkInput.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import MkSelect from '@/components/MkSelect.vue';
import type { MkSelectItem } from '@/components/MkSelect.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import MkInfo from '@/components/MkInfo.vue';
import { useRouter } from '@/router.js';
import { chatInviteLinkManageErrorText, chatNotificationErrors, chatRoomDeleteErrors, chatRoomUpdateErrors } from './chat-errors.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { copyToClipboard } from '@/utility/copy-to-clipboard.js';

const router = useRouter();
const $i = ensureSignin();

const props = defineProps<{
	room: Misskey.entities.ChatRoom;
	channels?: Misskey.entities.ChatRoomChannel[];
}>();

const isOwner = computed(() => {
	return props.room.ownerId === $i.id;
});

const name_ = ref(props.room.name);
const description_ = ref(props.room.description);

const emit = defineEmits<{
	(ev: 'updated', room: Misskey.entities.ChatRoom): void;
	(ev: 'deleting', deleting: boolean): void;
	(ev: 'channelsUpdated'): void;
}>();

const decorationEditorOpen = ref(false);

function changeIcon(ev: PointerEvent) {
	if (!isOwner.value || props.room.isArchived) return;
	const targetId = props.room.id;
	chooseAvatar(ev.currentTarget ?? ev.target, props.room.iconId ?? null, async iconId => {
		if (!isOwner.value || props.room.isArchived || props.room.id !== targetId) return;
		const updated = await os.apiWithDialog('chat/rooms/update', { roomId: props.room.id, iconId }, undefined, chatRoomUpdateErrors).catch(() => null);
		if (updated) emit('updated', updated);
	});
}

async function save() {
	// 失敗したときは apiWithDialog がダイアログで知らせるので、ここでは何もしない
	const updated = await os.apiWithDialog('chat/rooms/update', {
		roomId: props.room.id,
		name: name_.value,
		description: description_.value,
	}, undefined, chatRoomUpdateErrors).catch(() => null);
	if (updated == null) return;
	emit('updated', updated);
}

async function setArchived(isArchived: boolean) {
	if (isArchived) {
		const { canceled } = await os.confirm({
			type: 'warning',
			title: i18n.tsx._chat.archiveRoomConfirmTitle({ name: props.room.name }),
			text: i18n.ts._chat.archiveRoomConfirmDescription,
			room: props.room,
		});
		if (canceled) return;
	}

	const updated = await os.apiWithDialog('chat/rooms/update', {
		roomId: props.room.id,
		isArchived,
	}, undefined, chatRoomUpdateErrors).catch(() => null);
	if (updated == null) return;
	emit('updated', updated);
}

let roomClosed = false;
onBeforeUnmount(() => {
	roomClosed = true;
});

async function del() {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.tsx._chat.deleteRoomConfirm({ name: props.room.name }),
		room: props.room,
	});
	if (canceled) return;

	emit('deleting', true);
	try {
		await os.apiWithDialog('chat/rooms/delete', {
			roomId: props.room.id,
		}, undefined, chatRoomDeleteErrors);
	} catch {
		// apiWithDialog がエラーを表示済み。削除の通知を先に受けていれば、戻るルームはもう無い
		emit('deleting', false);
		if (!roomClosed) return;
	}
	router.push('/chat');
}

type NotificationLevel = 'all' | 'mentions' | 'none';
const groupNotificationItems = [
	{ label: i18n.ts._chat.notificationAll, value: 'all' },
	{ label: i18n.ts._chat.notificationMentions, value: 'mentions' },
	{ label: i18n.ts._chat.notificationNone, value: 'none' },
] satisfies MkSelectItem<NotificationLevel>[];
const channelNotificationItems = [
	{ label: i18n.ts._chat.notificationInherit, value: 'inherit' },
	...groupNotificationItems,
] satisfies MkSelectItem<NotificationLevel | 'inherit'>[];
const notificationLevel = ref<NotificationLevel>(props.room.notificationLevel ?? (props.room.isMuted ? 'none' : 'all'));
const savingNotification = ref(false);
const listedChannels = ref<Misskey.entities.ChatRoomChannel[]>([]);
const notificationChannels = computed(() => props.channels ?? listedChannels.value);
let notificationRequest = 0;
const channelLevels = ref<Record<string, NotificationLevel | 'inherit'>>({});

watch([() => props.room.id, () => props.room.hasChannels], async ([roomId, hasChannels]) => {
	const request = ++notificationRequest;
	listedChannels.value = [];
	channelLevels.value = {};
	notificationLevel.value = props.room.notificationLevel ?? (props.room.isMuted ? 'none' : 'all');
	if (!hasChannels) return;
	try {
		const [listed, settings] = await Promise.all([
			props.channels ?? misskeyApi('chat/rooms/channels/list', { roomId }),
			misskeyApi('chat/rooms/notifications', { roomId }),
		]);
		if (request !== notificationRequest || roomClosed || props.room.id !== roomId) return;
		listedChannels.value = listed;
		channelLevels.value = Object.fromEntries(settings.channelOverrides.map(setting => [setting.channelId, setting.level]));
	} catch {
		if (request === notificationRequest && !roomClosed && props.room.id === roomId) await os.alert({ type: 'error', text: i18n.ts._chat.roomUnavailable });
	}
}, { immediate: true });

async function setNotificationLevel(level: NotificationLevel) {
	const previous = notificationLevel.value;
	notificationLevel.value = level;
	savingNotification.value = true;
	try {
		await os.apiWithDialog('chat/rooms/notifications', { roomId: props.room.id, level }, undefined, chatNotificationErrors);
		emit('updated', { ...props.room, notificationLevel: level, isMuted: level === 'none' });
	} catch {
		notificationLevel.value = previous;
	} finally {
		savingNotification.value = false;
	}
}

async function setChannelNotification(channelId: string, level: NotificationLevel | 'inherit') {
	const previous = channelLevels.value[channelId];
	channelLevels.value[channelId] = level;
	savingNotification.value = true;
	try {
		await os.apiWithDialog('chat/rooms/notifications', { roomId: props.room.id, channelId, level }, undefined, chatNotificationErrors);
	} catch {
		channelLevels.value[channelId] = previous;
	} finally {
		savingNotification.value = false;
	}
}

type InviteLink = Misskey.Endpoints['chat/rooms/invite-link/show']['res'];

// undefined는 아직 읽는 중, null은 활성 링크가 없음
const inviteLink = ref<InviteLink | undefined>(undefined);
const inviteLinkError = ref<string | null>(null);
const inviteLinkBusy = ref(false);
let latestInviteLinkRequest = 0;

// 보관 중에도 조회는 된다. 발급·폐기만 보관을 해제한 뒤에 할 수 있다
async function loadInviteLink() {
	const request = ++latestInviteLinkRequest;
	const roomId = props.room.id;
	try {
		const link = await misskeyApi('chat/rooms/invite-link/show', { roomId });
		if (request !== latestInviteLinkRequest || roomClosed || props.room.id !== roomId) return;
		inviteLink.value = link;
		inviteLinkError.value = null;
	} catch (err) {
		if (request !== latestInviteLinkRequest || roomClosed || props.room.id !== roomId) return;
		inviteLinkError.value = chatInviteLinkManageErrorText(err);
	}
}

// 같은 화면에서 다른 그룹으로 바뀌면 이전 그룹의 링크를 보이지 않고 새로 읽는다
watch([() => props.room.id, isOwner], ([, owner]) => {
	++latestInviteLinkRequest;
	inviteLink.value = undefined;
	inviteLinkError.value = null;
	if (owner) void loadInviteLink();
}, { immediate: true });

function showInviteLinkError(err: unknown) {
	os.alert({ type: 'error', text: chatInviteLinkManageErrorText(err) });
}

async function createInviteLink() {
	inviteLinkBusy.value = true;
	const roomId = props.room.id;
	try {
		const created = await os.promiseDialog(misskeyApi('chat/rooms/invite-link/create', { roomId }), null, showInviteLinkError);
		if (roomClosed || props.room.id !== roomId) return;
		++latestInviteLinkRequest;
		inviteLink.value = created;
		inviteLinkError.value = null;
	} catch (err) {
		// 이미 있으면 서버의 기존 링크를 그대로 보인다. 그 링크를 바꾸거나 폐기하지 않는다
		if ((err as { code?: string } | null)?.code === 'INVITE_LINK_ALREADY_EXISTS' && props.room.id === roomId) await loadInviteLink();
	} finally {
		inviteLinkBusy.value = false;
	}
}

async function revokeInviteLink() {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.ts._chat._inviteLink.revokeConfirm,
	});
	if (canceled) return;

	inviteLinkBusy.value = true;
	const roomId = props.room.id;
	try {
		await os.promiseDialog(misskeyApi('chat/rooms/invite-link/revoke', { roomId }), null, showInviteLinkError);
		if (roomClosed || props.room.id !== roomId) return;
		++latestInviteLinkRequest;
		inviteLink.value = null;
	} catch (err) {
		if ((err as { code?: string } | null)?.code === 'NO_SUCH_INVITE_LINK' && props.room.id === roomId) await loadInviteLink();
	} finally {
		inviteLinkBusy.value = false;
	}
}

function copyInviteLink() {
	if (inviteLink.value == null) return;
	copyToClipboard(inviteLink.value.url, 'link');
}

async function readAll() {
	// 실패는 apiWithDialog가 대화상자로 알리므로 여기서는 따로 처리하지 않는다
	await os.apiWithDialog('chat/rooms/read', { roomId: props.room.id, readAll: true }, undefined, chatNotificationErrors).catch(() => null);
}
</script>

<style lang="scss" module>
.membership {
	display: flex;
}

.inviteLinkUrl {
	overflow-wrap: anywhere;
}

.membershipBody {
	flex: 1;
	min-width: 0;
	margin-right: 8px;

	&:hover {
		text-decoration: none;
	}
}
</style>
