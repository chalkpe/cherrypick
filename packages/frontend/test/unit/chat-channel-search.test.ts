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

const channels = [{ id: 'first', roomId: 'r', name: 'same', isLegacy: true, sectionId: null }, { id: 'second', roomId: 'r', name: 'same', isLegacy: false, sectionId: null }];
const searchRequests = () => state.requests.filter(request => 'query' in request);
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
	await waitFor(() => expect(searchRequests()).toHaveLength(1));

	expect(searchRequests()[0]).toEqual({ roomId: 'r', query: 'needle', i: 'unit-token' });
	await fireEvent.mouseDown(document.querySelector('[tabindex="0"]')!);
	const choices = state.popupMenu.mock.lastCall![0] as { text: string; action?: () => void }[];
	choices.find(choice => choice.text === '#same · 2')!.action!();
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.search }));
	await waitFor(() => expect(searchRequests()).toHaveLength(2));
	expect(searchRequests()[1]).toEqual({ roomId: 'r', channelId: 'second', query: 'needle', i: 'unit-token' });
});

test('rejects an old search response after switching groups', async () => {
	let resolve!: (response: Response) => void;
	state.respond = () => new Promise(done => { resolve = done; });
	const view = render(Search, { props: { roomId: 'r', channels }, global: { stubs: { MkResult: true }, directives: { adaptiveBorder: {} } } });
	await fireEvent.update(screen.getByPlaceholderText(i18n.ts._chat.searchMessages), 'needle');
	await fireEvent.click(screen.getByRole('button', { name: i18n.ts.search }));
	await waitFor(() => expect(searchRequests()).toHaveLength(1));
	await view.rerender({ roomId: 'other', channels: [] });
	resolve(new Response(JSON.stringify([{ id: 'old', text: 'old group secret' }]), { status: 200 }));
	await waitFor(() => expect(screen.queryByText('old group secret')).toBeNull());
});

test('searches on Enter and ignores whitespace-only input', async () => {
	render(Search, { props: { roomId: 'r', channels }, global: { stubs: { MkResult: true }, directives: { adaptiveBorder: {} } } });
	const input = screen.getByPlaceholderText(i18n.ts._chat.searchMessages);
	await fireEvent.update(input, '   ');
	await fireEvent.keyDown(input, { key: 'Enter' });
	expect(searchRequests()).toHaveLength(0);
	await fireEvent.update(input, ' needle ');
	await fireEvent.keyDown(input, { key: 'Enter' });
	await waitFor(() => expect(searchRequests()).toHaveLength(1));
	expect(searchRequests()[0]).toEqual({ roomId: 'r', query: 'needle', i: 'unit-token' });
});

test('groups the channel select options under section labels', async () => {
	state.respond = async () => {
		const last = state.requests[state.requests.length - 1] as Record<string, unknown>;
		if (!('query' in last)) return new Response(JSON.stringify([{ id: 's1', roomId: 'r', name: '운영' }]), { status: 200 });
		return new Response(JSON.stringify(state.answers), { status: 200 });
	};
	const sectioned = [
		{ id: 'first', roomId: 'r', name: 'general', isLegacy: true, sectionId: null },
		{ id: 'second', roomId: 'r', name: '공지', isLegacy: false, sectionId: 's1' },
	];
	render(Search, { props: { roomId: 'r', channels: sectioned }, global: { stubs: { MkResult: true }, directives: { adaptiveBorder: {} } } });
	await waitFor(() => expect(state.requests.some(request => !('query' in request))).toBe(true));
	// 섹션 응답이 반영될 때까지 마이크로태스크를 비운다.
	await new Promise(resolve => setTimeout(resolve, 0));
	await fireEvent.mouseDown(document.querySelector('[tabindex="0"]')!);
	const choices = state.popupMenu.mock.lastCall![0] as { type?: string; text: string }[];
	expect(choices.map(choice => choice.type === 'label' ? `[${choice.text}]` : choice.text)).toEqual([
		i18n.ts._chat._channels.all, '#general · 1', '[운영]', '#공지 · 2',
	]);
});

test('섹션 목록 조회가 실패해도 섹션 안 채널을 원래 순서대로 평평하게 고를 수 있다', async () => {
	state.respond = async () => {
		const last = state.requests[state.requests.length - 1] as Record<string, unknown>;
		if (!('query' in last)) return new Response(JSON.stringify({ error: { message: 'x', code: 'INTERNAL_ERROR', id: 'x' } }), { status: 500 });
		return new Response(JSON.stringify(state.answers), { status: 200 });
	};
	const sectioned = [
		{ id: 'first', roomId: 'r', name: 'general', isLegacy: true, sectionId: null },
		{ id: 'second', roomId: 'r', name: '공지', isLegacy: false, sectionId: 's1' },
		{ id: 'third', roomId: 'r', name: '자료', isLegacy: false, sectionId: 's1' },
	];
	render(Search, { props: { roomId: 'r', channels: sectioned }, global: { stubs: { MkResult: true }, directives: { adaptiveBorder: {} } } });
	await waitFor(() => expect(state.requests.some(request => !('query' in request))).toBe(true));
	await new Promise(resolve => setTimeout(resolve, 0));
	await fireEvent.mouseDown(document.querySelector('[tabindex="0"]')!);
	const choices = state.popupMenu.mock.lastCall![0] as { type?: string; text: string }[];
	expect(choices.map(choice => choice.type === 'label' ? `[${choice.text}]` : choice.text)).toEqual([
		i18n.ts._chat._channels.all, '#general · 1', '#공지 · 2', '#자료 · 3',
	]);
});
