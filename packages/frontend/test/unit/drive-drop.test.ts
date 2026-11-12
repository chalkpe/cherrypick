/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/vue';
import type * as Misskey from 'cherrypick-js';

vi.mock('@/store.js', async () => ({ store: { s: { realtimeMode: false }, r: { driveSortMode: (await import('vue')).ref('+name') } } }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ enableInfiniteScroll: false, animation: false }) }));
vi.mock('@/i.js', () => ({ $i: { token: 'unit-token' } }));
vi.mock('@/os.js', () => ({ waiting: () => () => {}, toast: vi.fn(), alert: vi.fn() }));
vi.mock('@/utility/drive.js', () => ({ chooseFileFromPcAndUpload: vi.fn(), selectDriveFolder: vi.fn() }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/get-drive-file-menu.js', () => ({ getDriveFileMenu: vi.fn() }));
vi.mock('@/stream.js', () => ({ useStream: vi.fn() }));
vi.mock('@/components/MkDrive.file.vue', () => ({ default: { props: ['file', 'isSelected'], template: '<button :aria-pressed="isSelected">{{ file.name }}</button>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' } }));

import MkDrive from '@/components/MkDrive.vue';
import * as os from '@/os.js';
import { store } from '@/store.js';
import { globalEvents } from '@/events.js';

const sand = { id: 'sand', name: 'Sand', parentId: null, parent: null } as Misskey.entities.DriveFolder;
const wind = { id: 'wind', name: 'Wind', parentId: sand.id, parent: sand } as Misskey.entities.DriveFolder;
const folders = [sand, wind];
let files: Misskey.entities.DriveFile[];
let failedBatches: number[];
let batches: number;

beforeEach(() => {
	vi.clearAllMocks();
	failedBatches = [];
	batches = 0;
	store.r.driveSortMode.value = '+name';
	files = Array.from({ length: 103 }, (_, index) => ({
		id: `piece-${String(103 - index).padStart(3, '0')}`,
		name: `Piece-${String(103 - index).padStart(3, '0')}.png`,
		folderId: sand.id, createdAt: '2026-11-11T00:00:00Z', type: 'image/png', size: 1,
	} as Misskey.entities.DriveFile));
	fetchMock.resetMocks();
	fetchMock.doMock();
	vi.spyOn(window, 'fetch').mockImplementation(fetchMock);
	fetchMock.mockResponse(async request => {
		const endpoint = new URL(request.url).pathname;
		const params = await request.json();
		if (endpoint === '/api/drive/files') {
			const folderFiles = files.filter(file => file.folderId === params.folderId);
			const offset = params.untilId == null ? 0 : folderFiles.findIndex(file => file.id === params.untilId) + 1;
			return JSON.stringify(folderFiles.slice(offset, offset + params.limit));
		}
		if (endpoint === '/api/drive/folders') return JSON.stringify(folders.filter(folder => folder.parentId === params.folderId));
		if (endpoint === '/api/drive/folders/show') return JSON.stringify(folders.find(folder => folder.id === params.folderId));
		if (endpoint === '/api/drive/files/move-bulk') {
			batches++;
			if (params.fileIds.length > 100) return { status: 400, body: JSON.stringify({ error: { code: 'INVALID_PARAM' } }) };
			if (failedBatches.includes(batches)) return { status: 500, body: JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }) };
			files = files.map(file => params.fileIds.includes(file.id) ? { ...file, folderId: params.folderId } : file);
			return { status: 204, body: '' };
		}
		if (endpoint === '/api/drive/folders/update') return JSON.stringify({ ...folders.find(folder => folder.id === params.folderId), parentId: params.parentId });
		throw new Error(`Unexpected ${endpoint}`);
	});
});

afterEach(cleanup);

function drive(initialFolder = sand.id) {
	return render(MkDrive, {
		props: { initialFolder },
		global: {
			stubs: { MkStickyContainer: { template: '<div><slot name="header"/><slot/><slot name="footer"/></div>' }, MkTip: true, MkLoading: true },
			directives: { anim: {}, appear: {} },
		},
	});
}

function requests(endpoint = 'drive/files/move-bulk') {
	return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(`/api/${endpoint}`)).map(([, options]) => JSON.parse(String(options?.body)));
}

async function source(count = 103) {
	const screen = drive();
	const view = within(screen.container as HTMLElement);
	await view.findByRole('button', { name: 'Piece-103.png' });
	if (count > 30) {
		for (const loaded of [60, 90, 103]) {
			await fireEvent.click(await view.findByRole('button', { name: 'Load more' }));
			await waitFor(() => expect(view.getAllByRole('button', { name: /^Piece-/ })).toHaveLength(loaded));
		}
	}
	for (const card of view.getAllByRole('button', { name: /^Piece-/ }).slice(0, count)) await fireEvent.click(card, { shiftKey: true });
	return { ...screen, view };
}

type Target = 'folder card' | 'breadcrumb' | 'other window';

async function target(screen: Awaited<ReturnType<typeof source>>, kind: Target) {
	if (kind === 'folder card') return { element: screen.view.getByTitle('Wind'), folderId: wind.id };
	if (kind === 'breadcrumb') return { element: screen.view.getByText('Drive').parentElement!, folderId: null };
	const other = drive(wind.id);
	const otherView = within(other.container as HTMLElement);
	await otherView.findByText('This folder is empty');
	return { element: otherView.getByText('This folder is empty').parentElement!.parentElement!, folderId: wind.id };
}

const targets: Target[] = ['folder card', 'breadcrumb', 'other window'];
const cases = targets.flatMap(kind => [
	{ kind, failed: [] as number[], remaining: 0 },
	{ kind, failed: [1], remaining: 100 },
	{ kind, failed: [2], remaining: 3 },
	{ kind, failed: [1, 2], remaining: 103 },
]);

test.each(cases)('dropping 103 files on $kind retains $remaining failures and retries only those files', async ({ kind, failed, remaining }) => {
	const screen = await source();
	const { element, folderId } = await target(screen, kind);
	const selectedIds = files.map(file => file.id);
	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(screen.view.getByRole('button', { name: 'Piece-103.png' }), { dataTransfer });
	failedBatches = failed;
	const updates = vi.fn();
	globalEvents.on('driveFilesUpdated', updates);
	try {
		await fireEvent.drop(element, { dataTransfer });
		await waitFor(() => expect(requests()).toHaveLength(2));
		await waitFor(() => expect(vi.mocked(os.alert).mock.calls.length + vi.mocked(os.toast).mock.calls.length).toBe(1));

		expect(requests().map(body => body.fileIds)).toEqual([selectedIds.slice(0, 100), selectedIds.slice(100)]);
		expect(requests().map(body => body.folderId)).toEqual([folderId, folderId]);
		await waitFor(() => expect(screen.view.queryAllByRole('button', { name: /^Piece-/, pressed: true })).toHaveLength(remaining));
		expect(files.filter(file => file.folderId === folderId)).toHaveLength(103 - remaining);
		const movedIds = updates.mock.calls.flatMap(([updated]) => updated.map((file: Misskey.entities.DriveFile) => file.id));
		const retryIds = selectedIds.filter(id => !movedIds.includes(id));
		expect(movedIds).toHaveLength(103 - remaining);
		if (remaining === 0) {
			expect(os.alert).not.toHaveBeenCalled();
			return;
		}
		expect(vi.mocked(os.alert).mock.calls[0][0]).toMatchObject({ type: 'warning', text: expect.stringContaining(String(remaining)) });
		failedBatches = [];
		const retryTransfer = new DataTransfer();
		await fireEvent.dragStart(screen.view.getByRole('button', { name: files.find(file => file.id === retryIds[0])!.name }), { dataTransfer: retryTransfer });
		await fireEvent.drop(element, { dataTransfer: retryTransfer });

		await waitFor(() => expect(screen.view.queryAllByRole('button', { name: /^Piece-/, pressed: true })).toHaveLength(0));
		expect(requests().slice(2).flatMap(body => body.fileIds)).toEqual(retryIds);
	} finally {
		globalEvents.off('driveFilesUpdated', updates);
	}
});

test.each(targets)('a single file dropped on %s keeps its destination and updates the source list', async kind => {
	const screen = await source(1);
	const { element, folderId } = await target(screen, kind);
	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(screen.view.getByRole('button', { name: 'Piece-103.png' }), { dataTransfer });

	await fireEvent.drop(element, { dataTransfer });
	await waitFor(() => expect(screen.view.queryByRole('button', { name: 'Piece-103.png' })).toBeNull());

	expect(requests()).toEqual([{ fileIds: ['piece-103'], folderId, i: 'unit-token' }]);
});

test.each(targets)('folder drops on %s still use the folder update endpoint', async kind => {
	const screen = await source(1);
	const { element, folderId } = await target(screen, kind);
	const dataTransfer = new DataTransfer();
	dataTransfer.setData('cherrypick/drivefolders', JSON.stringify([{ id: 'other', name: 'Other', parentId: null }]));

	await fireEvent.drop(element, { dataTransfer });
	await waitFor(() => expect(requests('drive/folders/update')).toHaveLength(1));

	expect(requests('drive/folders/update')).toEqual([{ folderId: 'other', parentId: folderId, i: 'unit-token' }]);
	expect(requests()).toHaveLength(0);
});
