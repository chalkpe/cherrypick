<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<SearchMarker :keywords="['note', 'cleanup', 'delete', 'keep', '노트', '정리']">
	<div class="_gaps_m">
		<SearchLabel><h2>{{ i18n.ts._noteCleanup.title }}</h2></SearchLabel>
		<SearchText>{{ i18n.ts._noteCleanup.intro }}</SearchText>
		<MkInfo>{{ i18n.ts._noteCleanup.broadProtection }}</MkInfo>
		<MkInfo v-if="blocked" warn role="alert">{{ i18n.ts._noteCleanup.blocked }}</MkInfo>
		<MkInfo v-if="failed" warn>{{ cleanupErrorMessage(failed) }}</MkInfo>
		<div v-if="status" role="status">{{ status }}</div>
		<MkButton :disabled="loading" @click="load()">{{ i18n.ts.reload }}</MkButton>
		<MkInfo v-if="loaded">{{ migrated ? i18n.ts._noteCleanup.migrated : i18n.ts._noteCleanup.defaults }}</MkInfo>
		<h3>{{ i18n.ts._noteCleanup.rules }}</h3>
		<div v-for="rule in rules" :key="rule.id" :class="$style.rule">
			<label v-if="rule.action === 'delete' && rule.enabled"><input type="checkbox" :checked="selected.includes(rule.id)" @change="toggle(rule.id)"> {{ i18n.ts._noteCleanup.request }}</label>
			<MkButton :primary="editingId === rule.id" @click="open(rule.id)">{{ cleanupRuleName(rule, i18n.ts._noteCleanup) }}</MkButton>
			<div>{{ rule.action === 'keep' ? i18n.ts._noteCleanup.keep : i18n.ts._noteCleanup.delete }} · {{ rule.enabled ? i18n.ts._noteCleanup.enabled : i18n.ts._noteCleanup.disabled }}</div>
			<!-- 신규 계정의 기본 규칙도 구 API 연결용 legacy 값을 가지므로 실제로 이관된 계정에서만 표시한다 -->
			<div v-if="migrated && rule.legacy">{{ i18n.ts._noteCleanup.legacy }}</div>
			<div v-if="rule.lastError" role="status">{{ cleanupErrorMessage(rule.lastError.code, rule.action) }}</div>
		</div>
		<MkButton :disabled="!loaded || rules.filter(rule => !rule.legacy).length >= 32" @click="open(undefined)">{{ i18n.ts._noteCleanup.newRule }}</MkButton>
		<template v-if="selected.length">
			<MkInfo>{{ i18n.ts._noteCleanup.queueHelp }}</MkInfo>
			<MkButton :disabled="loading || blocked" @click="requestSelected">{{ i18n.ts._noteCleanup.request }} ({{ selected.length }})</MkButton>
			<Preview :ruleIds="selected" :revision="previewRevision" :disabled="loading"/>
		</template>
		<MkInfo v-if="missing" warn>{{ i18n.ts._noteCleanup.missingReference }}</MkInfo>
		<RuleEditor v-if="loaded && !missing" ref="editor" :key="`${editingId ?? 'new'}:${revision}`" :rule="editingRule" :blocked="blocked" @saved="saved" @refresh="load()"/>
	</div>
</SearchMarker>
</template>
<script lang="ts" setup>
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import RuleEditor from './note-cleanup/RuleEditor.vue';
import Preview from './note-cleanup/Preview.vue';
import type { CleanupRule } from '@/utility/note-cleanup-api.js';
import { cleanupErrorMessage, cleanupFailure } from '@/utility/note-cleanup-errors.js';
import { cleanupApi } from '@/utility/note-cleanup-api.js';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import { cleanupRuleName } from '@/utility/note-cleanup-name.js';
import { i18n } from '@/i18n.js';
import { ensureSignin } from '@/i.js';
import { definePage } from '@/page.js';
import * as os from '@/os.js';
const props = defineProps<{ ruleId?: string }>();
ensureSignin();
const rules = shallowRef<CleanupRule[]>([]);
const selected = ref<string[]>([]);
const editingId = ref<string | undefined>(props.ruleId);
const editingRule = computed(() => rules.value.find(rule => rule.id === editingId.value));
const missing = computed(() => !!editingId.value && !editingRule.value);
const loading = ref(false);
const loaded = ref(false);
const failed = ref<string | null>(null);
const blocked = ref(false);
const migrated = ref(false);
const status = ref('');
const revision = ref(0);
const previewRevision = ref(0);

function toggle(id: string) { selected.value = selected.value.includes(id) ? selected.value.filter(v => v !== id) : [...selected.value, id]; }

const editor = ref<InstanceType<typeof RuleEditor>>();

async function open(id?: string) {
	if (editor.value?.dirty) {
		const { canceled } = await os.confirm({ type: 'warning', text: i18n.ts._noteCleanup.discardDraft });
		if (canceled) return;
	}
	editingId.value = id; revision.value++;
}

watch(() => props.ruleId, value => open(value));

async function load() {
	previewRevision.value++;
	if (loading.value) return;
	loading.value = true;
	failed.value = null;
	try {
		const result = await cleanupApi.list();
		if (blocked.value && !result.blocked) status.value = i18n.ts._noteCleanup.recovered;
		rules.value = result.rules;
		blocked.value = result.blocked;
		migrated.value = result.migrated;
		loaded.value = true;
		selected.value = selected.value.filter(id => result.rules.some(rule => rule.id === id && rule.action === 'delete' && rule.enabled));
	} catch (caught) { failed.value = cleanupFailure(caught).code || 'UNKNOWN'; } finally { loading.value = false; }
}

async function saved(id?: string) { editingId.value = id; await load(); revision.value++; }

async function requestSelected() {
	if (loading.value || blocked.value || !selected.value.length) return;
	loading.value = true;
	failed.value = null;
	try { const result = await cleanupApi.request([...selected.value]); status.value = result.queued ? i18n.ts._noteCleanup.queued : i18n.ts._noteCleanup.notQueued; } catch (caught) { failed.value = cleanupFailure(caught).code || 'UNKNOWN'; } finally { loading.value = false; }
}

onMounted(() => load());
definePage(() => ({ title: i18n.ts._noteCleanup.title, icon: 'ti ti-filter' }));
</script>
<style lang="scss" module>
.rule { border: 1px solid var(--MI_THEME-divider); border-radius: var(--MI-radius); padding: 14px; display: flex; flex-direction: column; gap: 8px; overflow-wrap: anywhere; }
</style>
