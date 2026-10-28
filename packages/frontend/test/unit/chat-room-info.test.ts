/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({ apiWithDialog: vi.fn(), me: { id: 'me', isAdmin: false, isModerator: false } }));
vi.mock('@/i.js', () => ({ ensureSignin: () => mocks.me }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import XInfo from '@/pages/chat/room.info.vue';
import XRoom from '@/pages/chat/XRoom.vue';
import { i18n } from '@/i18n.js';

const room = { id: 'r1', ownerId: 'me', owner: { id: 'me', username: 'me' }, name: ':test: room', description: ':test: description' } as any;
const stubs = {
	MkInput: { props: ['modelValue', 'mfmAutocomplete'], emits: ['update:modelValue'], template: '<label><slot name="label"/><input :value="modelValue" :data-autocomplete="JSON.stringify(mfmAutocomplete)" @input="$emit(\'update:modelValue\', $event.target.value)"/><slot name="caption"/></label>' },
	MkTextarea: { props: { modelValue: String, mfmAutocomplete: Array, mfmPreview: Boolean }, emits: ['update:modelValue'], template: '<label><slot name="label"/><textarea :value="modelValue" :data-autocomplete="JSON.stringify(mfmAutocomplete)" :data-preview="mfmPreview" @input="$emit(\'update:modelValue\', $event.target.value)"/></label>' },
	MkButton: { emits: ['click'], template: '<button @click="$emit(\'click\')"><slot/></button>' },
	MkSwitch: true,
	MkKeyValue: { template: '<div><slot name="key"/><slot name="value"/></div>' },
	MkAvatar: true,
	MkA: { template: '<a><slot/></a>' },
	Mfm: { props: ['text', 'plain'], template: '<span data-testid="mfm" :data-plain="plain">{{ text }}</span>' },
};

afterEach(() => { cleanup(); mocks.apiWithDialog.mockReset(); });

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
	expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/update', { roomId: 'r1', name: updated.name, description: updated.description });
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
