/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, assert, describe, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/vue';
import * as Misskey from 'cherrypick-js';
import { directives } from '@/directives/index.js';
import { components } from '@/components/index.js';

const { fakeMe } = vi.hoisted(() => ({
	fakeMe: {
		id: 'me',
		username: 'me',
		host: null,
		avatarUrl: 'https://example.com/avatar.png',
		isSilenced: false,
		isAdmin: false,
		isModerator: false,
		notesCount: 0,
		policies: {
			scheduledNoteLimit: 0,
			noteDraftLimit: 0,
		},
	},
}));

vi.mock('@/i.js', () => ({
	$i: fakeMe,
	iAmModerator: false,
	iAmAdmin: false,
	ensureSignin: () => fakeMe,
	notesCount: 0,
	incNotesCount: () => {},
}));

vi.mock('@/instance.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/instance.js')>()),
	instance: { maxNoteTextLength: 3000 },
}));

vi.mock('@/utility/misskey-api.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/utility/misskey-api.js')>()),
	// このテストではAPI応答を必要としないので、解決も拒否もしないPromiseを返す
	misskeyApi: vi.fn(() => new Promise(() => {})),
}));

vi.mock('@/utility/drive.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/utility/drive.js')>()),
	chooseDriveFile: vi.fn(),
}));

const { chooseDriveFile } = await import('@/utility/drive.js');
const { default: MkPostForm } = await import('@/components/MkPostForm.vue');
const { default: MkPostFormSimple } = await import('@/components/MkPostFormSimple.vue');

describe.each([
	{ name: 'MkPostForm', component: MkPostForm, submitSelector: '[data-testid="post-form-submit"]' },
	{ name: 'MkPostFormSimple', component: MkPostFormSimple, submitSelector: '[data-testid="post-form-submit"]' },
])('$name', ({ component, submitSelector }) => {
	const driveFile = {
		id: 'drive-file-1',
		createdAt: '1970-01-01T00:00:00.000Z',
		name: 'photo.png',
		type: 'image/png',
		md5: '15eca7fba0480996e2245f5185bf39f2',
		size: 1,
		isSensitive: false,
		blurhash: null,
		properties: {},
		url: 'https://example.com/photo.png',
		thumbnailUrl: null,
		comment: null,
		folderId: null,
		folder: null,
		userId: 'me',
		user: null,
	} as unknown as Misskey.entities.DriveFile;

	const renderPostForm = (): RenderResult => {
		return render(component, {
			props: { autofocus: false, initialVisibility: 'public', initialLocalOnly: false },
			global: {
				// v-panel はコンパイル済みテーマを前提とするので、テストでは no-op にする
				directives: { ...directives, panel: {} },
				components,
			},
		});
	};

	afterEach(() => {
		cleanup();
		vi.mocked(chooseDriveFile).mockReset();
	});

	test('attaches a file chosen from the drive', async () => {
		vi.mocked(chooseDriveFile).mockResolvedValue([driveFile]);
		const form = renderPostForm();

		// MkPostFormSimple はテキストエリアをクリックするまでフッターを表示しない
		const textarea = form.container.querySelector('textarea');
		assert.exists(textarea, 'textarea exists');
		await fireEvent.click(textarea!);

		const driveButton = form.container.querySelector('.ti-cloud-download')?.closest('button');
		assert.exists(driveButton, 'drive button exists');
		await fireEvent.click(driveButton!);
		assert.strictEqual(vi.mocked(chooseDriveFile).mock.calls.length, 1, 'drive chooser is opened');

		await waitFor(() => {
			assert.exists(form.container.querySelector(`[data-id="${driveFile.id}"]`), 'attached file thumbnail is rendered');
		});
		const submit = form.container.querySelector<HTMLButtonElement>(submitSelector);
		assert.exists(submit, 'submit button exists');
		assert.isFalse(submit!.disabled, 'submit button is enabled after attaching a file');
	});
});
