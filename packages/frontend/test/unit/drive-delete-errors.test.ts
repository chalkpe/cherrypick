/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.hoisted(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); });
vi.mock('@/i.js', async importOriginal => ({
	...await importOriginal<typeof import('@/i.js')>(),
	$i: { id: 'me', username: 'me', token: 'unit-token', policies: {} },
}));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false }) }));
vi.mock('@/os.js', async importOriginal => ({
	...await importOriginal<typeof import('@/os.js')>(),
	confirm: vi.fn(), alert: vi.fn(), waiting: () => () => {},
}));

import * as os from '@/os.js';
import { deleteDriveItems, driveDeletionBusy } from '@/utility/drive-delete.js';
import { i18n } from '@/i18n.js';

const operationId = '00000000-0000-4000-8000-000000000000';
const errors = [
	{ code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded.', id: 'rate-limit' },
	{ code: 'NO_SUCH_FOLDER', message: 'No such folder.', id: '8f7f49d8-a63d-480a-a4cd-7a54b8bb87f1' },
	{ code: 'INVALID_SELECTION', message: 'Choose either files or one folder.', id: '86206bf8-8890-4407-ac04-3c90c7a25424' },
];

beforeEach(() => {
	vi.clearAllMocks();
	os.popups.value = [];
	fetchMock.resetMocks();
	fetchMock.doMock();
	vi.spyOn(window, 'fetch').mockImplementation(fetchMock);
	vi.mocked(os.confirm).mockResolvedValue({ canceled: false });
});

afterEach(() => { os.popups.value = []; });

test.each(errors)('prepare $code shows the common API error without reporting an interrupted deletion', async error => {
	fetchMock.mockResponseOnce(JSON.stringify({ error }), { status: error.code === 'RATE_LIMIT_EXCEEDED' ? 429 : 400 });

	const result = await deleteDriveItems({ folderId: 'gone', name: 'Garden' });

	const dialogs = os.popups.value.map(popup => popup.props as { type?: string; title?: string; text?: string });
	expect(dialogs).toContainEqual(expect.objectContaining(error.code === 'RATE_LIMIT_EXCEEDED'
		? { type: 'error', title: i18n.ts.cannotPerformTemporary, text: i18n.ts.cannotPerformTemporaryDescription }
		: { type: 'error', text: error.code === 'NO_SUCH_FOLDER'
			? 'The folder to delete could not be found. Refresh the list.'
			: 'The selection is invalid. Reselect the files or folder to delete.' }));
	expect(os.alert).not.toHaveBeenCalled();
	expect(os.confirm).not.toHaveBeenCalled();
	expect(result).toBeNull();
	expect(driveDeletionBusy.value).toBe(false);
	expect(fetchMock.mock.calls).toHaveLength(1);
	expect(String(fetchMock.mock.calls[0][0])).toContain('/api/drive/delete/prepare');
});

test('a prepare network failure shows retry guidance without a confirmation or destructive request', async () => {
	fetchMock.mockRejectOnce(new TypeError('Failed to fetch'));

	const result = await deleteDriveItems({ fileIds: ['one'] });

	expect(os.popups.value.map(popup => popup.props)).toContainEqual(expect.objectContaining({
		type: 'error', text: 'Unable to start deletion. Please try again.',
	}));
	expect(os.alert).not.toHaveBeenCalled();
	expect(os.confirm).not.toHaveBeenCalled();
	expect(result).toBeNull();
	expect(driveDeletionBusy.value).toBe(false);
	expect(fetchMock.mock.calls).toHaveLength(1);
	expect(String(fetchMock.mock.calls[0][0])).toContain('/api/drive/delete/prepare');
});

test.each(['prepare', 'execute'])('%s keeps busy, expired and capacity errors distinct from interruption', async phase => {
	for (const [code, text] of [
		['DELETE_BUSY', i18n.ts._driveDeletion.busy],
		['PLAN_EXPIRED', i18n.ts._driveDeletion.expired],
		['TOO_MANY_ITEMS', i18n.ts._driveDeletion.tooMany],
	]) {
		fetchMock.resetMocks();
		if (phase === 'execute') fetchMock.mockResponseOnce(JSON.stringify({ operationId, totalCount: 1 }));
		fetchMock.mockResponseOnce(JSON.stringify({ error: { code, message: code, id: code } }), { status: 400 });
		if (phase === 'execute') fetchMock.mockResponseOnce(JSON.stringify({ error: { code: 'DELETE_BUSY', message: 'Busy.', id: 'busy' } }), { status: 400 });

		await deleteDriveItems({ fileIds: ['one'] });

		expect(os.alert).toHaveBeenLastCalledWith({ type: 'error', text });
		expect(os.popups.value).toHaveLength(0);
		expect(fetchMock.mock.calls).toHaveLength(phase === 'execute' ? 3 : 1);
	}
});

test('a lost first execute response reports interruption only after confirmation and status recovery fail', async () => {
	fetchMock.mockResponses(
		JSON.stringify({ operationId, totalCount: 1 }),
		() => Promise.reject(new TypeError('Failed to fetch')),
		() => Promise.reject(new TypeError('Failed to fetch')),
	);

	const result = await deleteDriveItems({ fileIds: ['one'] });

	expect(result).toBeNull();
	expect(os.alert).toHaveBeenLastCalledWith({ type: 'error', text: i18n.ts._driveDeletion.interrupted });
	expect(fetchMock.mock.calls.map(([url]) => String(url).split('/api/')[1])).toEqual([
		'drive/delete/prepare', 'drive/delete/execute', 'drive/delete/status',
	]);
});
