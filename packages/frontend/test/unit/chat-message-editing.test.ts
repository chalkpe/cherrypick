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
	reactionPicker: vi.fn(),
	me: { id: 'me', username: 'me', policies: { chatAvailability: 'available' } },
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/utility/drive.js', () => ({ selectFile: mocks.selectFile }));
vi.mock('@/os.js', () => ({ launchUploader: mocks.upload, popupMenu: mocks.popupMenu, alert: vi.fn() }));
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
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
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
		const form = renderForm(target, { ...message, fileId: driveFile.id, file: driveFile });
		await fireEvent.update(form.textarea, '');
		expect(screen.getByTitle(i18n.ts.save).hasAttribute('disabled')).toBe(false);
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
		expect(screen.getByTitle(i18n.ts.save).hasAttribute('disabled')).toBe(true);
		await fireEvent.keyDown(form.textarea, { key: 'Enter', ctrlKey: true });
		expect(mocks.api).not.toHaveBeenCalledWith('chat/messages/update', expect.anything());
	});

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

test('a failed save tells the user and keeps the edit open', async () => {
	mocks.api.mockRejectedValueOnce(new Error('This room is archived.'));
	const form = renderForm();
	form.editing.value = message;
	await nextTick();
	await fireEvent.update(form.textarea, 'Edited');
	await fireEvent.click(screen.getByTitle(i18n.ts.save));

	await waitFor(() => expect(os.alert).toHaveBeenCalledWith({ type: 'error', title: i18n.ts.somethingHappened, text: 'This room is archived.' }));
	expect(form.editing.value).toEqual(message);
	expect(form.textarea.value).toBe('Edited');
});

test.each(['user', 'room'] as const)('a failed %s message send tells the user and keeps the text', async target => {
	mocks.api.mockRejectedValueOnce(new Error('Rate limit exceeded.'));
	const form = renderForm(target);
	await fireEvent.update(form.textarea, 'Unsent');
	await fireEvent.click(screen.getByTitle(i18n.ts.send));

	await waitFor(() => expect(os.alert).toHaveBeenCalledWith({ type: 'error', title: i18n.ts.somethingHappened, text: 'Rate limit exceeded.' }));
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

		await waitFor(() => expect(os.alert).toHaveBeenCalledWith({ type: 'error', title: i18n.ts.somethingHappened, text: 'Rate limit exceeded.' }));
	});

	test('clicking a remote custom emoji reaction does not send a reaction the server would reject', async () => {
		const { container } = renderMessage({ reactions: [{ user: { id: 'carol', username: 'carol', host: 'other.test' }, reaction: ':blob@other.test:' }] });

		await fireEvent.click(container.querySelector('[class*="reactions"] > *')!);

		expect(mocks.api).not.toHaveBeenCalledWith('chat/messages/react', expect.anything());
	});
});
