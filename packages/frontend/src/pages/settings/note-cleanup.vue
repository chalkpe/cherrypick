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
			<MkButton v-if="!isCleanupBusyError(failed)" small @click="load">{{ i18n.ts.retry }}</MkButton>
		</MkInfo>
		<template v-else>
			<MkSwitch :modelValue="deletesFilesWithNote ? false : keepDriveFiles" accessible :disabled="savingKeepDriveFiles || deletesFilesWithNote" @update:modelValue="changeKeepDriveFiles">
				{{ i18n.ts._noteCleanup.keepDriveFiles }}
				<template v-if="!deletesFilesWithNote" #caption>
					<I18n :src="i18n.ts._noteCleanup.keepDriveFilesScope" tag="span">
						<template #link><MkA to="/settings/drive" class="_link">{{ i18n.ts._noteCleanup.driveSettingsLink }}</MkA></template>
						<template #option>{{ i18n.ts.autoDeleteNoteFiles }}</template>
					</I18n>
				</template>
			</MkSwitch>
			<MkInfo v-if="deletesFilesWithNote">
				<I18n :src="i18n.ts._noteCleanup.keepDriveFilesOverridden" tag="span">
					<template #link><MkA to="/settings/drive" class="_link">{{ i18n.ts._noteCleanup.driveSettingsLink }}</MkA></template>
					<template #option>{{ i18n.ts.autoDeleteNoteFiles }}</template>
				</I18n>
			</MkInfo>
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
import { cleanupErrorMessage, cleanupFailure, isCleanupBusyError } from '@/utility/note-cleanup-errors.js';
import { cleanupRuleName } from '@/utility/note-cleanup-name.js';
import { i18n } from '@/i18n.js';
import { ensureSignin } from '@/i.js';
import { definePage } from '@/page.js';
import * as os from '@/os.js';
const $i = ensureSignin();
const rules = shallowRef<CleanupRule[]>([]);
const loading = ref(true);
const failed = ref('');
const keepDriveFiles = ref(true);
// 드라이브 설정에서 노트와 함께 첨부 파일을 지우도록 했으면 이 스위치는 값과 상관없이 꺼진 모양으로 잠근다(저장된 값은 그대로 둔다).
const deletesFilesWithNote = computed(() => $i.autoDeleteNoteFiles);
// 저장 중에는 스위치를 잠그고, 실패하면 낙관적 값이 아니라 마지막 확인된 서버 값으로 돌린다.
const savingKeepDriveFiles = ref(false);
const confirmedKeepDriveFiles = ref(true);
const deleteRules = computed(() => rules.value.filter(rule => rule.action === 'delete'));
const keepRules = computed(() => rules.value.filter(rule => rule.action === 'keep'));

async function load() {
	loading.value = true;
	failed.value = '';
	try {
		const res = await cleanupApi.list();
		rules.value = res.rules;
		keepDriveFiles.value = res.keepDriveFiles;
		confirmedKeepDriveFiles.value = res.keepDriveFiles;
	} catch (error) {
		failed.value = cleanupFailure(error).code;
	} finally {
		loading.value = false;
	}
}

function changeKeepDriveFiles(value: boolean) {
	keepDriveFiles.value = value;
	saveKeepDriveFiles(value);
}

// 저장 실패는 스위치를 되돌리고 오류만 알린다. 목록 전체를 다시 불러오지는 않는다.
async function saveKeepDriveFiles(value: boolean) {
	savingKeepDriveFiles.value = true;
	try {
		await cleanupApi.setKeepDriveFiles(value);
		confirmedKeepDriveFiles.value = value;
	} catch (error) {
		keepDriveFiles.value = confirmedKeepDriveFiles.value;
		await os.alert({ type: 'error', text: cleanupErrorMessage(cleanupFailure(error).code) });
	} finally {
		savingKeepDriveFiles.value = false;
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
