<!--
SPDX-FileCopyrightText: noridev and cherrypick-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 700px; --MI_SPACER-min: 16px; --MI_SPACER-max: 32px;">
		<div class="_gaps_m">
			<div class="_panel" style="padding: 16px;">
				<MkSwitch v-model="enableReceivePrerelease">
					<template #label>{{ i18n.ts.enableReceivePrerelease }}</template>
				</MkSwitch>
			</div>

			<template v-if="(version && version.length > 0) && latestCherryPick">
				<FormInfo v-if="latestCherryPick && compareCherryPickVersions(version, latestCherryPick.tag_name) > 0">{{ i18n.ts.youAreRunningBetaClient }}</FormInfo>
				<FormInfo v-else-if="compareCherryPickVersions(version, latestCherryPick.tag_name) === 0" check>{{ i18n.ts.youAreRunningUpToDateClient }}</FormInfo>
				<FormInfo v-else warn>{{ i18n.ts.newVersionOfClientAvailable }}</FormInfo>
			</template>
			<FormInfo v-else>{{ cherryPickError ? i18n.ts.error : i18n.ts.notFound }}</FormInfo>

			<FormSection first>
				<template #label>{{ instanceName }}</template>
				<MkKeyValue @click="whatIsNewCherryPick">
					<template #key>{{ i18n.ts.currentVersion }} <i class="ti ti-external-link"></i></template>
					<template #value>{{ version }} <span :class="$style.commitHash" @click.stop="openCommitPage(cherryPickRepository, gitHash)">({{ gitHash.substring(0, 8) }})</span></template>
				</MkKeyValue>
				<MkKeyValue v-if="latestCherryPick && compareCherryPickVersions(version, latestCherryPick.tag_name) < 0 && !isSkipped" style="margin-top: 10px;" @click="whatIsNewLatestCherryPick">
					<template #key>{{ i18n.ts.latestVersion }} <i class="ti ti-external-link"></i></template>
					<template #value>{{ latestCherryPick.tag_name }} <span :class="$style.commitHash" @click.stop="openCommitPage(cherryPickRepository, cherryPickTagsMap.get(latestCherryPick.tag_name) || '')">({{ (cherryPickTagsMap.get(latestCherryPick.tag_name) || 'unknown').substring(0, 8) }})</span></template>
				</MkKeyValue>
				<MkButton v-if="latestCherryPick && !isSkipped && (compareCherryPickVersions(version, latestCherryPick.tag_name) < 0)" style="margin-top: 10px;" @click="skipThisVersion">{{ i18n.ts.skipThisVersion }}</MkButton>
			</FormSection>

			<FormSection @click="whatIsNewLatestCherryPick">
				<template #label>CherryPick <i class="ti ti-external-link"></i></template>
				<MkKeyValue>
					<template #key>{{ i18n.ts.latestVersion }}</template>
					<template v-if="latestCherryPick" #value>{{ latestCherryPick.tag_name }} <span :class="$style.commitHash" @click.stop="openCommitPage(cherryPickRepository, cherryPickTagsMap.get(latestCherryPick.tag_name) || '')">({{ (cherryPickTagsMap.get(latestCherryPick.tag_name) || 'unknown').substring(0, 8) }})</span></template>
					<template v-else #value>{{ i18n.ts.notFound }}</template>
				</MkKeyValue>
				<MkKeyValue style="margin: 8px 0 0; color: color(from var(--MI_THEME-fg) srgb r g b / 0.75); font-size: 0.85em;">
					<template v-if="latestCherryPick" #value><MkTime :time="latestCherryPick.published_at" mode="detail"/></template>
					<template v-else #value>{{ i18n.ts.notFound }}</template>
				</MkKeyValue>
			</FormSection>

			<FormSection @click="whatIsNewLatestMisskey">
				<template #label>Misskey <i class="ti ti-external-link"></i></template>
				<MkKeyValue>
					<template #key>{{ i18n.ts.latestVersion }}</template>
					<template v-if="latestMisskey" #value>{{ latestMisskey.tag_name }} <span :class="$style.commitHash" @click.stop="openCommitPage('misskey-dev/misskey', misskeyTagsMap.get(latestMisskey.tag_name) || '')">({{ (misskeyTagsMap.get(latestMisskey.tag_name) || 'unknown').substring(0, 8) }})</span></template>
					<template v-else #value>{{ i18n.ts.notFound }}</template>
				</MkKeyValue>
				<MkKeyValue style="margin: 8px 0 0; color: color(from var(--MI_THEME-fg) srgb r g b / 0.75); font-size: 0.85em;">
					<template v-if="latestMisskey" #value><MkTime :time="latestMisskey.published_at" mode="detail"/></template>
					<template v-else #value>{{ i18n.ts.notFound }}</template>
				</MkKeyValue>
			</FormSection>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import { version, instanceName, gitHash } from '@@/js/config.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { definePage } from '@/page.js';
import { i18n } from '@/i18n.js';
import { fetchInstance } from '@/instance.js';
import { cherryPickRepository, compareCherryPickVersions, fetchReleases, getLatestRelease, openCommitPage, getCommitHashForRelease } from '@/utility/fetch-releases.js';
import FormInfo from '@/components/MkInfo.vue';
import FormSection from '@/components/form/section.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import MkButton from '@/components/MkButton.vue';
import MkSwitch from '@/components/MkSwitch.vue';

const meta = await misskeyApi('admin/meta');

const enableReceivePrerelease = ref(meta.enableReceivePrerelease);
const skipVersion = ref(meta.skipVersion);
const skipCherryPickVersion = ref(meta.skipCherryPickVersion);
const cherryPickError = ref(false);
const [cherryPickData, misskeyData] = await Promise.all([
	fetchReleases(cherryPickRepository).catch(error => {
		console.error('Failed to fetch CherryPick releases:', error);
		cherryPickError.value = true;
		return [];
	}),
	fetchReleases('misskey-dev/misskey').catch(error => {
		console.error('Failed to fetch Misskey releases:', error);
		return [];
	}),
]);
const latestCherryPick = computed(() => getLatestRelease(cherryPickData, enableReceivePrerelease.value));
const latestMisskey = computed(() => getLatestRelease(misskeyData, enableReceivePrerelease.value));
const isSkipped = computed(() => skipVersion.value && skipCherryPickVersion.value === latestCherryPick.value?.tag_name);
const cherryPickTagsMap = ref(new Map<string, string>());
const misskeyTagsMap = ref(new Map<string, string>());

watch(latestCherryPick, async release => {
	if (!release || cherryPickTagsMap.value.has(release.tag_name)) return;
	cherryPickTagsMap.value.set(release.tag_name, await getCommitHashForRelease(cherryPickRepository, release));
}, { immediate: true });

watch(latestMisskey, async release => {
	if (!release || misskeyTagsMap.value.has(release.tag_name)) return;
	misskeyTagsMap.value.set(release.tag_name, await getCommitHashForRelease('misskey-dev/misskey', release));
}, { immediate: true });

const whatIsNewCherryPick = () => {
	window.open(`https://github.com/${cherryPickRepository}/releases/tag/${encodeURIComponent(version)}`, '_blank');
};

const whatIsNewLatestCherryPick = () => {
	if (latestCherryPick.value) window.open(latestCherryPick.value.html_url, '_blank');
};

const whatIsNewLatestMisskey = () => {
	if (latestMisskey.value) window.open(latestMisskey.value.html_url, '_blank');
};

function save() {
	os.apiWithDialog('admin/update-meta', {
		enableReceivePrerelease: enableReceivePrerelease.value,
	}).then(() => {
		fetchInstance(true);
	});
}

function skipThisVersion() {
	if (!latestCherryPick.value) return;
	skipCherryPickVersion.value = latestCherryPick.value.tag_name;
	skipVersion.value = true;

	os.apiWithDialog('admin/update-meta', {
		skipVersion: skipVersion.value,
		skipCherryPickVersion: skipCherryPickVersion.value,
	}).then(() => {
		fetchInstance(true);
	});
}

watch([
	enableReceivePrerelease,
], () => {
	save();
});

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts.cherrypickUpdate,
	icon: 'ti ti-refresh',
}));
</script>

<style lang="scss" module>
.commitHash {
	font-size: 11px;
	opacity: 0.5;
	cursor: pointer;

	&:hover {
		opacity: 1 !important;
		text-decoration: underline;
		color: var(--MI_THEME-link);
	}
}
</style>
