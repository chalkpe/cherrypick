/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, assert, describe, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/vue';
import * as Misskey from 'cherrypick-js';
import { directives } from '@/directives/index.js';
import { components } from '@/components/index.js';
import { prefer } from '@/preferences.js';
import * as os from '@/os.js';

const { fakeMe } = vi.hoisted(() => ({
	fakeMe: {
		id: 'me',
		username: 'me',
		host: null,
		avatarUrl: 'https://example.com/avatar.png',
		isSilenced: false,
		noteVisibilityLimit: 'none' as 'none' | 'home' | 'followers',
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
	// API応答が不要な呼び出しは、解決も拒否もしないPromiseを返す
	misskeyApi: vi.fn(() => new Promise(() => {})),
}));

vi.mock('@/utility/drive.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/utility/drive.js')>()),
	chooseDriveFile: vi.fn(),
}));

const { chooseDriveFile } = await import('@/utility/drive.js');
const { misskeyApi } = await import('@/utility/misskey-api.js');
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

	const renderPostForm = (initialCw?: string): RenderResult => {
		return render(component, {
			props: { autofocus: false, initialVisibility: 'public', initialLocalOnly: false, initialCw },
			global: {
				// v-panel はコンパイル済みテーマを前提とするので、テストでは no-op にする
				directives: { ...directives, panel: {} },
				components,
			},
		});
	};

	afterEach(() => {
		cleanup();
		localStorage.clear();
		fakeMe.noteVisibilityLimit = 'none';
		fakeMe.isSilenced = false;
		prefer.s.postFormVisibilityHotkey = false;
		prefer.s.keepCw = true;
		vi.mocked(misskeyApi).mockReset();
		vi.mocked(misskeyApi).mockImplementation(() => new Promise(() => {}));
		vi.mocked(chooseDriveFile).mockReset();
		vi.restoreAllMocks();
	});

	test('explicit reset clears the CW title even when keepCw is enabled', async () => {
		prefer.s.keepCw = true;
		const menu = vi.spyOn(os, 'popupMenu').mockResolvedValue();
		vi.spyOn(os, 'confirm').mockResolvedValue({ canceled: false });
		const form = renderPostForm('Spoiler warning');
		const textarea = form.container.querySelector('textarea')!;
		await fireEvent.click(textarea);
		await fireEvent.update(textarea, 'Unposted note');
		await fireEvent.click(form.container.querySelector('.ti-dots')!.closest('button')!);
		const reset = menu.mock.calls[0][0].find(item => item != null && 'text' in item && item.text === 'Reset');
		if (reset == null || !('action' in reset)) assert.fail('reset menu action is available');
		await reset.action(new PointerEvent('click'));
		await waitFor(() => {
			assert.strictEqual(textarea.value, '');
			assert.strictEqual(form.container.querySelector<HTMLInputElement>('input')!.value, '');
		});
	});

	test.each([
		{ keepCw: true, useCw: true, expectedCw: 'Spoiler warning', canPostAgain: true },
		{ keepCw: false, useCw: true, expectedCw: '', canPostAgain: false },
		{ keepCw: true, useCw: false, expectedCw: '', canPostAgain: true },
	])('after posting, CW retention follows keepCw=$keepCw and useCw=$useCw', async ({ keepCw, useCw, expectedCw, canPostAgain }) => {
		prefer.s.keepCw = keepCw;
		vi.mocked(misskeyApi).mockImplementation(async (endpoint) => {
			if (endpoint === 'notes/create') return undefined;
			return new Promise(() => {});
		});
		const form = renderPostForm('Spoiler warning');
		const textarea = form.container.querySelector('textarea')!;
		await fireEvent.click(textarea);
		if (!useCw) await fireEvent.click(form.container.querySelector('.ti-eye-off')!.closest('button')!);
		await fireEvent.update(textarea, 'First note');
		await fireEvent.click(form.container.querySelector(submitSelector)!);

		await waitFor(() => {
			assert.strictEqual(textarea.value, '', 'the posted body is cleared');
			assert.strictEqual(form.container.querySelector<HTMLInputElement>('input')!.value, expectedCw);
		});
		await fireEvent.click(textarea);
		await fireEvent.update(textarea, 'Second note');
		assert.strictEqual(form.container.querySelector<HTMLButtonElement>(submitSelector)!.disabled, !canPostAgain,
			'the next note can be posted without retyping a retained title');
		if (canPostAgain) {
			await fireEvent.click(form.container.querySelector(submitSelector)!);
			await waitFor(() => {
				assert.strictEqual(textarea.value, '', 'the second note is posted');
				assert.strictEqual(form.container.querySelector<HTMLInputElement>('input')!.value, expectedCw);
			});
		}
	});

	test.each([
		{ limit: 'home', icon: '.ti-home' },
		{ limit: 'followers', icon: '.ti-lock' },
	] as const)('lowers initial public visibility to $limit', async ({ limit, icon }) => {
		fakeMe.noteVisibilityLimit = limit;
		const form = renderPostForm();
		const textarea = form.container.querySelector('textarea')!;
		await fireEvent.click(textarea);
		const visibilityButton = form.container.querySelector('.ti-world, .ti-home, .ti-lock')?.closest('button');
		assert.exists(visibilityButton?.querySelector(icon));
		assert.notExists(visibilityButton?.querySelector('.ti-world'));
	});

	test('keeps role restrictions when the personal limit is removed', async () => {
		fakeMe.isSilenced = true;
		const form = renderPostForm();
		await fireEvent.click(form.container.querySelector('textarea')!);
		const visibilityButton = form.container.querySelector('.ti-home')?.closest('button');
		assert.exists(visibilityButton);
		assert.notExists(visibilityButton?.querySelector('.ti-world'));
	});

	test('hotkey skips public and home under the followers limit', async () => {
		fakeMe.noteVisibilityLimit = 'followers';
		prefer.s.postFormVisibilityHotkey = true;
		const form = renderPostForm();
		const textarea = form.container.querySelector('textarea')!;
		await fireEvent.click(textarea);
		await fireEvent.keyDown(textarea, { key: 'v', ctrlKey: true, shiftKey: true });
		assert.exists(form.container.querySelector('.ti-mail')?.closest('button'));
		await fireEvent.keyDown(textarea, { key: 'v', ctrlKey: true, shiftKey: true });
		assert.exists(form.container.querySelector('.ti-lock')?.closest('button'));
		assert.notExists(form.container.querySelector('.ti-world'));
		assert.notExists(form.container.querySelector('.ti-home'));
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
