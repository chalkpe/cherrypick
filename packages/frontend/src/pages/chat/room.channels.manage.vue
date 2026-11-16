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
		<!-- 섹션 없는 채널 목록 아래에 섹션들을 바깥 목록으로 두고, 각 목록의 채널을 안쪽에서 끈다. -->
		<MkDraggable
			v-if="list.length || sections.length"
			:modelValue="ungroupedChannels"
			direction="vertical"
			manualDragStart
			canNest
			strictGroup
			:group="channelDragGroup"
			@update:modelValue="items => onChannelDrag('ungrouped', items)"
		>
			<template #default="{ item: channel, index: channelIndex, dragStart: channelDragStart }">
				<div :data-chat-channel-id="channel.id" :class="$style.channel">
					<button v-if="!narrow" class="_button" :class="$style.handle" :disabled="!canManage || busy" :draggable="canManage && !busy && !narrow" tabindex="-1" :aria-label="i18n.ts.dragToReorder" @dragstart.stop="channelDragStart"><i class="ti ti-grip-vertical" aria-hidden="true"></i></button>
					<span :class="$style.name">#{{ channel.name }}</span>
					<div :class="$style.actions">
						<button class="_button" :disabled="!canManage || busy || channelIndex === 0" :aria-label="i18n.ts._chat._channels.moveUp" @click="moveChannel(channel, -1)"><i class="ti ti-arrow-up" aria-hidden="true"></i></button>
						<button class="_button" :disabled="!canManage || busy || channelIndex === ungroupedChannels.length - 1" :aria-label="i18n.ts._chat._channels.moveDown" @click="moveChannel(channel, 1)"><i class="ti ti-arrow-down" aria-hidden="true"></i></button>
						<button v-if="sections.length" class="_button" :disabled="!canManage || busy" :aria-label="i18n.ts._chat._channels.moveSection" @click="moveChannelToSection(channel)"><i class="ti ti-folder" aria-hidden="true"></i></button>
						<button class="_button" :disabled="!canManage || busy" :aria-label="i18n.ts.rename" @click="rename(channel)"><i class="ti ti-pencil" aria-hidden="true"></i></button>
						<button class="_button" :disabled="!canManage || busy || list.length <= 1" :aria-label="i18n.ts.delete" :title="list.length <= 1 ? i18n.ts._chat._channels.lastChannel : undefined" @click="remove(channel)"><i class="ti ti-trash" aria-hidden="true"></i></button>
					</div>
				</div>
			</template>
		</MkDraggable>
		<MkDraggable
			v-if="sectionGroups.length"
			:modelValue="sectionGroups"
			direction="vertical"
			manualDragStart
			canNest
			strictGroup
			:group="sectionDragGroup"
			@update:modelValue="onSectionDrag"
		>
			<template #default="{ item: group, index, dragStart }">
				<div :class="$style.sectionBlock">
					<div :class="$style.section" :data-chat-manage-section-id="group.section.id">
						<button v-if="!narrow" class="_button" :class="$style.handle" :disabled="!canManage || busy" :draggable="canManage && !busy && !narrow" tabindex="-1" :aria-label="i18n.ts.dragToReorder" @dragstart.stop="dragStart"><i class="ti ti-grip-vertical" aria-hidden="true"></i></button>
						<span :class="$style.name">{{ group.section.name }}</span>
						<div :class="$style.actions">
							<button class="_button" :disabled="!canManage || busy || index === 0" :aria-label="i18n.ts._chat._channels.moveUp" @click="moveSection(group.section, -1)"><i class="ti ti-arrow-up" aria-hidden="true"></i></button>
							<button class="_button" :disabled="!canManage || busy || index === sectionGroups.length - 1" :aria-label="i18n.ts._chat._channels.moveDown" @click="moveSection(group.section, 1)"><i class="ti ti-arrow-down" aria-hidden="true"></i></button>
							<button class="_button" :disabled="!canManage || busy || list.length >= 128" :aria-label="i18n.ts._chat._channels.createChannelInSection" @click="createChannel(group.section.id)"><i class="ti ti-plus" aria-hidden="true"></i></button>
							<button class="_button" :disabled="!canManage || busy" :aria-label="i18n.ts.rename" @click="renameSection(group.section)"><i class="ti ti-pencil" aria-hidden="true"></i></button>
							<button class="_button" :disabled="!canManage || busy" :aria-label="i18n.ts.delete" @click="removeSection(group.section)"><i class="ti ti-trash" aria-hidden="true"></i></button>
						</div>
					</div>
					<MkDraggable
						:modelValue="group.channels"
						direction="vertical"
						manualDragStart
						canNest
						strictGroup
						:group="channelDragGroup"
						@update:modelValue="items => onChannelDrag(group.section.id, items)"
					>
						<template #default="{ item: channel, index: channelIndex, dragStart: channelDragStart }">
							<div :data-chat-channel-id="channel.id" :class="[$style.channel, $style.sectionChannel]">
								<button v-if="!narrow" class="_button" :class="$style.handle" :disabled="!canManage || busy" :draggable="canManage && !busy && !narrow" tabindex="-1" :aria-label="i18n.ts.dragToReorder" @dragstart.stop="channelDragStart"><i class="ti ti-grip-vertical" aria-hidden="true"></i></button>
								<span :class="$style.name">#{{ channel.name }}</span>
								<div :class="$style.actions">
									<button class="_button" :disabled="!canManage || busy || channelIndex === 0" :aria-label="i18n.ts._chat._channels.moveUp" @click="moveChannel(channel, -1)"><i class="ti ti-arrow-up" aria-hidden="true"></i></button>
									<button class="_button" :disabled="!canManage || busy || channelIndex === group.channels.length - 1" :aria-label="i18n.ts._chat._channels.moveDown" @click="moveChannel(channel, 1)"><i class="ti ti-arrow-down" aria-hidden="true"></i></button>
									<button class="_button" :disabled="!canManage || busy" :aria-label="i18n.ts._chat._channels.moveSection" @click="moveChannelToSection(channel)"><i class="ti ti-folder" aria-hidden="true"></i></button>
									<button class="_button" :disabled="!canManage || busy" :aria-label="i18n.ts.rename" @click="rename(channel)"><i class="ti ti-pencil" aria-hidden="true"></i></button>
									<button class="_button" :disabled="!canManage || busy || list.length <= 1" :aria-label="i18n.ts.delete" :title="list.length <= 1 ? i18n.ts._chat._channels.lastChannel : undefined" @click="remove(channel)"><i class="ti ti-trash" aria-hidden="true"></i></button>
								</div>
							</div>
						</template>
					</MkDraggable>
				</div>
			</template>
		</MkDraggable>
		<div class="_buttons">
			<MkButton :disabled="!canManage || busy || loading || list.length >= 128" @click="createChannel()"><i class="ti ti-plus" aria-hidden="true"></i> {{ i18n.ts._chat._channels.create }}</MkButton>
			<MkButton :disabled="!canManage || busy || loading || sections.length >= 128" @click="createSection"><i class="ti ti-plus" aria-hidden="true"></i> {{ i18n.ts._chat._channels.createSection }}</MkButton>
		</div>
		<MkInfo v-if="list.length >= 128">{{ i18n.ts._chat._channels.limit }}</MkInfo>
		<MkInfo v-if="sections.length >= 128">{{ i18n.ts._chat._channels.sectionLimit }}</MkInfo>
	</template>
</section>
</template>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type * as Misskey from 'cherrypick-js';
import { chatErrorText } from './chat-errors.js';
import { arrangePayload, flattenArrangement, groupChannelsBySection } from './chat-channel-sections.js';
import type { ChannelArrangement, ChatChannel, ChatChannelSection } from './chat-channel-sections.js';
import { ensureSignin } from '@/i.js';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { genId } from '@/utility/id.js';
import * as os from '@/os.js';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkDraggable from '@/components/MkDraggable.vue';

type ManageGroup = { id: string; section: ChatChannelSection | null; channels: ChatChannel[] };
type SectionManageGroup = ManageGroup & { section: ChatChannelSection };

const props = defineProps<{ room: Misskey.entities.ChatRoom; channels?: Misskey.entities.ChatRoomChannel[]; narrow?: boolean }>();
const emit = defineEmits<{
	(ev: 'updated', room: Misskey.entities.ChatRoom): void;
	(ev: 'channelsUpdated'): void;
}>();
const $i = ensureSignin();
const isOwner = computed(() => props.room.ownerId === $i.id);
const canManage = computed(() => isOwner.value && !props.room.isArchived && $i.policies.chatAvailability === 'available');
const list = ref<ChatChannel[]>([]);
const sections = ref<ChatChannelSection[]>([]);
const busy = ref(false);
const loading = ref(false);
const sectionDragGroup = genId();
const channelDragGroup = genId();
let version = 0;
let sectionVersion = 0;
let closed = false;
onBeforeUnmount(() => { closed = true; version++; sectionVersion++; });

const manageGroups = computed<ManageGroup[]>(() => {
	const { ungrouped, sectionGroups } = groupChannelsBySection(list.value, sections.value);
	return [{ id: 'ungrouped', section: null, channels: ungrouped }, ...sectionGroups.map(group => ({ id: group.section.id, section: group.section, channels: group.channels }))];
});

const ungroupedChannels = computed(() => manageGroups.value[0].channels);
const sectionGroups = computed(() => manageGroups.value.slice(1) as SectionManageGroup[]);

async function loadSections() {
	const request = ++sectionVersion;
	if (!props.room.hasChannels || !isOwner.value) { sections.value = []; return; }
	const target = props.room.id;
	try {
		const fetched = await misskeyApi('chat/rooms/sections/list', { roomId: target });
		if (request === sectionVersion && !closed && props.room.id === target) sections.value = fetched;
	} catch {
		// 목록을 다시 읽을 때까지 지금 섹션을 그대로 보인다.
	}
}

watch(() => [props.room.id, props.room.hasChannels, props.channels] as const, async () => {
	const request = ++version;
	void loadSections();
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
		if (!closed) {
			emit('channelsUpdated');
			void loadSections();
		}
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

async function inputSectionName(defaultValue = ''): Promise<string | null> {
	const { canceled, result } = await os.inputText({ title: i18n.ts._chat._channels.sectionName, default: defaultValue });
	if (canceled) return null;
	const name = result.trim();
	if (name.length === 0 || Array.from(name).length > 128) {
		os.alert({ type: 'error', text: i18n.ts._chat._channels.sectionNameLimit });
		return null;
	}
	return name;
}

async function createChannel(sectionId?: string) {
	if (!canManage.value || busy.value || list.value.length >= 128) return;
	const target = props.room.id;
	const name = await inputName();
	if (name == null || props.room.id !== target) return;
	await change(() => misskeyApi('chat/rooms/channels/create', { roomId: target, name, ...(sectionId != null ? { sectionId } : {}) }));
}

async function createSection() {
	if (!canManage.value || busy.value || sections.value.length >= 128) return;
	const target = props.room.id;
	const name = await inputSectionName();
	if (name == null || props.room.id !== target) return;
	await change(() => misskeyApi('chat/rooms/sections/create', { roomId: target, name }));
}

async function rename(channel: ChatChannel) {
	if (!canManage.value || busy.value) return;
	const name = await inputName(channel.name);
	if (name == null || props.room.id !== channel.roomId) return;
	await change(() => misskeyApi('chat/rooms/channels/update', { channelId: channel.id, name }));
}

async function renameSection(section: ChatChannelSection) {
	if (!canManage.value || busy.value) return;
	const name = await inputSectionName(section.name);
	if (name == null || props.room.id !== section.roomId) return;
	await change(() => misskeyApi('chat/rooms/sections/update', { sectionId: section.id, name }));
}

function arrangementOf(groups: ManageGroup[]): ChannelArrangement {
	return {
		ungrouped: groups.find(group => group.section == null)?.channels ?? [],
		sectionGroups: groups.filter(group => group.section != null).map(group => ({ section: group.section!, channels: group.channels })),
	};
}

async function submitArrangement(arrangement: ChannelArrangement, optimistic: boolean) {
	if (!canManage.value || busy.value || closed) return;
	if (sections.value.length === 0) {
		// 섹션이 없으면 PR49와 같은 평평한 순서 바꾸기다.
		if (optimistic) {
			await reorderChannels(arrangement.ungrouped);
		} else {
			const ids = arrangement.ungrouped.map(channel => channel.id);
			await change(() => misskeyApi('chat/rooms/channels/reorder', { roomId: props.room.id, channelIds: ids }));
		}
		return;
	}
	const target = props.room.id;
	const previousList = list.value;
	const previousSections = sections.value;
	if (optimistic) {
		list.value = flattenArrangement(arrangement);
		sections.value = arrangement.sectionGroups.map(group => group.section);
	}
	busy.value = true;
	try {
		await misskeyApi('chat/rooms/channels/arrange', arrangePayload(target, arrangement));
		if (!closed) {
			emit('channelsUpdated');
			void loadSections();
		}
	} catch (err) {
		if (!closed) {
			if (optimistic) {
				list.value = previousList;
				sections.value = previousSections;
			}
			os.alert({ type: 'error', text: chatErrorText(err) });
			emit('channelsUpdated');
		}
	} finally {
		busy.value = false;
	}
}

async function moveChannel(channel: ChatChannel, offset: number) {
	if (!canManage.value || busy.value) return;
	const groups = manageGroups.value.map(group => ({ ...group, channels: [...group.channels] }));
	const group = groups.find(entry => entry.channels.some(item => item.id === channel.id));
	if (group == null) return;
	const index = group.channels.findIndex(item => item.id === channel.id);
	if (index + offset < 0 || index + offset >= group.channels.length) return;
	[group.channels[index], group.channels[index + offset]] = [group.channels[index + offset], group.channels[index]];
	await submitArrangement(arrangementOf(groups), false);
}

async function moveSection(section: ChatChannelSection, offset: number) {
	if (!canManage.value || busy.value) return;
	const groups = manageGroups.value.map(group => ({ ...group, channels: [...group.channels] }));
	const sectionEntries = groups.filter(group => group.section != null);
	const index = sectionEntries.findIndex(group => group.section!.id === section.id);
	if (index < 0 || index + offset < 0 || index + offset >= sectionEntries.length) return;
	const reordered = [...sectionEntries];
	[reordered[index], reordered[index + offset]] = [reordered[index + offset], reordered[index]];
	await submitArrangement(arrangementOf([groups[0], ...reordered]), false);
}

async function moveChannelToSection(channel: ChatChannel) {
	if (!canManage.value || busy.value) return;
	const { canceled, result } = await os.select({
		title: i18n.ts._chat._channels.moveSection,
		items: [{ value: '', label: i18n.ts._chat._channels.noSection }, ...sections.value.map(section => ({ value: section.id, label: section.name }))],
		default: channel.sectionId ?? '',
	});
	if (canceled || props.room.id !== channel.roomId) return;
	const destination = result ?? '';
	if (destination === (channel.sectionId ?? '')) return;
	const groups = manageGroups.value.map(group => ({ ...group, channels: group.channels.filter(item => item.id !== channel.id) }));
	const targetGroup = destination === '' ? groups.find(group => group.section == null) : groups.find(group => group.id === destination);
	if (targetGroup == null) return;
	targetGroup.channels = [...targetGroup.channels, channel];
	await submitArrangement(arrangementOf(groups), false);
}

// 끌기 한 번에 두 묶음의 채널 목록이 각각 바뀐다. 한 번의 arrange로 묶어 보낸다.
let pendingChannels: Map<string, ChatChannel[]> | null = null;
let pendingGroupOrder: string[] | null = null;
let flushScheduled = false;

function onChannelDrag(groupId: string, items: ChatChannel[]) {
	(pendingChannels ??= new Map()).set(groupId, items);
	scheduleFlush();
}

function onSectionDrag(entries: ManageGroup[]) {
	pendingGroupOrder = ['ungrouped', ...entries.map(entry => entry.id)];
	scheduleFlush();
}

function scheduleFlush() {
	if (flushScheduled) return;
	flushScheduled = true;
	void nextTick(() => {
		flushScheduled = false;
		void flushManageArrange();
	});
}

async function flushManageArrange() {
	const changedChannels = pendingChannels;
	const groupOrder = pendingGroupOrder;
	pendingChannels = null;
	pendingGroupOrder = null;
	if (!canManage.value || busy.value || closed || changedChannels == null && groupOrder == null) return;
	let groups = manageGroups.value.map(group => ({ ...group, channels: changedChannels?.has(group.id) ? changedChannels.get(group.id)! : group.channels }));
	if (groupOrder != null) {
		groups = groupOrder.map(id => groups.find(group => group.id === id)).filter((group): group is ManageGroup => group != null);
	}
	await submitArrangement(arrangementOf(groups), true);
}

async function reorderChannels(newList: ChatChannel[]) {
	if (!canManage.value || busy.value || closed) return;
	const target = props.room.id;
	const previous = list.value;
	const ids = newList.map(channel => channel.id);
	list.value = newList;
	busy.value = true;
	try {
		await misskeyApi('chat/rooms/channels/reorder', { roomId: target, channelIds: ids });
		if (!closed) emit('channelsUpdated');
	} catch (err) {
		if (!closed) {
			list.value = previous;
			os.alert({ type: 'error', text: chatErrorText(err) });
			emit('channelsUpdated');
		}
	} finally {
		busy.value = false;
	}
}

async function remove(channel: ChatChannel) {
	if (!canManage.value || busy.value || list.value.length <= 1) return;
	const warning = props.room.legacyChannelId === channel.id ? `\n${i18n.ts._chat._channels.legacyDeleteWarning}` : '';
	const { canceled } = await os.confirm({ type: 'warning', text: i18n.tsx._chat._channels.deleteConfirm({ name: channel.name }) + warning });
	if (canceled || props.room.id !== channel.roomId || list.value.length <= 1) return;
	await change(() => misskeyApi('chat/rooms/channels/delete', { channelId: channel.id }));
}

async function removeSection(section: ChatChannelSection) {
	if (!canManage.value || busy.value) return;
	const { canceled } = await os.confirm({ type: 'warning', text: i18n.tsx._chat._channels.deleteSectionConfirm({ name: section.name }) });
	if (canceled || props.room.id !== section.roomId) return;
	await change(() => misskeyApi('chat/rooms/sections/delete', { sectionId: section.id }));
}
</script>

<style lang="scss" module>
// 바깥 끌기 영역(위·아래 30px)이 안쪽 채널 행을 덮지 않게 섹션 아래에 같은 높이의 여백을 둔다.
.sectionBlock {
	padding-bottom: 30px;
}

.sectionChannel {
	padding-left: 12px;
}

.section {
	display: flex;
	align-items: center;
	gap: 8px;
	padding-block: 8px;
	border-bottom: 1px solid var(--MI_THEME-divider);
	font-weight: bold;
}

.channel {
	display: flex;
	align-items: center;
	gap: 8px;
	padding-block: 8px;
	border-bottom: 1px solid var(--MI_THEME-divider);
}

.handle {
	flex-shrink: 0;
	padding: 10px;
	cursor: move;
	opacity: 0.5;

	&:disabled {
		cursor: default;
		opacity: 0.3;
	}
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
