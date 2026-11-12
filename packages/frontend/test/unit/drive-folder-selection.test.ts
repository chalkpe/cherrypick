/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent } from 'vue';
import type * as Misskey from 'cherrypick-js';

vi.mock('@/store.js', async () => ({ store: { s: { realtimeMode: false }, r: { driveSortMode: (await import('vue')).ref('+name') } } }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ enableInfiniteScroll: false, animation: false }) }));
vi.mock('@/i.js', () => ({ $i: { token: 'unit-token' } }));
vi.mock('@/os.js', () => ({ waiting: () => () => {}, toast: vi.fn(), alert: vi.fn() }));
vi.mock('@/utility/drive.js', () => ({ chooseFileFromPcAndUpload: vi.fn(), selectDriveFolder: vi.fn() }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/get-drive-file-menu.js', () => ({ getDriveFileMenu: vi.fn() }));
vi.mock('@/stream.js', () => ({ useStream: vi.fn() }));
vi.mock('@/components/global/MkA.vue', () => ({ default: { template: '<a><slot /></a>' } }));
vi.mock('@/components/MkDrive.file.vue', () => ({ default: { props: ['file', 'isSelected'], template: '<button :aria-pressed="isSelected">{{ file.name }}</button>' } }));
vi.mock('@/components/MkDrive.navFolder.vue', () => ({ default: { props: ['folder'], template: '<button>{{ folder ? folder.name : "Drive" }}</button>' } }));

import MkDriveFolderSelectDialog from '@/components/MkDriveFolderSelectDialog.vue';
import MkDriveFileSelectDialog from '@/components/MkDriveFileSelectDialog.vue';

const sand = { id: 'sand', name: 'Sand', parentId: null, parent: null } as Misskey.entities.DriveFolder;
const wind = { id: 'wind', name: 'Wind', parentId: null, parent: null } as Misskey.entities.DriveFolder;
const folders = [sand, wind];
const files = [
	{ id: 'light', name: 'Light.png', folderId: sand.id },
	{ id: 'leaf', name: 'Leaf.png', folderId: wind.id },
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

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.resetMocks();
	fetchMock.doMock();
	vi.spyOn(window, 'fetch').mockImplementation(fetchMock);
	fetchMock.mockResponse(async request => {
		const endpoint = new URL(request.url).pathname;
		const params = await request.json();
		if (endpoint === '/api/drive/files') return JSON.stringify(files.filter(file => file.folderId === params.folderId));
		if (endpoint === '/api/drive/folders') return JSON.stringify(folders.filter(folder => folder.parentId === params.folderId));
		if (endpoint === '/api/drive/folders/show') return JSON.stringify(folders.find(folder => folder.id === params.folderId));
		throw new Error(`Unexpected ${endpoint}`);
	});
});

afterEach(cleanup);

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
