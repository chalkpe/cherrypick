/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, nextTick } from 'vue';
import type * as Misskey from 'cherrypick-js';

vi.mock('@/store.js', async () => ({ store: { s: { realtimeMode: false }, r: { driveSortMode: (await import('vue')).ref('+name') } } }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ enableInfiniteScroll: false, animation: false }) }));
vi.mock('@/i.js', () => ({ $i: { token: 'unit-token' } }));
vi.mock('@/os.js', () => ({ waiting: () => () => {}, toast: vi.fn(), alert: vi.fn(), confirm: vi.fn(), contextMenu: vi.fn() }));
vi.mock('@/utility/drive.js', () => ({ chooseFileFromPcAndUpload: vi.fn(), selectDriveFolder: vi.fn() }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/get-drive-file-menu.js', () => ({ getDriveFileMenu: vi.fn() }));
vi.mock('@/stream.js', () => ({ useStream: vi.fn() }));
vi.mock('@/components/global/MkA.vue', () => ({ default: { template: '<a><slot /></a>' } }));
vi.mock('@/components/MkDrive.file.vue', () => ({ default: { props: ['file', 'isSelected'], template: '<button :aria-pressed="isSelected">{{ file.name }}</button>' } }));
vi.mock('@/components/MkDrive.navFolder.vue', () => ({ default: { props: ['folder'], template: '<button>{{ folder ? folder.name : "Drive" }}</button>' } }));

import MkDriveFolderSelectDialog from '@/components/MkDriveFolderSelectDialog.vue';
import MkDriveFileSelectDialog from '@/components/MkDriveFileSelectDialog.vue';
import * as os from '@/os.js';
import { globalEvents } from '@/events.js';
import { pendingApiRequestsCount } from '@/utility/misskey-api.js';

const sand = { id: 'sand', name: 'Sand', parentId: null, parent: null } as Misskey.entities.DriveFolder;
const wind = { id: 'wind', name: 'Wind', parentId: null, parent: null } as Misskey.entities.DriveFolder;
const inner = { id: 'inner', name: 'Inner', parentId: sand.id, parent: sand } as Misskey.entities.DriveFolder;
const folders = [sand, wind, inner];
let removedFolderIds = new Set<string>();
const delayedFolderLookups = new Map<string, { response: Promise<string>; received: () => void }>();
const files = [
	{ id: 'light', name: 'Light.png', folderId: sand.id },
	{ id: 'leaf', name: 'Leaf.png', folderId: wind.id },
	{ id: 'seed', name: 'Seed.png', folderId: inner.id },
].map(file => ({ ...file, createdAt: '2026-11-11T00:00:00Z', type: 'image/png', size: 1 } as Misskey.entities.DriveFile));

// 창의 배치·애니메이션만 대체하고 완료 버튼과 선택 이벤트는 제품 컴포넌트를 사용한다.
const modalShell = defineComponent({
	emits: ['closed', 'click'],
	setup(_props, { emit, expose }) {
		expose({ close: () => emit('closed') });
	},
	template: '<div role="dialog"><slot type="dialog" /></div>',
});

const global = {
	stubs: {
		MkModal: modalShell,
		MkStickyContainer: { template: '<div><slot name="header"/><slot/><slot name="footer"/></div>' },
		MkTip: true,
		MkLoading: true,
	},
	directives: { anim: {}, appear: {} },
};

function delayFolderLookup(target: Misskey.entities.DriveFolder) {
	let received!: () => void;
	let release!: () => void;
	let reject!: (error: Error) => void;
	const requested = new Promise<void>(resolve => { received = resolve; });
	const response = new Promise<string>((resolve, rejectResponse) => {
		release = () => resolve(JSON.stringify(target));
		reject = rejectResponse;
	});
	delayedFolderLookups.set(target.id, { response, received });
	return { requested, release, reject };
}

async function settleRequests(pending = 0) {
	await waitFor(() => expect(pendingApiRequestsCount.value).toBe(pending));
	await setImmediate();
	await waitFor(() => expect(pendingApiRequestsCount.value).toBe(pending));
	await nextTick();
}

beforeEach(() => {
	vi.clearAllMocks();
	removedFolderIds = new Set();
	delayedFolderLookups.clear();
	fetchMock.resetMocks();
	fetchMock.doMock();
	vi.spyOn(window, 'fetch').mockImplementation(fetchMock);
	fetchMock.mockResponse(async request => {
		const endpoint = new URL(request.url).pathname;
		const params = await request.json();
		if (endpoint === '/api/drive/files') return JSON.stringify(files.filter(file => file.folderId === params.folderId));
		if (endpoint === '/api/drive/folders') return JSON.stringify(folders.filter(folder => folder.parentId === params.folderId && !removedFolderIds.has(folder.id)));
		if (endpoint === '/api/drive/folders/show') {
			if (removedFolderIds.has(params.folderId)) return { status: 400, body: JSON.stringify({ error: { code: 'NO_SUCH_FOLDER', message: 'No such folder.', id: 'gone' } }) };
			const delayed = delayedFolderLookups.get(params.folderId);
			if (delayed) {
				delayedFolderLookups.delete(params.folderId);
				delayed.received();
				return delayed.response;
			}
			return JSON.stringify(folders.find(folder => folder.id === params.folderId));
		}
		if (endpoint === '/api/drive/delete/prepare') return JSON.stringify({ operationId: 'operation', totalCount: 0 });
		if (endpoint === '/api/drive/delete/execute') {
			removedFolderIds.add(sand.id);
			return JSON.stringify({
				operationId: 'operation', totalCount: 0, deletedCount: 0, missingCount: 0, failedCount: 0, remainingCount: 0, remainingFoldersCount: 0,
				deletedIds: [], missingIds: [], deletedFolderIds: [sand.id], missingFolderIds: [], folderDeleted: true, done: true,
			});
		}
		throw new Error(`Unexpected ${endpoint}`);
	});
});

afterEach(cleanup);

test('a late successful lookup cannot open a destination deleted while navigating from the root', async () => {
	const screen = render(MkDriveFolderSelectDialog, { global });
	const card = await screen.findByTitle('Sand');
	await settleRequests();
	const lookup = delayFolderLookup(sand);

	await fireEvent.click(card);
	await lookup.requested;
	removedFolderIds.add(sand.id);
	globalEvents.emit('driveFoldersDeleted', [{ id: sand.id }]);
	await waitFor(() => expect(screen.queryByTitle('Sand')).toBeNull());
	lookup.release();
	await settleRequests();

	expect(screen.queryByRole('button', { name: 'Light.png' })).toBeNull();
	expect(screen.getByTitle('Wind')).toBeTruthy();
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(true);
	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
	expect(screen.emitted('done')).toEqual([[[null]]]);
});

test('returning to the root cancels a folder lookup even when the root is still displayed', async () => {
	const screen = render(MkDriveFolderSelectDialog, { global });
	const card = await screen.findByTitle('Sand');
	await settleRequests();
	const lookup = delayFolderLookup(sand);

	await fireEvent.click(card);
	await lookup.requested;
	await fireEvent.click(screen.getByRole('button', { name: 'Drive' }));
	lookup.release();
	await settleRequests();

	expect(screen.queryByRole('button', { name: 'Light.png' })).toBeNull();
	expect(screen.getByTitle('Sand')).toBeTruthy();
	expect(screen.getByTitle('Wind')).toBeTruthy();
});

test('deleting a pending child destination preserves the current surviving folder', async () => {
	const screen = render(MkDriveFolderSelectDialog, { props: { initialFolder: sand.id }, global });
	await screen.findByRole('button', { name: 'Light.png' });
	await settleRequests();
	const lookup = delayFolderLookup(inner);

	await fireEvent.click(screen.getByTitle('Inner'));
	await lookup.requested;
	removedFolderIds.add(inner.id);
	globalEvents.emit('driveFoldersDeleted', [{ id: inner.id }]);
	lookup.release();
	await settleRequests();

	expect(screen.getByRole('button', { name: 'Light.png' })).toBeTruthy();
	expect(screen.queryByRole('button', { name: 'Seed.png' })).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
	expect(screen.emitted('done')).toEqual([[[sand]]]);
});

test('deleting an unrelated root folder does not cancel a valid pending destination', async () => {
	const screen = render(MkDriveFolderSelectDialog, { global });
	await screen.findByTitle('Sand');
	await settleRequests();
	const lookup = delayFolderLookup(sand);

	await fireEvent.click(screen.getByTitle('Sand'));
	await lookup.requested;
	removedFolderIds.add(wind.id);
	globalEvents.emit('driveFoldersDeleted', [{ id: wind.id }]);
	lookup.release();
	await settleRequests();

	expect(screen.getByRole('button', { name: 'Light.png' })).toBeTruthy();
	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
	expect(screen.emitted('done')).toEqual([[[sand]]]);
});

test.each([false, true])('only the newest destination opens when different lookups finish out of order (newest first: %s)', async newestFirst => {
	const screen = render(MkDriveFolderSelectDialog, { props: { initialFolder: inner.id }, global });
	await screen.findByRole('button', { name: 'Seed.png' });
	await settleRequests();
	const parentLookup = delayFolderLookup(sand);

	await fireEvent.click(screen.getByRole('button', { name: 'Sand' }));
	await parentLookup.requested;
	await fireEvent.click(screen.getByRole('button', { name: 'Drive' }));
	await screen.findByTitle('Wind');
	await settleRequests(1);
	const newestLookup = delayFolderLookup(wind);
	await fireEvent.click(screen.getByTitle('Wind'));
	await newestLookup.requested;

	(newestFirst ? newestLookup : parentLookup).release();
	await settleRequests(1);
	if (newestFirst) expect(screen.getByRole('button', { name: 'Leaf.png' })).toBeTruthy();
	else expect(screen.getByTitle('Wind')).toBeTruthy();
	(newestFirst ? parentLookup : newestLookup).release();
	await settleRequests();

	expect(screen.getByRole('button', { name: 'Leaf.png' })).toBeTruthy();
	expect(screen.queryByRole('button', { name: 'Light.png' })).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
	expect(screen.emitted('done')).toEqual([[[wind]]]);
});

test('an obsolete lookup finishing cannot stop deletion from invalidating the newest pending destination', async () => {
	const screen = render(MkDriveFolderSelectDialog, { global });
	await screen.findByTitle('Sand');
	await settleRequests();
	const oldLookup = delayFolderLookup(sand);

	await fireEvent.click(screen.getByTitle('Sand'));
	await oldLookup.requested;
	await fireEvent.click(screen.getByRole('button', { name: 'Drive' }));
	await settleRequests(1);
	const newestLookup = delayFolderLookup(wind);
	await fireEvent.click(screen.getByTitle('Wind'));
	await newestLookup.requested;
	oldLookup.release();
	await settleRequests(1);
	removedFolderIds.add(wind.id);
	globalEvents.emit('driveFoldersDeleted', [{ id: wind.id }]);
	newestLookup.release();
	await settleRequests();

	expect(screen.getByTitle('Sand')).toBeTruthy();
	expect(screen.queryByTitle('Wind')).toBeNull();
	expect(screen.queryByRole('button', { name: 'Leaf.png' })).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
	expect(screen.emitted('done')).toEqual([[[null]]]);
});

test('a late failed parent lookup cannot return a newer destination to the root', async () => {
	const screen = render(MkDriveFolderSelectDialog, { props: { initialFolder: inner.id }, global });
	await screen.findByRole('button', { name: 'Seed.png' });
	await settleRequests();
	const parentLookup = delayFolderLookup(sand);

	removedFolderIds.add(inner.id);
	globalEvents.emit('driveFoldersDeleted', [{ id: inner.id }]);
	await parentLookup.requested;
	await fireEvent.click(screen.getByRole('button', { name: 'Drive' }));
	await screen.findByTitle('Wind');
	await fireEvent.click(screen.getByTitle('Wind'));
	await screen.findByRole('button', { name: 'Leaf.png' });
	parentLookup.reject(new Error('Parent lookup failed'));
	await settleRequests();

	expect(screen.getByRole('button', { name: 'Leaf.png' })).toBeTruthy();
	expect(screen.queryByTitle('Wind')).toBeNull();
});

test('a late lookup after closing the dialog does not fetch the destination contents', async () => {
	const screen = render(MkDriveFolderSelectDialog, { global });
	await screen.findByTitle('Sand');
	await settleRequests();
	const lookup = delayFolderLookup(sand);

	await fireEvent.click(screen.getByTitle('Sand'));
	await lookup.requested;
	screen.unmount();
	const requestsBeforeResponse = fetchMock.mock.calls.length;
	lookup.release();
	await settleRequests();

	expect(fetchMock.mock.calls).toHaveLength(requestsBeforeResponse);
});

test('deleting a selected destination through its folder-card menu disables Done', async () => {
	const screen = render(MkDriveFolderSelectDialog, { props: { initialFolder: sand.id }, global });
	await screen.findByRole('button', { name: 'Light.png' });
	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Drive' }));
	const card = await screen.findByTitle('Sand');
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(false);
	vi.mocked(os.confirm).mockResolvedValue({ canceled: false });

	await fireEvent.contextMenu(card);
	const menu = vi.mocked(os.contextMenu).mock.calls.at(-1)![0];
	const item = menu.find(entry => entry && typeof entry === 'object' && 'text' in entry && entry.text === 'Delete');
	if (!item || typeof item !== 'object' || !('action' in item) || !item.action) throw new Error('Folder delete action missing');
	await item.action(new PointerEvent('click'));

	await waitFor(() => expect(screen.queryByTitle('Sand')).toBeNull());
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(true);
	expect(fetchMock.mock.calls.map(([url]) => String(url))).toContainEqual(expect.stringContaining('/api/drive/delete/execute'));
});

test('a deleted current folder clears its selection and returns to the drive root', async () => {
	const screen = render(MkDriveFolderSelectDialog, { props: { initialFolder: sand.id }, global });
	await screen.findByRole('button', { name: 'Light.png' });
	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));

	removedFolderIds.add(sand.id);
	globalEvents.emit('driveFoldersDeleted', [{ id: sand.id }]);

	await screen.findByTitle('Wind');
	expect(screen.queryByRole('button', { name: 'Light.png' })).toBeNull();
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(true);
	expect(screen.getByRole('button', { name: 'Select a folder' })).toBeTruthy();
});

test.each([false, true])('deleting the current nested folder returns to its parent or the root if its parent is gone (parent gone: %s)', async parentGone => {
	const screen = render(MkDriveFolderSelectDialog, { props: { initialFolder: inner.id }, global });
	await screen.findByRole('button', { name: 'Seed.png' });
	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));

	removedFolderIds.add(inner.id);
	if (parentGone) removedFolderIds.add(sand.id);
	globalEvents.emit('driveFoldersDeleted', [{ id: inner.id }, ...(parentGone ? [{ id: sand.id }] : [])]);

	if (parentGone) await screen.findByTitle('Wind');
	else await screen.findByRole('button', { name: 'Light.png' });
	expect(screen.queryByRole('button', { name: 'Seed.png' })).toBeNull();
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(true);
});

test('a late parent lookup cannot restore a deleted location after its ancestor deletion event', async () => {
	const screen = render(MkDriveFolderSelectDialog, { props: { initialFolder: inner.id }, global });
	await screen.findByRole('button', { name: 'Seed.png' });
	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));
	let finishParentLookup!: () => void;
	fetchMock.mockResponseOnce(() => new Promise(resolve => {
		finishParentLookup = () => resolve(JSON.stringify(sand));
	}));

	removedFolderIds.add(inner.id);
	globalEvents.emit('driveFoldersDeleted', [{ id: inner.id }]);
	await waitFor(() => expect(finishParentLookup).toBeDefined());
	removedFolderIds.add(sand.id);
	globalEvents.emit('driveFoldersDeleted', [{ id: sand.id }]);
	finishParentLookup();

	await screen.findByTitle('Wind');
	expect(screen.queryByRole('button', { name: 'Light.png' })).toBeNull();
	expect(screen.queryByRole('button', { name: 'Seed.png' })).toBeNull();
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(true);
});

test.each([false, true])('the first current-folder selection enables Done and returns the destination (navigate: %s)', async navigate => {
	const screen = render(MkDriveFolderSelectDialog, { props: { initialFolder: sand.id }, global });
	await screen.findByRole('button', { name: 'Light.png' });
	if (navigate) {
		await fireEvent.click(screen.getByRole('button', { name: 'Drive' }));
		await fireEvent.click(await screen.findByTitle('Wind'));
		await screen.findByRole('button', { name: 'Leaf.png' });
	}
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(true);

	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));

	expect(screen.getByRole('button', { name: 'Deselect folder' })).toBeTruthy();
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(false);
	await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
	expect(screen.emitted('done')).toEqual([[[navigate ? wind : sand]]]);
});

test('deselecting and reselecting the current folder updates Done each time', async () => {
	const screen = render(MkDriveFolderSelectDialog, { props: { initialFolder: sand.id }, global });
	await screen.findByRole('button', { name: 'Light.png' });

	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(false);
	await fireEvent.click(screen.getByRole('button', { name: 'Deselect folder' }));
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(true);
	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));

	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(false);
	await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
	expect(screen.emitted('done')).toEqual([[[sand]]]);
});

test('selecting the root enables Done and returns null as the destination', async () => {
	const screen = render(MkDriveFolderSelectDialog, { global });
	await screen.findByTitle('Sand');
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(true);

	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(false);
	await fireEvent.click(screen.getByRole('button', { name: 'Deselect folder' }));
	expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(true);
	await fireEvent.click(screen.getByRole('button', { name: 'Select a folder' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Done' }));

	expect(screen.emitted('done')).toEqual([[[null]]]);
});

test('the attachment dialog keeps multiple files selected across folders and returns both', async () => {
	const screen = render(MkDriveFileSelectDialog, { props: { initialFolder: sand.id, multiple: true }, global });
	await fireEvent.click(await screen.findByRole('button', { name: 'Light.png' }));
	await fireEvent.click(screen.getByRole('button', { name: 'Drive' }));
	await fireEvent.click(await screen.findByTitle('Wind'));
	await fireEvent.click(await screen.findByRole('button', { name: 'Leaf.png' }));

	await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled).toBe(false));
	await fireEvent.click(screen.getByRole('button', { name: 'Done' }));

	expect(screen.emitted('done')).toEqual([[[files[0], files[1]]]]);
	expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
});
