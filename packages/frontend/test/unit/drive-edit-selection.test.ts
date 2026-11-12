/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import type * as Misskey from 'cherrypick-js';

vi.mock('@/store.js', async () => ({ store: { s: { realtimeMode: false }, r: { driveSortMode: (await import('vue')).ref('+name') } } }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ enableInfiniteScroll: false, animation: false }) }));
vi.mock('@/i.js', () => ({ $i: { token: 'unit-token' } }));
vi.mock('@/os.js', () => ({ waiting: () => () => {}, toast: vi.fn(), alert: vi.fn(), confirm: vi.fn(), contextMenu: vi.fn() }));
vi.mock('@/utility/drive.js', () => ({ chooseFileFromPcAndUpload: vi.fn(), selectDriveFolder: vi.fn() }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/get-drive-file-menu.js', () => ({ getDriveFileMenu: vi.fn() }));
vi.mock('@/stream.js', () => ({ useStream: vi.fn() }));
vi.mock('@/components/MkDrive.file.vue', () => ({ default: { props: ['file', 'isSelected'], template: '<button :aria-pressed="isSelected">{{ file.name }}</button>' } }));
vi.mock('@/components/MkDrive.folder.vue', () => ({ default: { props: ['folder'], template: '<button>{{ folder.name }}</button>' } }));
vi.mock('@/components/MkDrive.navFolder.vue', () => ({ default: { props: ['folder'], template: '<button>{{ folder ? folder.name : "Drive" }}</button>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' } }));

import MkDrive from '@/components/MkDrive.vue';
import * as os from '@/os.js';
import { globalEvents } from '@/events.js';
import { store } from '@/store.js';
import { selectDriveFolder } from '@/utility/drive.js';
import { driveDeletionBusy } from '@/utility/drive-delete.js';
import { pendingApiRequestsCount } from '@/utility/misskey-api.js';

const sand = { id: 'sand', name: 'Sand', parentId: null, parent: null } as Misskey.entities.DriveFolder;
const wind = { id: 'wind', name: 'Wind', parentId: null, parent: null } as Misskey.entities.DriveFolder;
const inner = { id: 'inner', name: 'Inner', parentId: sand.id, parent: sand } as Misskey.entities.DriveFolder;
const folders = [sand, wind, inner];
const original = [
	{ id: 'light', name: 'Light.png', folderId: sand.id },
	{ id: 'face', name: 'Face.png', folderId: wind.id },
	{ id: 'nested', name: 'Nested.png', folderId: inner.id },
	{ id: 'one', name: 'One.png', folderId: null },
	{ id: 'two', name: 'Two.png', folderId: null },
].map(file => ({ ...file, createdAt: '2026-11-11T00:00:00Z', type: 'image/png', size: 1 } as Misskey.entities.DriveFile));
let files: Misskey.entities.DriveFile[];
let preparedIds: string[];
let failMove: boolean;
let failFileList: boolean;
let failedMoveBatch: number | undefined;
let moveBatchCount: number;
let fileListGate: Promise<void> | undefined;
let failedDeleteIds: Set<string>;
let failPrepare: boolean;

beforeEach(() => {
	vi.clearAllMocks();
	files = original.map(file => ({ ...file }));
	preparedIds = [];
	failMove = false;
	failFileList = false;
	failedMoveBatch = undefined;
	moveBatchCount = 0;
	fileListGate = undefined;
	failedDeleteIds = new Set();
	failPrepare = false;
	store.r.driveSortMode.value = '+name';
	vi.mocked(os.confirm).mockResolvedValue({ canceled: false });
	fetchMock.resetMocks();
	fetchMock.doMock();
	vi.spyOn(window, 'fetch').mockImplementation(fetchMock);
	fetchMock.mockResponse(async request => {
		const endpoint = new URL(request.url).pathname;
		const params = await request.json();
		if (endpoint === '/api/drive/files') {
			await fileListGate;
			if (failFileList) return { status: 500, body: JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }) };
			const folderFiles = files.filter(file => file.folderId === params.folderId);
			const offset = params.untilId == null ? 0 : folderFiles.findIndex(file => file.id === params.untilId) + 1;
			return JSON.stringify(folderFiles.slice(offset, offset + params.limit));
		}
		if (endpoint === '/api/drive/folders') return JSON.stringify(folders.filter(folder => folder.parentId === params.folderId));
		if (endpoint === '/api/drive/folders/show') return JSON.stringify(folders.find(folder => folder.id === params.folderId));
		if (endpoint === '/api/drive/delete/prepare') {
			if (failPrepare) return { status: 500, body: JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }) };
			preparedIds = params.fileIds ?? files.filter(file => file.folderId === params.folderId).map(file => file.id);
			return JSON.stringify({ operationId: 'operation', totalCount: preparedIds.length });
		}
		if (endpoint === '/api/drive/delete/execute') {
			const deletedIds = preparedIds.filter(id => !failedDeleteIds.has(id));
			const failedCount = preparedIds.length - deletedIds.length;
			files = files.filter(file => !deletedIds.includes(file.id));
			return JSON.stringify({
				operationId: 'operation', totalCount: preparedIds.length, deletedCount: deletedIds.length,
				missingCount: 0, failedCount, remainingCount: failedCount, remainingFoldersCount: 0,
				deletedIds, missingIds: [], deletedFolderIds: [], missingFolderIds: [], folderDeleted: false, done: true,
			});
		}
		if (endpoint === '/api/drive/files/move-bulk') {
			moveBatchCount++;
			if (failMove || moveBatchCount === failedMoveBatch) return { status: 500, body: JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }) };
			files = files.map(file => params.fileIds.includes(file.id) ? { ...file, folderId: params.folderId } : file);
			return { status: 204, body: '' };
		}
		throw new Error(`Unexpected ${endpoint}`);
	});
});

afterEach(cleanup);

function drive(props = {}) {
	return render(MkDrive, {
		props,
		global: {
			stubs: { MkStickyContainer: { template: '<div><slot name="header"/><slot/><slot name="footer"/></div>' }, MkTip: true, MkLoading: true },
			directives: { anim: {}, appear: {} },
		},
	});
}

function requests(endpoint: string) {
	return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(`/api/${endpoint}`)).map(([, options]) => JSON.parse(String(options?.body)));
}

function expectCount(screen: ReturnType<typeof drive>, count: number) {
	expect(screen.getByRole('status').textContent).toMatch(new RegExp(`\\b${count}$`));
}

async function selectAcrossFolders(screen: ReturnType<typeof drive>, shiftKey: boolean) {
	await fireEvent.click(await screen.findByRole('button', { name: 'Sand' }));
	await fireEvent.click(await screen.findByRole('button', { name: 'Light.png' }), { shiftKey });
	await fireEvent.click(screen.getByRole('button', { name: 'Drive' }));
	await fireEvent.click(await screen.findByRole('button', { name: 'Wind' }));
	await fireEvent.click(await screen.findByRole('button', { name: 'Face.png' }));
}

test('folder navigation limits the visible count, confirmation and delete request to the current folder', async () => {
	const screen = drive();
	await selectAcrossFolders(screen, true);

	expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
	const countBeforeDelete = screen.getByRole('status').textContent;
	await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

	await waitFor(() => expect(requests('drive/delete/execute')).toHaveLength(1));
	expect(requests('drive/delete/prepare')).toEqual([{ fileIds: ['face'], i: 'unit-token' }]);
	expect(countBeforeDelete).toMatch(/\b1$/);
	expect(vi.mocked(os.confirm).mock.calls[0][0].text).toContain('1');
	expect(files.map(file => file.id)).toContain('light');
	await waitFor(() => expectCount(screen, 0));
});

test('root and ancestor breadcrumbs clear edit selection before choosing files in another folder', async () => {
	const screen = drive({ initialFolder: inner.id });
	await fireEvent.click(await screen.findByRole('button', { name: 'Nested.png' }), { shiftKey: true });
	await fireEvent.click(screen.getByRole('button', { name: 'Sand' }));
	await screen.findByRole('button', { name: 'Light.png' });

	expectCount(screen, 0);
	expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(true);
	expect(screen.getByRole('button', { name: /Move/ }).hasAttribute('disabled')).toBe(true);
	await fireEvent.click(screen.getByRole('button', { name: 'Light.png' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Drive' }));
	await screen.findByRole('button', { name: 'One.png' });

	expectCount(screen, 0);
	await fireEvent.click(screen.getByRole('button', { name: 'Sand' }));
	await screen.findByRole('button', { name: 'Light.png' });
	expect(screen.getByRole('button', { name: 'Light.png' }).getAttribute('aria-pressed')).toBe('false');
});

test('bulk move after folder navigation only submits the visible selection', async () => {
	const screen = drive();
	await selectAcrossFolders(screen, true);
	vi.mocked(selectDriveFolder).mockResolvedValue({ canceled: false, folders: [sand] });
	await fireEvent.click(screen.getByRole('button', { name: /Move/ }));

	await waitFor(() => expect(requests('drive/files/move-bulk')).toHaveLength(1));
	expect(requests('drive/files/move-bulk')).toEqual([{ fileIds: ['face'], folderId: sand.id, i: 'unit-token' }]);
});

test.each(['+createdAt', '+name'] as const)('list updates in %s order remove hidden edit selection and keep visible selection', async sort => {
	store.r.driveSortMode.value = sort;
	const screen = drive();
	await fireEvent.click(await screen.findByRole('button', { name: 'One.png' }), { shiftKey: true });
	await fireEvent.click(screen.getByRole('button', { name: 'Two.png' }));
	const moved = { ...files.find(file => file.id === 'one')!, folderId: wind.id };
	files = files.map(file => file.id === moved.id ? moved : file);
	globalEvents.emit('driveFilesUpdated', [moved]);

	await waitFor(() => expect(screen.queryByRole('button', { name: 'One.png' })).toBeNull());
	expectCount(screen, 1);
	expect(screen.getByRole('button', { name: 'Two.png' }).getAttribute('aria-pressed')).toBe('true');
	vi.mocked(os.confirm).mockResolvedValue({ canceled: true });
	await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

	await waitFor(() => expect(os.confirm).toHaveBeenCalledOnce());
	expect(requests('drive/delete/prepare')).toEqual([{ fileIds: ['two'], i: 'unit-token' }]);
	expect(requests('drive/delete/execute')).toHaveLength(0);
	await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(false));
	expectCount(screen, 1);
});

test('sort reload removes files outside the loaded list while keeping visible edit selection', async () => {
	const screen = drive();
	await fireEvent.click(await screen.findByRole('button', { name: 'One.png' }), { shiftKey: true });
	await fireEvent.click(screen.getByRole('button', { name: 'Two.png' }));
	files = files.filter(file => file.id !== 'one');
	store.r.driveSortMode.value = '+size';

	await waitFor(() => expect(screen.queryByRole('button', { name: 'One.png' })).toBeNull());
	await screen.findByRole('button', { name: 'Two.png' });
	await waitFor(() => expectCount(screen, 1));
	expect(screen.getByRole('button', { name: 'Two.png' }).getAttribute('aria-pressed')).toBe('true');
});

test('failed bulk move keeps visible files selected for retry after reloading', async () => {
	const screen = drive();
	await fireEvent.click(await screen.findByRole('button', { name: 'One.png' }), { shiftKey: true });
	failMove = true;
	vi.mocked(selectDriveFolder).mockResolvedValue({ canceled: false, folders: [sand] });
	await fireEvent.click(screen.getByRole('button', { name: /Move/ }));

	await waitFor(() => expect(os.alert).toHaveBeenCalledOnce());
	await screen.findByRole('button', { name: 'One.png' });
	expectCount(screen, 1);
	expect(screen.getByRole('button', { name: 'One.png' }).getAttribute('aria-pressed')).toBe('true');
});

async function selectPaginatedFiles(count = 103) {
	files = Array.from({ length: 103 }, (_, index) => ({
		...original[0],
		id: `piece-${String(103 - index).padStart(3, '0')}`,
		name: `Piece-${String(103 - index).padStart(3, '0')}.png`,
	}));
	const screen = drive({ initialFolder: sand.id });
	await screen.findByRole('button', { name: 'Piece-103.png' });

	for (const loaded of [60, 90, 103]) {
		await fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
		await waitFor(() => expect(screen.getAllByRole('button', { name: /^Piece-/ })).toHaveLength(loaded));
	}
	const cards = screen.getAllByRole('button', { name: /^Piece-/ });
	for (const card of cards.slice(0, count)) await fireEvent.click(card, { shiftKey: true });
	expectCount(screen, count);
	return screen;
}

test.each([
	{ sort: '+createdAt', failed: 103 },
	{ sort: '+name', failed: 103 },
	{ sort: '+createdAt', failed: 100 },
	{ sort: '+name', failed: 100 },
] as const)('delete failures in $sort order retain all $failed selections for retry', async ({ sort, failed }) => {
	store.r.driveSortMode.value = sort;
	const screen = await selectPaginatedFiles();
	const retryIds = files.slice(0, failed).map(file => file.id);
	failedDeleteIds = new Set(retryIds);

	await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
	await waitFor(() => expect(os.alert).toHaveBeenCalledOnce());
	await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(false));
	await waitFor(() => expect(pendingApiRequestsCount.value).toBe(0));

	expectCount(screen, failed);
	expect(screen.getAllByRole('button', { name: /^Piece-/, pressed: true })).toHaveLength(failed);
	expect(files.map(file => file.id)).toEqual(retryIds);
	failedDeleteIds.clear();
	await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
	await waitFor(() => expectCount(screen, 0));
	expect(requests('drive/delete/prepare').at(-1).fileIds).toEqual(retryIds);
});

test.each([
	{ sort: '+createdAt', prepareFails: false },
	{ sort: '+name', prepareFails: false },
	{ sort: '+createdAt', prepareFails: true },
	{ sort: '+name', prepareFails: true },
] as const)('current-folder deletion in $sort order preserves 103 selections without a result (prepare failure: $prepareFails)', async ({ sort, prepareFails }) => {
	store.r.driveSortMode.value = sort;
	const screen = await selectPaginatedFiles();
	const fileQueries = requests('drive/files').length;
	const folderQueries = requests('drive/folders').length;
	failPrepare = prepareFails;
	vi.mocked(os.confirm).mockResolvedValue({ canceled: true });

	await fireEvent.contextMenu(screen.getByRole('button', { name: 'Piece-103.png' }));
	const menu = vi.mocked(os.contextMenu).mock.calls.at(-1)![0];
	const item = menu.find(entry => entry && typeof entry === 'object' && 'text' in entry && entry.text === 'Delete this folder');
	if (!item || typeof item !== 'object' || !('action' in item) || !item.action) throw new Error('Folder delete action missing');
	item.action(new PointerEvent('click'));
	await waitFor(() => expect(requests('drive/delete/prepare')).toHaveLength(1));
	await waitFor(() => expect(driveDeletionBusy.value).toBe(false));
	await waitFor(() => expect(pendingApiRequestsCount.value).toBe(0));

	expectCount(screen, 103);
	expect(screen.getAllByRole('button', { name: /^Piece-/, pressed: true })).toHaveLength(103);
	expect(requests('drive/delete/execute')).toHaveLength(0);
	expect(requests('drive/files')).toHaveLength(fileQueries);
	expect(requests('drive/folders')).toHaveLength(folderQueries);
});

test.each(['+createdAt', '+name'] as const)('canceling a delete in %s order preserves all 103 selections for the next confirmation', async sort => {
	store.r.driveSortMode.value = sort;
	const screen = await selectPaginatedFiles();
	const selectedIds = files.map(file => file.id);
	const fileQueries = requests('drive/files').length;
	const folderQueries = requests('drive/folders').length;
	vi.mocked(os.confirm).mockResolvedValueOnce({ canceled: true });

	await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
	await waitFor(() => expect(os.confirm).toHaveBeenCalledOnce());
	await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(false));

	expectCount(screen, 103);
	expect(screen.getAllByRole('button', { name: /^Piece-/, pressed: true })).toHaveLength(103);
	expect(requests('drive/delete/prepare').map(body => body.fileIds)).toEqual([selectedIds]);
	expect(requests('drive/delete/execute')).toHaveLength(0);
	expect(requests('drive/files')).toHaveLength(fileQueries);
	expect(requests('drive/folders')).toHaveLength(folderQueries);
	expect(files.map(file => file.id)).toEqual(selectedIds);

	await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
	await waitFor(() => expect(requests('drive/delete/execute')).toHaveLength(1));
	await waitFor(() => expectCount(screen, 0));
	await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Piece-/ })).toHaveLength(0));

	expect(vi.mocked(os.confirm).mock.calls.map(([options]) => options.text)).toEqual([
		expect.stringContaining('103'),
		expect.stringContaining('103'),
	]);
	expect(requests('drive/delete/prepare').map(body => body.fileIds)).toEqual([selectedIds, selectedIds]);
	expect(files).toHaveLength(0);
});

test.each(['+createdAt', '+name'] as const)('canceling a move in %s order preserves all 103 loaded cards and selections without reloading', async sort => {
	store.r.driveSortMode.value = sort;
	const screen = await selectPaginatedFiles();
	const fileQueries = requests('drive/files').length;
	const folderQueries = requests('drive/folders').length;
	vi.mocked(selectDriveFolder).mockResolvedValue({ canceled: true, folders: undefined });

	await fireEvent.click(screen.getByRole('button', { name: /Move/ }));
	await waitFor(() => expect(screen.getByRole('button', { name: /Move/ }).hasAttribute('disabled')).toBe(false));

	expectCount(screen, 103);
	expect(screen.getAllByRole('button', { name: /^Piece-/, pressed: true })).toHaveLength(103);
	expect(requests('drive/files/move-bulk')).toHaveLength(0);
	expect(requests('drive/files')).toHaveLength(fileQueries);
	expect(requests('drive/folders')).toHaveLength(folderQueries);
});

test.each(['+createdAt', '+name'] as const)('paginated bulk moves in %s order retain all unmoved cards and failed selections', async sort => {
	store.r.driveSortMode.value = sort;
	const screen = await selectPaginatedFiles();
	const selectedIds = files.map(file => file.id);
	failMove = true;
	vi.mocked(selectDriveFolder).mockResolvedValue({ canceled: false, folders: [wind] });

	await fireEvent.click(screen.getByRole('button', { name: /Move/ }));
	await waitFor(() => expect(screen.getByRole('button', { name: /Move/ }).hasAttribute('disabled')).toBe(false));

	expectCount(screen, 103);
	expect(screen.getAllByRole('button', { name: /^Piece-/, pressed: true })).toHaveLength(103);
	expect(requests('drive/files/move-bulk').map(body => body.fileIds)).toEqual([selectedIds.slice(0, 100), selectedIds.slice(100)]);
});

test('a failed list refresh after a failed move still reports the result and allows retry', async () => {
	const screen = await selectPaginatedFiles();
	failMove = true;
	failFileList = true;
	vi.mocked(selectDriveFolder).mockResolvedValue({ canceled: false, folders: [wind] });

	await fireEvent.click(screen.getByRole('button', { name: /Move/ }));
	await waitFor(() => expect(os.alert).toHaveBeenCalledOnce());
	await waitFor(() => expect(screen.getByRole('button', { name: /Move/ }).hasAttribute('disabled')).toBe(false));

	expectCount(screen, 103);
	expect(screen.getAllByRole('button', { name: /^Piece-/, pressed: true })).toHaveLength(103);
	failMove = false;
	failFileList = false;
	await fireEvent.click(screen.getByRole('button', { name: /Move/ }));

	await waitFor(() => expectCount(screen, 0));
	await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Piece-/ })).toHaveLength(0));
});

test.each([
	{ sort: '+createdAt', failedBatch: 1, remaining: 100 },
	{ sort: '+name', failedBatch: 1, remaining: 100 },
	{ sort: '+createdAt', failedBatch: 2, remaining: 3 },
	{ sort: '+name', failedBatch: 2, remaining: 3 },
] as const)('partial move in $sort order keeps $remaining failed files selected and visible for retry', async ({ sort, failedBatch, remaining }) => {
	store.r.driveSortMode.value = sort;
	const screen = await selectPaginatedFiles();
	const selectedIds = files.map(file => file.id);
	failedMoveBatch = failedBatch;
	vi.mocked(selectDriveFolder).mockResolvedValue({ canceled: false, folders: [wind] });

	await fireEvent.click(screen.getByRole('button', { name: /Move/ }));
	await waitFor(() => expect(screen.getByRole('button', { name: /Move/ }).hasAttribute('disabled')).toBe(false));
	await waitFor(() => expect(screen.getAllByRole('button', { name: /^Piece-/ })).toHaveLength(remaining));

	expectCount(screen, remaining);
	expect(screen.getAllByRole('button', { name: /^Piece-/, pressed: true })).toHaveLength(remaining);
	expect(requests('drive/files/move-bulk').map(body => body.fileIds)).toEqual([selectedIds.slice(0, 100), selectedIds.slice(100)]);
	const retryIds = failedBatch === 1 ? selectedIds.slice(0, 100) : selectedIds.slice(100);
	await fireEvent.click(screen.getByRole('button', { name: /Move/ }));

	await waitFor(() => expectCount(screen, 0));
	await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Piece-/ })).toHaveLength(0));
	expect(requests('drive/files/move-bulk').at(-1).fileIds).toEqual(retryIds);
});

test.each([
	{ sort: '+createdAt', selected: 103, remaining: 0 },
	{ sort: '+name', selected: 103, remaining: 0 },
	{ sort: '+createdAt', selected: 63, remaining: 40 },
	{ sort: '+name', selected: 63, remaining: 40 },
] as const)('successful move of $selected files in $sort order keeps all $remaining unselected cards loaded', async ({ sort, selected, remaining }) => {
	store.r.driveSortMode.value = sort;
	const screen = await selectPaginatedFiles(selected);
	vi.mocked(selectDriveFolder).mockResolvedValue({ canceled: false, folders: [wind] });

	await fireEvent.click(screen.getByRole('button', { name: /Move/ }));
	await waitFor(() => expectCount(screen, 0));
	await waitFor(() => expect(os.toast).toHaveBeenCalledOnce());
	await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Piece-/ })).toHaveLength(remaining));

	expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(true);
	expect(screen.queryAllByRole('button', { name: /^Piece-/, pressed: true })).toHaveLength(0);
	expect(files.filter(file => file.folderId === wind.id)).toHaveLength(selected);
});

test('bulk actions wait until reloading resolves which selected files are still visible', async () => {
	const screen = drive();
	await fireEvent.click(await screen.findByRole('button', { name: 'One.png' }), { shiftKey: true });
	let release!: () => void;
	fileListGate = new Promise<void>(resolve => { release = resolve; });
	store.r.driveSortMode.value = '+size';

	try {
		await waitFor(() => expect(screen.queryByRole('button', { name: 'One.png' })).toBeNull());
		expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(true);
		expect(screen.getByRole('button', { name: /Move/ }).hasAttribute('disabled')).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await fireEvent.click(screen.getByRole('button', { name: /Move/ }));

		expect(requests('drive/delete/prepare')).toHaveLength(0);
		expect(selectDriveFolder).not.toHaveBeenCalled();
	} finally {
		release();
	}

	await screen.findByRole('button', { name: 'One.png' });
	expectCount(screen, 1);
	await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(false));
});

test.each([false, true])('multiple attachment selection across folders is preserved with shift selection %s', async shiftKey => {
	const screen = drive({ select: 'file', multiple: true });
	await selectAcrossFolders(screen, shiftKey);

	const selections = screen.emitted('changeSelectedFiles') as [Misskey.entities.DriveFile[]][];
	expect(selections.at(-1)?.[0].map(file => file.id)).toEqual(['light', 'face']);
	expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
});

test('single attachment selection still replaces the previous folder selection', async () => {
	const screen = drive({ select: 'file' });
	await selectAcrossFolders(screen, false);

	const selections = screen.emitted('changeSelectedFiles') as [Misskey.entities.DriveFile[]][];
	expect(selections.at(-1)?.[0].map(file => file.id)).toEqual(['face']);
	expect(screen.queryByRole('status')).toBeNull();
});
