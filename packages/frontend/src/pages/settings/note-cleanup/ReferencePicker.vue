<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<div class="_gaps_s">
	<MkInput v-model="query" type="search"><template #label>{{ i18n.ts._noteCleanup.searchReferences }}</template></MkInput>
	<MkButton :disabled="loading" @click="load()">{{ i18n.ts.search }}</MkButton>
	<MkInfo v-if="failed" warn>{{ i18n.ts._noteCleanup.referenceError }}</MkInfo>
	<div v-for="id in modelValue" :key="id" class="_gaps_s" :class="$style.item">
		<div>{{ known.get(id)?.name ?? i18n.ts._noteCleanup.missingReference }}</div>
		<div v-if="known.get(id)?.description || known.get(id)?.visibility">{{ known.get(id)?.description }} {{ known.get(id)?.visibility }}</div>
		<MkA :to="`${kind === 'clip' ? '/clips/' : '/channels/'}${id}`">{{ i18n.ts.details }}</MkA>
		<MkButton small @click="emit('update:modelValue', modelValue.filter(v => v !== id))">{{ i18n.ts.remove }}</MkButton>
	</div>
	<div v-for="item in displayed" :key="item.id" :class="$style.item">
		<label><input type="checkbox" :checked="modelValue.includes(item.id)" :disabled="!modelValue.includes(item.id) && modelValue.length >= 32" @change="toggle(item.id)"> {{ item.name }}</label>
		<div v-if="item.description || item.visibility">{{ item.description }} {{ item.visibility }}</div>
	</div>
	<MkButton v-if="hasMore" :disabled="loading" @click="load(true)">{{ i18n.ts._noteCleanup.moreReferences }}</MkButton>
</div>
</template>
<script lang="ts" setup>
import { computed, onMounted, ref, shallowRef } from 'vue';
import MkInput from '@/components/MkInput.vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { cleanupApi } from '@/utility/note-cleanup-api.js';
import { $i } from '@/i.js';
const props = defineProps<{ kind: 'clip' | 'channel'; modelValue: string[] }>();
const emit = defineEmits<{ (ev: 'update:modelValue', value: string[]): void }>();
type Reference = { id: string; name: string; description: string | null; visibility: string };
const known = shallowRef(new Map<string, Reference>());
const results = ref<Reference[]>([]);
const query = ref('');
const loading = ref(false);
const failed = ref(false);
const hasMore = ref(false);
let cursor: string | undefined;
let previousQuery = '';
const displayed = computed(() => props.kind === 'clip' ? results.value.filter(item => item.name.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())) : results.value);

function toggle(id: string) {
	emit('update:modelValue', props.modelValue.includes(id) ? props.modelValue.filter(v => v !== id) : [...props.modelValue, id]);
}

async function load(next = false) {
	if (loading.value) return;
	loading.value = true;
	failed.value = false;
	try {
		if (query.value !== previousQuery && props.kind === 'channel') next = false;
		previousQuery = query.value;
		if (!next) cursor = undefined;
		let mapped: Reference[];
		if (props.kind === 'clip') {
			const values = await cleanupApi.clips(cursor);
			mapped = values.map(item => ({ id: item.id, name: item.name, description: item.description, visibility: item.isPublic ? i18n.ts.public : i18n.ts.private }));
		} else {
			const values = await cleanupApi.channels(query.value, cursor);
			mapped = values.map(item => ({ id: item.id, name: item.name, description: item.description, visibility: '' }));
		}
		hasMore.value = mapped.length === 100;
		cursor = mapped.at(-1)?.id;
		results.value = next ? [...results.value, ...mapped.filter(item => !results.value.some(existing => existing.id === item.id))] : mapped;
		const nextKnown = new Map(known.value);
		for (const item of results.value) nextKnown.set(item.id, item);
		// 저장된 ID는 이름으로 대체하지 않고, 현재 권한으로 각각 확인한다.
		for (const id of props.modelValue) {
			if (nextKnown.has(id)) continue;
			try {
				if (props.kind === 'clip') {
					const item = await misskeyApi('clips/show', { clipId: id });
					if (item.userId === $i?.id) nextKnown.set(id, { id, name: item.name, description: item.description, visibility: item.isPublic ? i18n.ts.public : i18n.ts.private });
				} else {
					const item = await misskeyApi('channels/show', { channelId: id });
					nextKnown.set(id, { id, name: item.name, description: item.description, visibility: '' });
				}
			} catch { /* 사라진 참조도 선택 목록에 ID로 남긴다. */ }
		}
		known.value = nextKnown;
	} catch {
		failed.value = true;
	} finally { loading.value = false; }
}

onMounted(() => load());
</script>
<style lang="scss" module>
.item { padding: 12px; border: 1px solid var(--MI_THEME-divider); border-radius: var(--MI-radius); overflow-wrap: anywhere; }
</style>
