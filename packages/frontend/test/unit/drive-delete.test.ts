/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('@/os.js', () => ({ confirm: vi.fn(), alert: vi.fn(), waiting: () => vi.fn() }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { uploadFolder: 'child' }, commit: vi.fn() } }));
vi.mock('@/i.js', () => ({ $i: { token: 'unit-token' } }));

import * as os from '@/os.js';
import { prefer } from '@/preferences.js';
import { deleteDriveItems } from '@/utility/drive-delete.js';

const done = {
	operationId: '00000000-0000-0000-0000-000000000000', totalCount: 2,
	deletedCount: 1, missingCount: 0, failedCount: 1, remainingCount: 1, remainingFoldersCount: 0,
	deletedIds: ['one'], missingIds: [], deletedFolderIds: ['child'], missingFolderIds: [], folderDeleted: false, done: true,
};

const emptyResult = {
	...done, totalCount: 0, deletedCount: 0, missingCount: 0, failedCount: 0, remainingCount: 0, remainingFoldersCount: 0,
	deletedIds: [], missingIds: [], deletedFolderIds: [], missingFolderIds: [], folderDeleted: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.resetMocks();
	fetchMock.doMock();
	vi.spyOn(window, 'fetch').mockImplementation(fetchMock);
});

test('confirmation cancellation sends prepare but no destructive request over the real API transport', async () => {
	fetchMock.mockResponseOnce(JSON.stringify({ operationId: done.operationId, totalCount: 0 }));
	vi.mocked(os.confirm).mockResolvedValue({ canceled: true });

	const result = await deleteDriveItems({ folderId: 'root', name: 'Empty' });

	expect(result).toBeNull();
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(String(fetchMock.mock.calls[0][0])).toContain('/api/drive/delete/prepare');
	expect(vi.mocked(os.confirm).mock.calls[0][0].text).toContain('0');
	expect(vi.mocked(os.confirm).mock.calls[0][0].text).toContain('Empty');
});

test('uses frozen IDs, reports actual partial results and clears deleted upload-folder preference', async () => {
	fetchMock.mockResponses(JSON.stringify({ operationId: done.operationId, totalCount: 2 }), JSON.stringify(done));
	vi.mocked(os.confirm).mockResolvedValue({ canceled: false });
	const ids = ['one', 'two'];

	const promise = deleteDriveItems({ fileIds: ids });
	ids.push('later');
	const result = await promise;

	expect(result).toEqual(done);
	const prepareBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
	expect(prepareBody.fileIds).toEqual(['one', 'two']);
	expect(prepareBody.i).toBe('unit-token');
	expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ operationId: done.operationId });
	expect(vi.mocked(os.alert).mock.calls.at(-1)?.[0].type).toBe('warning');
	expect(vi.mocked(os.alert).mock.calls.at(-1)?.[0].text).toContain('1');
	expect(prefer.commit).toHaveBeenCalledWith('uploadFolder', null);
});

test('blocks a second activation while confirmation is pending', async () => {
	fetchMock.mockResponseOnce(JSON.stringify({ operationId: done.operationId, totalCount: 2 }));
	let resolveConfirm!: (value: { canceled: boolean }) => void;
	vi.mocked(os.confirm).mockImplementation(() => new Promise(resolve => { resolveConfirm = resolve; }));

	const first = deleteDriveItems({ fileIds: ['one'] });
	await vi.waitFor(() => expect(os.confirm).toHaveBeenCalledOnce());
	const repeated = await deleteDriveItems({ fileIds: ['two'] });
	resolveConfirm({ canceled: true });
	await first;

	expect(repeated).toBeNull();
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('executes serial batches until the server finishes', async () => {
	fetchMock.mockResponses(
		JSON.stringify({ operationId: done.operationId, totalCount: 205 }),
		JSON.stringify({ ...done, deletedCount: 100, done: false }),
		JSON.stringify({ ...done, deletedCount: 200, done: false }),
		JSON.stringify({ ...done, deletedCount: 205, failedCount: 0, remainingCount: 0 }),
	);
	vi.mocked(os.confirm).mockResolvedValue({ canceled: false });

	const result = await deleteDriveItems({ folderId: 'root', name: 'Nested' });

	expect(result?.deletedCount).toBe(205);
	expect(fetchMock).toHaveBeenCalledTimes(4);
});

test('recovers persisted results through a read-only status request after a lost execute response', async () => {
	fetchMock.mockResponses(
		JSON.stringify({ operationId: done.operationId, totalCount: 2 }),
		() => Promise.reject(new Error('response lost')),
		JSON.stringify(done),
	);
	vi.mocked(os.confirm).mockResolvedValue({ canceled: false });

	const result = await deleteDriveItems({ fileIds: ['one', 'two'] });

	expect(result).toEqual(done);
	expect(String(fetchMock.mock.calls[2][0])).toContain('/api/drive/delete/status');
	expect(vi.mocked(os.alert).mock.calls.at(-1)?.[0].text).toContain('1');
});

test.each([
	{
		name: '103 deleted files without zero-valued outcomes',
		response: { ...emptyResult, totalCount: 103, deletedCount: 103, deletedIds: Array.from({ length: 103 }, (_, index) => `file-${index}`) },
		text: 'Files deleted: 103.', type: 'success',
	},
	{
		name: 'empty folders without inventing a file deletion',
		response: { ...emptyResult, deletedFolderIds: ['root', 'child'], folderDeleted: true },
		text: 'Folders deleted: 2.', type: 'success',
	},
	{
		name: 'a folder that was already removed',
		response: { ...emptyResult, missingFolderIds: ['root'], folderDeleted: true },
		text: 'Folders already missing or unavailable: 1.', type: 'success',
	},
	{
		name: 'no deleted items without an empty message',
		response: emptyResult,
		text: 'No items were deleted.', type: 'success',
	},
	{
		name: 'all nonzero outcomes and the next action',
		response: {
			...emptyResult, totalCount: 9, deletedCount: 2, deletedIds: ['one', 'two'], deletedFolderIds: ['child'],
			missingCount: 3, missingIds: ['gone-one', 'gone-two', 'gone-three'], failedCount: 4, remainingCount: 4, remainingFoldersCount: 1,
		},
		text: 'Files deleted: 2.\nFolders deleted: 1.\nFiles already missing or unavailable: 3.\nFailed files: 4.\nFiles remaining: 4.\nFolders remaining: 1.\nCheck the remaining items and retry deletion.', type: 'warning',
	},
])('reports $name through the deletion result dialog', async ({ response, text, type }) => {
	fetchMock.mockResponses(JSON.stringify({ operationId: response.operationId, totalCount: response.totalCount }), JSON.stringify(response));
	vi.mocked(os.confirm).mockResolvedValue({ canceled: false });

	const result = await deleteDriveItems({ folderId: 'root', name: 'Garden' });

	expect(result).toEqual(response);
	expect(vi.mocked(os.alert).mock.calls.at(-1)?.[0]).toEqual({ type, text });
});

test('an interrupted deletion keeps nonzero result counts with concise recovery guidance', async () => {
	const partial = { ...emptyResult, totalCount: 3, deletedCount: 1, deletedIds: ['one'], remainingCount: 2, done: false };
	fetchMock.mockResponses(
		JSON.stringify({ operationId: partial.operationId, totalCount: partial.totalCount }),
		JSON.stringify(partial),
		() => Promise.reject(new Error('response lost')),
		JSON.stringify(partial),
	);
	vi.mocked(os.confirm).mockResolvedValue({ canceled: false });

	const result = await deleteDriveItems({ fileIds: ['one', 'two', 'three'] });

	expect(result).toEqual(partial);
	expect(vi.mocked(os.alert).mock.calls.at(-1)?.[0]).toEqual({
		type: 'error',
		text: 'Files deleted: 1.\nFiles remaining: 2.\nDeletion was interrupted. Check the remaining files and folders.',
	});
});
