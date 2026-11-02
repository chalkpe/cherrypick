/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { defineComponent, h, nextTick, ref } from 'vue';
import type * as Misskey from 'cherrypick-js';
import type { MenuItem } from '@/types/menu.js';

const mocks = vi.hoisted(() => ({
	api: vi.fn().mockResolvedValue([]),
	selectFile: vi.fn(),
	upload: vi.fn(),
	popupMenu: vi.fn(),
	me: { id: 'me', username: 'me', policies: { chatAvailability: 'available' } },
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/utility/drive.js', () => ({ selectFile: mocks.selectFile }));
vi.mock('@/os.js', () => ({ launchUploader: mocks.upload, popupMenu: mocks.popupMenu, alert: vi.fn() }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/utility/emoji-picker.js', () => ({ emojiPicker: { show: vi.fn() } }));
vi.mock('@/utility/reaction-picker.js', () => ({ reactionPicker: { show: vi.fn() } }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));

import XForm from '@/pages/chat/room.form.vue';
import XMessage from '@/pages/chat/XMessage.vue';
import { i18n } from '@/i18n.js';

const driveFile = {
	id: 'draft-file', createdAt: '2026-11-01T00:00:00.000Z', name: 'draft.png', type: 'image/png',
	md5: '15eca7fba0480996e2245f5185bf39f2', size: 1, isSensitive: false, blurhash: null,
	properties: {}, url: 'https://local.test/draft.png', thumbnailUrl: null, comment: null,
	folderId: null, folder: null, userId: 'me', user: null,
} as unknown as Misskey.entities.DriveFile;
const message = { id: 'm1', fromUserId: 'me', fromUser: mocks.me, text: 'Original message', createdAt: '2026-11-01T00:00:00.000Z', reactions: [] } as unknown as Misskey.entities.ChatMessage;
const user = { id: 'bob', username: 'bob' } as Misskey.entities.UserDetailed;
const room = { id: 'room1', name: 'Room' } as Misskey.entities.ChatRoom;
const stubs = {
	XVoiceCallBarSlot: true,
	MkDraggable: { props: ['modelValue'], template: '<div><slot v-for="item in modelValue" :item="item"/></div>' },
	MkDriveFileThumbnail: { props: ['file'], template: '<img :alt="file.name" />' },
	MkLoading: true,
	MkUserName: true,
	MkAvatar: true,
	MkA: true,
	MkTime: true,
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

function renderForm(target: 'user' | 'room' = 'room', initialEdit: typeof message | null = null) {
	const editing = ref(initialEdit);
	const host = defineComponent({
		setup: () => () => h(XForm, {
			...(target === 'user' ? { user } : { room }),
			editingMessage: editing.value,
			onEdited: () => { editing.value = null; },
			onCancelEdit: () => { editing.value = null; },
		}),
	});
	const result = render(host, { global: { stubs } });
	return { ...result, editing, textarea: screen.getByRole('textbox') as HTMLTextAreaElement };
}

function storedDraft(target: 'user' | 'room' = 'room') {
	return JSON.parse(localStorage.getItem('chatMessageDrafts') ?? '{}')[target === 'user' ? 'user:bob' : 'room:room1']?.data;
}

async function composeDraft(textarea: HTMLTextAreaElement) {
	await fireEvent.update(textarea, 'Unsent draft');
	mocks.selectFile.mockResolvedValueOnce(driveFile);
	await fireEvent.click(document.querySelector('.ti-photo-plus')!.closest('button')!);
	await waitFor(() => expect(screen.getByAltText('draft.png')).toBeTruthy());
}

async function pasteImage(textarea: HTMLTextAreaElement) {
	const image = new File(['image'], 'paste.png', { type: 'image/png' });
	await fireEvent.paste(textarea, {
		clipboardData: { items: [{ kind: 'file', getAsFile: () => image }], files: [image], getData: () => '' },
	});
}

async function dropImage(container: Element) {
	await fireEvent.drop(container.firstElementChild!, {
		dataTransfer: { files: [new File(['image'], 'drop.png', { type: 'image/png' })] },
	});
}

beforeEach(() => {
	localStorage.clear();
	vi.resetAllMocks();
	mocks.api.mockResolvedValue({});
	mocks.selectFile.mockResolvedValue(driveFile);
	mocks.upload.mockResolvedValue([driveFile]);
});
afterEach(cleanup);

describe.each(['user', 'room'] as const)('%s message editing', target => {
	test('keeps the persisted compose draft separate from edit text', async () => {
		const form = renderForm(target);
		await composeDraft(form.textarea);
		form.editing.value = message;
		await nextTick();
		await fireEvent.update(form.textarea, 'Changed message');
		expect(storedDraft(target)).toEqual({ text: 'Unsent draft', file: driveFile });
	});

	test('cancel restores the unsent text and attachment', async () => {
		const form = renderForm(target);
		await composeDraft(form.textarea);
		form.editing.value = message;
		await nextTick();
		await fireEvent.update(form.textarea, 'Changed message');
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts.cancel }));
		expect(form.textarea.value).toBe('Unsent draft');
		expect(screen.getByAltText('draft.png')).toBeTruthy();
	});

	test('saving restores the compose draft and sends only the edited text', async () => {
		const form = renderForm(target);
		await composeDraft(form.textarea);
		form.editing.value = message;
		await nextTick();
		await fireEvent.update(form.textarea, 'Changed message');
		await fireEvent.click(screen.getByTitle(i18n.ts.save));
		await waitFor(() => expect(form.editing.value).toBeNull());
		expect(form.textarea.value).toBe('Unsent draft');
		expect(screen.getByAltText('draft.png')).toBeTruthy();
		expect(storedDraft(target)).toEqual({ text: 'Unsent draft', file: driveFile });
		expect(mocks.api).toHaveBeenCalledWith('chat/messages/update', { messageId: 'm1', text: 'Changed message' });
	});
});

test('an in-flight save does not clear a restored compose draft', async () => {
	const pending = deferred<object>();
	mocks.api.mockReturnValueOnce(pending.promise);
	const form = renderForm();
	await composeDraft(form.textarea);
	form.editing.value = message;
	await nextTick();
	await fireEvent.click(screen.getByTitle(i18n.ts.save));
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.cancel }));
	await fireEvent.update(form.textarea, 'Continued draft');
	pending.resolve({});
	await waitFor(() => expect(screen.getByTitle(i18n.ts.send).hasAttribute('disabled')).toBe(false));
	expect(form.textarea.value).toBe('Continued draft');
	expect(screen.getByAltText('draft.png')).toBeTruthy();
});

test('an earlier save does not end a different edit session', async () => {
	const pending = deferred<object>();
	mocks.api.mockReturnValueOnce(pending.promise);
	const form = renderForm('room', message);
	await fireEvent.click(screen.getByTitle(i18n.ts.save));
	form.editing.value = { ...message, id: 'm2', text: 'Second message' };
	await nextTick();
	pending.resolve({});
	await waitFor(() => expect(screen.getByTitle(i18n.ts.save).hasAttribute('disabled')).toBe(false));
	expect(form.editing.value?.id).toBe('m2');
	expect(form.textarea.value).toBe('Second message');
});

test('edit mode blocks the picker, clipboard images, dropped uploads and Drive drops', async () => {
	const form = renderForm('room', message);
	const picker = form.container.querySelector('.ti-photo-plus')?.closest('button');
	if (picker) await fireEvent.click(picker);
	await pasteImage(form.textarea);
	await dropImage(form.container);
	await fireEvent.drop(form.container.firstElementChild!, {
		dataTransfer: { files: [], getData: () => JSON.stringify([driveFile]) },
	});
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.cancel }));
	expect(mocks.selectFile).not.toHaveBeenCalled();
	expect(mocks.upload).not.toHaveBeenCalled();
	expect(form.container.querySelector('[data-id="draft-file"]')).toBeNull();
	expect(storedDraft()?.file ?? null).toBeNull();
});

test.each(['picker', 'upload'] as const)('ignores a pending %s result after entering and leaving edit mode', async source => {
	const form = renderForm();
	const picked = deferred<Misskey.entities.DriveFile>();
	const uploaded = deferred<Misskey.entities.DriveFile[]>();
	mocks.selectFile.mockReturnValueOnce(picked.promise);
	mocks.upload.mockReturnValueOnce(uploaded.promise);
	if (source === 'picker') await fireEvent.click(form.container.querySelector('.ti-photo-plus')!.closest('button')!);
	else await dropImage(form.container);
	form.editing.value = message;
	await nextTick();
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.cancel }));
	picked.resolve(driveFile);
	uploaded.resolve([driveFile]);
	await new Promise(resolve => setTimeout(resolve, 0));
	await nextTick();
	expect(form.container.querySelector('[data-id="draft-file"]')).toBeNull();
	expect(storedDraft()?.file ?? null).toBeNull();
});

test('a draft attachment does not enable saving an empty text-only edit', async () => {
	const form = renderForm();
	await composeDraft(form.textarea);
	form.editing.value = message;
	await nextTick();
	await fireEvent.update(form.textarea, '   ');
	expect(screen.getByTitle(i18n.ts.save).hasAttribute('disabled')).toBe(true);
});

test.each([false, true])('only offers Edit with an explicit editing capability (%s)', async canEdit => {
	const result = render(XMessage, {
		props: { message, ...(canEdit ? { canEdit: true } : {}) },
		global: { stubs },
	});
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.menu }));
	const items = mocks.popupMenu.mock.calls[0][0] as MenuItem[];
	const edit = items.find(item => item != null && 'text' in item && item.text === i18n.ts.edit);
	if (canEdit) {
		expect(edit).toBeDefined();
		if (edit && 'action' in edit) await edit.action(new PointerEvent('click'));
		expect(result.emitted().edit).toEqual([[message]]);
	} else {
		expect(edit).toBeUndefined();
	}
});
