<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<MkInput
		ref="searchQueryEl"
		v-model="searchQuery"
		:placeholder="i18n.ts._chat.searchMessages"
		large
		autofocus
		type="search"
		@enter.prevent="search"
	>
		<template #prefix><i class="ti ti-search"></i></template>
		<template v-if="searchQuery !== ''" #suffix>
			<button type="button" :class="$style.searchInputButton" :aria-label="i18n.ts.clear" @click="searchQuery = ''; searchQueryEl?.focus();"><i class="ti ti-x"></i></button>
			<button type="button" :class="$style.searchInputButton" :aria-label="i18n.ts.search" :disabled="!searchQuery.trim()" @click="search"><i class="ti ti-search"></i></button>
		</template>
	</MkInput>

	<MkFoldableSection v-if="channels?.length" expanded>
		<template #header>{{ i18n.ts.options }}</template>
		<MkSelect v-model="channelId" :items="channelItems" :class="$style.channelSelect" small>
			<template #label>{{ i18n.ts._chat._channels.channels }}</template>
		</MkSelect>
	</MkFoldableSection>

	<MkFoldableSection v-if="searched">
		<template #header>{{ i18n.ts.searchResult }}</template>

		<div v-if="searchResults.length > 0" class="_gaps_s">
			<div v-for="message in searchResults" :key="message.id" :class="$style.searchResultItem">
				<XMessage :message="message" :channels="channels" :user="message.fromUser" :isSearchResult="true"/>
			</div>
		</div>
		<MkResult v-else type="empty"/>
	</MkFoldableSection>
</div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import XMessage from './XMessage.vue';
import { groupChannelsBySection } from './chat-channel-sections.js';
import MkSelect from '@/components/MkSelect.vue';
import type { MkSelectItem } from '@/components/MkSelect.vue';
import * as os from '@/os.js';
import { chatErrorText } from './chat-errors.js';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import MkInput from '@/components/MkInput.vue';
import MkFoldableSection from '@/components/MkFoldableSection.vue';

const props = defineProps<{
	userId?: string;
	roomId?: string;
	channels?: Misskey.entities.ChatRoomChannel[];
}>();

const channelId = ref('');
const sections = ref<Misskey.entities.ChatRoomChannelSection[]>([]);
let sectionRequest = 0;

// 섹션 묶음은 보여 주기 위한 것이다. 읽기에 실패하면 섹션 없이 평평하게 보인다.
watch([() => props.roomId, () => props.channels], async ([roomId, channels]) => {
	const request = ++sectionRequest;
	sections.value = [];
	if (roomId == null || channels == null || channels.length === 0) return;
	try {
		const fetched = await misskeyApi('chat/rooms/sections/list', { roomId });
		if (request === sectionRequest) sections.value = fetched;
	} catch {
		// 평평한 목록으로 대체한다.
	}
}, { immediate: true });

const channelItems = computed<MkSelectItem<string>[]>(() => {
	const channels = props.channels ?? [];
	const position = new Map(channels.map((channel, index) => [channel.id, index + 1]));
	const option = (channel: Misskey.entities.ChatRoomChannel) => ({ value: channel.id, label: `#${channel.name} · ${position.get(channel.id)}`, caption: channel.id });
	const { sectionGroups } = groupChannelsBySection(channels, sections.value);
	const groupedIds = new Set(sectionGroups.flatMap(group => group.channels.map(channel => channel.id)));
	// 섹션 목록을 읽지 못했거나 아직 읽는 중이면 섹션을 해석하지 못한 채널도 원래 순서대로 평평한 선택지에 남긴다.
	const flat = channels.filter(channel => !groupedIds.has(channel.id));
	const items: MkSelectItem<string>[] = [{ value: '', label: i18n.ts._chat._channels.all }, ...flat.map(option)];
	for (const group of sectionGroups) {
		items.push({ type: 'group', label: group.section.name, items: group.channels.map(option) });
	}
	return items;
});
const searchQuery = ref('');
const searchQueryEl = useTemplateRef('searchQueryEl');
let version = 0;
onBeforeUnmount(() => { version++; });
watch(() => props.channels, channels => {
	if (channelId.value && !channels?.some(channel => channel.id === channelId.value)) { version++; channelId.value = ''; searched.value = false; }
});
watch(() => [props.roomId, props.userId], () => { version++; searchResults.value = []; searched.value = false; channelId.value = ''; });
const searched = ref(false);
const searchResults = ref<Misskey.entities.ChatMessage[]>([]);

async function search() {
	const query = searchQuery.value.trim();
	if (!query) return;
	const request = ++version;
	try {
		const res = await misskeyApi('chat/messages/search', {
			query,
			roomId: props.roomId,
			userId: props.userId,
			...(channelId.value ? { channelId: channelId.value } : {}),
		});
		if (request !== version) return;
		searchResults.value = res;
		searched.value = true;
	} catch (err) {
		if (request === version) os.alert({ type: 'error', text: chatErrorText(err) });
	}
}

</script>

<style lang="scss" module>
.channelSelect :global([tabindex="-1"] > div:first-child) {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.searchInputButton {
	position: relative;
	z-index: 2;
	margin: 0 auto;
	border: none;
	background: none;
	color: inherit;
	font-size: 0.8em;
	cursor: pointer;
	pointer-events: auto;
	-webkit-tap-highlight-color: transparent;
}

.searchResultItem {
	padding: 12px;
	border: solid 1px var(--MI_THEME-divider);
	border-radius: 12px;
}
</style>
