<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<div class="_gaps_m">
	<MkInfo v-for="error in paginator.errors.value" :key="`${error.ruleId}:${error.path}`" warn>
		<MkA :to="`/settings/note-cleanup/${error.ruleId}`">{{ ruleName(error.ruleId) }}</MkA>
		<div>{{ cleanupErrorMessage(error.code) }}</div>
	</MkInfo>
	<MkNotesTimeline :paginator="paginator" :pullToRefresh="false" :withControl="false"/>
</div>
</template>
<script lang="ts" setup>
import { markRaw, watch } from 'vue';
import MkInfo from '@/components/MkInfo.vue';
import MkNotesTimeline from '@/components/MkNotesTimeline.vue';
import { i18n } from '@/i18n.js';
import { cleanupRuleName } from '@/utility/note-cleanup-name.js';
import { cleanupErrorMessage } from '@/utility/note-cleanup-errors.js';
import { CleanupPreviewPaginator } from '@/utility/note-cleanup-preview.js';
const props = defineProps<{ ruleId: string; version: number }>();
const paginator = markRaw(new CleanupPreviewPaginator([props.ruleId]));

// 저장 직후 등 규칙이 바뀌면 같은 자리에서 첫 페이지부터 다시 읽는다.
watch(() => props.version, () => paginator.reload());

function ruleName(ruleId: string): string {
	const rule = paginator.rules.value.find(r => r.id === ruleId);
	return rule ? cleanupRuleName(rule, i18n.ts._noteCleanup) : ruleId;
}
</script>
