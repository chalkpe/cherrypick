/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('@/os.js', () => ({ alert: mocks.alert }));
vi.mock('@/i.js', () => ({ $i: { token: 'token', policies: { maxFileSizeMb: 10 } } }));
vi.mock('@/instance.js', () => ({ instance: { maxFileSize: 10 * 1024 * 1024 } }));
vi.mock('@/preferences.js', () => ({ prefer: { s: {} } }));
vi.mock('@/stream.js', () => ({ useStream: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));

import { uploadFile, UploadAbortedError } from '@/utility/drive.js';
import { i18n } from '@/i18n.js';

class FakeXhr {
	static last: FakeXhr;
	upload = {};
	status = 0;
	response: string | null = null;
	onload: ((ev: unknown) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	constructor() {
		FakeXhr.last = this;
	}
	open() {}
	send() {}
	abort() {}
}

// Whether the promise has settled, without waiting for one that never will.
async function outcome(promise: Promise<unknown>) {
	const settled = promise.then(() => 'resolved', () => 'rejected');
	const pending = new Promise(resolve => { setTimeout(() => resolve('pending'), 0); });
	return await Promise.race([settled, pending]);
}

beforeEach(() => {
	mocks.alert.mockReset();
	vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('uploadFile', () => {
	const file = new File(['content'], 'file.txt');

	test('fails with an explanation when the request never reaches the server', async () => {
		const { filePromise } = uploadFile(file);

		FakeXhr.last.onerror?.({});

		expect(await outcome(filePromise)).toBe('rejected');
		expect(mocks.alert).toHaveBeenCalledExactlyOnceWith({
			type: 'error',
			title: i18n.ts.failedToUpload,
			text: i18n.ts.cannotUploadBecauseNetworkError,
		});
	});

	test('stays quiet when the user aborts', async () => {
		const { filePromise, abort } = uploadFile(file);

		abort();

		await expect(filePromise).rejects.toBeInstanceOf(UploadAbortedError);
		expect(mocks.alert).not.toHaveBeenCalled();
	});

	test('still explains an answer from the server', async () => {
		const { filePromise } = uploadFile(file);
		const xhr = FakeXhr.last;
		xhr.status = 413;

		xhr.onload?.({ target: xhr });

		expect(await outcome(filePromise)).toBe('rejected');
		expect(mocks.alert).toHaveBeenCalledExactlyOnceWith({
			type: 'error',
			title: i18n.ts.failedToUpload,
			text: i18n.ts.cannotUploadBecauseExceedsFileSizeLimit,
		});
	});
});
