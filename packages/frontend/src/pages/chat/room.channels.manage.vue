<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<section v-if="isOwner" class="_gaps">
	<strong>{{ i18n.ts._chat._channels.manage }}</strong>
	<template v-if="!room.hasChannels">
		<MkButton :disabled="!canManage || busy" @click="convert">{{ i18n.ts._chat._channels.convert }}</MkButton>
	</template>
	<template v-else>
		<MkLoading v-if="loading"/>
		<div v-for="(channel, index) in list" :key="channel.id" :data-chat-channel-id="channel.id" :class="$style.channel">
			<span :class="$style.name">#{{ channel.name }}</span>
			<div :class="$style.actions">
				<button class="_button" :disabled="!canManage || busy || index === 0" :aria-label="i18n.ts._chat._channels.moveUp" @click="move(index, -1)"><i class="ti ti-arrow-up" aria-hidden="true"></i></button>
				<button class="_button" :disabled="!canManage || busy || index === list.length - 1" :aria-label="i18n.ts._chat._channels.moveDown" @click="move(index, 1)"><i class="ti ti-arrow-down" aria-hidden="true"></i></button>
				<button class="_button" :disabled="!canManage || busy" :aria-label="i18n.ts.rename" @click="rename(channel)"><i class="ti ti-pencil" aria-hidden="true"></i></button>
				<button class="_button" :disabled="!canManage || busy || list.length <= 1" :aria-label="i18n.ts.delete" :title="list.length <= 1 ? i18n.ts._chat._channels.lastChannel : undefined" @click="remove(channel)"><i class="ti ti-trash" aria-hidden="true"></i></button>
			</div>
		</div>
		<MkButton :disabled="!canManage || busy || loading || list.length >= 128" @click="create"><i class="ti ti-plus" aria-hidden="true"></i> {{ i18n.ts._chat._channels.create }}</MkButton>
		<MkInfo v-if="list.length >= 128">{{ i18n.ts._chat._channels.limit }}</MkInfo>
	</template>
</section>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type * as Misskey from 'cherrypick-js';
import { chatErrorText } from './chat-errors.js';
import { ensureSignin } from '@/i.js';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';

const props = defineProps<{ room: Misskey.entities.ChatRoom; channels?: Misskey.entities.ChatRoomChannel[] }>();
const emit = defineEmits<{
	(ev: 'updated', room: Misskey.entities.ChatRoom): void;
	(ev: 'channelsUpdated'): void;
}>();
const $i = ensureSignin();
const isOwner = computed(() => props.room.ownerId === $i.id);
const canManage = computed(() => isOwner.value && !props.room.isArchived && $i.policies.chatAvailability === 'available');
const list = ref<Misskey.entities.ChatRoomChannel[]>([]);
const busy = ref(false);
const loading = ref(false);
let version = 0;
let closed = false;
onBeforeUnmount(() => { closed = true; version++; });
watch(() => [props.room.id, props.room.hasChannels, props.channels] as const, async () => {
	const request = ++version;
	if (props.channels != null) { list.value = props.channels; return; }
	if (!props.room.hasChannels || !isOwner.value) return;
	loading.value = true;
	try {
		const channels = await misskeyApi('chat/rooms/channels/list', { roomId: props.room.id });
		if (request === version) list.value = channels;
	} catch (err) {
		if (request === version) os.alert({ type: 'error', text: chatErrorText(err) });
	} finally {
		if (request === version) loading.value = false;
	}
}, { immediate: true });

async function change(operation: () => Promise<unknown>) {
	if (!canManage.value || busy.value || closed) return;
	busy.value = true;
	try {
		await operation();
		if (!closed) emit('channelsUpdated');
	} catch (err) {
		if (!closed) os.alert({ type: 'error', text: chatErrorText(err) });
	} finally {
		busy.value = false;
	}
}

async function convert() {
	if (!canManage.value || busy.value) return;
	const target = props.room.id;
	const { canceled } = await os.confirm({ type: 'warning', text: `${i18n.ts._chat._channels.convertHistory}\n${i18n.ts._chat._channels.convertPermanent}` });
	if (canceled || props.room.id !== target) return;
	await change(async () => {
		const room = await misskeyApi('chat/rooms/convert-to-channels', { roomId: target });
		if (!closed && props.room.id === target) emit('updated', room);
	});
}

async function inputName(defaultValue = ''): Promise<string | null> {
	const { canceled, result } = await os.inputText({ title: i18n.ts._chat._channels.name, default: defaultValue });
	if (canceled) return null;
	const name = result.trim();
	if (name.length === 0 || Array.from(name).length > 128) {
		os.alert({ type: 'error', text: i18n.ts._chat._channels.nameLimit });
		return null;
	}
	return name;
}

async function create() {
	if (!canManage.value || busy.value || list.value.length >= 128) return;
	const target = props.room.id;
	const name = await inputName();
	if (name == null || props.room.id !== target) return;
	await change(() => misskeyApi('chat/rooms/channels/create', { roomId: target, name }));
}

async function rename(channel: Misskey.entities.ChatRoomChannel) {
	if (!canManage.value || busy.value) return;
	const name = await inputName(channel.name);
	if (name == null || props.room.id !== channel.roomId) return;
	await change(() => misskeyApi('chat/rooms/channels/update', { channelId: channel.id, name }));
}

async function move(index: number, offset: number) {
	if (index + offset < 0 || index + offset >= list.value.length) return;
	const ids = list.value.map(channel => channel.id);
	[ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
	await change(() => misskeyApi('chat/rooms/channels/reorder', { roomId: props.room.id, channelIds: ids }));
}

async function remove(channel: Misskey.entities.ChatRoomChannel) {
	if (!canManage.value || busy.value || list.value.length <= 1) return;
	const warning = props.room.legacyChannelId === channel.id ? `\n${i18n.ts._chat._channels.legacyDeleteWarning}` : '';
	const { canceled } = await os.confirm({ type: 'warning', text: i18n.tsx._chat._channels.deleteConfirm({ name: channel.name }) + warning });
	if (canceled || props.room.id !== channel.roomId || list.value.length <= 1) return;
	await change(() => misskeyApi('chat/rooms/channels/delete', { channelId: channel.id }));
}
</script>

<style lang="scss" module>
.channel {
	display: flex;
	align-items: center;
	gap: 8px;
	padding-block: 8px;
	border-bottom: 1px solid var(--MI_THEME-divider);
}

.name {
	flex: 1;
	min-width: 0;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.actions {
	display: flex;
	flex-shrink: 0;

	button {
		padding: 10px;
	}
}
</style>
