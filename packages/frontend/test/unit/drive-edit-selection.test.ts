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
vi.mock('@/os.js', () => ({ waiting: () => () => {}, toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }));
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
let fileListGate: Promise<void> | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	files = original.map(file => ({ ...file }));
	preparedIds = [];
	failMove = false;
	fileListGate = undefined;
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
			return JSON.stringify(files.filter(file => file.folderId === params.folderId));
		}
		if (endpoint === '/api/drive/folders') return JSON.stringify(folders.filter(folder => folder.parentId === params.folderId));
		if (endpoint === '/api/drive/folders/show') return JSON.stringify(folders.find(folder => folder.id === params.folderId));
		if (endpoint === '/api/drive/delete/prepare') {
			preparedIds = params.fileIds;
			return JSON.stringify({ operationId: 'operation', totalCount: preparedIds.length });
		}
		if (endpoint === '/api/drive/delete/execute') {
			files = files.filter(file => !preparedIds.includes(file.id));
			return JSON.stringify({
				operationId: 'operation', totalCount: preparedIds.length, deletedCount: preparedIds.length,
				missingCount: 0, failedCount: 0, remainingCount: 0, remainingFoldersCount: 0,
				deletedIds: preparedIds, missingIds: [], deletedFolderIds: [], missingFolderIds: [], folderDeleted: false, done: true,
			});
		}
		if (endpoint === '/api/drive/files/move-bulk') {
			if (failMove) return { status: 500, body: JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }) };
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
