/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';

vi.mock('@/store.js', async () => ({ store: { s: { realtimeMode: false }, r: { driveSortMode: (await import('vue')).ref('+name') } } }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ enableInfiniteScroll: false, animation: false }) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/os.js', () => ({ waiting: () => () => {}, toast: vi.fn(), alert: vi.fn() }));
vi.mock('@/utility/drive.js', () => ({ chooseFileFromPcAndUpload: vi.fn(), selectDriveFolder: vi.fn() }));
vi.mock('@/utility/drive-delete.js', async () => ({ deleteDriveItems: vi.fn(), driveDeletionBusy: (await import('vue')).ref(false) }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/get-drive-file-menu.js', () => ({ getDriveFileMenu: vi.fn() }));
vi.mock('@/stream.js', () => ({ useStream: vi.fn() }));
vi.mock('@/components/MkDrive.file.vue', () => ({ default: { props: ['file', 'isSelected'], template: '<button :aria-pressed="isSelected">{{ file.name }}</button>' } }));
vi.mock('@/components/MkDrive.folder.vue', () => ({ default: { template: '<div></div>' } }));
vi.mock('@/components/MkDrive.navFolder.vue', () => ({ default: { template: '<span></span>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' } }));

import MkDrive from '@/components/MkDrive.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { selectDriveFolder } from '@/utility/drive.js';
import type * as Misskey from 'cherrypick-js';

const original = ['one', 'two'].map(id => ({ id, name: id, folderId: null, createdAt: '2026-11-11T00:00:00Z', type: 'text/plain', size: 1 } as Misskey.entities.DriveFile));
let files = [...original];

beforeEach(() => {
	vi.clearAllMocks();
	files = [...original];
	vi.mocked(misskeyApi).mockImplementation(async (endpoint, params) => {
		if (endpoint === 'drive/files') return files;
		if (endpoint === 'drive/folders') return [];
		if (endpoint === 'drive/files/move-bulk') {
			const moved = new Set((params as { fileIds: string[] }).fileIds);
			files = files.filter(file => !moved.has(file.id));
			return undefined;
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

test('edit mode exposes selected count and enabled move/delete actions, then clears moved selection', async () => {
	const screen = drive();
	await fireEvent.click(await screen.findByRole('button', { name: 'one' }), { shiftKey: true });
	await fireEvent.click(screen.getByRole('button', { name: 'two' }));

	expect(screen.getByRole('status').textContent).toContain('2');
	expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(false);
	vi.mocked(selectDriveFolder).mockResolvedValue({ canceled: false, folders: [{ id: 'target' } as Misskey.entities.DriveFolder] });
	await fireEvent.click(screen.getByRole('button', { name: /Move/ }));

	await waitFor(() => expect(screen.getByRole('status').textContent).toContain('0'));
	expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(true);
	await waitFor(() => {
		expect(screen.queryByRole('button', { name: 'one' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'two' })).toBeNull();
	});
});

test('the attachment picker still selects files without showing destructive edit actions', async () => {
	const screen = drive({ select: 'file', multiple: true });
	await fireEvent.click(await screen.findByRole('button', { name: 'one' }));
	await fireEvent.click(screen.getByRole('button', { name: 'two' }));

	const selections = screen.emitted('changeSelectedFiles') as [Misskey.entities.DriveFile[]][];
	const latest = selections.at(-1)?.[0];
	expect(latest?.map(file => file.id)).toEqual(['one', 'two']);
	expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
});
