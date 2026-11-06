/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { nextTick } from 'vue';
import MkReactedUsersDialog from '@/components/MkReactedUsersDialog.vue';

vi.mock('@/i.js', () => ({ $i: { token: 'test-token' } }));
vi.mock('@/components/MkModalWindow.vue', () => ({ default: { template: '<div><slot name="header"/><slot/></div>' } }));
vi.mock('@/components/MkReactionIcon.vue', () => ({ default: { props: ['reaction'], template: '<span>{{ reaction }}</span>' } }));
vi.mock('@/components/MkUserCardMini.vue', () => ({ default: { props: ['user'], template: '<div>{{ user.username }}</div>' } }));
vi.mock('@@/js/user.js', () => ({ userPage: () => '/' }));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

test('loads authenticated reaction users and keeps the latest tab when responses arrive out of order', async () => {
	const pending = new Map<string, (value: Response) => void>();
	const calls: { method: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
		const method = options.method!;
		const body = method === 'POST' ? JSON.parse(options.body as string) : Object.fromEntries(new URL(url).searchParams);
		if (url.endsWith('/notes/show')) {
			return new Response(JSON.stringify({ reactions: { '👍': 1, ':shape@.:': 1 } }), { status: 200 });
		}
		calls.push({ method, body });
		return await new Promise<Response>(resolve => pending.set(body.type, resolve));
	}));
	window.fetch = globalThis.fetch;

	const screen = render(MkReactedUsersDialog, { props: { noteId: 'note' }, global: { stubs: { MkA: { template: '<a><slot/></a>' }, MkLoading: true, MkResult: true } } });
	await waitFor(() => expect(pending.has('👍')).toBe(true));
	expect(calls[0]).toEqual({ method: 'POST', body: { noteId: 'note', type: '👍', limit: 30, i: 'test-token' } });
	await fireEvent.click(screen.getByRole('button', { name: ':shape@.: 1' }));
	await waitFor(() => expect(pending.has(':shape@.:')).toBe(true));
	expect(calls[1]).toEqual({ method: 'POST', body: { noteId: 'note', type: ':shape@.:', limit: 30, i: 'test-token' } });
	pending.get(':shape@.:')!(new Response(JSON.stringify([{ user: { id: '2', username: 'yuna' } }]), { status: 200 }));
	await screen.findByText('yuna');
	pending.get('👍')!(new Response(JSON.stringify([{ user: { id: '1', username: 'minji' } }]), { status: 200 }));
	await new Promise(resolve => setTimeout(resolve, 0));
	await nextTick();
	expect(screen.queryByText('minji')).toBeNull();
	expect(screen.getByText('yuna')).toBeTruthy();
});
