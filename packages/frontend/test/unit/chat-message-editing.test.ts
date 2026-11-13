/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { defineComponent, h, inject, nextTick, ref } from 'vue';
import type * as Misskey from 'cherrypick-js';
import type { MenuItem } from '@/types/menu.js';

const mocks = vi.hoisted(() => ({
	api: vi.fn().mockResolvedValue([]),
	selectFile: vi.fn(),
	upload: vi.fn(),
	popupMenu: vi.fn(),
	contextMenu: vi.fn(),
	confirm: vi.fn(),
	reactionPicker: vi.fn(),
	me: { id: 'me', username: 'me', policies: { chatAvailability: 'available' } },
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/utility/drive.js', () => ({ selectFile: mocks.selectFile }));
vi.mock('@/os.js', () => ({ launchUploader: mocks.upload, popupMenu: mocks.popupMenu, contextMenu: mocks.contextMenu, confirm: mocks.confirm, alert: vi.fn(), popup: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/utility/emoji-picker.js', () => ({ emojiPicker: { show: vi.fn() } }));
vi.mock('@/utility/reaction-picker.js', () => ({ reactionPicker: { show: mocks.reactionPicker } }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));

import XForm from '@/pages/chat/room.form.vue';
import { emojiPicker } from '@/utility/emoji-picker.js';
import XMessage from '@/pages/chat/XMessage.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { DI } from '@/di.js';

const driveFile = {
	id: 'draft-file', createdAt: '2026-11-01T00:00:00.000Z', name: 'draft.png', type: 'image/png',
	md5: '15eca7fba0480996e2245f5185bf39f2', size: 1, isSensitive: false, blurhash: null,
	properties: {}, url: 'https://local.test/draft.png', thumbnailUrl: null, comment: null,
	folderId: null, folder: null, userId: 'me', user: null,
} as unknown as Misskey.entities.DriveFile;
const message = { id: 'm1', fromUserId: 'me', fromUser: mocks.me, text: 'Original message', createdAt: '2026-11-01T00:00:00.000Z', reactions: [], fileIds: [], files: [] } as unknown as Misskey.entities.ChatMessage;
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
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function renderForm(target: 'user' | 'room' = 'room', initialEdit: typeof message | null = null, onSent?: (id: string) => void) {
	const editing = ref(initialEdit);
	const host = defineComponent({
		setup: () => () => h(XForm, {
			...(target === 'user' ? { user } : { room }),
			editingMessage: editing.value,
			onEdited: () => { editing.value = null; },
			onCancelEdit: () => { editing.value = null; },
			onSent,
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
	mocks.selectFile.mockResolvedValueOnce([driveFile]);
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
	mocks.selectFile.mockResolvedValue([driveFile]);
	mocks.upload.mockResolvedValue([driveFile]);
});
afterEach(cleanup);

test('sends channel messages and preserves selected references during editing', async () => {
	const channelMessage = { ...message, text: '😀 #same', channelRefs: [{ channelId: 'same2', start: 3, length: 5 }] };
	const form = render(XForm, {
		props: { room: { ...room, hasChannels: true }, channelId: 'same1', editingMessage: channelMessage },
		global: { stubs },
	});
	await fireEvent.update(screen.getByRole('textbox'), 'hello 😀 #same');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.save }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/messages/update', {
		messageId: 'm1', text: 'hello 😀 #same', channelRefs: [{ channelId: 'same2', start: 9, length: 5 }],
	}));
	form.unmount();

	render(XForm, { props: { room: { ...room, hasChannels: true }, channelId: 'same2' }, global: { stubs } });
	await fireEvent.update(screen.getByRole('textbox'), '/dice 1d6');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.send }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/messages/create-to-room', {
		toRoomId: 'room1', toRoomChannelId: 'same2', text: '/dice 1d6', fileIds: undefined, channelRefs: [],
	}));
});

test('connects only the channel selected from the mention-style candidate list', async () => {
	const channels = [{ id: 'same1', roomId: room.id, name: 'same', isLegacy: true }, { id: 'same2', roomId: room.id, name: 'same', isLegacy: false }];
	render(XForm, { props: { room: { ...room, hasChannels: true }, channelId: 'same1', channels }, global: { stubs } });
	const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
	await fireEvent.update(textarea, '😀 #sa');
	textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	await fireEvent.input(textarea);
	const popup = vi.mocked(os.popup).mock.lastCall!;
	expect(popup[1]).toMatchObject({ type: 'chatChannel' });
	(popup[2] as unknown as { done: (result: unknown) => void }).done({ type: 'chatChannel', value: channels[1] });
	await nextTick();
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.send }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/messages/create-to-room', {
		toRoomId: 'room1', toRoomChannelId: 'same1', text: '😀 #same ', fileIds: undefined, channelRefs: [{ channelId: 'same2', start: 3, length: 5 }],
	}));
});

const dice = { version: 1, engine: '@dice-roller/rpg-dice-roller', engineVersion: '5.5.1', notation: '1d6', total: 4, output: '1d6: [4] = 4 <b>$(spin)</b>' } satisfies NonNullable<Misskey.entities.ChatMessage['dice']>;

test('shows a saved total and closed, plain-text roll details', () => {
	const { container } = render(XMessage, { props: { message: { ...message, text: '/dice', dice } }, global: { stubs } });

	expect(screen.getByText('4')).toBeTruthy();
	const details = container.querySelector('details')!;
	expect(details).toBeTruthy();
	expect(details.open).toBe(false);
	expect(details.textContent).toContain(dice.output);
	expect(details.querySelector('b')).toBeNull();
});

test('ordinary result-like text cannot create a dice result and tombstones hide it', () => {
	const normal = render(XMessage, { props: { message: { ...message, text: dice.output } }, global: { stubs } });
	expect(normal.container.querySelector('details')).toBeNull();
	normal.unmount();

	const deleted = render(XMessage, { props: { message: { ...message, text: '/dice', dice, deletedAt: new Date().toISOString() } }, global: { stubs } });
	expect(deleted.container.querySelector('details')).toBeNull();
	expect(screen.queryByText('4')).toBeNull();
});

test('a saved dice result has no edit menu entry', async () => {
	render(XMessage, { props: { message: { ...message, dice }, canEdit: true }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.menu }));

	const menu = mocks.popupMenu.mock.lastCall![0] as MenuItem[];
	expect(menu.some(item => item && 'text' in item && item.text === i18n.ts.edit)).toBe(false);
});

test.each([
	['DICE_INVALID', 'diceInvalid'],
	['DICE_LIMIT', 'diceLimit'],
	['DICE_BUSY', 'diceBusy'],
] as const)('preserves a failed dice command and shows the localized %s error', async (code, key) => {
	const form = renderForm();
	mocks.api.mockRejectedValueOnce({ code });
	await fireEvent.update(form.textarea, '/dice bad-expression');

	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.send }));
	await waitFor(() => expect(os.alert).toHaveBeenCalledWith({ type: 'error', title: i18n.ts.somethingHappened, text: i18n.ts._chat[key] }));
	expect(form.textarea.value).toBe('/dice bad-expression');
});

describe.each(['user', 'room'] as const)('the %s message box offers no dice help', target => {
	function expectNoDiceHelp(container: Element) {
		expect(container.querySelector('details, summary')).toBeNull();
		expect(container.querySelector('a[href]')).toBeNull();
		expect(container.textContent).not.toMatch(/dice/i);
	}

	test('while it is empty', () => {
		const form = renderForm(target);

		expect(form.textarea.value).toBe('');
		expectNoDiceHelp(form.container);
	});

	test('after /dice is typed', async () => {
		const form = renderForm(target);

		await fireEvent.update(form.textarea, '/dice');

		expect(form.textarea.value).toBe('/dice');
		expectNoDiceHelp(form.container);
	});

	test('while a message is being edited', () => {
		const form = renderForm(target, message);

		expect(screen.getByText(i18n.ts._chat.editingMessage)).toBeTruthy();
		expectNoDiceHelp(form.container);
	});
});

test('the message box and the emoji button have accessible names', () => {
	const form = renderForm();
	expect(form.textarea.getAttribute('aria-label')).toBe(i18n.ts.inputMessageHere);
	expect(screen.getByRole('button', { name: i18n.ts.emoji })).toBeTruthy();
	expect(screen.getByRole('button', { name: i18n.ts.selectFile }).getAttribute('title')).toBe(i18n.ts.selectFile);
});

test('closing the emoji picker returns focus to the message box', async () => {
	const form = renderForm();
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.emoji }));
	const [, , onClosed] = vi.mocked(emojiPicker.show).mock.lastCall as unknown as [unknown, unknown, () => void];

	onClosed();
	await nextTick();

	expect(document.activeElement).toBe(form.textarea);
});

describe.each(['user', 'room'] as const)('%s message editing', target => {
	test('clears an existing attachment caption without replacing the file', async () => {
		const form = renderForm(target, { ...message, fileIds: [driveFile.id], files: [driveFile] });
		await fireEvent.update(form.textarea, '');
		expect(screen.getByTitle(i18n.ts.save).getAttribute('aria-disabled') === 'true').toBe(false);
		await fireEvent.click(screen.getByTitle(i18n.ts.save));
		await waitFor(() => expect(form.editing.value).toBeNull());
		expect(mocks.api).toHaveBeenCalledWith('chat/messages/update', { messageId: message.id, text: '' });
	});

	test('a compose draft attachment does not allow an empty edit of a text-only message', async () => {
		const form = renderForm(target);
		await composeDraft(form.textarea);
		form.editing.value = message;
		await nextTick();
		await fireEvent.update(form.textarea, '');
		expect(screen.getByTitle(i18n.ts.save).getAttribute('aria-disabled') === 'true').toBe(true);
		await fireEvent.keyDown(form.textarea, { key: 'Enter', ctrlKey: true });
		expect(mocks.api).not.toHaveBeenCalledWith('chat/messages/update', expect.anything());
	});

	test('keeps the persisted compose draft separate from edit text', async () => {
		const form = renderForm(target);
		await composeDraft(form.textarea);
		form.editing.value = message;
		await nextTick();
		await fireEvent.update(form.textarea, 'Changed message');
		expect(storedDraft(target)).toEqual({ text: 'Unsent draft', files: [driveFile] });
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
		expect(storedDraft(target)).toEqual({ text: 'Unsent draft', files: [driveFile] });
		expect(mocks.api).toHaveBeenCalledWith('chat/messages/update', { messageId: 'm1', text: 'Changed message' });
	});
});

// The room goes to the newest message for what this window sent. The channel says only who wrote it, which could be another device.
describe('telling the page what was sent from here', () => {
	test.each(['user', 'room'] as const)('names a new message to a %s once the server has it', async (target) => {
		const sent = deferred<{ id: string }>();
		mocks.api.mockReturnValueOnce(sent.promise);
		const onSent = vi.fn();
		const form = renderForm(target, null, onSent);
		await fireEvent.update(form.textarea, 'Hello');

		await fireEvent.click(screen.getByTitle(i18n.ts.send));
		expect(onSent).not.toHaveBeenCalled();

		sent.resolve({ id: 'sent-1' });
		await waitFor(() => expect(onSent).toHaveBeenCalledExactlyOnceWith('sent-1'));
	});

	test('does not for a saved edit, which is not new', async () => {
		const onSent = vi.fn();
		const form = renderForm('room', message, onSent);
		await fireEvent.update(form.textarea, 'Changed message');

		await fireEvent.click(screen.getByTitle(i18n.ts.save));

		await waitFor(() => expect(form.editing.value).toBeNull());
		expect(onSent).not.toHaveBeenCalled();
	});

	test('does not when sending fails', async () => {
		mocks.api.mockRejectedValueOnce(new Error('refused'));
		const onSent = vi.fn();
		const form = renderForm('room', null, onSent);
		await fireEvent.update(form.textarea, 'Hello');

		await fireEvent.click(screen.getByTitle(i18n.ts.send));

		await waitFor(() => expect(mocks.api).toHaveBeenCalled());
		await nextTick();
		await nextTick();
		expect(onSent).not.toHaveBeenCalled();
		expect(form.textarea.value).toBe('Hello');
	});
});

test('a failed save tells the user and keeps the edit open', async () => {
	mocks.api.mockRejectedValueOnce(new Error('This room is archived.'));
	const form = renderForm();
	form.editing.value = message;
	await nextTick();
	await fireEvent.update(form.textarea, 'Edited');
	await fireEvent.click(screen.getByTitle(i18n.ts.save));

	await waitFor(() => expect(os.alert).toHaveBeenCalledWith({ type: 'error', title: i18n.ts.somethingHappened, text: i18n.ts._chat.actionFailed }));
	expect(form.editing.value).toEqual(message);
	expect(form.textarea.value).toBe('Edited');
});

test('says that a message is being edited only while it is', async () => {
	const form = renderForm();
	expect(screen.queryByText(i18n.ts._chat.editingMessage)).toBeNull();

	form.editing.value = message;
	await nextTick();
	expect(screen.getByText(i18n.ts._chat.editingMessage)).toBeTruthy();

	form.editing.value = null;
	await nextTick();
	expect(screen.queryByText(i18n.ts._chat.editingMessage)).toBeNull();
});

test.each(['user', 'room'] as const)('a failed %s message send tells the user and keeps the text', async target => {
	mocks.api.mockRejectedValueOnce(new Error('Rate limit exceeded.'));
	const form = renderForm(target);
	await fireEvent.update(form.textarea, 'Unsent');
	await fireEvent.click(screen.getByTitle(i18n.ts.send));

	await waitFor(() => expect(os.alert).toHaveBeenCalledWith({ type: 'error', title: i18n.ts.somethingHappened, text: i18n.ts._chat.actionFailed }));
	expect(form.textarea.value).toBe('Unsent');
});

test('a save that fails after the form closed adds no second dialog', async () => {
	const pending = deferred<object>();
	mocks.api.mockReturnValueOnce(pending.promise);
	const form = renderForm();
	form.editing.value = message;
	await nextTick();
	await fireEvent.update(form.textarea, 'Edited');
	await fireEvent.click(screen.getByTitle(i18n.ts.save));
	form.unmount();

	pending.reject(new Error('No such message.'));
	await nextTick();
	await nextTick();

	expect(os.alert).not.toHaveBeenCalled();
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
	await waitFor(() => expect(screen.getByTitle(i18n.ts.send).getAttribute('aria-disabled') === 'true').toBe(false));
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
	await waitFor(() => expect(screen.getByTitle(i18n.ts.save).getAttribute('aria-disabled') === 'true').toBe(false));
	expect(form.editing.value?.id).toBe('m2');
	expect(form.textarea.value).toBe('Second message');
});

test.each(['user', 'room'] as const)('a pending %s send preserves later text and attachments', async target => {
	const pending = deferred<{ id: string }>();
	mocks.api.mockReturnValueOnce(pending.promise);
	const form = renderForm(target);
	await composeDraft(form.textarea);
	await fireEvent.click(screen.getByTitle(i18n.ts.send));
	await fireEvent.update(form.textarea, 'Later draft');
	const laterFile = { ...driveFile, id: 'later-file', name: 'later.png' };
	mocks.selectFile.mockResolvedValueOnce([laterFile]);
	await fireEvent.click(form.container.querySelector('.ti-photo-plus')!.closest('button')!);
	await waitFor(() => expect(screen.getByAltText('later.png')).toBeTruthy());

	pending.resolve({ id: 'sent-1' });
	await waitFor(() => expect(screen.getByTitle(i18n.ts.send).getAttribute('aria-disabled')).toBe('false'));
	expect(form.textarea.value).toBe('Later draft');
	expect(screen.queryByAltText('draft.png')).toBeNull();
	expect(screen.getByAltText('later.png')).toBeTruthy();
	expect(storedDraft(target)).toEqual({ text: 'Later draft', files: [laterFile] });
});

test('a failed pending send keeps both the original and later draft contents', async () => {
	const pending = deferred<{ id: string }>();
	mocks.api.mockReturnValueOnce(pending.promise);
	const form = renderForm();
	await composeDraft(form.textarea);
	await fireEvent.click(screen.getByTitle(i18n.ts.send));
	await fireEvent.update(form.textarea, 'Later draft');
	const laterFile = { ...driveFile, id: 'later-file', name: 'later.png' };
	mocks.selectFile.mockResolvedValueOnce([laterFile]);
	await fireEvent.click(form.container.querySelector('.ti-photo-plus')!.closest('button')!);
	await waitFor(() => expect(screen.getByAltText('later.png')).toBeTruthy());

	pending.reject(new Error('refused'));
	await waitFor(() => expect(os.alert).toHaveBeenCalled());
	expect(form.textarea.value).toBe('Later draft');
	expect(storedDraft()).toEqual({ text: 'Later draft', files: [driveFile, laterFile] });
});

test('a pending send does not disturb an edit or a later compose draft', async () => {
	const pending = deferred<{ id: string }>();
	mocks.api.mockReturnValueOnce(pending.promise);
	const form = renderForm();
	await fireEvent.update(form.textarea, 'Sent draft');
	await fireEvent.click(screen.getByTitle(i18n.ts.send));
	await fireEvent.update(form.textarea, 'Later draft');
	form.editing.value = message;
	await nextTick();
	await fireEvent.update(form.textarea, 'Later edit');

	pending.resolve({ id: 'sent-1' });
	await waitFor(() => expect(screen.getByTitle(i18n.ts.save).getAttribute('aria-disabled')).toBe('false'));
	expect(form.textarea.value).toBe('Later edit');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.cancel }));
	expect(form.textarea.value).toBe('Later draft');
	expect(storedDraft()?.text).toBe('Later draft');
});

test('a pending edit save keeps later text in the same edit session', async () => {
	const pending = deferred<object>();
	mocks.api.mockReturnValueOnce(pending.promise);
	const form = renderForm('room', message);
	await fireEvent.update(form.textarea, 'Saved version');
	await fireEvent.click(screen.getByTitle(i18n.ts.save));
	await fireEvent.update(form.textarea, 'Later edit');

	pending.resolve({});
	await waitFor(() => expect(screen.getByTitle(i18n.ts.save).getAttribute('aria-disabled')).toBe('false'));
	expect(form.editing.value?.id).toBe(message.id);
	expect(form.textarea.value).toBe('Later edit');
});

test('a send completed after leaving does not delete a new instance draft for the same room', async () => {
	const pending = deferred<{ id: string }>();
	mocks.api.mockReturnValueOnce(pending.promise);
	const first = renderForm();
	await fireEvent.update(first.textarea, 'Sent draft');
	await fireEvent.click(screen.getByTitle(i18n.ts.send));
	first.unmount();
	const second = renderForm();
	await fireEvent.update(second.textarea, 'New instance draft');

	pending.resolve({ id: 'sent-1' });
	await nextTick();
	await nextTick();
	expect(second.textarea.value).toBe('New instance draft');
	expect(storedDraft()?.text).toBe('New instance draft');
});

test('a completed send clears the unchanged stored draft after leaving', async () => {
	const pending = deferred<{ id: string }>();
	mocks.api.mockReturnValueOnce(pending.promise);
	const first = renderForm();
	await fireEvent.update(first.textarea, 'Sent draft');
	await fireEvent.click(screen.getByTitle(i18n.ts.send));
	first.unmount();

	pending.resolve({ id: 'sent-1' });
	await nextTick();
	await nextTick();
	expect(storedDraft()).toBeUndefined();
});

test('a new instance retains its restored draft even within the same millisecond', async () => {
	const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
	try {
		const pending = deferred<{ id: string }>();
		mocks.api.mockReturnValueOnce(pending.promise);
		const first = renderForm();
		await fireEvent.update(first.textarea, 'Draft');
		await fireEvent.click(screen.getByTitle(i18n.ts.send));
		first.unmount();
		const second = renderForm();

		pending.resolve({ id: 'sent-1' });
		await nextTick();
		await nextTick();
		expect(second.textarea.value).toBe('Draft');
		expect(storedDraft()?.text).toBe('Draft');
	} finally {
		clock.mockRestore();
	}
});

test('an attachment removed and selected again during a send stays in the draft', async () => {
	const pending = deferred<{ id: string }>();
	mocks.api.mockReturnValueOnce(pending.promise);
	mocks.popupMenu.mockResolvedValue(undefined);
	const form = renderForm();
	await composeDraft(form.textarea);
	await fireEvent.click(screen.getByTitle(i18n.ts.send));
	await fireEvent.click(screen.getByAltText('draft.png').closest('[role="button"]')!);
	const items = mocks.popupMenu.mock.lastCall![0] as MenuItem[];
	const detach = items.find(item => item != null && 'text' in item && item.text === i18n.ts.attachCancel) as unknown as { action: () => void };
	detach.action();
	await nextTick();
	mocks.selectFile.mockResolvedValueOnce([driveFile]);
	await fireEvent.click(form.container.querySelector('.ti-photo-plus')!.closest('button')!);
	await waitFor(() => expect(screen.getByAltText('draft.png')).toBeTruthy());

	pending.resolve({ id: 'sent-1' });
	await waitFor(() => expect(screen.getByTitle(i18n.ts.send).getAttribute('aria-disabled')).toBe('false'));
	expect(storedDraft()?.files).toEqual([driveFile]);
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
	expect(storedDraft()?.files ?? []).toEqual([]);
});

test.each(['picker', 'upload'] as const)('ignores a pending %s result after entering and leaving edit mode', async source => {
	const form = renderForm();
	const picked = deferred<Misskey.entities.DriveFile[]>();
	const uploaded = deferred<Misskey.entities.DriveFile[]>();
	mocks.selectFile.mockReturnValueOnce(picked.promise);
	mocks.upload.mockReturnValueOnce(uploaded.promise);
	if (source === 'picker') await fireEvent.click(form.container.querySelector('.ti-photo-plus')!.closest('button')!);
	else await dropImage(form.container);
	form.editing.value = message;
	await nextTick();
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.cancel }));
	picked.resolve([driveFile]);
	uploaded.resolve([driveFile]);
	await new Promise(resolve => setTimeout(resolve, 0));
	await nextTick();
	expect(form.container.querySelector('[data-id="draft-file"]')).toBeNull();
	expect(storedDraft()?.files ?? []).toEqual([]);
});

test('a draft attachment does not enable saving an empty text-only edit', async () => {
	const form = renderForm();
	await composeDraft(form.textarea);
	form.editing.value = message;
	await nextTick();
	await fireEvent.update(form.textarea, '   ');
	expect(screen.getByTitle(i18n.ts.save).getAttribute('aria-disabled') === 'true').toBe(true);
});

test('does not offer reactions for a deleted message', async () => {
	const deletedMessage = {
		...message,
		fromUserId: 'bob',
		fromUser: { id: 'bob', username: 'bob' },
		deletedAt: '2026-11-02T00:00:00.000Z',
	} as unknown as Misskey.entities.ChatMessage;

	render(XMessage, {
		props: { message: deletedMessage },
		global: { stubs },
	});
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.menu }));
	const items = mocks.popupMenu.mock.calls[0][0] as MenuItem[];
	expect(items.find(item => item != null && 'text' in item && item.text === i18n.ts.reaction)).toBeUndefined();
});

test('hides URL previews on a deleted message even if stale text is present', async () => {
	const text = 'https://remote.test/deleted-content';
	const liveMessage = { ...message, text };
	const result = render(XMessage, {
		props: { message: liveMessage },
		global: {
			stubs: {
				...stubs,
				MkFukidashi: { template: '<div><slot/></div>' },
				MkUrlPreview: { props: ['url'], template: '<a :href="url">{{ url }}</a>' },
			},
		},
	});
	expect(screen.getByRole('link', { name: text })).toBeTruthy();
	await result.rerender({ message: { ...liveMessage, deletedAt: '2026-11-02T00:00:00.000Z' } });
	expect(screen.getByText(i18n.ts._chat.deletedMessage)).toBeTruthy();
	expect(screen.queryByRole('link', { name: text })).toBeNull();
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

test.each([null, '2026-11-01T00:01:00.000Z'])('only offers reactions on a live message (deletedAt: %s)', async deletedAt => {
	render(XMessage, {
		props: { message: { ...message, fromUserId: user.id, fromUser: user, deletedAt } },
		global: { stubs },
	});
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.menu }));
	const items = mocks.popupMenu.mock.calls[0][0] as MenuItem[];
	const reaction = items.find(item => item != null && 'text' in item && item.text === i18n.ts.reaction);
	expect(reaction != null).toBe(deletedAt == null);
});

test.each([
	{ source: 'menu', removed: false },
	{ source: 'picker', removed: false },
	{ source: 'menu', removed: true },
	{ source: 'picker', removed: true },
])('ignores an open reaction $source after deletion (unmounted: $removed)', async ({ source, removed }) => {
	const liveMessage = { ...message, fromUserId: user.id, fromUser: user };
	const result = render(XMessage, { props: { message: liveMessage }, global: { stubs } });
	const button = screen.getByRole('button', { name: i18n.ts.menu });
	await fireEvent.click(button);
	const items = mocks.popupMenu.mock.calls[0][0] as MenuItem[];
	const reaction = items.find(item => item != null && 'text' in item && item.text === i18n.ts.reaction);
	if (!reaction || !('action' in reaction)) throw new Error('Expected the reaction menu action');
	const event = new PointerEvent('click');
	Object.defineProperty(event, 'currentTarget', { value: button });
	if (source === 'picker') await reaction.action(event);
	if (removed) result.unmount();
	else await result.rerender({ message: { ...liveMessage, deletedAt: '2026-11-01T00:01:00.000Z' } });
	if (source === 'menu') {
		await reaction.action(event);
		expect(mocks.reactionPicker).not.toHaveBeenCalled();
	} else {
		await mocks.reactionPicker.mock.calls[0][2]('❤');
	}
	expect(mocks.api).not.toHaveBeenCalled();
});

test.each([false, true])('ignores an MFM emoji reaction callback after deletion (unmounted: %s)', async removed => {
	let react!: (emoji: string) => void;
	const mfmStub = defineComponent({
		setup() {
			react = inject(DI.mfmEmojiReactCallback)!;
			return () => h('span');
		},
	});
	const liveMessage = { ...message, fromUserId: user.id, fromUser: user };
	const result = render(XMessage, {
		props: { message: liveMessage },
		global: { stubs: { ...stubs, Mfm: mfmStub } },
	});
	react('❤');
	expect(mocks.api).toHaveBeenCalledWith('chat/messages/react', { messageId: 'm1', reaction: '❤' });
	mocks.api.mockClear();
	if (removed) result.unmount();
	else await result.rerender({ message: { ...liveMessage, deletedAt: '2026-11-01T00:01:00.000Z' } });
	react('❤');
	expect(mocks.api).not.toHaveBeenCalled();
});

describe('the length of a message', () => {
	test.each([
		['a new message', () => renderForm(), () => i18n.ts.send],
		['an edit', () => renderForm('room', message), () => i18n.ts.save],
	])('%s can be as long as the servers take and no longer', async (_name, render, title) => {
		const form = render();

		await fireEvent.update(form.textarea, 'x'.repeat(4096));
		expect(screen.getByTitle(title()).getAttribute('aria-disabled') === 'true').toBe(false);

		await fireEvent.update(form.textarea, 'x'.repeat(4097));
		expect(screen.getByTitle(title()).getAttribute('aria-disabled') === 'true').toBe(true);
	});

	test('is counted by characters, as the servers count it', async () => {
		const form = renderForm();

		await fireEvent.update(form.textarea, '🦈'.repeat(4096));

		expect(screen.getByTitle(i18n.ts.send).getAttribute('aria-disabled') === 'true').toBe(false);
	});

	test('sending by keyboard stops at the limit too', async () => {
		const form = renderForm();

		await fireEvent.update(form.textarea, 'x'.repeat(4097));
		await fireEvent.keyDown(form.textarea, { key: 'Enter', ctrlKey: true });

		expect(mocks.api).not.toHaveBeenCalled();
	});

	test('shows how much is left only near the limit', async () => {
		const form = renderForm();

		await fireEvent.update(form.textarea, 'x'.repeat(3996));
		expect(form.container.querySelector('[class*="remaining"]')).toBeNull();

		await fireEvent.update(form.textarea, 'x'.repeat(3997));
		expect(form.container.querySelector('[class*="remaining"]')?.textContent).toBe('99');

		await fireEvent.update(form.textarea, 'x'.repeat(4098));
		expect(form.container.querySelector('[class*="remaining"]')?.textContent).toBe('-2');
	});

	test('tells a screen reader why the message cannot be sent', async () => {
		const form = renderForm();

		await fireEvent.update(form.textarea, 'x'.repeat(4096));
		expect(form.textarea.getAttribute('aria-invalid')).toBe('false');

		await fireEvent.update(form.textarea, 'x'.repeat(4097));
		const remaining = form.container.querySelector('[class*="remaining"]')!;
		expect(form.textarea.getAttribute('aria-invalid')).toBe('true');
		expect(form.textarea.getAttribute('aria-describedby')).toBe(remaining.id);
		expect(remaining.getAttribute('aria-label')).toBe(i18n.tsx.remainingN({ n: -1 }));
	});
});

describe('attaching several files', () => {
	const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(id => ({ ...driveFile, id, name: `${id}.png` })) as Misskey.entities.DriveFile[];
	const pick = async (form: ReturnType<typeof renderForm>, ...picked: Misskey.entities.DriveFile[]) => {
		mocks.selectFile.mockResolvedValueOnce(picked);
		await fireEvent.click(form.container.querySelector('.ti-photo-plus')!.closest('button')!);
		await nextTick();
		await nextTick();
	};

	test.each([
		['user', 'chat/messages/create-to-user'],
		['room', 'chat/messages/create-to-room'],
	] as const)('a message to a %s sends them all in order', async (target, endpoint) => {
		const form = renderForm(target);

		await pick(form, c, a, d, b);
		await fireEvent.click(screen.getByTitle(i18n.ts.send));

		expect(mocks.api).toHaveBeenCalledWith(endpoint, expect.objectContaining({ fileIds: ['c', 'a', 'd', 'b'] }));
	});

	test('the picker asks for several files', async () => {
		const form = renderForm();

		await pick(form, a);

		expect(mocks.selectFile).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }));
	});

	test('a later pick adds to the attachments instead of replacing them', async () => {
		const form = renderForm();

		await pick(form, a);
		await pick(form, b);

		expect(screen.getByAltText('a.png')).toBeTruthy();
		expect(screen.getByAltText('b.png')).toBeTruthy();
		expect(storedDraft().files.map((file: { id: string }) => file.id)).toEqual(['a', 'b']);
	});

	test('picking an attached file again does not attach it twice', async () => {
		const form = renderForm();

		await pick(form, a);
		await pick(form, a, b);

		expect(storedDraft().files.map((file: { id: string }) => file.id)).toEqual(['a', 'b']);
	});

	test('picking past the limit keeps four and says so', async () => {
		const form = renderForm();

		await pick(form, a, b, c, d, e);

		expect(storedDraft().files.map((file: { id: string }) => file.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(os.alert).toHaveBeenCalledWith({ type: 'error', text: i18n.tsx._chat.tooManyFiles({ max: 4 }) });
	});

	test('the picker is disabled once four are attached', async () => {
		const form = renderForm();
		const picker = form.container.querySelector('.ti-photo-plus')!.closest('button')!;

		await pick(form, a, b, c);
		expect(picker.hasAttribute('disabled')).toBe(false);
		await pick(form, d);

		expect(picker.hasAttribute('disabled')).toBe(true);
	});

	test('an upload that would go past the limit does not start', async () => {
		const form = renderForm();
		await pick(form, a, b, c, d);

		await dropImage(form.container);

		expect(mocks.upload).not.toHaveBeenCalled();
		expect(os.alert).toHaveBeenCalledWith({ type: 'error', text: i18n.tsx._chat.tooManyFiles({ max: 4 }) });
	});

	test('several dropped files upload together', async () => {
		const form = renderForm();
		mocks.upload.mockResolvedValueOnce([a, b]);

		await fireEvent.drop(form.container.firstElementChild!, {
			dataTransfer: { files: [new File(['1'], 'a.png', { type: 'image/png' }), new File(['2'], 'b.png', { type: 'image/png' })] },
		});
		await waitFor(() => expect(screen.getByAltText('b.png')).toBeTruthy());

		expect(mocks.upload).toHaveBeenCalledWith(expect.any(Array), { multiple: true });
		expect(storedDraft().files.map((file: { id: string }) => file.id)).toEqual(['a', 'b']);
	});

	test('dropping several files from the drive attaches them all', async () => {
		const form = renderForm();

		await fireEvent.drop(form.container.firstElementChild!, {
			dataTransfer: { files: [], getData: () => JSON.stringify([a, b]) },
		});
		await nextTick();

		expect(storedDraft().files.map((file: { id: string }) => file.id)).toEqual(['a', 'b']);
	});

	test('removing one keeps the others', async () => {
		mocks.popupMenu.mockResolvedValue(undefined);
		const form = renderForm();
		await pick(form, a, b);

		await fireEvent.click(screen.getByAltText('a.png').closest('[role="button"]')!);
		const items = mocks.popupMenu.mock.lastCall![0] as MenuItem[];
		const detach = items.find(item => item != null && 'text' in item && item.text === i18n.ts.attachCancel) as unknown as { action: () => void };
		detach.action();
		await nextTick();

		expect(screen.queryByAltText('a.png')).toBeNull();
		expect(screen.getByAltText('b.png')).toBeTruthy();
		expect(storedDraft().files.map((file: { id: string }) => file.id)).toEqual(['b']);
	});

	test('sending clears them all', async () => {
		const form = renderForm();
		await pick(form, a, b);

		await fireEvent.click(screen.getByTitle(i18n.ts.send));
		await waitFor(() => expect(screen.queryByAltText('a.png')).toBeNull());

		expect(storedDraft()?.files ?? []).toEqual([]);
	});

	test('a draft keeps them all across a reload', async () => {
		const first = renderForm();
		await pick(first, a, b);
		first.unmount();

		renderForm();
		await nextTick();

		expect(screen.getByAltText('a.png')).toBeTruthy();
		expect(screen.getByAltText('b.png')).toBeTruthy();
	});

	test('a draft saved when there could be only one file is still restored', async () => {
		localStorage.setItem('chatMessageDrafts', JSON.stringify({ 'room:room1': { updatedAt: new Date(), data: { text: 'old draft', file: a } } }));

		const form = renderForm();
		await nextTick();

		expect(form.textarea.value).toBe('old draft');
		expect(screen.getByAltText('a.png')).toBeTruthy();
	});

	test('a draft without a file restores no attachment', async () => {
		localStorage.setItem('chatMessageDrafts', JSON.stringify({ 'room:room1': { updatedAt: new Date(), data: { text: 'old draft', file: null } } }));

		renderForm();
		await nextTick();

		await fireEvent.click(screen.getByTitle(i18n.ts.send));
		expect(mocks.api).toHaveBeenCalledWith('chat/messages/create-to-room', { toRoomId: 'room1', text: 'old draft', fileIds: undefined });
	});

	describe('in a message', () => {
		const gallery = { props: ['mediaList'], template: '<ul><li v-for="media in mediaList" :key="media.id">{{ media.name }}</li></ul>' };
		const renderFiles = (overrides: object) => render(XMessage, {
			props: { message: { ...message, ...overrides } as Misskey.entities.ChatMessage },
			global: { stubs: { ...stubs, MkFukidashi: { template: '<div><slot/></div>' }, MkUrlPreview: true, MkMediaList: gallery } },
		});

		test('the gallery of notes shows them all in order', () => {
			renderFiles({ fileIds: ['b', 'a', 'd', 'c'], files: [b, a, d, c], fileId: 'b', file: b });

			expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['b.png', 'a.png', 'd.png', 'c.png']);
		});

		test('a message without files has no gallery', () => {
			renderFiles({});

			expect(screen.queryByRole('list')).toBeNull();
		});

		test('a deleted message has no gallery even if it still names files', () => {
			renderFiles({ fileIds: ['a'], files: [a], deletedAt: '2026-11-02T00:00:00.000Z' });

			expect(screen.queryByRole('list')).toBeNull();
		});
	});
});

describe('XMessage on messages it cannot act on', () => {
	function renderMessage(overrides: Record<string, unknown>) {
		return render(XMessage, {
			props: { message: { ...message, fromUserId: 'bob', fromUser: { id: 'bob', username: 'bob' }, ...overrides } as Misskey.entities.ChatMessage },
			global: { stubs: { ...stubs, MkReactionIcon: true, MkFukidashi: { template: '<div><slot/></div>' }, MkMediaList: true, MkUrlPreview: true } },
		});
	}

	async function openMenu(): Promise<MenuItem[]> {
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts.menu }));
		return mocks.popupMenu.mock.calls[0][0] as MenuItem[];
	}

	test('a deleted message offers neither a reaction nor a text copy', async () => {
		renderMessage({ text: null, deletedAt: '2026-11-02T00:00:00.000Z' });

		const items = (await openMenu()).filter(item => item !== undefined && 'text' in item).map(item => (item as { text: string }).text);

		expect(items).not.toContain(i18n.ts.reaction);
		expect(items).not.toContain(i18n.ts.copyContent);
	});

	test('a live message from someone else still offers both', async () => {
		renderMessage({});

		const items = (await openMenu()).filter(item => item !== undefined && 'text' in item).map(item => (item as { text: string }).text);

		expect(items).toContain(i18n.ts.reaction);
		expect(items).toContain(i18n.ts.copyContent);
	});

	test.each([
		['the room page', { roomArchived: true }, {}],
		['a search result', {}, { toRoomId: 'r1', toRoom: { id: 'r1', name: 'room', isArchived: true } }],
	])('a message in an archived room offers no writes on %s, but can be copied and reported', async (_where, props, overrides) => {
		render(XMessage, {
			props: { canEdit: true, ...props, message: { ...message, fromUserId: 'me', ...overrides } as Misskey.entities.ChatMessage },
			global: { stubs: { ...stubs, MkReactionIcon: true, MkFukidashi: { template: '<div><slot/></div>' }, MkMediaList: true, MkUrlPreview: true } },
		});

		const mine = (await openMenu()).filter(item => item !== undefined && 'text' in item).map(item => (item as { text: string }).text);

		expect(mine).not.toContain(i18n.ts.edit);
		expect(mine).not.toContain(i18n.ts.delete);
		expect(mine).toContain(i18n.ts.copyContent);
	});

	test('a message from someone else in an archived room offers no reaction', async () => {
		render(XMessage, {
			props: { roomArchived: true, message: { ...message, fromUserId: 'bob', fromUser: { id: 'bob', username: 'bob' } } as Misskey.entities.ChatMessage },
			global: { stubs: { ...stubs, MkReactionIcon: true, MkFukidashi: { template: '<div><slot/></div>' }, MkMediaList: true, MkUrlPreview: true } },
		});

		const items = (await openMenu()).filter(item => item !== undefined && 'text' in item).map(item => (item as { text: string }).text);

		expect(items).not.toContain(i18n.ts.reaction);
		expect(items).toContain(i18n.ts.reportAbuse);
	});

	test('a refused reaction change is shown instead of being lost in the console', async () => {
		mocks.api.mockRejectedValueOnce(new Error('Rate limit exceeded.'));
		const { container } = renderMessage({ reactions: [{ user: { id: 'me', username: 'me' }, reaction: '👍' }] });

		await fireEvent.click(container.querySelector('[class*="reactions"] > *')!);

		await waitFor(() => expect(os.alert).toHaveBeenCalledWith({ type: 'error', title: i18n.ts.somethingHappened, text: i18n.ts._chat.actionFailed }));
	});

	test('a message that is gone is explained in the language of the screen, not the English of the API', async () => {
		mocks.api.mockRejectedValueOnce(Object.assign(new Error('No such message.'), { code: 'NO_SUCH_MESSAGE' }));
		const { container } = renderMessage({ reactions: [{ user: { id: 'me', username: 'me' }, reaction: '👍' }] });

		await fireEvent.click(container.querySelector('[class*="reactions"] > *')!);

		await waitFor(() => expect(os.alert).toHaveBeenCalledWith({ type: 'error', title: i18n.ts.somethingHappened, text: i18n.ts._chat.messageUnavailable }));
	});

	test('pressing a reaction on my own message asks nothing of the server, which would refuse it', async () => {
		const { container } = renderMessage({ fromUserId: 'me', fromUser: mocks.me, reactions: [{ user: { id: 'bob', username: 'bob' }, reaction: '👍' }] });

		await fireEvent.click(container.querySelector('[class*="reactions"] > *')!);
		await nextTick();

		expect(mocks.api).not.toHaveBeenCalledWith('chat/messages/react', expect.anything());
		expect(os.alert).not.toHaveBeenCalled();
	});

	test('a refused delete is shown instead of being lost in the console', async () => {
		mocks.confirm.mockResolvedValue({ canceled: false });
		mocks.api.mockRejectedValueOnce(new Error('Rate limit exceeded.'));
		renderMessage({ fromUserId: 'me', fromUser: mocks.me });

		const deleteItem = (await openMenu()).find(item => item !== undefined && 'text' in item && item.text === i18n.ts.delete) as unknown as { action: () => Promise<void> };
		await deleteItem.action();

		expect(mocks.api).toHaveBeenCalledWith('chat/messages/delete', { messageId: 'm1' });
		await waitFor(() => expect(os.alert).toHaveBeenCalledWith({ type: 'error', title: i18n.ts.somethingHappened, text: i18n.ts._chat.actionFailed }));
	});

	test('clicking a remote custom emoji reaction does not send a reaction the server would reject', async () => {
		const { container } = renderMessage({ reactions: [{ user: { id: 'carol', username: 'carol', host: 'other.test' }, reaction: ':blob@other.test:' }] });

		await fireEvent.click(container.querySelector('[class*="reactions"] > *')!);

		expect(mocks.api).not.toHaveBeenCalledWith('chat/messages/react', expect.anything());
	});
});

describe('pressing and holding a message', () => {
	const received = { ...message, fromUserId: 'bob', fromUser: { id: 'bob', username: 'bob' } } as unknown as Misskey.entities.ChatMessage;

	function contextmenu(container: Element, pointerType: string) {
		const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'pointerType', { value: pointerType });
		container.querySelector('[aria-haspopup="menu"]')!.dispatchEvent(event);
		return event;
	}

	function selectAWord(container: Element) {
		const range = window.document.createRange();
		range.selectNodeContents(container.querySelector('[aria-haspopup="menu"]')!);
		window.getSelection()!.removeAllRanges();
		window.getSelection()!.addRange(range);
		vi.spyOn(window.getSelection()!, 'toString').mockReturnValue('word');
	}

	beforeEach(() => {
		mocks.contextMenu.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		window.getSelection()?.removeAllRanges();
	});

	test('a finger opens the menu and leaves nothing selected, though the browser selected a word first', () => {
		const { container } = render(XMessage, { props: { message: received }, global: { stubs } });
		selectAWord(container);
		const removeAllRanges = vi.spyOn(window.getSelection()!, 'removeAllRanges');

		contextmenu(container, 'touch');

		expect(removeAllRanges).toHaveBeenCalled();
		expect(mocks.contextMenu).toHaveBeenCalledTimes(1);
	});

	test('a mouse over a selection still gets the menu of the browser, to copy what was selected', () => {
		const { container } = render(XMessage, { props: { message: received }, global: { stubs } });
		selectAWord(container);

		contextmenu(container, 'mouse');

		expect(mocks.contextMenu).not.toHaveBeenCalled();
	});

	test('a mouse with nothing selected opens the menu as before', () => {
		const { container } = render(XMessage, { props: { message: received }, global: { stubs } });

		contextmenu(container, 'mouse');

		expect(mocks.contextMenu).toHaveBeenCalledTimes(1);
	});
});

// ソフトウェアキーボードは入力欄のフォーカスについてくる。押したボタンにフォーカスが移ると閉じてしまう
describe('the focus of the message box when pressing send', () => {
	const sendButton = (name = i18n.ts.send) => screen.getByRole('button', { name }) as HTMLButtonElement;
	// 既定の動作を止めれば、ブラウザはフォーカスを動かさない
	const pressKeepsFocus = (button: HTMLElement) => {
		const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		button.dispatchEvent(press);
		return press.defaultPrevented;
	};

	test('stays in the box when it was there', async () => {
		const { textarea } = renderForm();
		await fireEvent.update(textarea, 'hello');
		textarea.focus();

		expect(pressKeepsFocus(sendButton())).toBe(true);
	});

	test('is not pulled to the box when it was elsewhere, so no keyboard comes up', async () => {
		const { textarea } = renderForm();
		await fireEvent.update(textarea, 'hello');
		textarea.blur();

		expect(pressKeepsFocus(sendButton())).toBe(false);
		await fireEvent.click(sendButton());
		expect(window.document.activeElement).not.toBe(textarea);
	});

	test('stays in the box when there is nothing to send, and pressing does nothing', async () => {
		const { textarea } = renderForm();
		textarea.focus();

		expect(sendButton().getAttribute('aria-disabled')).toBe('true');
		expect(sendButton().disabled).toBe(false);
		expect(pressKeepsFocus(sendButton())).toBe(true);
		await fireEvent.click(sendButton());
		expect(mocks.api).not.toHaveBeenCalled();
	});

	test('stays in the box while a message is on its way, and a second press sends nothing', async () => {
		const { textarea } = renderForm();
		const pending = deferred<unknown>();
		mocks.api.mockReturnValueOnce(pending.promise);
		await fireEvent.update(textarea, 'hello');
		textarea.focus();

		await fireEvent.click(sendButton());
		expect(sendButton().disabled).toBe(false);
		expect(pressKeepsFocus(sendButton())).toBe(true);
		await fireEvent.click(sendButton());
		expect(mocks.api).toHaveBeenCalledTimes(1);
		pending.resolve({});
		await waitFor(() => expect(textarea.value).toBe(''));
		expect(window.document.activeElement).toBe(textarea);
	});

	test('stays in the box when saving an edit', async () => {
		const { textarea } = renderForm('room', message);
		mocks.api.mockResolvedValueOnce(undefined);
		textarea.focus();

		expect(pressKeepsFocus(sendButton(i18n.ts.save))).toBe(true);
	});

	test('a button reached with the keyboard stays where it is and still sends', async () => {
		const { textarea } = renderForm();
		mocks.api.mockResolvedValueOnce({});
		await fireEvent.update(textarea, 'hello');
		sendButton().focus();

		await fireEvent.click(sendButton());

		expect(mocks.api).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(textarea.value).toBe(''));
		expect(window.document.activeElement).toBe(sendButton());
	});
});

// スマートフォンのキーボードは打った文字をほとんど常に変換中のままにするので、変換中の文字も入力欄の値として扱う
describe('letters still in composition', () => {
	const sendButton = (name = i18n.ts.send) => screen.getByRole('button', { name }) as HTMLButtonElement;

	async function compose(textarea: HTMLTextAreaElement, value: string) {
		await fireEvent.compositionStart(textarea);
		textarea.value = value;
		await fireEvent.input(textarea);
	}

	test('count as text: the button turns on and the draft has them', async () => {
		const { textarea } = renderForm();

		await compose(textarea, 'Dk');

		expect(sendButton().getAttribute('aria-disabled')).toBe('false');
		expect(storedDraft()?.text).toBe('Dk');
	});

	test('count toward the length', async () => {
		const { textarea } = renderForm();

		await compose(textarea, 'a'.repeat(4097));

		expect(sendButton().getAttribute('aria-disabled')).toBe('true');
		expect(screen.getByText('-1')).toBeTruthy();
	});

	test('go out with one press, and the composition ends without the focus leaving', async () => {
		const { textarea } = renderForm();
		mocks.api.mockResolvedValueOnce({});
		textarea.focus();
		await compose(textarea, 'Dk');
		const blur = vi.spyOn(textarea, 'blur');

		await fireEvent.click(sendButton());

		expect(mocks.api).toHaveBeenCalledWith('chat/messages/create-to-room', expect.objectContaining({ text: 'Dk' }));
		expect(mocks.api).toHaveBeenCalledTimes(1);
		expect(blur).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(textarea.value).toBe(''));
		expect(window.document.activeElement).toBe(textarea);
	});

	test('are saved with an edit', async () => {
		const { textarea } = renderForm('room', message);
		mocks.api.mockResolvedValueOnce(undefined);
		textarea.focus();
		await compose(textarea, 'edited text');

		await fireEvent.click(sendButton(i18n.ts.save));

		expect(mocks.api).toHaveBeenCalledWith('chat/messages/update', expect.objectContaining({ text: 'edited text' }));
	});

	test('with no composition going on, sending does not touch the focus', async () => {
		const { textarea } = renderForm();
		mocks.api.mockResolvedValueOnce({});
		textarea.focus();
		await fireEvent.update(textarea, 'typed');
		const blur = vi.spyOn(textarea, 'blur');

		await fireEvent.click(sendButton());

		expect(mocks.api).toHaveBeenCalledTimes(1);
		expect(blur).not.toHaveBeenCalled();
	});

	test('after the composition ended, sending does not touch the focus either', async () => {
		const { textarea } = renderForm();
		mocks.api.mockResolvedValueOnce({});
		textarea.focus();
		await compose(textarea, '안녕');
		await fireEvent.compositionEnd(textarea);
		const blur = vi.spyOn(textarea, 'blur');

		await fireEvent.click(sendButton());

		expect(mocks.api).toHaveBeenCalledWith('chat/messages/create-to-room', expect.objectContaining({ text: '안녕' }));
		expect(blur).not.toHaveBeenCalled();
	});

	test('Enter while composing commits them and sends nothing', async () => {
		const { textarea } = renderForm();
		textarea.focus();
		await compose(textarea, '안녕');

		await fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });

		expect(mocks.api).not.toHaveBeenCalled();
	});
});

// iOS 27 の Safari は「haru: …」のように「語:」で始まる文字をコピーすると、同じものを URL (text/uri-list) としても入れ、
// 普通に貼ると `haru:%20…` のほうが入る
describe('pasting text that the clipboard also holds as a URL', () => {
	function clipboard(plain: string, uri?: string) {
		const types = uri == null ? ['text/plain'] : ['text/plain', 'text/uri-list'];
		return {
			types,
			items: types.map(() => ({ kind: 'string' })),
			files: [],
			getData: (type: string) => type === 'text/plain' ? plain : type === 'text/uri-list' ? uri ?? '' : '',
		};
	}

	async function paste(textarea: HTMLTextAreaElement, data: ReturnType<typeof clipboard>) {
		const event = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', { value: data });
		await fireEvent(textarea, event);
		return event;
	}

	test.each([
		['haru: 확인했어요 — 안녕', 'haru:%20%ED%99%95%EC%9D%B8%ED%96%88%EC%96%B4%EC%9A%94%20%E2%80%94%20%EC%95%88%EB%85%95'],
		['Note: hello world', 'note:%20hello%20world'],
		['https://example.com/a b', 'https://example.com/a%20b'],
	])('puts "%s" at the caret as written', async (plain, uri) => {
		const form = renderForm();
		await fireEvent.update(form.textarea, '[]');
		form.textarea.setSelectionRange(1, 1);

		const event = await paste(form.textarea, clipboard(plain, uri));

		expect(event.defaultPrevented).toBe(true);
		expect(form.textarea.value).toBe(`[${plain}]`);
		await waitFor(() => expect(storedDraft()?.text).toBe(`[${plain}]`));
	});

	test('does the same while editing a message', async () => {
		const form = renderForm('room', message);
		form.textarea.setSelectionRange(form.textarea.value.length, form.textarea.value.length);

		const event = await paste(form.textarea, clipboard('Note: hello world', 'note:%20hello%20world'));

		expect(event.defaultPrevented).toBe(true);
		expect(form.textarea.value).toBe('Original messageNote: hello world');
		await fireEvent.click(screen.getByTitle(i18n.ts.save));
		expect(mocks.api).toHaveBeenCalledWith('chat/messages/update', { messageId: message.id, text: 'Original messageNote: hello world' });
	});

	test('lets the browser insert the text so that undo and the input event keep working', async () => {
		const execCommand = vi.fn(() => true);
		Object.defineProperty(window.document, 'execCommand', { value: execCommand, configurable: true });
		try {
			const form = renderForm();

			const event = await paste(form.textarea, clipboard('Note: hello world', 'note:%20hello%20world'));

			expect(event.defaultPrevented).toBe(true);
			expect(execCommand).toHaveBeenCalledWith('insertText', false, 'Note: hello world');
			// 入れるのはブラウザ (ここでは何もしない偽物) で、こちらでは入れない
			expect(form.textarea.value).toBe('');
		} finally {
			Reflect.deleteProperty(window.document, 'execCommand');
		}
	});

	test.each([
		['a copied link', 'https://example.com/', 'https://example.com/'],
		['text alone', 'Note: hello world', undefined],
		['a URL that is not the text', 'Example page', 'https://example.com/'],
		['a URL that cannot be decoded', 'haru: 100%', 'haru:%20100%'],
	])('leaves %s to the browser', async (_, plain, uri) => {
		const form = renderForm();

		const event = await paste(form.textarea, clipboard(plain, uri));

		expect(event.defaultPrevented).toBe(false);
		expect(form.textarea.value).toBe('');
	});
});

test('keeps the second identical reference when the first plain occurrence is deleted', async () => {
	const editingMessage = { ...message, text: '#same #same', channelRefs: [{ channelId: 'second', start: 6, length: 5 }] };
	render(XForm, { props: { room: { ...room, hasChannels: true }, channelId: 'first', editingMessage }, global: { stubs } });
	const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
	textarea.setSelectionRange(0, 6);
	await fireEvent(textarea, new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true }));
	await fireEvent.update(textarea, '#same');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.save }));

	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/messages/update', { messageId: 'm1', text: '#same', channelRefs: [{ channelId: 'second', start: 0, length: 5 }] }));
});

test('unmatched channel text stays plain and can be sent from the keyboard', async () => {
	render(XForm, { props: { room: { ...room, hasChannels: true }, channelId: 'first', channels: [{ id: 'first', roomId: room.id, name: 'general', isLegacy: true }] }, global: { stubs } });
	const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
	await fireEvent.update(textarea, '#not-a-channel');
	textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	await fireEvent.input(textarea);
	await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/messages/create-to-room', { toRoomId: room.id, toRoomChannelId: 'first', text: '#not-a-channel', fileIds: undefined, channelRefs: [] }));
});

test('typing after a selected reference does not reopen its candidate list', async () => {
	const channels = [{ id: 'first', roomId: room.id, name: 'same', isLegacy: true }];
	render(XForm, { props: { room: { ...room, hasChannels: true }, channelId: 'first', channels }, global: { stubs } });
	const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
	await fireEvent.update(textarea, '#sa');
	textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	await fireEvent.input(textarea);
	const popup = vi.mocked(os.popup).mock.lastCall!;
	(popup[2] as unknown as { done: (result: unknown) => void }).done({ type: 'chatChannel', value: channels[0] });
	await nextTick();
	vi.mocked(os.popup).mockClear();
	await fireEvent.update(textarea, '#same more words');

	expect(os.popup).not.toHaveBeenCalled();
});
