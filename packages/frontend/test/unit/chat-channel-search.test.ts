/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';

const state = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[], answers: [] as { id: string; text: string }[], popupMenu: vi.fn(), respond: null as null | (() => Promise<Response>) }));
vi.mock('@/i.js', () => ({ $i: { id: 'me', token: 'unit-token' } }));
vi.mock('@/os.js', () => ({ alert: vi.fn(), popupMenu: state.popupMenu }));
vi.mock('@/components/MkInput.vue', () => ({ default: { props: ['modelValue', 'placeholder'], emits: ['update:modelValue', 'enter'], template: '<div><input :placeholder="placeholder" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @keydown.enter="$emit(\'enter\', $event)"/><slot name="suffix"/></div>' } }));
vi.mock('@/components/MkFoldableSection.vue', () => ({ default: { template: '<section><slot name="header"/><slot/></section>' } }));
vi.mock('@/pages/chat/XMessage.vue', () => ({ default: { props: ['message'], template: '<div>{{ message.text }}</div>' } }));

import { installFakeResizeObserver } from './fake-resize-observer.js';

installFakeResizeObserver();

import Search from '@/pages/chat/room.search.vue';
import { i18n } from '@/i18n.js';

const channels = [{ id: 'first', roomId: 'r', name: 'same', isLegacy: true }, { id: 'second', roomId: 'r', name: 'same', isLegacy: false }];
beforeEach(() => {
	state.requests.length = 0;
	state.popupMenu.mockClear();
	state.answers = [];
	state.respond = null;
	vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
		state.requests.push(JSON.parse(init.body as string));
		return state.respond ? state.respond() : new Response(JSON.stringify(state.answers), { status: 200 });
	}));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('sends a credentialed all-channel query by default and filters duplicate names by ID', async () => {
	render(Search, { props: { roomId: 'r', channels }, global: { stubs: { MkResult: true }, directives: { adaptiveBorder: {} } } });
	await fireEvent.update(screen.getByPlaceholderText(i18n.ts._chat.searchMessages), 'needle');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.search }));
	await waitFor(() => expect(state.requests).toHaveLength(1));

	expect(state.requests[0]).toEqual({ roomId: 'r', query: 'needle', i: 'unit-token' });
	await fireEvent.mouseDown(document.querySelector('[tabindex="0"]')!);
	const choices = state.popupMenu.mock.lastCall![0] as { text: string; action?: () => void }[];
	choices.find(choice => choice.text === '#same · 2')!.action!();
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.search }));
	await waitFor(() => expect(state.requests).toHaveLength(2));
	expect(state.requests[1]).toEqual({ roomId: 'r', channelId: 'second', query: 'needle', i: 'unit-token' });
});

test('rejects an old search response after switching groups', async () => {
	let resolve!: (response: Response) => void;
	state.respond = () => new Promise(done => { resolve = done; });
	const view = render(Search, { props: { roomId: 'r', channels }, global: { stubs: { MkResult: true }, directives: { adaptiveBorder: {} } } });
	await fireEvent.update(screen.getByPlaceholderText(i18n.ts._chat.searchMessages), 'needle');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.search }));
	await waitFor(() => expect(state.requests).toHaveLength(1));
	await view.rerender({ roomId: 'other', channels: [] });
	resolve(new Response(JSON.stringify([{ id: 'old', text: 'old group secret' }]), { status: 200 }));
	await waitFor(() => expect(screen.queryByText('old group secret')).toBeNull());
});

test('searches on Enter and ignores whitespace-only input', async () => {
	render(Search, { props: { roomId: 'r', channels }, global: { stubs: { MkResult: true }, directives: { adaptiveBorder: {} } } });
	const input = screen.getByPlaceholderText(i18n.ts._chat.searchMessages);
	await fireEvent.update(input, '   ');
	await fireEvent.keyDown(input, { key: 'Enter' });
	expect(state.requests).toHaveLength(0);
	await fireEvent.update(input, ' needle ');
	await fireEvent.keyDown(input, { key: 'Enter' });
	await waitFor(() => expect(state.requests).toHaveLength(1));
	expect(state.requests[0]).toEqual({ roomId: 'r', query: 'needle', i: 'unit-token' });
});
