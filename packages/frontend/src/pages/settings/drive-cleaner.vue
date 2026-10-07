<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<MkSelect v-model="sortModeSelect" :items="sortModeSelectDef">
		<template #label>{{ i18n.ts.sort }}</template>
	</MkSelect>
	<MkSwitch v-model="unusedOnly">
		<template #label>{{ i18n.ts._drivecleaner.unusedOnly }}</template>
		<template #caption>{{ i18n.ts._drivecleaner.unusedOnlyDescription }}</template>
	</MkSwitch>
	<div v-if="unusedOnly" :class="$style.selectionBar">
		<MkButton inline :disabled="deleting" @click="toggleSelectAll">{{ allLoadedSelected ? i18n.ts._drivecleaner.deselectAll : i18n.ts._drivecleaner.selectAll }}</MkButton>
		<MkButton inline danger :disabled="selectedIds.length === 0 || deleting" @click="deleteSelected"><i class="ti ti-trash"></i> {{ i18n.ts._drivecleaner.deleteSelected }}</MkButton>
		<span v-if="selectedIds.length > 0">{{ i18n.tsx._drivecleaner.selectedFilesSummary({ n: selectedIds.length, size: bytes(selectedSize) }) }}</span>
	</div>
	<div v-if="!fetching">
		<MkPagination :key="unusedOnly ? 'unused' : 'all'" v-slot="{items}" :paginator="unusedOnly ? unusedPaginator : paginator">
			<div class="_gaps">
				<div
					v-for="file in items" :key="file.id"
					class="_button"
					:role="unusedOnly ? 'checkbox' : undefined"
					:aria-checked="unusedOnly ? selectedIds.includes(file.id) : undefined"
					:aria-disabled="unusedOnly && deleting ? true : undefined"
					:tabindex="unusedOnly ? 0 : undefined"
					@click="$event => onClick($event, file)"
					@keydown.enter.prevent="onKeyToggle(file)"
					@keydown.space.prevent="onKeyToggle(file)"
					@contextmenu.stop="$event => onContextMenu($event, file)"
				>
					<div :class="[$style.file, { [$style.selected]: unusedOnly && selectedIds.includes(file.id) }]">
						<i v-if="unusedOnly" :class="[$style.checkIcon, selectedIds.includes(file.id) ? 'ti ti-checkbox' : 'ti ti-square']"></i>
						<div v-if="file.isSensitive" class="sensitive-label">{{ i18n.ts.sensitive }}</div>
						<MkDriveFileThumbnail :class="$style.fileThumbnail" :file="file" fit="contain"/>
						<div :class="$style.fileBody">
							<div style="margin-bottom: 4px;">
								{{ file.name }}
							</div>
							<div>
								<span style="margin-right: 1em;">{{ file.type }}</span>
								<span>{{ bytes(file.size) }}</span>
							</div>
							<div>
								<span>{{ i18n.ts.registeredDate }}: <MkTime :time="file.createdAt" mode="detail"/></span>
							</div>
							<div v-if="sortModeSelect === 'sizeDesc'">
								<div :class="$style.meter"><div :class="$style.meterValue" :style="genUsageBar(file.size)"></div></div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</MkPagination>
	</div>
	<div v-else>
		<MkLoading/>
	</div>
</div>
</template>

<script setup lang="ts">
import * as Misskey from 'cherrypick-js';
import { computed, markRaw, ref, watch } from 'vue';
import tinycolor from 'tinycolor2';
import type { StyleValue } from 'vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import MkPagination from '@/components/MkPagination.vue';
import MkDriveFileThumbnail from '@/components/MkDriveFileThumbnail.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import bytes from '@/filters/bytes.js';
import { definePage } from '@/page.js';
import MkSelect from '@/components/MkSelect.vue';
import { useMkSelect } from '@/composables/use-mkselect.js';
import { globalEvents, useGlobalEvent } from '@/events.js';
import { getDriveFileMenu } from '@/utility/get-drive-file-menu.js';
import { Paginator } from '@/utility/paginator.js';

const BULK_DELETE_CHUNK = 100;

const sortMode = ref<Misskey.entities.DriveFilesRequest['sort']>('+size');
const paginator = markRaw(new Paginator('drive/files', {
	limit: 10,
	computedParams: computed(() => ({ sort: sortMode.value })),
}));
// サイズ順・名前順でも読み進められるよう、未使用一覧は末尾のファイルをカーソルにする
const unusedPaginator = markRaw(new Paginator('drive/files/unused', {
	limit: 30,
	olderCursorParams: (last) => ({ untilId: last.id, untilSize: last.size, untilName: last.name }),
	computedParams: computed(() => ({ sort: sortMode.value })),
}));

const unusedOnly = ref(false);
const selectedIds = ref<string[]>([]);
const deleting = ref(false);

const selectedFiles = computed(() => unusedPaginator.items.value.filter(f => selectedIds.value.includes(f.id)));
const selectedSize = computed(() => selectedFiles.value.reduce((sum, f) => sum + f.size, 0));
const allLoadedSelected = computed(() => {
	const loaded = unusedPaginator.items.value;
	return loaded.length > 0 && loaded.every(f => selectedIds.value.includes(f.id));
});

const capacity = ref<number>(0);
const usage = ref<number>(0);
const fetching = ref(true);
const {
	model: sortModeSelect,
	def: sortModeSelectDef,
} = useMkSelect({
	items: [
		{ label: i18n.ts._drivecleaner.orderBySizeDesc, value: 'sizeDesc' },
		{ label: i18n.ts._drivecleaner.orderByCreatedAtAsc, value: 'createdAtAsc' },
	],
	initialValue: 'sizeDesc',
});

fetchDriveInfo();

watch(sortModeSelect, () => {
	selectedIds.value = [];
	switch (sortModeSelect.value) {
		case 'sizeDesc':
			sortMode.value = '+size';
			fetchDriveInfo();
			break;

		case 'createdAtAsc':
			sortMode.value = '-createdAt';
			fetchDriveInfo();
			break;
	}
});

watch(unusedOnly, () => {
	selectedIds.value = [];
});

function fetchDriveInfo(): void {
	fetching.value = true;
	misskeyApi('drive').then(info => {
		capacity.value = info.capacity;
		usage.value = info.usage;
		fetching.value = false;
	});
}

// 使用量だけを更新する。fetchDriveInfo は読み込み中表示に切り替わって一覧が再マウントされ、読み進めた位置が失われる
function refreshUsage(): void {
	misskeyApi('drive').then(info => {
		capacity.value = info.capacity;
		usage.value = info.usage;
	}).catch(() => {
		// 使用量の表示が古いままになるだけなので握りつぶす
	});
}

function genUsageBar(fsize: number): StyleValue {
	return {
		width: `${fsize / usage.value * 100}%`,
		background: tinycolor({ h: 180 - (fsize / usage.value * 180), s: 0.7, l: 0.5 }).toHslString(),
	};
}

function toggleSelection(file: Misskey.entities.DriveFile): void {
	if (selectedIds.value.includes(file.id)) {
		selectedIds.value = selectedIds.value.filter(id => id !== file.id);
	} else {
		selectedIds.value = [...selectedIds.value, file.id];
	}
}

function toggleSelectAll(): void {
	if (allLoadedSelected.value) {
		selectedIds.value = [];
	} else {
		selectedIds.value = unusedPaginator.items.value.map(f => f.id);
	}
}

async function deleteSelected(): Promise<void> {
	if (deleting.value) return;
	const targets = selectedFiles.value;
	if (targets.length === 0) return;

	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.tsx._drivecleaner.deleteSelectedConfirm({ n: targets.length, size: bytes(selectedSize.value) }),
	});
	if (canceled) return;

	// 100件ずつ delete-bulk を呼ぶ。リクエスト自体が失敗した塊以降は中断する
	// サーバーは削除直前に未使用かどうかを確かめ直し、実際に消した ID と削除に失敗した ID をファイルごとに返す
	const deleted: Misskey.entities.DriveFile[] = [];
	const skipped: Misskey.entities.DriveFile[] = [];
	let failed = false;
	deleting.value = true;
	try {
		for (let i = 0; i < targets.length; i += BULK_DELETE_CHUNK) {
			const chunk = targets.slice(i, i + BULK_DELETE_CHUNK);
			try {
				const { deletedIds, failedIds } = await misskeyApi('drive/files/delete-bulk', { fileIds: chunk.map(f => f.id) });
				for (const f of chunk) {
					if (deletedIds.includes(f.id)) {
						deleted.push(f);
					} else if (failedIds.includes(f.id)) {
						// 削除に失敗したファイルは一覧と選択に残し、やり直せるようにする
						failed = true;
					} else {
						skipped.push(f);
					}
				}
			} catch {
				failed = true;
				break;
			}
		}
	} finally {
		deleting.value = false;
	}

	// 一覧と選択からの除去は driveFilesDeleted のハンドラーに任せる
	if (deleted.length > 0) {
		globalEvents.emit('driveFilesDeleted', deleted);
	}
	// 一覧を取得した後に使われたファイルはもう未使用ではないので、一覧と選択から外すだけにする
	for (const f of skipped) {
		unusedPaginator.removeItem(f.id);
	}
	selectedIds.value = selectedIds.value.filter(id => !skipped.some(f => f.id === id));
	refreshUsage();

	const messages: string[] = [];
	if (failed) messages.push(i18n.ts._drivecleaner.deleteSelectedFailed);
	if (skipped.length > 0) messages.push(i18n.tsx._drivecleaner.deleteSelectedSkipped({ n: skipped.length }));
	if (messages.length > 0) {
		os.alert({
			type: failed ? 'error' : 'info',
			text: messages.join('\n'),
		});
	}
}

function onKeyToggle(file: Misskey.entities.DriveFile): void {
	if (!unusedOnly.value || deleting.value) return;
	toggleSelection(file);
}

function onClick(ev: PointerEvent, file: Misskey.entities.DriveFile) {
	if (unusedOnly.value) {
		if (!deleting.value) toggleSelection(file);
		return;
	}
	os.popupMenu(getDriveFileMenu(file), (ev.currentTarget ?? ev.target ?? undefined) as HTMLElement | undefined);
}

function onContextMenu(ev: PointerEvent, file: Misskey.entities.DriveFile): void {
	os.contextMenu(getDriveFileMenu(file), ev);
}

useGlobalEvent('driveFilesDeleted', (files) => {
	for (const f of files) {
		paginator.removeItem(f.id);
		unusedPaginator.removeItem(f.id);
	}
	selectedIds.value = selectedIds.value.filter(id => !files.some(f => f.id === id));
});

definePage(() => ({
	title: i18n.ts.drivecleaner,
	icon: 'ti ti-trash',
}));
</script>

<style lang="scss" module>
.file {
	display: flex;
	width: 100%;
	box-sizing: border-box;
	text-align: left;
	align-items: center;

	&:hover {
		color: var(--MI_THEME-accent);
	}
}

.selected {
	color: var(--MI_THEME-accent);
}

.selectionBar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}

.checkIcon {
	flex-shrink: 0;
	font-size: 1.5em;
	margin-right: 8px;
}

.fileThumbnail {
	width: 100px;
	height: 100px;
}

.fileBody {
	margin-left: 0.3em;
	padding: 8px;
	flex: 1;
}

.meter {
	margin-top: 8px;
	height: 12px;
	background: rgba(0, 0, 0, 0.1);
	overflow: clip;
	border-radius: 999px;
}

.meterValue {
	height: 100%;
}
</style>
