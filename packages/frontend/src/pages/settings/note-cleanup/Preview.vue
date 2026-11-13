<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<section class="_gaps_m" aria-live="polite">
	<MkButton :disabled="disabled || loading || !ruleIds.length" @click="load()">{{ i18n.ts._noteCleanup.preview }}</MkButton>
	<MkInfo v-if="failed" warn>{{ cleanupErrorMessage(failed) }}</MkInfo>
	<template v-if="page">
		<p>{{ i18n.tsx._noteCleanup.pageCounts({ scanned: page.scanned, deleted: page.deleteCount, protectedCount: page.protectedCount }) }}</p>
		<MkInfo v-for="error in page.errors" :key="`${error.ruleId}:${error.path}`" warn>
			<MkA :to="`/settings/note-cleanup/${error.ruleId}`">{{ ruleName(error.ruleId) }}</MkA>
			<div>{{ cleanupErrorMessage(error.code, page.rules.find(rule => rule.id === error.ruleId)?.action) }}</div>
		</MkInfo>
		<article v-for="item in page.items" :key="item.noteId" :class="$style.item">
			<MkA :to="`/notes/${item.noteId}`">{{ item.noteId }}</MkA>
			<time :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString() }}</time>
			<div v-if="item.cw" :class="$style.content">{{ item.cw }}</div>
			<div :class="$style.content">{{ item.text }}</div>
			<strong>{{ item.reason === 'protected' && item.deleteRuleIds.length ? i18n.ts._noteCleanup.protectionWins : item.reason === 'blocked' ? i18n.ts._noteCleanup.blocked : i18n.ts._noteCleanup[item.reason] }}</strong>
			<div>{{ i18n.ts._noteCleanup.delete }}: {{ item.deleteRuleIds.map(ruleName).join(', ') || i18n.ts.none }}</div>
			<div>{{ i18n.ts._noteCleanup.keep }}: {{ item.keepRuleIds.map(ruleName).join(', ') || i18n.ts.none }}</div>
		</article>
		<!-- complete인 마지막 페이지는 nextCursor가 남아 있어도 더 요청하지 않는다 -->
		<MkButton v-if="page.nextCursor && !page.complete" :disabled="loading" @click="load(page.nextCursor)">{{ i18n.ts._noteCleanup.nextPage }}</MkButton>
		<p v-if="page.complete">{{ i18n.ts._noteCleanup.complete }}</p>
	</template>
</section>
</template>
<script lang="ts" setup>
import { ref, shallowRef, watch } from 'vue';
import type { CleanupPreview } from '@/utility/note-cleanup-api.js';
import { cleanupErrorMessage, cleanupFailure } from '@/utility/note-cleanup-errors.js';
import { cleanupApi } from '@/utility/note-cleanup-api.js';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import { cleanupRuleName } from '@/utility/note-cleanup-name.js';
import { i18n } from '@/i18n.js';
const props = withDefaults(defineProps<{ ruleIds: string[]; revision?: number; disabled?: boolean; immediate?: boolean }>(), { revision: 0, disabled: false, immediate: false });
const emit = defineEmits<{ (ev: 'loaded', page: CleanupPreview): void; (ev: 'invalidated'): void }>();
const page = shallowRef<CleanupPreview | null>(null);
const loading = ref(false);
const failed = ref<string | null>(null);
let version = 0;

function ruleName(id: string) { const rule = page.value?.rules.find(rule => rule.id === id); return rule ? cleanupRuleName(rule, i18n.ts._noteCleanup) : i18n.ts._noteCleanup.rules; }

async function load(afterId?: string) {
	if (props.disabled || loading.value || !props.ruleIds.length) return;
	const current = ++version;
	loading.value = true;
	page.value = null;
	emit('invalidated');
	failed.value = null;
	try {
		const result = await cleanupApi.preview([...props.ruleIds], afterId);
		if (current !== version) return;
		page.value = result;
		emit('loaded', result);
	} catch (caught) { if (current === version) failed.value = cleanupFailure(caught).code || 'UNKNOWN'; } finally { if (current === version) loading.value = false; }
}

watch([() => props.ruleIds.join(','), () => props.revision], () => { version++; loading.value = false; page.value = null; emit('invalidated'); if (props.immediate) void load(); }, { immediate: true });
</script>
<style lang="scss" module>
.item { border: 1px solid var(--MI_THEME-divider); border-radius: var(--MI-radius); padding: 14px; display: flex; flex-direction: column; gap: 8px; overflow-wrap: anywhere; }
.content { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
