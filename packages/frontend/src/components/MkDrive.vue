<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkStickyContainer style="background: var(--MI_THEME-bg);">
	<template #header>
		<nav :class="$style.nav">
			<div :class="$style.navPath" @contextmenu.prevent.stop="() => {}">
				<XNavFolder
					:class="[$style.navPathItem, { [$style.navCurrent]: folder == null }]"
					:parentFolder="folder"
					@click="cd(null)"
					@upload="onUploadRequested"
				/>
				<template v-for="f in hierarchyFolders">
					<span :class="[$style.navPathItem, $style.navSeparator]"><i class="ti ti-chevron-right"></i></span>
					<XNavFolder
						:folder="f"
						:parentFolder="folder"
						:class="[$style.navPathItem]"
						@click="cd(f)"
						@upload="onUploadRequested"
					/>
				</template>
				<span v-if="folder != null" :class="[$style.navPathItem, $style.navSeparator]"><i class="ti ti-chevron-right"></i></span>
				<span v-if="folder != null" :class="[$style.navPathItem, $style.navCurrent]">{{ folder.name }}</span>
			</div>
			<button class="_button" :class="$style.navMenu" @click="showMenu"><i class="ti ti-dots"></i></button>
		</nav>
	</template>

	<div>
		<div v-if="select === 'folder'">
			<template v-if="folder == null">
				<MkButton v-if="!isRootSelected" @click="isRootSelected = true">
					<i class="ti ti-square"></i> {{ i18n.ts.selectFolder }}
				</MkButton>
				<MkButton v-else @click="isRootSelected = false">
					<i class="ti ti-checkbox"></i> {{ i18n.ts.unselectFolder }}
				</MkButton>
			</template>
			<template v-else>
				<MkButton v-if="!selectedFolders.some(f => f.id === folder!.id)" @click="selectedFolders = [...selectedFolders, folder]">
					<i class="ti ti-square"></i> {{ i18n.ts.selectFolder }}
				</MkButton>
				<MkButton v-else @click="selectedFolders = selectedFolders.filter(f => f.id !== folder!.id)">
					<i class="ti ti-checkbox"></i> {{ i18n.ts.unselectFolder }}
				</MkButton>
			</template>
		</div>

		<div
			ref="main"
			:class="[$style.main, { [$style.fetching]: fetching }]"
			@dragover.prevent.stop="onDragover"
			@dragenter="onDragenter"
			@dragleave="onDragleave"
			@drop.prevent.stop="onDrop"
			@contextmenu.stop="onContextmenu"
		>
			<div :class="$style.tipContainer">
				<MkTip k="drive"><div v-html="i18n.ts.driveAboutTip"></div></MkTip>
			</div>

			<div :class="$style.folders">
				<XFolder
					v-for="(f, i) in foldersPaginator.items.value"
					:key="f.id"
					v-anim="i"
					:data-scroll-anchor="f.id"
					:folder="f"
					:selectMode="select === 'folder'"
					:isSelected="selectedFolders.some(x => x.id === f.id)"
					@chosen="chooseFolder"
					@unchose="unchoseFolder"
					@click="cd(f)"
					@upload="onUploadRequested"
					@dragstart="isDragSource = true"
					@dragend="isDragSource = false"
				/>
			</div>
			<MkButton v-if="canFetchFolders" :class="$style.loadMore" primary rounded @click="fetchMoreFolders">{{ i18n.ts.loadMore }}</MkButton>

			<template v-if="shouldBeGroupedByDate">
				<MkStickyContainer v-for="(item, i) in filesTimeline" :key="`${item.date.getFullYear()}/${item.date.getMonth() + 1}`">
					<template #header>
						<div :class="$style.date">
							<span><i class="ti ti-chevron-down"></i> {{ item.date.getFullYear() }}/{{ item.date.getMonth() + 1 }}</span>
						</div>
					</template>

					<TransitionGroup
						tag="div"
						:enterActiveClass="prefer.s.animation ? $style.transition_files_enterActive : ''"
						:leaveActiveClass="prefer.s.animation ? $style.transition_files_leaveActive : ''"
						:enterFromClass="prefer.s.animation ? $style.transition_files_enterFrom : ''"
						:leaveToClass="prefer.s.animation ? $style.transition_files_leaveTo : ''"
						:moveClass="prefer.s.animation ? $style.transition_files_move : ''"
						:class="$style.files"
					>
						<XFile
							v-for="file in item.items" :key="file.id"
							:data-scroll-anchor="file.id"
							:file="file"
							:folder="folder"
							:isSelected="selectedFiles.some(x => x.id === file.id)"
							:isDisabled="excludeSensitive && file.isSensitive"
							@click="onFileClick($event, file)"
							@dragstart="onFileDragstart(file, $event)"
							@dragend="isDragSource = false"
						/>
					</TransitionGroup>
				</MkStickyContainer>
			</template>
			<TransitionGroup
				v-else
				tag="div"
				:enterActiveClass="prefer.s.animation ? $style.transition_files_enterActive : ''"
				:leaveActiveClass="prefer.s.animation ? $style.transition_files_leaveActive : ''"
				:enterFromClass="prefer.s.animation ? $style.transition_files_enterFrom : ''"
				:leaveToClass="prefer.s.animation ? $style.transition_files_leaveTo : ''"
				:moveClass="prefer.s.animation ? $style.transition_files_move : ''"
				:class="$style.files"
			>
				<XFile
					v-for="file in filesPaginator.items.value" :key="file.id"
					:data-scroll-anchor="file.id"
					:file="file"
					:folder="folder"
					:isSelected="selectedFiles.some(x => x.id === file.id)"
					:isDisabled="excludeSensitive && file.isSensitive"
					@click="onFileClick($event, file)"
					@dragstart="onFileDragstart(file, $event)"
					@dragend="isDragSource = false"
				/>
			</TransitionGroup>

			<MkButton
				v-show="canFetchFiles"
				v-appear="shouldEnableInfiniteScroll ? fetchMoreFiles : null"
				:class="$style.loadMore"
				primary
				rounded
				@click="fetchMoreFiles"
			>
				{{ i18n.ts.loadMore }}
			</MkButton>

			<div v-if="filesPaginator.items.value.length == 0 && foldersPaginator.items.value.length == 0 && !fetching" :class="$style.empty">
				<div v-if="draghover">{{ i18n.ts.dropHereToUpload }}</div>
				<div v-if="!draghover && folder == null"><strong>{{ i18n.ts.emptyDrive }}</strong></div>
				<div v-if="!draghover && folder != null">{{ i18n.ts.emptyFolder }}</div>
			</div>
		</div>
		<MkLoading v-if="fetching"/>
		<div v-if="draghover" :class="$style.dropzone"></div>
	</div>

	<template #footer>
		<div v-if="isEditMode" :class="$style.footer">
			<span role="status">{{ i18n.tsx._driveDeletion.selectedCount({ count: selectedFiles.length }) }}</span>
			<MkButton primary rounded :disabled="selectedFiles.length === 0 || (!select && fetching) || bulkBusy || driveDeletionBusy" @click="moveFilesBulk()"><i class="ti ti-folder-symlink"></i> {{ i18n.ts.move }}...</MkButton>
			<MkButton v-if="!select" danger rounded :disabled="selectedFiles.length === 0 || fetching || bulkBusy || driveDeletionBusy" @click="deleteFilesBulk()"><i class="ti ti-trash"></i> {{ i18n.ts.delete }}</MkButton>
		</div>
	</template>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref, useTemplateRef, watch, computed, TransitionGroup, markRaw } from 'vue';
import * as Misskey from 'cherrypick-js';
import { debounce } from 'throttle-debounce';
import MkButton from './MkButton.vue';
import type { MenuItem } from '@/types/menu.js';
import XNavFolder from '@/components/MkDrive.navFolder.vue';
import XFolder from '@/components/MkDrive.folder.vue';
import XFile from '@/components/MkDrive.file.vue';
import * as os from '@/os.js';
import { deleteDriveItems, driveDeletionBusy } from '@/utility/drive-delete.js';
import { runDriveFileBatches } from '@/utility/drive-bulk.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useStream } from '@/stream.js';
import { i18n } from '@/i18n.js';
import { claimAchievement } from '@/utility/achievements.js';
import { prefer } from '@/preferences.js';
import { chooseFileFromPcAndUpload, selectDriveFolder } from '@/utility/drive.js';
import { store } from '@/store.js';
import { makeDateGroupedTimelineComputedRef } from '@/utility/timeline-date-separate.js';
import { globalEvents, useGlobalEvent } from '@/events.js';
import { checkDragDataType, getDragData, setDragData } from '@/drag-and-drop.js';
import { getDriveFileMenu } from '@/utility/get-drive-file-menu.js';
import { Paginator } from '@/utility/paginator.js';

const props = withDefaults(defineProps<{
	initialFolder?: Misskey.entities.DriveFolder | Misskey.entities.DriveFolder['id'] | null;
	type?: string;
	multiple?: boolean;
	excludeSensitive?: boolean;
	select?: 'file' | 'folder' | null;
	forceDisableInfiniteScroll?: boolean;
}>(), {
	initialFolder: null,
	multiple: false,
	excludeSensitive: false,
	select: null,
	forceDisableInfiniteScroll: false,
});

const emit = defineEmits<{
	(ev: 'changeSelectedFiles', v: Misskey.entities.DriveFile[]): void;
	(ev: 'changeSelectedFolders', v: (Misskey.entities.DriveFolder | null)[]): void;
	(ev: 'cd', v: Misskey.entities.DriveFolder | null): void;
}>();

const shouldEnableInfiniteScroll = computed(() => {
	return prefer.r.enableInfiniteScroll.value && !props.forceDisableInfiniteScroll;
});

const folder = ref<Misskey.entities.DriveFolder | null>(null);
const hierarchyFolders = ref<Misskey.entities.DriveFolder[]>([]);

// ドロップされようとしているか
const draghover = ref(false);

// 自身の所有するアイテムがドラッグをスタートさせたか
// (自分自身の階層にドロップできないようにするためのフラグ)
const isDragSource = ref(false);

const isEditMode = ref(false);
const bulkBusy = ref(false);

const selectedFiles = ref<Misskey.entities.DriveFile[]>([]);
const selectedFolders = ref<Misskey.entities.DriveFolder[]>([]);
const isRootSelected = ref(false);

watch(selectedFiles, () => {
	emit('changeSelectedFiles', selectedFiles.value);
}, { deep: true });

watch([selectedFolders, isRootSelected], () => {
	emit('changeSelectedFolders', isRootSelected.value ? [null, ...selectedFolders.value] : selectedFolders.value);
});

const fetching = ref(true);

const sortModeSelect = store.r.driveSortMode;
const folderSortMode = computed(() => sortModeSelect.value === '+size' || sortModeSelect.value === '-size' ? '+createdAt' : sortModeSelect.value);

const filesPaginator = markRaw(new Paginator('drive/files', {
	limit: 30,
	canFetchDetection: 'limit',
	olderCursorParams: last => ({ untilId: last.id, untilName: last.name, untilSize: last.size }),
	params: () => ({ // 自動でリロードしたくないためcomputedParamsは使わない
		folderId: folder.value ? folder.value.id : null,
		type: props.type,
		sort: ['-createdAt', '+createdAt'].includes(sortModeSelect.value) ? null : sortModeSelect.value,
	}),
}));
const foldersPaginator = markRaw(new Paginator('drive/folders', {
	limit: 30,
	canFetchDetection: 'limit',
	olderCursorParams: last => ({ untilId: last.id, untilName: last.name }),
	params: () => ({ // 自動でリロードしたくないためcomputedParamsは使わない
		folderId: folder.value ? folder.value.id : null,
		sort: ['-createdAt', '+createdAt'].includes(folderSortMode.value) ? null : folderSortMode.value,
	}),
}));

const canFetchFolders = computed(() => !fetching.value && (foldersPaginator.order.value === 'oldest' ? foldersPaginator.canFetchNewer.value : foldersPaginator.canFetchOlder.value));

let loadingMoreFolders: Promise<void> | null = null;

async function fetchMoreFolders() {
	if (fetching.value || loadingMoreFolders || refreshingFolders) return;
	loadingMoreFolders = foldersPaginator.order.value === 'oldest' ? foldersPaginator.fetchNewer() : foldersPaginator.fetchOlder();
	try {
		await loadingMoreFolders;
	} finally {
		loadingMoreFolders = null;
	}
}

const canFetchFiles = computed(() => !fetching.value && (filesPaginator.order.value === 'oldest' ? filesPaginator.canFetchNewer.value : filesPaginator.canFetchOlder.value));

let loadingMoreFiles: Promise<void> | null = null;

async function fetchMoreFiles() {
	if (fetching.value || loadingMoreFiles || refreshingFiles) return;
	loadingMoreFiles = filesPaginator.order.value === 'oldest' ? filesPaginator.fetchNewer() : filesPaginator.fetchOlder();
	try {
		await loadingMoreFiles;
	} finally {
		loadingMoreFiles = null;
	}
}

const filesTimeline = makeDateGroupedTimelineComputedRef(filesPaginator.items, 'month');
const shouldBeGroupedByDate = computed(() => ['+createdAt', '-createdAt'].includes(sortModeSelect.value));

watch(folder, (current, previous) => {
	if (!props.select && current?.id !== previous?.id) selectedFiles.value = [];
	emit('cd', folder.value);
});
// 같은 폴더의 재조회 중에는 선택을 유지하고, 응답에 남은 파일만 선택한다.
watch(() => fetching.value ? null : filesPaginator.items.value.map(file => file.id), fileIds => {
	if (props.select || fileIds == null) return;
	const visibleIds = new Set(fileIds);
	selectedFiles.value = selectedFiles.value.filter(file => visibleIds.has(file.id));
});
watch(sortModeSelect, () => {
	initialize();
});

let listGeneration = 0;
let needsReload = false;
let reloadPromise: Promise<void> | null = null;

function initialize(): Promise<void> {
	listGeneration++;
	pendingCreatedFiles.clear();
	pendingCreatedFolders.clear();
	needsReload = true;
	if (reloadPromise) return reloadPromise;

	reloadPromise = (async () => {
		fetching.value = true;
		try {
			while (needsReload) {
				needsReload = false;
				await Promise.all([loadingMoreFolders, loadingMoreFiles]);
				foldersPaginator.initialDirection = folderSortMode.value === '-createdAt' ? 'newer' : 'older';
				foldersPaginator.order.value = folderSortMode.value === '-createdAt' ? 'oldest' : 'newest';
				filesPaginator.initialDirection = sortModeSelect.value === '-createdAt' ? 'newer' : 'older';
				filesPaginator.order.value = sortModeSelect.value === '-createdAt' ? 'oldest' : 'newest';
				await Promise.all([foldersPaginator.reload(), filesPaginator.reload()]);
			}
		} finally {
			fetching.value = false;
			reloadPromise = null;
		}
	})();
	return reloadPromise;
}

// Refresh only the affected list, retaining the number of rows the user loaded.
// The server remains responsible for name collation and tuple cursor ordering.
const pendingCreatedFiles = new Set<string>();
const pendingCreatedFolders = new Set<string>();
let refreshingFiles = false;
let refreshingFolders = false;
let filesChanged = false;
let foldersChanged = false;

const notifyUploadedOutsidePage = debounce(1000, () => { os.toast(i18n.ts.saved); });
const scheduleFilesRefresh = debounce(150, () => { void refreshFiles().catch(() => {}); });
const scheduleFoldersRefresh = debounce(150, () => { void refreshFolders().catch(() => {}); });

async function refreshFiles() {
	filesChanged = true;
	if (refreshingFiles) return;
	refreshingFiles = true;
	try {
		while (filesChanged) {
			filesChanged = false;
			const generation = listGeneration;
			await Promise.all([reloadPromise, loadingMoreFiles]);
			if (generation !== listGeneration) continue;
			const count = Math.max(30, filesPaginator.items.value.length);
			const sort = sortModeSelect.value;
			const folderId = folder.value?.id ?? null;
			const items: Misskey.entities.DriveFile[] = [];
			let more = true;
			while (items.length < count && more) {
				const limit = Math.min(100, count - items.length);
				const last = items.at(-1);
				const page = await misskeyApi('drive/files', {
					folderId, type: props.type, limit,
					sort: sort === '-createdAt' || sort === '+createdAt' ? null : sort,
					...(last == null ? (sort === '-createdAt' ? { sinceId: '0' } : {}) : sort === '-createdAt'
						? { sinceId: last.id }
						: { untilId: last.id, untilName: last.name, untilSize: last.size }),
				});
				items.push(...page);
				more = page.length === limit;
			}
			if (generation !== listGeneration) continue;
			filesPaginator.items.value = items;
			(filesPaginator.order.value === 'oldest' ? filesPaginator.canFetchNewer : filesPaginator.canFetchOlder).value = more;
			if ([...pendingCreatedFiles].some(id => !items.some(item => item.id === id))) notifyUploadedOutsidePage();
			pendingCreatedFiles.clear();
		}
	} finally {
		refreshingFiles = false;
	}
}

async function refreshFolders() {
	foldersChanged = true;
	if (refreshingFolders) return;
	refreshingFolders = true;
	try {
		while (foldersChanged) {
			foldersChanged = false;
			const generation = listGeneration;
			await Promise.all([reloadPromise, loadingMoreFolders]);
			if (generation !== listGeneration) continue;
			const count = Math.max(30, foldersPaginator.items.value.length);
			const sort = folderSortMode.value;
			const folderId = folder.value?.id ?? null;
			const items: Misskey.entities.DriveFolder[] = [];
			let more = true;
			while (items.length < count && more) {
				const limit = Math.min(100, count - items.length);
				const last = items.at(-1);
				const page = await misskeyApi('drive/folders', {
					folderId, limit,
					sort: sort === '-createdAt' || sort === '+createdAt' ? null : sort,
					...(last == null ? (sort === '-createdAt' ? { sinceId: '0' } : {}) : sort === '-createdAt'
						? { sinceId: last.id }
						: { untilId: last.id, untilName: last.name }),
				});
				items.push(...page);
				more = page.length === limit;
			}
			if (generation !== listGeneration) continue;
			foldersPaginator.items.value = items;
			(foldersPaginator.order.value === 'oldest' ? foldersPaginator.canFetchNewer : foldersPaginator.canFetchOlder).value = more;
			if ([...pendingCreatedFolders].some(id => !items.some(item => item.id === id))) os.toast(i18n.ts.saved);
			pendingCreatedFolders.clear();
		}
	} finally {
		refreshingFolders = false;
	}
}

function insertByNewestId<T extends { id: string }>(items: T[], item: T, canFetchMore: boolean): boolean {
	if (items.some(existing => existing.id === item.id)) return true;
	const index = items.findIndex(existing => existing.id < item.id);
	if (index >= 0) items.splice(index, 0, item);
	else if (!canFetchMore) items.push(item);
	else return false;
	return true;
}

function onFileCreated(file: Misskey.entities.DriveFile, local = false) {
	if (file.folderId !== (folder.value?.id ?? null)) return;
	if (props.type && !(props.type.endsWith('/*') ? file.type.startsWith(props.type.slice(0, -1)) : file.type === props.type)) return;
	if (sortModeSelect.value === '+createdAt' && !fetching.value && !loadingMoreFiles && !refreshingFiles) {
		if (!insertByNewestId(filesPaginator.items.value, file, filesPaginator.canFetchOlder.value) && local) notifyUploadedOutsidePage();
	} else {
		if (local) pendingCreatedFiles.add(file.id);
		scheduleFilesRefresh();
	}
}

function onFilesUpdated(files: Misskey.entities.DriveFile[]) {
	for (const file of files) {
		const present = filesPaginator.items.value.some(item => item.id === file.id);
		const belongs = file.folderId === (folder.value?.id ?? null) && (!props.type || (props.type.endsWith('/*') ? file.type.startsWith(props.type.slice(0, -1)) : file.type === props.type));
		if (!present && !belongs) continue;
		if (sortModeSelect.value === '+createdAt' && !fetching.value && !loadingMoreFiles && !refreshingFiles) {
			if (!belongs) filesPaginator.removeItem(file.id);
			else if (present) filesPaginator.updateItem(file.id, () => file);
			else insertByNewestId(filesPaginator.items.value, file, filesPaginator.canFetchOlder.value);
		} else {
			scheduleFilesRefresh();
		}
	}
}

function onFoldersUpdated(folders: Misskey.entities.DriveFolder[]) {
	for (const item of folders) {
		const present = foldersPaginator.items.value.some(existing => existing.id === item.id);
		const belongs = item.parentId === (folder.value?.id ?? null);
		if (!present && !belongs) continue;
		if (folderSortMode.value === '+createdAt' && !fetching.value && !loadingMoreFolders && !refreshingFolders) {
			if (!belongs) foldersPaginator.removeItem(item.id);
			else if (present) foldersPaginator.updateItem(item.id, () => item);
			else insertByNewestId(foldersPaginator.items.value, item, foldersPaginator.canFetchOlder.value);
		} else {
			scheduleFoldersRefresh();
		}
	}
}

function onFileDragstart(file: Misskey.entities.DriveFile, ev: DragEvent) {
	if (isEditMode.value) {
		if (!selectedFiles.value.some(f => f.id === file.id)) {
			selectedFiles.value.push(file);
		}

		if (ev.dataTransfer) {
			ev.dataTransfer.effectAllowed = 'move';
			setDragData(ev, 'driveFiles', selectedFiles.value);
		}
	}

	isDragSource.value = true;
}

function onDragover(ev: DragEvent) {
	if (!ev.dataTransfer) return;

	// ドラッグ元が自分自身の所有するアイテムだったら
	if (isDragSource.value) {
		// 自分自身にはドロップさせない
		ev.dataTransfer.dropEffect = 'none';
		return;
	}

	const isFile = ev.dataTransfer.items[0].kind === 'file';
	if (isFile || checkDragDataType(ev, ['driveFiles', 'driveFolders'])) {
		switch (ev.dataTransfer.effectAllowed) {
			case 'all':
			case 'uninitialized':
			case 'copy':
			case 'copyLink':
			case 'copyMove':
				ev.dataTransfer.dropEffect = 'copy';
				break;
			case 'linkMove':
			case 'move':
				ev.dataTransfer.dropEffect = 'move';
				break;
			default:
				ev.dataTransfer.dropEffect = 'none';
				break;
		}
	} else {
		ev.dataTransfer.dropEffect = 'none';
	}

	return false;
}

function onDragenter() {
	if (!isDragSource.value) draghover.value = true;
}

function onDragleave() {
	draghover.value = false;
}

function onDrop(ev: DragEvent): void | boolean {
	draghover.value = false;

	if (!ev.dataTransfer) return;

	// ドロップされてきたものがファイルだったら
	if (ev.dataTransfer.files.length > 0) {
		os.launchUploader(Array.from(ev.dataTransfer.files), {
			folderId: folder.value?.id ?? null,
		});
		return;
	}

	//#region ドライブのファイル
	{
		const droppedData = getDragData(ev, 'driveFiles');
		if (droppedData != null) {
			misskeyApi('drive/files/move-bulk', {
				fileIds: droppedData.map(f => f.id),
				folderId: folder.value ? folder.value.id : null,
			}).then(() => {
				globalEvents.emit('driveFilesUpdated', droppedData.map(x => ({
					...x,
					folderId: folder.value ? folder.value.id : null,
					folder: folder.value,
				})));
			});
		}
	}
	//#endregion

	//#region ドライブのフォルダ
	{
		const droppedData = getDragData(ev, 'driveFolders');
		if (droppedData != null) {
			const droppedFolder = droppedData[0];
			// 移動先が自分自身ならreject
			if (folder.value && droppedFolder.id === folder.value.id) return false;
			if (foldersPaginator.items.value.some(f => f.id === droppedFolder.id)) return false;
			misskeyApi('drive/folders/update', {
				folderId: droppedFolder.id,
				parentId: folder.value ? folder.value.id : null,
			}).then(() => {
				globalEvents.emit('driveFoldersUpdated', [droppedFolder].map(x => ({
					...x,
					parentId: folder.value ? folder.value.id : null,
					parent: folder.value,
				})));
			}).catch(err => {
				switch (err.code) {
					case 'RECURSIVE_NESTING':
						claimAchievement('driveFolderCircularReference');
						os.alert({
							type: 'error',
							title: i18n.ts.unableToProcess,
							text: i18n.ts.circularReferenceFolder,
						});
						break;
					default:
						os.alert({
							type: 'error',
							text: i18n.ts.somethingHappened,
						});
				}
			});
		}
	}
	//#endregion
}

function onUploadRequested(files: File[], folder?: Misskey.entities.DriveFolder | null) {
	os.launchUploader(files, {
		folderId: folder?.id ?? null,
	});
}

async function urlUpload() {
	const { canceled, result: url } = await os.inputText({
		title: i18n.ts.uploadFromUrl,
		type: 'url',
		placeholder: i18n.ts.uploadFromUrlDescription,
	});
	if (canceled || !url) return;

	await os.apiWithDialog('drive/files/upload-from-url', {
		url: url,
		folderId: folder.value ? folder.value.id : undefined,
	});

	os.alert({
		title: i18n.ts.uploadFromUrlRequested,
		text: i18n.ts.uploadFromUrlMayTakeTime,
	});
}

async function createFolder() {
	const { canceled, result: name } = await os.inputText({
		title: i18n.ts.createFolder,
		placeholder: i18n.ts.folderName,
	});
	if (canceled || name == null) return;

	const createdFolder = await os.apiWithDialog('drive/folders/create', {
		name: name,
		parentId: folder.value ? folder.value.id : undefined,
	});

	if (folderSortMode.value !== '+createdAt' || fetching.value || loadingMoreFolders || refreshingFolders) {
		pendingCreatedFolders.add(createdFolder.id);
	}
	onFoldersUpdated([createdFolder]);
	if (folderSortMode.value === '+createdAt' && !foldersPaginator.items.value.some(item => item.id === createdFolder.id) && !pendingCreatedFolders.has(createdFolder.id)) os.toast(i18n.ts.saved);
}

async function renameFolder(folderToRename: Misskey.entities.DriveFolder) {
	const { canceled, result: name } = await os.inputText({
		title: i18n.ts.renameFolder,
		placeholder: i18n.ts.inputNewFolderName,
		default: folderToRename.name,
	});
	if (canceled) return;

	const updatedFolder = await os.apiWithDialog('drive/folders/update', {
		folderId: folderToRename.id,
		name: name,
	});

	globalEvents.emit('driveFoldersUpdated', [updatedFolder]);
}

async function deleteFolder(folderToDelete: Misskey.entities.DriveFolder) {
	const result = await deleteDriveItems({ folderId: folderToDelete.id, name: folderToDelete.name });
	if (result?.folderDeleted && folder.value?.id === folderToDelete.id) cd(folderToDelete.parentId);
	else initialize();
}

async function deleteFilesBulk() {
	if (fetching.value || bulkBusy.value || driveDeletionBusy.value || selectedFiles.value.length === 0 || props.select) return;
	bulkBusy.value = true;
	try {
		const result = await deleteDriveItems({ fileIds: selectedFiles.value.map(file => file.id) });
		if (result) initialize();
	} finally {
		bulkBusy.value = false;
	}
}

function onFileClick(ev: PointerEvent, file: Misskey.entities.DriveFile) {
	if (bulkBusy.value || driveDeletionBusy.value) return;
	if (props.excludeSensitive && file.isSensitive) return;

	if (ev.shiftKey) {
		isEditMode.value = true;
	}

	if (props.select === 'file' || isEditMode.value) {
		const isAlreadySelected = selectedFiles.value.some(f => f.id === file.id);

		if (isEditMode.value) {
			if (isAlreadySelected) {
				selectedFiles.value = selectedFiles.value.filter(f => f.id !== file.id);
			} else {
				selectedFiles.value.push(file);
			}
			return;
		}

		if (props.multiple) {
			if (isAlreadySelected) {
				selectedFiles.value = selectedFiles.value.filter(f => f.id !== file.id);
			} else {
				selectedFiles.value.push(file);
			}
		} else {
			if (isAlreadySelected) {
				//emit('selected', file);
			} else {
				selectedFiles.value = [file];
			}
		}
	} else {
		os.popupMenu(getDriveFileMenu(file, folder.value), (ev.currentTarget ?? ev.target ?? undefined) as HTMLElement | undefined);
	}
}

function chooseFolder(folderToChoose: Misskey.entities.DriveFolder) {
	const isAlreadySelected = selectedFolders.value.some(f => f.id === folderToChoose.id);
	if (props.multiple) {
		if (isAlreadySelected) {
			selectedFolders.value = selectedFolders.value.filter(f => f.id !== folderToChoose.id);
		} else {
			selectedFolders.value.push(folderToChoose);
		}
	} else {
		if (isAlreadySelected) {
			//emit('selected', folderToChoose);
		} else {
			selectedFolders.value = [folderToChoose];
		}
	}
}

function unchoseFolder(folderToUnchose: Misskey.entities.DriveFolder) {
	selectedFolders.value = selectedFolders.value.filter(f => f.id !== folderToUnchose.id);
}

function cd(target?: Misskey.entities.DriveFolder | Misskey.entities.DriveFolder['id' | 'parentId']) {
	if (!target) {
		goRoot();
		return;
	} else if (typeof target === 'object') {
		target = target.id;
	}

	fetching.value = true;

	misskeyApi('drive/folders/show', {
		folderId: target,
	}).then(folderToMove => {
		folder.value = folderToMove;
		hierarchyFolders.value = [];

		const dive = (folderToDive: Misskey.entities.DriveFolder) => {
			hierarchyFolders.value.unshift(folderToDive);
			if (folderToDive.parent) dive(folderToDive.parent);
		};

		if (folderToMove.parent) dive(folderToMove.parent);

		initialize();
	});
}

async function moveFilesBulk() {
	if ((!props.select && fetching.value) || selectedFiles.value.length === 0 || bulkBusy.value || driveDeletionBusy.value) return;
	bulkBusy.value = true;
	const snapshot = [...selectedFiles.value];
	try {
		const { canceled, folders } = await selectDriveFolder(folder.value ? folder.value.id : null);
		if (canceled) return;
		const target = folders[0] ?? null;
		const closeWaiting = os.waiting();
		let result: Awaited<ReturnType<typeof runDriveFileBatches>>;
		try {
			result = await runDriveFileBatches(snapshot.map(file => file.id), fileIds => misskeyApi('drive/files/move-bulk', { fileIds, folderId: target?.id ?? null }));
		} finally {
			closeWaiting();
		}
		const moved = new Set(result.succeededIds);
		selectedFiles.value = selectedFiles.value.filter(file => !moved.has(file.id));
		globalEvents.emit('driveFilesUpdated', snapshot.filter(file => moved.has(file.id)).map(file => ({ ...file, folderId: target?.id ?? null, folder: target })));
		// 취소 시에는 재조회하지 않고, 실행 후에는 불러온 범위를 유지해 실패한 파일도 확인한다.
		await refreshFiles().catch(() => {});
		if (result.failedIds.length > 0) await os.alert({ type: 'warning', text: i18n.tsx._driveDeletion.moveResult({ moved: moved.size, failed: result.failedIds.length }) });
		else os.toast(i18n.ts.saved);
	} finally {
		bulkBusy.value = false;
	}
}

function goRoot() {
	// 既にrootにいるなら何もしない
	if (folder.value == null) return;

	folder.value = null;
	hierarchyFolders.value = [];
	initialize();
}

function getMenu() {
	const menu: MenuItem[] = [];

	menu.push({
		text: i18n.ts.addFile,
		type: 'label',
	}, {
		text: i18n.ts.upload,
		icon: 'ti ti-upload',
		action: () => {
			chooseFileFromPcAndUpload({
				multiple: true,
				folderId: folder.value?.id,
			});
		},
	}, {
		text: i18n.ts.fromUrl,
		icon: 'ti ti-link',
		action: () => { urlUpload(); },
	}, { type: 'divider' }, {
		text: folder.value ? folder.value.name : i18n.ts.drive,
		type: 'label',
	});

	menu.push({
		type: 'parent',
		text: i18n.ts.sort,
		icon: 'ti ti-arrows-sort',
		children: [{
			text: `${i18n.ts.registeredDate} (${i18n.ts.descendingOrder})`,
			icon: 'ti ti-sort-descending-letters',
			action: () => { store.set('driveSortMode', '+createdAt'); },
			active: sortModeSelect.value === '+createdAt',
		}, {
			text: `${i18n.ts.registeredDate} (${i18n.ts.ascendingOrder})`,
			icon: 'ti ti-sort-ascending-letters',
			action: () => { store.set('driveSortMode', '-createdAt'); },
			active: sortModeSelect.value === '-createdAt',
		}, {
			text: `${i18n.ts.driveSortSize} (${i18n.ts.descendingOrder})`,
			icon: 'ti ti-sort-descending-letters',
			action: () => { store.set('driveSortMode', '+size'); },
			active: sortModeSelect.value === '+size',
		}, {
			text: `${i18n.ts.driveSortSize} (${i18n.ts.ascendingOrder})`,
			icon: 'ti ti-sort-ascending-letters',
			action: () => { store.set('driveSortMode', '-size'); },
			active: sortModeSelect.value === '-size',
		}, {
			text: `${i18n.ts.name} (${i18n.ts.descendingOrder})`,
			icon: 'ti ti-sort-descending-letters',
			action: () => { store.set('driveSortMode', '+name'); },
			active: sortModeSelect.value === '+name',
		}, {
			text: `${i18n.ts.name} (${i18n.ts.ascendingOrder})`,
			icon: 'ti ti-sort-ascending-letters',
			action: () => { store.set('driveSortMode', '-name'); },
			active: sortModeSelect.value === '-name',
		}],
	});

	if (folder.value) {
		menu.push({
			text: i18n.ts.renameFolder,
			icon: 'ti ti-forms',
			action: () => { if (folder.value) renameFolder(folder.value); },
		}, {
			text: i18n.ts.deleteFolder,
			icon: 'ti ti-trash',
			action: () => { deleteFolder(folder.value as Misskey.entities.DriveFolder); },
		});
	}

	menu.push({
		text: i18n.ts.createFolder,
		icon: 'ti ti-folder-plus',
		action: () => { createFolder(); },
	}, { type: 'divider' }, {
		type: 'switch',
		text: i18n.ts.edit,
		icon: 'ti ti-pointer',
		ref: isEditMode,
	});

	return menu;
}

function showMenu(ev: PointerEvent) {
	os.popupMenu(getMenu(), (ev.currentTarget ?? ev.target ?? undefined) as HTMLElement | undefined, { repositionOnResize: true });
}

function onContextmenu(ev: PointerEvent) {
	os.contextMenu(getMenu(), ev);
}

function onFileDeleted(id: string) {
	selectedFiles.value = selectedFiles.value.filter(file => file.id !== id);
	const present = filesPaginator.items.value.some(item => item.id === id);
	if (present) filesPaginator.removeItem(id);
	if (refreshingFiles || (present && (fetching.value || loadingMoreFiles))) scheduleFilesRefresh();
}

function onFolderDeleted(id: string) {
	const present = foldersPaginator.items.value.some(item => item.id === id);
	if (present) foldersPaginator.removeItem(id);
	if (refreshingFolders || (present && (fetching.value || loadingMoreFolders))) scheduleFoldersRefresh();
}

useGlobalEvent('driveFileCreated', file => { onFileCreated(file, true); });
useGlobalEvent('driveFilesUpdated', onFilesUpdated);
useGlobalEvent('driveFilesDeleted', files => { for (const file of files) onFileDeleted(file.id); });
useGlobalEvent('driveFoldersUpdated', onFoldersUpdated);
useGlobalEvent('driveFoldersDeleted', folders => { for (const item of folders) onFolderDeleted(item.id); });

let connection: Misskey.IChannelConnection<Misskey.Channels['drive']> | null = null;

onMounted(() => {
	if (store.s.realtimeMode) {
		connection = useStream().useChannel('drive');
		connection.on('fileCreated', file => { onFileCreated(file); });
		connection.on('fileUpdated', file => { onFilesUpdated([file]); });
		connection.on('fileDeleted', onFileDeleted);
		connection.on('folderCreated', item => { onFoldersUpdated([item]); });
		connection.on('folderUpdated', item => { onFoldersUpdated([item]); });
		connection.on('folderDeleted', onFolderDeleted);
	}

	if (props.initialFolder) {
		cd(props.initialFolder);
	} else {
		initialize();
	}
});

onActivated(() => {
});

onBeforeUnmount(() => {
	listGeneration++;
	scheduleFilesRefresh.cancel();
	scheduleFoldersRefresh.cancel();
	notifyUploadedOutsidePage.cancel();
	if (connection != null) {
		connection.dispose();
	}
});
</script>

<style lang="scss" module>
.transition_files_move,
.transition_files_enterActive,
.transition_files_leaveActive {
	transition: all 0.2s ease;
}
.transition_files_enterFrom,
.transition_files_leaveTo {
	opacity: 0;
}
.transition_files_leaveActive {
	position: absolute;
}

.nav {
	display: flex;
	width: 100%;
	padding: 0 8px;
	box-sizing: border-box;
	overflow: auto;
	font-size: 0.9em;
	background: color(from var(--MI_THEME-bg) srgb r g b / 0.75);
	-webkit-backdrop-filter: var(--MI-blur, blur(15px));
	backdrop-filter: var(--MI-blur, blur(15px));
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}

.navPath {
	display: inline-block;
	vertical-align: bottom;
	line-height: 42px;
	white-space: nowrap;
}

.navPathItem {
	display: inline-block;
	margin: 0;
	padding: 0 8px;
	line-height: 42px;
	cursor: pointer;

	&:hover {
		text-decoration: underline;
	}

	&.navCurrent {
		font-weight: bold;
		cursor: default;

		&:hover {
			text-decoration: none;
		}
	}

	&.navSeparator {
		margin: 0;
		padding: 0;
		opacity: 0.5;
		cursor: default;
	}
}

.navMenu {
	margin-left: auto;
	padding: 0 12px;
}

.main {
	min-height: 100cqh;
	user-select: none;

	&.fetching {
		cursor: wait !important;
		opacity: 0.5;
		pointer-events: none;
	}
}

.tipContainer:not(:empty) {
	padding: 16px 32px;
}

.folders,
.files {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
	grid-gap: 12px;
	padding: 16px 32px;
}

@container (max-width: 600px) {
	.tipContainer:not(:empty) {
		padding: 16px;
	}

	.folders,
	.files {
		padding: 16px;
	}
}

.date {
	padding: 8px 16px;
	font-size: 90%;
	-webkit-backdrop-filter: var(--MI-blur, blur(8px));
	backdrop-filter: var(--MI-blur, blur(8px));
	background-color: color(from var(--MI_THEME-bg) srgb r g b / 0.85);
}

.loadMore {
	margin: 16px auto;
}

.footer {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px;
	padding: 8px 16px;
	font-size: 90%;
	-webkit-backdrop-filter: var(--MI-blur, blur(8px));
	backdrop-filter: var(--MI-blur, blur(8px));
	background-color: color(from var(--MI_THEME-bg) srgb r g b / 0.85);
}

.empty {
	padding: 16px;
	text-align: center;
	pointer-events: none;
	opacity: 0.5;
}

.dropzone {
	position: absolute;
	left: 0;
	top: 38px;
	width: 100%;
	height: calc(100% - 38px);
	border: dashed 2px var(--MI_THEME-focus);
	pointer-events: none;
}
</style>
