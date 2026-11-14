<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<SearchMarker :keywords="['note', 'cleanup', 'delete', 'keep', 'ノート', '정리', '削除', '残す']">
	<div class="_gaps_m">
		<SearchLabel><h2>{{ i18n.ts._noteCleanup.title }}</h2></SearchLabel>
		<MkLoading v-if="loading"/>
		<MkInfo v-else-if="failed" warn role="alert">
			{{ cleanupErrorMessage(failed) }}
			<MkButton small @click="load">{{ i18n.ts.retry }}</MkButton>
		</MkInfo>
		<template v-else>
			<MkSwitch v-model="keepDriveFiles" accessible @update:modelValue="saveKeepDriveFiles">{{ i18n.ts._noteCleanup.keepDriveFiles }}</MkSwitch>
			<FormSection>
				<template #label><i class="ti ti-trash"></i> {{ i18n.ts._noteCleanup.deleteRules }}</template>
				<div class="_gaps_s">
					<FormLink v-for="rule in deleteRules" :key="rule.id" :to="`/settings/note-cleanup/${rule.id}`">
						<template #icon><i :class="ruleIcon(rule)"></i></template>
						{{ cleanupRuleName(rule, i18n.ts._noteCleanup) }}
						<template v-if="rule.automatic" #suffix>{{ i18n.ts._noteCleanup.automaticShort }}</template>
					</FormLink>
					<FormLink to="/settings/note-cleanup/new?action=delete">
						<template #icon><i class="ti ti-plus"></i></template>
						{{ i18n.ts._noteCleanup.newRule }}
					</FormLink>
				</div>
			</FormSection>
			<FormSection>
				<template #label><i class="ti ti-shield"></i> {{ i18n.ts._noteCleanup.keepRules }}</template>
				<div class="_gaps_s">
					<FormLink v-for="rule in keepRules" :key="rule.id" :to="`/settings/note-cleanup/${rule.id}`">
						<template #icon><i :class="ruleIcon(rule)"></i></template>
						{{ cleanupRuleName(rule, i18n.ts._noteCleanup) }}
					</FormLink>
					<FormLink to="/settings/note-cleanup/new?action=keep">
						<template #icon><i class="ti ti-plus"></i></template>
						{{ i18n.ts._noteCleanup.newRule }}
					</FormLink>
				</div>
			</FormSection>
		</template>
	</div>
</SearchMarker>
</template>
<script lang="ts" setup>
import { computed, onMounted, ref, shallowRef } from 'vue';
import FormSection from '@/components/form/section.vue';
import FormLink from '@/components/form/link.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkButton from '@/components/MkButton.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import type { CleanupRule } from '@/utility/note-cleanup-api.js';
import { cleanupApi } from '@/utility/note-cleanup-api.js';
import { cleanupErrorMessage, cleanupFailure } from '@/utility/note-cleanup-errors.js';
import { cleanupRuleName } from '@/utility/note-cleanup-name.js';
import { i18n } from '@/i18n.js';
import { ensureSignin } from '@/i.js';
import { definePage } from '@/page.js';
import * as os from '@/os.js';
ensureSignin();
const rules = shallowRef<CleanupRule[]>([]);
const loading = ref(true);
const failed = ref('');
const keepDriveFiles = ref(true);
const deleteRules = computed(() => rules.value.filter(rule => rule.action === 'delete'));
const keepRules = computed(() => rules.value.filter(rule => rule.action === 'keep'));

async function load() {
	loading.value = true;
	failed.value = '';
	try {
		const res = await cleanupApi.list();
		rules.value = res.rules;
		keepDriveFiles.value = res.keepDriveFiles;
	} catch (error) {
		failed.value = cleanupFailure(error).code;
	} finally {
		loading.value = false;
	}
}

// 저장 실패는 스위치를 되돌리고 오류만 알린다. 목록 전체를 다시 불러오지는 않는다.
async function saveKeepDriveFiles(value: boolean) {
	try {
		await cleanupApi.setKeepDriveFiles(value);
	} catch (error) {
		keepDriveFiles.value = !value;
		await os.alert({ type: 'error', text: cleanupErrorMessage(cleanupFailure(error).code) });
	}
}

function ruleIcon(rule: CleanupRule): string {
	if (rule.lastError) return 'ti ti-alert-triangle';
	if (!rule.enabled) return 'ti ti-player-pause';
	return rule.action === 'keep' ? 'ti ti-shield' : 'ti ti-trash';
}

onMounted(load);

definePage(() => ({
	title: i18n.ts._noteCleanup.title,
	icon: 'ti ti-history',
}));
</script>
