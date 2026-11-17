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
	<!-- 후보 없이 아직 읽을 범위가 남았으면 빈 목록 대신 더 보기를 보인다. 타임라인은 다시 마운트되지 않게 숨기기만 한다. -->
	<template v-if="pending">
		<MkLoading v-if="paginator.fetchingNewer.value"/>
		<MkButton v-else primary rounded :class="$style.more" @click="paginator.fetchNewer()">{{ i18n.ts.loadMore }}</MkButton>
	</template>
	<MkNotesTimeline v-show="!pending" :paginator="paginator" :pullToRefresh="false" :withControl="false"/>
</div>
</template>
<script lang="ts" setup>
import { computed, markRaw, watch } from 'vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkNotesTimeline from '@/components/MkNotesTimeline.vue';
import { i18n } from '@/i18n.js';
import { cleanupRuleName } from '@/utility/note-cleanup-name.js';
import { cleanupErrorMessage } from '@/utility/note-cleanup-errors.js';
import { CleanupPreviewPaginator } from '@/utility/note-cleanup-preview.js';
const props = defineProps<{ ruleId: string; version: number }>();
const emit = defineEmits<{ (e: 'ready', value: boolean): void }>();
const paginator = markRaw(new CleanupPreviewPaginator([props.ruleId]));
const pending = computed(() => !paginator.fetching.value && !paginator.error.value && paginator.items.value.length === 0 && paginator.canFetchNewer.value);

// 저장 직후 등 규칙이 바뀌면 같은 자리에서 첫 페이지부터 다시 읽는다.
watch(() => props.version, () => paginator.reload());
// 현재 미리 보기의 성공 여부를 편집 화면에 알려 최초 자동 켜기 판정에 쓴다.
watch(() => paginator.ready.value, value => emit('ready', value), { immediate: true });

function ruleName(ruleId: string): string {
	const rule = paginator.rules.value.find(r => r.id === ruleId);
	return rule ? cleanupRuleName(rule, i18n.ts._noteCleanup) : ruleId;
}
</script>
<style lang="scss" module>
.more {
	margin-left: auto;
	margin-right: auto;
}
</style>
