<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
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

	<hr>

	<MkButton v-if="isOwner" @click="setArchived(!room.isArchived)"><i :class="room.isArchived ? 'ti ti-archive-off' : 'ti ti-archive'"></i> {{ room.isArchived ? i18n.ts.unarchive : i18n.ts.archive }}</MkButton>

	<MkButton v-if="isOwner || ($i.isAdmin || $i.isModerator)" danger @click="del">{{ i18n.ts._chat.deleteRoom }}</MkButton>

	<MkSelect :modelValue="notificationLevel" :items="groupNotificationItems" :disabled="savingNotification" @update:modelValue="setNotificationLevel">
		<template #label>{{ i18n.ts.notificationSetting }}</template>
	</MkSelect>
	<template v-if="room.hasChannels">
		<MkSelect v-for="channel in channels" :key="channel.id" :modelValue="channelLevels[channel.id] ?? 'inherit'" :items="channelNotificationItems" :disabled="savingNotification" @update:modelValue="level => setChannelNotification(channel.id, level)">
			<template #label>#{{ channel.name }}</template>
		</MkSelect>
	</template>
	<MkButton @click="readAll"><i class="ti ti-checks"></i> {{ i18n.ts._chat.readAllRoom }}</MkButton>
</div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import * as Misskey from 'cherrypick-js';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { ensureSignin } from '@/i.js';
import MkInput from '@/components/MkInput.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import MkSelect from '@/components/MkSelect.vue';
import type { MkSelectItem } from '@/components/MkSelect.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import { useRouter } from '@/router.js';
import { chatNotificationErrors, chatRoomDeleteErrors, chatRoomUpdateErrors } from './chat-errors.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const router = useRouter();
const $i = ensureSignin();

const props = defineProps<{
	room: Misskey.entities.ChatRoom;
}>();

const isOwner = computed(() => {
	return props.room.ownerId === $i.id;
});

const name_ = ref(props.room.name);
const description_ = ref(props.room.description);

const emit = defineEmits<{
	(ev: 'updated', room: Misskey.entities.ChatRoom): void;
	(ev: 'deleting', deleting: boolean): void;
}>();

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
const channels = ref<Misskey.entities.ChatRoomChannel[]>([]);
const channelLevels = ref<Record<string, NotificationLevel | 'inherit'>>({});

onMounted(async () => {
	if (!props.room.hasChannels) return;
	try {
		const [listed, settings] = await Promise.all([
			misskeyApi('chat/rooms/channels/list', { roomId: props.room.id }),
			misskeyApi('chat/rooms/notifications', { roomId: props.room.id }),
		]);
		channels.value = listed;
		channelLevels.value = Object.fromEntries(settings.channelOverrides.map(setting => [setting.channelId, setting.level]));
	} catch {
		await os.alert({ type: 'error', text: i18n.ts._chat.roomUnavailable });
	}
});

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

async function readAll() {
	// 失敗したときは apiWithDialog がダイアログで知らせるので、ここでは何もしない
	await os.apiWithDialog('chat/rooms/read', { roomId: props.room.id, readAll: true }, undefined, chatNotificationErrors).catch(() => null);
}
</script>

<style lang="scss" module>
.membership {
	display: flex;
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
