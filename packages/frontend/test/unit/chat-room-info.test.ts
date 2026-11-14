/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({ apiWithDialog: vi.fn(), confirm: vi.fn(), push: vi.fn(), me: { id: 'me', isAdmin: false, isModerator: false } }));
vi.mock('@/i.js', () => ({ ensureSignin: () => mocks.me }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog, confirm: mocks.confirm }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: mocks.push }) }));

import XInfo from '@/pages/chat/room.info.vue';
import { chatMuteErrors, chatRoomDeleteErrors, chatRoomUpdateErrors } from '@/pages/chat/chat-errors.js';
import XRoom from '@/pages/chat/XRoom.vue';
import { i18n } from '@/i18n.js';

const room = { id: 'r1', ownerId: 'me', owner: { id: 'me', username: 'me' }, name: ':test: room', description: ':test: description' } as any;
const stubs = {
	MkInput: { props: ['modelValue', 'mfmAutocomplete'], emits: ['update:modelValue'], template: '<label><slot name="label"/><input :value="modelValue" :data-autocomplete="JSON.stringify(mfmAutocomplete)" @input="$emit(\'update:modelValue\', $event.target.value)"/><slot name="caption"/></label>' },
	MkTextarea: { props: { modelValue: String, mfmAutocomplete: Array, mfmPreview: Boolean }, emits: ['update:modelValue'], template: '<label><slot name="label"/><textarea :value="modelValue" :data-autocomplete="JSON.stringify(mfmAutocomplete)" :data-preview="mfmPreview" @input="$emit(\'update:modelValue\', $event.target.value)"/></label>' },
	MkButton: { emits: ['click'], template: '<button @click="$emit(\'click\')"><slot/></button>' },
	MkSwitch: { props: ['modelValue'], emits: ['update:modelValue'], template: '<button role="switch" :aria-checked="String(modelValue)" @click="$emit(\'update:modelValue\', !modelValue)"><slot name="label"/></button>' },
	MkKeyValue: { template: '<div><slot name="key"/><slot name="value"/></div>' },
	MkAvatar: true,
	MkA: { template: '<a><slot/></a>' },
	Mfm: { props: ['text', 'plain'], template: '<span data-testid="mfm" :data-plain="plain">{{ text }}</span>' },
};

afterEach(() => { cleanup(); mocks.apiWithDialog.mockReset(); mocks.confirm.mockReset(); mocks.push.mockReset(); });

test('the owner archives the room after confirming, and the saved room propagates', async () => {
	const updated = { ...room, isArchived: true };
	mocks.confirm.mockResolvedValueOnce({ canceled: false });
	mocks.apiWithDialog.mockResolvedValueOnce(updated);
	const result = render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.archive }));
	await waitFor(() => expect(result.emitted().updated).toEqual([[updated]]));
	expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/update', { roomId: 'r1', isArchived: true }, undefined, chatRoomUpdateErrors);
});

test('tells the room page while its own deletion is in progress', async () => {
	mocks.confirm.mockResolvedValueOnce({ canceled: false });
	mocks.apiWithDialog.mockResolvedValueOnce(undefined);
	const result = render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat.deleteRoom }));
	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/delete', { roomId: 'r1' }, undefined, chatRoomDeleteErrors));
	expect(result.emitted().deleting).toEqual([[true]]);
});

test('a failed deletion lets later deletions be announced again', async () => {
	mocks.confirm.mockResolvedValueOnce({ canceled: false });
	mocks.apiWithDialog.mockRejectedValueOnce(new Error('failed'));
	const result = render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat.deleteRoom }));
	await waitFor(() => expect(result.emitted().deleting).toEqual([[true], [false]]));
});

test('leaves the page when the deletion fails after the room has already closed', async () => {
	let fail!: (reason: unknown) => void;
	mocks.confirm.mockResolvedValueOnce({ canceled: false });
	mocks.apiWithDialog.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
	const result = render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat.deleteRoom }));
	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalled());
	result.unmount();

	fail(new Error('No such room.'));

	await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/chat'));
});

test('stays on the page when the deletion fails while the room is still open', async () => {
	mocks.confirm.mockResolvedValueOnce({ canceled: false });
	mocks.apiWithDialog.mockRejectedValueOnce(new Error('failed'));
	const result = render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat.deleteRoom }));
	await waitFor(() => expect(result.emitted().deleting).toEqual([[true], [false]]));
	expect(mocks.push).not.toHaveBeenCalled();
});

test('canceling the confirmation does not archive', async () => {
	mocks.confirm.mockResolvedValueOnce({ canceled: true });
	render(XInfo, { props: { room: { ...room, isArchived: false } }, global: { stubs } });
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.archive }));
	await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
	await nextTick();
	expect(mocks.apiWithDialog).not.toHaveBeenCalled();
});

test('an archived room offers unarchiving without a confirmation, and no saving', async () => {
	mocks.apiWithDialog.mockResolvedValueOnce({ ...room, isArchived: false });
	render(XInfo, { props: { room: { ...room, isArchived: true } }, global: { stubs } });
	expect(screen.queryByRole('button', { name: i18n.ts.save })).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.unarchive }));
	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/update', { roomId: 'r1', isArchived: false }, undefined, chatRoomUpdateErrors));
	expect(mocks.confirm).not.toHaveBeenCalled();
});

// ミュートは見ている本人だけの通知の設定で、持ち主も自分のルームをミュートできる
test.each([
	['the owner', 'me'],
	['a member', 'someone-else'],
])('%s mutes the room, and the choice propagates to the room page', async (_, ownerId) => {
	mocks.apiWithDialog.mockResolvedValueOnce(undefined);
	const shown = { ...room, ownerId, isArchived: false, isMuted: false };
	const result = render(XInfo, { props: { room: shown }, global: { stubs } });
	const muteSwitch = screen.getByRole('switch', { name: i18n.ts._chat.muteThisRoom });
	expect(muteSwitch.getAttribute('aria-checked')).toBe('false');

	await fireEvent.click(muteSwitch);

	// ページが持つルームに伝えないと、タブを切り替えて戻ったときにスイッチが元に戻って見える
	await waitFor(() => expect(result.emitted().updated).toEqual([[{ ...shown, isMuted: true }]]));
	expect(mocks.apiWithDialog).toHaveBeenCalledExactlyOnceWith('chat/rooms/mute', { roomId: 'r1', mute: true }, undefined, chatMuteErrors);
	expect(muteSwitch.getAttribute('aria-checked')).toBe('true');
});

test('the owner unmutes a room they muted', async () => {
	mocks.apiWithDialog.mockResolvedValueOnce(undefined);
	const shown = { ...room, isArchived: false, isMuted: true };
	const result = render(XInfo, { props: { room: shown }, global: { stubs } });
	const muteSwitch = screen.getByRole('switch', { name: i18n.ts._chat.muteThisRoom });
	expect(muteSwitch.getAttribute('aria-checked')).toBe('true');

	await fireEvent.click(muteSwitch);

	await waitFor(() => expect(result.emitted().updated).toEqual([[{ ...shown, isMuted: false }]]));
	expect(mocks.apiWithDialog).toHaveBeenCalledExactlyOnceWith('chat/rooms/mute', { roomId: 'r1', mute: false }, undefined, chatMuteErrors);
});

test('a mute that was refused is not passed on to the room page', async () => {
	mocks.apiWithDialog.mockRejectedValueOnce(new Error('refused'));
	const result = render(XInfo, { props: { room: { ...room, isArchived: false, isMuted: false } }, global: { stubs } });
	const muteSwitch = screen.getByRole('switch', { name: i18n.ts._chat.muteThisRoom });

	await fireEvent.click(muteSwitch);

	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalled());
	await waitFor(() => expect(muteSwitch.getAttribute('aria-checked')).toBe('false'));
	expect(result.emitted().updated).toBeUndefined();
});

test('the switch follows the room when the page reads it again', async () => {
	const shown = { ...room, isArchived: false, isMuted: false };
	const result = render(XInfo, { props: { room: shown }, global: { stubs } });

	await result.rerender({ room: { ...shown, isMuted: true } });

	expect(screen.getByRole('switch', { name: i18n.ts._chat.muteThisRoom }).getAttribute('aria-checked')).toBe('true');
});

test('other members cannot archive', () => {
	render(XInfo, { props: { room: { ...room, ownerId: 'someone-else', isArchived: false } }, global: { stubs } });
	expect(screen.queryByRole('button', { name: i18n.ts.archive })).toBeNull();
});

test('enables emoji completion for both editable fields and propagates the saved room', async () => {
	const updated = { ...room, name: ':other: name', description: ':other: description' };
	mocks.apiWithDialog.mockResolvedValueOnce(updated);
	const result = render(XInfo, { props: { room }, global: { stubs } });
	const input = screen.getByLabelText(new RegExp(i18n.ts.name));
	const textarea = screen.getByLabelText(i18n.ts.description);
	expect(input.getAttribute('data-autocomplete')).toBe('["emoji"]');
	expect(textarea.getAttribute('data-autocomplete')).toBe('["emoji"]');
	expect(textarea.getAttribute('data-preview')).toBe('true');
	await fireEvent.update(input, updated.name);
	await fireEvent.update(textarea, updated.description);
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.save }));
	await nextTick();
	expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/update', { roomId: 'r1', name: updated.name, description: updated.description }, undefined, chatRoomUpdateErrors);
	expect(result.emitted().updated).toEqual([[updated]]);
});

test('renders the name and description with MFM for other members', () => {
	render(XInfo, { props: { room: { ...room, ownerId: 'someone-else' } }, global: { stubs } });
	expect(screen.queryByRole('textbox')).toBeNull();
	expect(screen.getAllByTestId('mfm').map(el => el.textContent)).toEqual([room.name, room.description]);
});

test('uses MFM for the room card name and description', () => {
	render(XRoom, { props: { room }, global: { stubs } });
	expect(screen.getAllByTestId('mfm').map(el => el.textContent)).toEqual([room.name, room.description]);
});
