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
	<!-- 첫 검사 범위에 후보가 없어도 다음 범위로 갈 수 있게 한다. 후보가 있으면 타임라인이 같은 버튼을 그린다. -->
	<template v-if="paginator.items.value.length === 0 && !paginator.fetching.value && !paginator.error.value">
		<MkLoading v-if="paginator.fetchingNewer.value"/>
		<MkButton v-else-if="paginator.canFetchNewer.value" :class="$style.more" primary rounded @click="paginator.fetchNewer()">{{ i18n.ts.loadMore }}</MkButton>
	</template>
</div>
</template>
<script lang="ts" setup>
import { markRaw, watch } from 'vue';
import MkInfo from '@/components/MkInfo.vue';
import MkButton from '@/components/MkButton.vue';
import MkLoading from '@/components/global/MkLoading.vue';
import MkNotesTimeline from '@/components/MkNotesTimeline.vue';
import { i18n } from '@/i18n.js';
import { cleanupRuleName } from '@/utility/note-cleanup-name.js';
import { cleanupErrorMessage } from '@/utility/note-cleanup-errors.js';
import { CleanupPreviewPaginator } from '@/utility/note-cleanup-preview.js';
const props = defineProps<{ ruleId: string; version: number }>();
const emit = defineEmits<{ (e: 'ready', value: boolean): void }>();
const paginator = markRaw(new CleanupPreviewPaginator([props.ruleId]));

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
