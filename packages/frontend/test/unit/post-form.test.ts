/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, assert, beforeEach, describe, test, vi, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/vue';
import { nextTick } from 'vue';
import * as Misskey from 'cherrypick-js';
import { directives } from '@/directives/index.js';
import { components } from '@/components/index.js';
import { prefer } from '@/preferences.js';
import { store } from '@/store.js';
import * as os from '@/os.js';
import * as accounts from '@/accounts.js';
import { i18n } from '@/i18n.js';
import * as sound from '@/utility/sound.js';

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
	uploadFile: vi.fn(),
}));

const { chooseDriveFile, uploadFile } = await import('@/utility/drive.js');
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

	async function chooseAccountMenuItem(form: RenderResult, menu: MockInstance<typeof os.popupMenu>, text: string) {
		menu.mockClear();
		await fireEvent.click(form.container.querySelector('header button img')!.closest('button')!);
		await waitFor(() => assert.isNotEmpty(menu.mock.calls));
		const item = menu.mock.lastCall![0].find(item => item != null && 'text' in item && item.text === text);
		if (item == null || !('action' in item) || !item.action) assert.fail(`The account menu offers ${text}`);
		await item.action(new PointerEvent('click'));
	}

	afterEach(() => {
		cleanup();
		localStorage.clear();
		fakeMe.noteVisibilityLimit = 'none';
		fakeMe.isSilenced = false;
		prefer.s.postFormVisibilityHotkey = false;
		prefer.s.keepCw = true;
		prefer.s.showPreview = false;
		prefer.s.showProfilePreview = false;
		vi.mocked(misskeyApi).mockReset();
		vi.mocked(misskeyApi).mockImplementation(() => new Promise(() => {}));
		vi.mocked(chooseDriveFile).mockReset();
		vi.mocked(uploadFile).mockReset();
		vi.restoreAllMocks();
	});

	async function chooseUploadMenuItem(form: RenderResult, menu: MockInstance<typeof os.popupMenu>, label: string, index = 0) {
		await fireEvent.click(form.container.querySelectorAll('[class*="itemActionWrapper"] button')[index]);
		const item = menu.mock.lastCall?.[0].find(item => item != null && 'text' in item && item.text === label);
		if (item == null || !('action' in item) || !item.action) assert.fail(`The upload menu offers ${label}`);
		void item.action(new PointerEvent('click'));
	}

	test('uses the selected account for a menu upload and holds the account until it finishes', async () => {
		const alternate = { ...fakeMe, id: 'alternate', policies: { ...fakeMe.policies, maxFileSizeMb: 12 } } as unknown as Misskey.entities.MeDetailed;
		vi.spyOn(accounts, 'getAccounts').mockReturnValue([{ host: 'local.test', id: alternate.id, username: alternate.username, token: 'selected-session' }]);
		vi.spyOn(accounts, 'getAccountMenu').mockImplementation(async ({ onChoose }) => [{
			type: 'button', text: 'Alternate', action: () => onChoose?.(alternate),
		}]);
		const menu = vi.spyOn(os, 'popupMenu').mockResolvedValue();
		vi.spyOn(os, 'chooseFileFromPc').mockResolvedValue([new File(['contents'], 'attachment.txt', { type: 'text/plain' })]);
		let finish!: (file: Misskey.entities.DriveFile) => void;
		vi.mocked(uploadFile).mockReturnValue({ filePromise: new Promise(resolve => { finish = resolve; }), abort: vi.fn() });
		const form = renderPostForm();
		await fireEvent.click(form.container.querySelector('textarea')!);
		await chooseAccountMenuItem(form, menu, 'Alternate');
		await fireEvent.click(form.container.querySelector('.ti-photo-plus')!.closest('button')!);
		await waitFor(() => assert.exists(form.container.querySelector('[class*="itemThumbnail"]')));
		await chooseUploadMenuItem(form, menu, i18n.ts.upload);
		assert.propertyVal(vi.mocked(uploadFile).mock.lastCall?.[1], 'token', 'selected-session');
		assert.propertyVal(vi.mocked(uploadFile).mock.lastCall?.[1], 'maxFileSizeMb', 12);
		assert.isTrue(form.container.querySelector('header button img')!.closest('button')!.disabled);
		finish(driveFile);
		await waitFor(() => assert.exists(form.container.querySelector(`[data-id="${driveFile.id}"]`)));
		assert.isFalse(form.container.querySelector('header button img')!.closest('button')!.disabled);
	});

	test('skips a removed waiting item and uploads the remaining item in order', async () => {
		const menu = vi.spyOn(os, 'popupMenu').mockResolvedValue();
		vi.spyOn(os, 'chooseFileFromPc').mockResolvedValue(['first', 'removed', 'last'].map(name => new File(['contents'], name + '.txt', { type: 'text/plain' })));
		let finish!: (file: Misskey.entities.DriveFile) => void;
		vi.mocked(uploadFile).mockReturnValueOnce({ filePromise: new Promise(resolve => { finish = resolve; }), abort: vi.fn() });
		vi.mocked(uploadFile).mockReturnValue({ filePromise: Promise.resolve({ ...driveFile, id: 'last-file' }), abort: vi.fn() });
		const form = renderPostForm();
		await fireEvent.click(form.container.querySelector('textarea')!);
		await fireEvent.click(form.container.querySelector('.ti-photo-plus')!.closest('button')!);
		await waitFor(() => assert.lengthOf(form.container.querySelectorAll('[class*="itemThumbnail"]'), 3));
		await fireEvent.click(form.container.querySelector(submitSelector)!);
		await waitFor(() => assert.lengthOf(vi.mocked(uploadFile).mock.calls, 1));
		await chooseUploadMenuItem(form, menu, i18n.ts.remove, 1);
		finish(driveFile);
		await waitFor(() => {
			const request = vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/create');
			assert.deepEqual(vi.mocked(uploadFile).mock.calls.map(([file]) => (file as File).name), ['first.txt', 'last.txt']);
			assert.deepPropertyVal(request?.[1], 'fileIds', [driveFile.id, 'last-file']);
		});
	});

	test('restores recipients and the draft ID under the selected account before resubmitting', async () => {
		const alternate = { ...fakeMe, id: 'alternate', policies: { noteDraftLimit: 10, scheduledNoteLimit: 10 } } as unknown as Misskey.entities.MeDetailed;
		vi.spyOn(accounts, 'getAccounts').mockReturnValue([{
			host: 'local.test', id: alternate.id, username: alternate.username, token: 'selected-session',
		}]);
		vi.spyOn(accounts, 'getAccountMenu').mockImplementation(async ({ onChoose }) => [{
			type: 'button', text: 'Alternate', action: () => onChoose?.(alternate),
		}, {
			type: 'button', text: 'Current', action: () => onChoose?.(fakeMe as unknown as Misskey.entities.MeDetailed),
		}]);
		const menu = vi.spyOn(os, 'popupMenu').mockResolvedValue();
		const alert = vi.spyOn(os, 'alert').mockResolvedValue(undefined);
		const form = renderPostForm();
		const textarea = form.container.querySelector('textarea')!;
		await fireEvent.click(textarea);
		await fireEvent.update(textarea, 'Existing text');
		await chooseAccountMenuItem(form, menu, 'Alternate');

		vi.mocked(chooseDriveFile).mockResolvedValue([driveFile]);
		await fireEvent.click(form.container.querySelector('.ti-cloud-download')!.closest('button')!);
		assert.deepEqual(vi.mocked(chooseDriveFile).mock.lastCall, [{ multiple: true, token: 'selected-session' }]);
		await waitFor(() => assert.exists(form.container.querySelector(`[data-id="${driveFile.id}"]`)));
		await chooseAccountMenuItem(form, menu, 'Current');
		assert.propertyVal(alert.mock.lastCall?.[0], 'text', i18n.ts._postForm.detachFilesToChangeAccount);
		assert.strictEqual(textarea.value, 'Existing text');
		assert.exists(form.container.querySelector(`[data-id="${driveFile.id}"]`));

		const popup = vi.spyOn(os, 'popup').mockReturnValue({ dispose: () => {} });
		await chooseAccountMenuItem(form, menu, i18n.ts._drafts.listScheduledNotes);
		const restore = (popup.mock.lastCall?.[2] as unknown as {
			restore: (draft: Misskey.entities.NoteDraft) => Promise<void>;
		}).restore;
		const draft = {
			id: 'restored-draft', text: 'Restored text', files: [driveFile], visibility: 'specified',
			visibleUserIds: ['recipient'], scheduledAt: Date.now() + 3_600_000,
		} as Misskey.entities.NoteDraft;
		let resolveRecipients!: (users: Misskey.entities.UserLite[]) => void;
		const recipients = new Promise<Misskey.entities.UserLite[]>(resolve => { resolveRecipients = resolve; });
		vi.mocked(misskeyApi).mockImplementation((endpoint, params) => endpoint === 'users/show' && params && 'userIds' in params ? recipients : new Promise(() => {}));
		const restoration = restore(draft);
		await nextTick();

		const submit = form.container.querySelector<HTMLButtonElement>(submitSelector)!;
		assert.isTrue(submit.disabled);
		await fireEvent.click(submit);
		assert.notExists(vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint.startsWith('notes/drafts/')));
		assert.strictEqual(textarea.value, 'Existing text');
		assert.deepEqual(vi.mocked(misskeyApi).mock.calls.filter(([endpoint]) => endpoint === 'users/show'), [
			['users/show', { userIds: draft.visibleUserIds }, 'selected-session'],
		]);

		resolveRecipients([{ id: 'recipient', username: 'recipient', host: null } as Misskey.entities.UserLite]);
		await restoration;
		await nextTick();
		assert.strictEqual(textarea.value, 'Restored text');
		await fireEvent.click(submit);
		const request = vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/drafts/update');
		assert.strictEqual(request?.[2], 'selected-session');
		assert.propertyVal(request?.[1], 'draftId', draft.id);
		assert.deepPropertyVal(request?.[1], 'visibleUserIds', draft.visibleUserIds);
	});

	test('opens a partial server draft and clears prior draft fields before saving', async () => {
		fakeMe.noteVisibilityLimit = 'followers';
		const alternate = { ...fakeMe, id: 'alternate', noteVisibilityLimit: 'none', policies: { scheduledNoteLimit: 10, noteDraftLimit: 10 } } as unknown as Misskey.entities.MeDetailed;
		vi.spyOn(accounts, 'getAccounts').mockReturnValue([{ host: 'local.test', id: alternate.id, username: alternate.username, token: 'selected-session' }]);
		vi.spyOn(accounts, 'getAccountMenu').mockImplementation(async ({ onChoose }) => [{
			type: 'button', text: 'Alternate', action: () => onChoose?.(alternate),
		}]);
		const menu = vi.spyOn(os, 'popupMenu').mockResolvedValue();
		const popup = vi.spyOn(os, 'popup').mockReturnValue({ dispose: () => {} });
		const recipient = { id: 'recipient', username: 'recipient', host: null } as Misskey.entities.UserLite;
		vi.mocked(misskeyApi).mockImplementation((endpoint, params) => endpoint === 'users/show' && params && 'userIds' in params
			? Promise.resolve([recipient])
			: new Promise(() => {}));
		const form = renderPostForm();
		const textarea = form.container.querySelector('textarea')!;
		await fireEvent.click(textarea);
		await chooseAccountMenuItem(form, menu, 'Alternate');
		assert.exists(form.container.querySelector('button .ti-world'), 'the alternate account allows public notes');

		await chooseAccountMenuItem(form, menu, i18n.ts._drafts.listScheduledNotes);
		const restore = (popup.mock.lastCall?.[2] as unknown as {
			restore: (draft: Misskey.entities.NoteDraft) => Promise<void>;
		}).restore;
		const when = Date.now() + 3_600_000;
		const prior = {
			id: 'prior', text: 'Prior draft', visibility: 'public', scheduledAt: when,
			channel: { id: 'channel', name: 'Prior channel', color: '#aaa' },
			deleteAt: new Date(when + 3_600_000).toISOString(),
			poll: { choices: ['Prior choice', 'Second option'], multiple: false },
			event: { title: 'Prior event', start: when, end: when + 30 * 60_000, metadata: {} },
		} as unknown as Misskey.entities.NoteDraft;
		await restore(prior);
		await nextTick();
		assert.exists(form.getByDisplayValue('Prior choice'));
		assert.exists(form.getByDisplayValue('Prior event'));

		const draft = {
			id: 'restored-draft', text: 'Partial draft', files: [driveFile], visibility: 'specified',
			visibleUserIds: [recipient.id, 'unavailable'], scheduledAt: when,
		} as Misskey.entities.NoteDraft;
		await restore(draft);
		await nextTick();

		assert.strictEqual(textarea.value, 'Partial draft');
		assert.exists(form.container.querySelector(`[data-id="${driveFile.id}"]`));
		assert.isNull(form.queryByDisplayValue('Prior choice'));
		assert.isNull(form.queryByDisplayValue('Prior event'));
		assert.isNull(form.queryByText('Prior channel'));
		const submit = form.container.querySelector<HTMLButtonElement>(submitSelector)!;
		assert.isTrue(submit.disabled);
		assert.notExists(vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/drafts/update'));

		await fireEvent.click(form.getByRole('button', { name: i18n.ts._postForm.removeUnavailableDraftRecipients }));
		await fireEvent.click(submit);
		const request = vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/drafts/update');
		assert.strictEqual(request?.[2], 'selected-session');
		assert.propertyVal(request?.[1], 'draftId', draft.id);
		assert.propertyVal(request?.[1], 'visibility', 'specified');
		assert.propertyVal(request?.[1], 'channelId', null);
		assert.propertyVal(request?.[1], 'scheduledDelete', null);
		assert.propertyVal(request?.[1], 'poll', null);
		assert.propertyVal(request?.[1], 'event', null);
		assert.deepPropertyVal(request?.[1], 'visibleUserIds', [recipient.id]);
	});

	test('opens a legacy local draft with its attachment account selected', async () => {
		const alternate = { ...fakeMe, id: 'alternate' } as unknown as Misskey.entities.MeDetailed;
		vi.spyOn(accounts, 'getAccounts').mockReturnValue([{ host: 'local.test', id: alternate.id, username: alternate.username, token: 'selected-session' }]);
		vi.mocked(misskeyApi).mockImplementation(endpoint => endpoint === 'i' ? Promise.resolve(alternate) : new Promise(() => {}));
		localStorage.setItem('drafts', JSON.stringify({
			'note:me': { data: { text: 'Local draft', visibility: 'public', files: [driveFile], attachmentAccountId: alternate.id } },
		}));
		const form = renderPostForm();
		const textarea = form.container.querySelector('textarea')!;
		await waitFor(() => assert.strictEqual(textarea.value, 'Local draft'));
		await fireEvent.click(textarea);
		await fireEvent.click(form.container.querySelector(submitSelector)!);
		await waitFor(() => {
			const call = vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/create');
			assert.strictEqual(call?.[2], 'selected-session');
			assert.deepPropertyVal(call?.[1], 'fileIds', [driveFile.id]);
		});
	});

	test.each([false, true])('uses the selected account for server drafts (scheduled: %s)', async scheduled => {
		fakeMe.policies.noteDraftLimit = 10;
		fakeMe.policies.scheduledNoteLimit = 10;
		try {
			const alternate = { ...fakeMe, id: 'alternate' } as unknown as Misskey.entities.MeDetailed;
			vi.spyOn(accounts, 'getAccounts').mockReturnValue([{
				host: 'local.test', id: alternate.id, username: alternate.username, token: 'selected-session',
			}]);
			vi.spyOn(accounts, 'getAccountMenu').mockImplementation(async ({ onChoose }) => [{
				type: 'button',
				text: 'Alternate',
				action: () => onChoose?.(alternate),
			}]);
			const menu = vi.spyOn(os, 'popupMenu').mockResolvedValue();
			const apiError = vi.spyOn(os, 'apiErrorDialog').mockResolvedValue();
			vi.spyOn(sound, 'playMisskeySfx').mockImplementation(() => {});
			const chooseFromPc = vi.spyOn(os, 'chooseFileFromPc').mockResolvedValue([new File(['contents'], 'attachment.txt', { type: 'text/plain' })]);
			let completeUpload!: (file: Misskey.entities.DriveFile) => void;
			vi.mocked(uploadFile).mockImplementationOnce(() => ({
				filePromise: Promise.reject(new Error('Upload failed')),
				abort: vi.fn(),
			})).mockReturnValue({
				filePromise: new Promise(resolve => { completeUpload = resolve; }),
				abort: vi.fn(),
			});
			const date = new Date(Date.now() + 3_600_000);
			vi.spyOn(os, 'inputDatetime').mockResolvedValue({ canceled: false, result: date });
			const form = renderPostForm();
			const textarea = form.container.querySelector('textarea')!;
			await fireEvent.click(textarea);
			await fireEvent.update(textarea, 'Text for one account');
			await fireEvent.click(form.container.querySelector('header button img')!.closest('button')!);
			await waitFor(() => assert.isNotEmpty(menu.mock.calls));
			const choose = menu.mock.lastCall![0].find(item => item != null && 'text' in item && item.text === 'Alternate');
			if (choose == null || !('type' in choose) || choose.type !== 'button') assert.fail('the alternate account is available');
			await choose.action(new PointerEvent('click'));
			await fireEvent.click(form.container.querySelector('.ti-photo-plus')!.closest('button')!);
			assert.strictEqual(chooseFromPc.mock.calls.length, 1);

			const icon = scheduled ? '.ti-dots' : '.ti-caret-down-filled';
			await fireEvent.click(form.container.querySelector(icon)!.closest('button')!);
			const label = scheduled ? i18n.ts.schedulePost + '...' : i18n.ts._drafts.saveToDraft;
			const option = menu.mock.lastCall![0].find(item => item != null && 'text' in item && item.text === label);
			if (option != null && 'type' in option && option.type === 'switch') option.ref.value = true;
			else if (option != null && 'action' in option) await option.action(new PointerEvent('click'));
			else assert.fail('the server draft option is available');
			await nextTick();

			const submit = form.container.querySelector<HTMLButtonElement>(submitSelector)!;
			await waitFor(() => assert.isFalse(submit.disabled));
			await fireEvent.click(submit);
			await waitFor(() => assert.isFalse(submit.disabled));
			assert.strictEqual(textarea.value, 'Text for one account');
			assert.exists(form.container.querySelector('[class*="itemThumbnail"]'));
			assert.isUndefined(vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/drafts/create'));

			const draftError: Misskey.api.APIError = { message: 'Draft rejected', id: 'draft-error', code: 'DRAFT_REJECTED', kind: 'client', info: {} };
			let rejectSave!: (err: typeof draftError) => void;
			const save = new Promise<never>((_, reject) => { rejectSave = reject; });
			vi.mocked(misskeyApi).mockImplementation(endpoint => endpoint === 'notes/drafts/create' ? save : new Promise(() => {}));
			await fireEvent.click(submit);
			assert.isTrue(submit.disabled, 'submission is locked during the upload');
			assert.isUndefined(vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/drafts/create'));
			assert.propertyVal(vi.mocked(uploadFile).mock.lastCall?.[1], 'token', 'selected-session');

			completeUpload(driveFile);
			await waitFor(() => assert.isNotEmpty(vi.mocked(misskeyApi).mock.calls.filter(([endpoint]) => endpoint === 'notes/drafts/create')));
			await fireEvent.click(submit);

			const requests = vi.mocked(misskeyApi).mock.calls.filter(([endpoint]) => endpoint === 'notes/drafts/create');
			assert.lengthOf(requests, 1, 'a pending save cannot be repeated');
			const [request] = requests;
			assert.strictEqual(request?.[2], 'selected-session');
			assert.propertyVal(request?.[1], 'isActuallyScheduled', scheduled);
			assert.deepPropertyVal(request?.[1], 'fileIds', [driveFile.id]);

			rejectSave(draftError);
			await waitFor(() => assert.isFalse(submit.disabled));
			assert.deepEqual(apiError.mock.lastCall, ['notes/drafts/create', draftError]);
			assert.strictEqual(textarea.value, 'Text for one account');
			assert.exists(form.container.querySelector(`[data-id="${driveFile.id}"]`));
			assert.propertyVal(JSON.parse(localStorage.getItem('drafts') ?? '{}')['note:me']?.data, 'postAccountId', alternate.id);

			vi.mocked(misskeyApi).mockImplementation(async endpoint => endpoint === 'notes/drafts/create' ? undefined : new Promise(() => {}));
			await fireEvent.click(submit);
			await waitFor(() => {
				assert.strictEqual(textarea.value, '');
				assert.isUndefined(JSON.parse(localStorage.getItem('drafts') ?? '{}')['note:me']);
			});
			assert.lengthOf(vi.mocked(uploadFile).mock.calls, 2, 'an already uploaded file is reused when retrying the save');
		} finally {
			fakeMe.policies.noteDraftLimit = 0;
			fakeMe.policies.scheduledNoteLimit = 0;
		}
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

	test('editing a note does not send visibility, which notes/update reserves for moderation', async () => {
		// 編集完了音はテスト環境にサウンド設定が無いので鳴らさない
		vi.spyOn(sound, 'playMisskeySfx').mockImplementation(() => {});
		const popupMenu = vi.spyOn(os, 'popupMenu').mockResolvedValue();
		vi.mocked(misskeyApi).mockImplementation(async (endpoint) => {
			if (endpoint === 'notes/update') return { updatedNote: {} };
			return new Promise(() => {});
		});
		const localDraft = JSON.stringify({
			'note:me': { data: { text: 'A different draft', files: [{ ...driveFile, id: 'other-file' }], attachmentAccountId: 'alternate' } },
		});
		localStorage.setItem('drafts', localDraft);
		const initialNote = {
			id: 'note-1',
			createdAt: '1970-01-01T00:00:00.000Z',
			userId: 'me',
			text: 'Original note',
			cw: null,
			visibility: 'home',
			localOnly: false,
			files: [driveFile],
			reactionAcceptance: null,
		} as unknown as Misskey.entities.Note;
		const form = render(component, {
			props: { autofocus: false, initialVisibility: 'home', initialLocalOnly: false, initialNote, updateMode: true },
			global: {
				directives: { ...directives, panel: {} },
				components,
			},
		});
		const textarea = form.container.querySelector('textarea')!;
		await fireEvent.click(textarea);
		await nextTick();
		assert.notExists(form.container.querySelector('.ti-home')?.closest('button'), 'visibility control is hidden in edit mode');
		assert.notExists(form.container.querySelector('.ti-rocket')?.closest('button'), 'local-only control is hidden in edit mode');
		await fireEvent.click(form.container.querySelector('.ti-dots')!.closest('button')!);
		await nextTick();
		const menuItems = popupMenu.mock.calls[0][0] as { icon?: string }[];
		assert.isFalse(menuItems.some(item => item.icon === 'ti ti-truck-delivery'), 'delivery target control is hidden in edit mode');
		await fireEvent.update(textarea, 'Edited note');
		await fireEvent.click(form.container.querySelector(submitSelector)!);

		await waitFor(() => {
			const call = vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/update');
			assert.exists(call, 'notes/update is called');
			const params = call![1] as Record<string, unknown>;
			assert.strictEqual(params.noteId, 'note-1');
			assert.strictEqual(params.text, 'Edited note');
			assert.deepEqual(params.fileIds, [driveFile.id]);
			assert.strictEqual(localStorage.getItem('drafts'), localDraft);
			assert.isUndefined(params.visibility, 'visibility is omitted from the request body');
			assert.isUndefined(params.localOnly, 'localOnly is omitted from the request body');
			assert.isUndefined(params.deliveryTargets, 'deliveryTargets is omitted from the request body');
		});
	});

	test('editing a specified note hides the recipient editor and omits the audience', async () => {
		vi.spyOn(sound, 'playMisskeySfx').mockImplementation(() => {});
		vi.mocked(misskeyApi).mockImplementation(async (endpoint) => {
			if (endpoint === 'notes/update') return { updatedNote: {} };
			return new Promise(() => {});
		});
		const initialNote = {
			id: 'note-1',
			createdAt: '1970-01-01T00:00:00.000Z',
			userId: 'me',
			text: 'Original note',
			cw: null,
			visibility: 'specified',
			localOnly: false,
			visibleUserIds: [],
			files: [],
			reactionAcceptance: null,
		} as unknown as Misskey.entities.Note;
		const form = render(component, {
			props: { autofocus: false, initialVisibility: 'specified', initialLocalOnly: false, initialNote, updateMode: true },
			global: {
				directives: { ...directives, panel: {} },
				components,
			},
		});
		const textarea = form.container.querySelector('textarea')!;
		await fireEvent.click(textarea);
		await nextTick();
		assert.notExists(form.container.querySelector('[class*="toSpecified"]'), 'recipient editor is hidden in edit mode');
		await fireEvent.update(textarea, 'Edited note @bob');
		await nextTick();
		assert.notExists(form.container.querySelector('[class*="hasNotSpecifiedMentions"]'), 'missing mention warning is hidden in edit mode');
		await fireEvent.click(form.container.querySelector(submitSelector)!);

		await waitFor(() => {
			const call = vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/update');
			assert.exists(call, 'notes/update is called');
			const params = call![1] as Record<string, unknown>;
			assert.strictEqual(params.noteId, 'note-1');
			assert.strictEqual(params.text, 'Edited note @bob');
			assert.isUndefined(params.visibleUserIds, 'visibleUserIds is omitted from the request body');
			assert.isUndefined(params.localOnly, 'localOnly is omitted from the request body');
			assert.isUndefined(params.deliveryTargets, 'deliveryTargets is omitted from the request body');
		});
	});

	test('keeps the preview avatar while the first syllable is being composed', async () => {
		prefer.s.showPreview = true;
		prefer.s.showProfilePreview = true;
		const form = renderPostForm();
		const textarea = form.container.querySelector('textarea')!;
		await fireEvent.click(textarea);
		// フォーム上部のアカウントアバターではなく、プレビュー内のアバターだけを見る
		const previewRoot = () => form.container.querySelector<HTMLElement>('[class*="preview"]');
		const previewAvatar = () => previewRoot()?.querySelector(`img[src="${fakeMe.avatarUrl}"]`) ?? null;
		// happy-dom の CompositionEvent は data を持たない素の Event なので、ここで補う
		const composition = async (type: 'compositionstart' | 'compositionupdate' | 'compositionend', data: string) => {
			const event = new Event(type, { bubbles: true });
			Object.defineProperty(event, 'data', { value: data });
			if (type !== 'compositionstart') textarea.value = data;
			textarea.dispatchEvent(event);
			await nextTick();
		};

		// macOS の韓国語 IME は 1 音節目を組み立てる途中で、未確定文字列を一度空にしてから組み直す
		await composition('compositionstart', '');
		await composition('compositionupdate', 'ㄱ');
		const avatar = previewAvatar();
		assert.exists(avatar, 'the preview appears while composing');
		await composition('compositionupdate', '');
		assert.strictEqual(previewRoot()?.style.display, 'none', 'the preview is hidden, not removed, while the body is empty');
		await composition('compositionend', '');
		await composition('compositionstart', '');
		await composition('compositionupdate', '가');
		assert.notStrictEqual(previewRoot()?.style.display, 'none', 'the preview is shown again once the body has text');
		assert.strictEqual(previewAvatar(), avatar, 'the avatar element is not recreated');
	});

	// iOS の Safari (iOS 18・27 で確認) は「単語:」で始まる文字列をコピーすると、text/plain の原文に加えてパーセントエンコードした
	// text/uri-list も登録し、既定の貼り付けでそちらを入れる (iPhone SE 2 / iOS 27.2 の実機で確認した値)
	describe('pasting text that iOS also registered as an encoded URL', () => {
		const iosPastes = [
			{ plain: 'haru: 확인했어요 — 안녕', uriList: 'haru:%20%ED%99%95%EC%9D%B8%ED%96%88%EC%96%B4%EC%9A%94%20%E2%80%94%20%EC%95%88%EB%85%95' },
			{ plain: 'Note: hello world', uriList: 'note:%20hello%20world' },
			{ plain: 'https://example.com/a b', uriList: 'https://example.com/a%20b' },
		];
		const fields = [
			{ field: 'CW', selector: '[class*="cwOuter"] input' },
			{ field: 'hashtags', selector: 'input[list="hashtags"]' },
		];

		// happy-dom には document.execCommand が無い。ブラウザと同じく insertText を最初に試すことだけ確かめ、
		// 挿入そのものは insert-text-at-cursor の代替経路 (setRangeText + input イベント) に任せる
		const execCommand = vi.fn((_commandId: string, _showUi?: boolean, _value?: string) => false);
		beforeEach(() => {
			execCommand.mockClear();
			document.execCommand = execCommand;
		});
		afterEach(async () => {
			Reflect.deleteProperty(document, 'execCommand');
			// ハッシュタグ欄は store に保存されて次のフォームへ引き継がれる
			await store.set('postFormHashtags', '');
		});

		const paste = async (el: HTMLElement, data: Record<string, string>, files: File[] = []) => {
			const clipboardData = new DataTransfer();
			for (const file of files) clipboardData.items.add(file);
			for (const [type, value] of Object.entries(data)) clipboardData.setData(type, value);
			const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
			el.dispatchEvent(event);
			await nextTick();
			return event;
		};

		test.each(iosPastes)('inserts the original text into the body at the caret: $plain', async ({ plain, uriList }) => {
			vi.mocked(misskeyApi).mockImplementation(async (endpoint) => {
				if (endpoint === 'notes/create') return undefined;
				return new Promise(() => {});
			});
			const form = renderPostForm();
			const textarea = form.container.querySelector('textarea')!;
			await fireEvent.click(textarea);
			await fireEvent.update(textarea, 'ab');
			textarea.setSelectionRange(1, 1);

			const event = await paste(textarea, { 'text/plain': plain, 'text/uri-list': uriList });

			assert.isTrue(event.defaultPrevented, 'the encoded URL is not pasted');
			assert.deepStrictEqual(execCommand.mock.calls, [['insertText', false, plain]], 'insertText is tried first so the paste can be undone');
			assert.strictEqual(textarea.value, `a${plain}b`);
			await fireEvent.click(form.container.querySelector(submitSelector)!);
			await waitFor(() => {
				const call = vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/create');
				assert.exists(call, 'notes/create is called');
				assert.strictEqual((call![1] as Record<string, unknown>).text, `a${plain}b`, 'the form model follows the inserted text');
			});
		});

		test.each(fields)('inserts the original text into the $field input', async ({ selector }) => {
			const { plain, uriList } = iosPastes[0];
			const form = renderPostForm();
			await fireEvent.click(form.container.querySelector('textarea')!);
			const input = form.container.querySelector<HTMLInputElement>(selector)!;

			const event = await paste(input, { 'text/plain': plain, 'text/uri-list': uriList });

			assert.isTrue(event.defaultPrevented, 'the encoded URL is not pasted');
			assert.deepStrictEqual(execCommand.mock.calls, [['insertText', false, plain]]);
			assert.strictEqual(input.value, plain);
		});

		test.each<{ title: string; data: Record<string, string> }>([
			{ title: 'a copied link', data: { 'text/plain': 'https://example.com/a', 'text/uri-list': 'https://example.com/a' } },
			{ title: 'text only', data: { 'text/plain': 'Note: hello world' } },
			{ title: 'a URL only', data: { 'text/uri-list': 'note:%20hello%20world' } },
			{ title: 'a URL that is not the encoded text', data: { 'text/plain': 'see https://example.com', 'text/uri-list': 'https://example.com' } },
			{ title: 'a URL that cannot be decoded', data: { 'text/plain': 'note: 100%', 'text/uri-list': 'note:%20100%' } },
		])('leaves the browser paste alone for $title', async ({ data }) => {
			const form = renderPostForm();
			const textarea = form.container.querySelector('textarea')!;
			await fireEvent.click(textarea);
			for (const el of [textarea, ...fields.map(({ selector }) => form.container.querySelector<HTMLInputElement>(selector)!)]) {
				const event = await paste(el, data);
				assert.isFalse(event.defaultPrevented);
				assert.strictEqual(el.value, '');
			}
			assert.strictEqual(execCommand.mock.calls.length, 0);
		});

		test('does not write into a read-only body', async () => {
			const { plain, uriList } = iosPastes[0];
			const form = renderPostForm();
			const textarea = form.container.querySelector('textarea')!;
			await fireEvent.click(textarea);
			// メンションの挿入中などはフォーカストラップ回避のために本文を一時的に読み取り専用にする
			textarea.readOnly = true;

			const event = await paste(textarea, { 'text/plain': plain, 'text/uri-list': uriList });

			assert.isFalse(event.defaultPrevented);
			assert.strictEqual(textarea.value, '');
			assert.strictEqual(execCommand.mock.calls.length, 0);
		});

		test('pasting a file does not insert the text that came with it', async () => {
			const { plain, uriList } = iosPastes[0];
			const form = renderPostForm();
			const textarea = form.container.querySelector('textarea')!;
			await fireEvent.click(textarea);
			const file = () => new File(['%PDF-'], 'document.pdf', { type: 'application/pdf' });

			const bodyEvent = await paste(textarea, { 'text/plain': plain, 'text/uri-list': uriList }, [file()]);
			assert.isTrue(bodyEvent.defaultPrevented, 'the body attaches the file instead');
			assert.strictEqual(textarea.value, '');
			await waitFor(() => {
				assert.exists(form.container.querySelector('[class*="itemThumbnail"]'), 'the file is queued for upload');
			});

			for (const { selector } of fields) {
				const input = form.container.querySelector<HTMLInputElement>(selector)!;
				const event = await paste(input, { 'text/plain': plain, 'text/uri-list': uriList }, [file()]);
				assert.isFalse(event.defaultPrevented, 'single-line inputs keep the browser paste for files');
				assert.strictEqual(input.value, '');
			}
			assert.strictEqual(execCommand.mock.calls.length, 0);
		});
	});
});
