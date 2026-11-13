<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<MkInput
		v-model="searchQuery"
		:placeholder="i18n.ts._chat.searchMessages"
		type="search"
		@enter="search()"
	>
		<template #prefix><i class="ti ti-search"></i></template>
	</MkInput>

	<MkSelect v-if="channels?.length" v-model="channelId" :items="channelItems">
		<template #label>{{ i18n.ts._chat._channels.channels }}</template>
	</MkSelect>

	<MkButton primary rounded @click="search">{{ i18n.ts.search }}</MkButton>

	<MkFoldableSection v-if="searched">
		<template #header>{{ i18n.ts.searchResult }}</template>

		<div v-if="searchResults.length > 0" class="_gaps_s">
			<div v-for="message in searchResults" :key="message.id" :class="$style.searchResultItem">
				<XMessage :message="message" :channels="channels" :user="message.fromUser" :isSearchResult="true"/>
			</div>
		</div>
		<MkResult v-else type="notFound"/>
	</MkFoldableSection>
</div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import XMessage from './XMessage.vue';
import MkSelect from '@/components/MkSelect.vue';
import * as os from '@/os.js';
import { chatErrorText } from './chat-errors.js';
import MkButton from '@/components/MkButton.vue';
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
const channelItems = computed(() => [{ value: '', label: i18n.ts._chat._channels.all }, ...(props.channels ?? []).map((channel, index) => ({ value: channel.id, label: `#${channel.name} · ${index + 1}`, caption: channel.id }))]);
const searchQuery = ref('');
let version = 0;
onBeforeUnmount(() => { version++; });
watch(() => props.channels, channels => {
	if (channelId.value && !channels?.some(channel => channel.id === channelId.value)) { version++; channelId.value = ''; searched.value = false; }
});
watch(() => [props.roomId, props.userId], () => { version++; searchResults.value = []; searched.value = false; channelId.value = ''; });
const searched = ref(false);
const searchResults = ref<Misskey.entities.ChatMessage[]>([]);

async function search() {
	const request = ++version;
	try {
		const res = await misskeyApi('chat/messages/search', {
			query: searchQuery.value,
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
.searchResultItem {
	padding: 12px;
	border: solid 1px var(--MI_THEME-divider);
	border-radius: 12px;
}
</style>
