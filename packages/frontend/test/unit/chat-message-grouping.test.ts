/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { prefer as mockedPrefer } from '@/preferences.js';
import type { FakePrefer } from './fake-prefer.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { getChatMessageGroupPositions } from '@/utility/chat-message-grouping.js';
import XMessage from '@/pages/chat/XMessage.vue';
import type { NormalizedChatMessage } from '@/pages/chat/room.vue';

const me = vi.hoisted(() => ({ id: 'me', username: 'me', policies: { chatAvailability: 'available' } }));

vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: me, ensureSignin: () => me }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn().mockResolvedValue([]) }));
vi.mock('@/os.js', () => ({ popupMenu: vi.fn(), contextMenu: vi.fn() }));
vi.mock('@/utility/reaction-picker.js', () => ({ reactionPicker: { show: vi.fn() } }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));

const MINUTE = 60 * 1000;
const base = Date.parse('2026-10-27T12:00:00.000Z');

function message(id: string, fromUserId: string, after: number) {
	return { id, type: 'item' as const, data: { id, fromUserId, createdAt: new Date(base + after).toISOString() } };
}

const divider = { id: 'date-x', type: 'date' as const };

describe('getChatMessageGroupPositions', () => {
	test('groups consecutive messages from the same sender', () => {
		expect(getChatMessageGroupPositions([
			message('a', 'alice', 0),
			message('b', 'alice', MINUTE),
			message('c', 'alice', 2 * MINUTE),
		])).toEqual([
			{ first: true, last: false },
			{ first: false, last: false },
			{ first: false, last: true },
		]);
	});

	test('starts a new group when the sender changes', () => {
		expect(getChatMessageGroupPositions([
			message('a', 'alice', 0),
			message('b', 'alice', MINUTE),
			message('c', 'bob', 2 * MINUTE),
			message('d', 'alice', 3 * MINUTE),
		])).toEqual([
			{ first: true, last: false },
			{ first: false, last: true },
			{ first: true, last: true },
			{ first: true, last: true },
		]);
	});

	test('groups a message sent exactly 17 minutes after the previous one', () => {
		expect(getChatMessageGroupPositions([
			message('a', 'alice', 0),
			message('b', 'alice', 17 * MINUTE),
		])).toEqual([
			{ first: true, last: false },
			{ first: false, last: true },
		]);
	});

	test('does not group a message sent 17 minutes and 1 second later', () => {
		expect(getChatMessageGroupPositions([
			message('a', 'alice', 0),
			message('b', 'alice', 17 * MINUTE + 1000),
		])).toEqual([
			{ first: true, last: true },
			{ first: true, last: true },
		]);
	});

	test('does not group across a date divider', () => {
		expect(getChatMessageGroupPositions([
			message('a', 'alice', 0),
			divider,
			message('b', 'alice', MINUTE),
		])).toEqual([
			{ first: true, last: true },
			null,
			{ first: true, last: true },
		]);
	});
});

describe('XMessage in a group', () => {
	const alice = { id: 'alice', username: 'alice', name: 'Alice', host: null };
	const stubs = {
		MkAvatar: { template: '<span data-testid="avatar"></span>' },
		MkUserName: { props: ['user'], template: '<span data-testid="name">{{ user.name }}</span>' },
		MkTime: { template: '<span data-testid="time"></span>' },
		MkA: { template: '<a><slot /></a>' },
		Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
	};

	function renderMessage(props: Record<string, unknown>) {
		const chatMessage = { id: 'm', createdAt: new Date(base).toISOString(), fromUserId: alice.id, fromUser: alice, text: 'hello', reactions: [] } as unknown as NormalizedChatMessage;
		return render(XMessage, { props: { message: chatMessage, ...props }, global: { stubs } });
	}

	beforeEach(() => {
		(mockedPrefer as unknown as FakePrefer).reset({ 'chat.showSenderName': true });
		vi.mocked(os.popupMenu).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	test('hides the footer before the last bubble and drops the avatar after the first one', () => {
		const head = renderMessage({ firstInGroup: true, lastInGroup: false });
		expect(head.queryByTestId('avatar')).not.toBeNull();
		expect(head.queryByTestId('name')).not.toBeNull();
		expect(head.container.querySelector('svg')).not.toBeNull();
		expect(head.getByTestId('time').parentElement!.className).toContain('groupedFooter');
		expect(head.getByRole('button', { name: i18n.ts.menu })).toBeTruthy();
		head.unmount();

		const tail = renderMessage({ firstInGroup: false, lastInGroup: true });
		expect(tail.queryByTestId('avatar')).toBeNull();
		expect(tail.queryByTestId('name')).toBeNull();
		expect(tail.container.querySelector('svg')).toBeNull();
		expect(tail.queryByTestId('time')).not.toBeNull();
		expect(tail.container.querySelector('.ti-dots-circle-horizontal')).not.toBeNull();
	});


	test.each([
		{ key: 'Enter' },
		{ key: 'F10', shiftKey: true },
		{ key: 'ContextMenu' },
	])('opens the same message menu from a non-last bubble with $key', async keys => {
		const result = renderMessage({ firstInGroup: false, lastInGroup: false });
		const bubble = result.getByText('hello').closest('[tabindex="0"]') as HTMLElement;
		expect(bubble).not.toBeNull();
		bubble.focus();
		expect(document.activeElement).toBe(bubble);

		await fireEvent.keyDown(bubble, keys);
		expect(os.popupMenu).toHaveBeenCalledTimes(1);
		const [items, anchor] = vi.mocked(os.popupMenu).mock.calls[0];
		expect(anchor).toBe(bubble);
		expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ text: i18n.ts.copyContent })]));
	});

	test('does not intercept keyboard activation on links inside a bubble', async () => {
		const result = renderMessage({ firstInGroup: false, lastInGroup: false });
		const body = result.getByText('hello').parentElement!.parentElement!;
		const link = document.createElement('a');
		link.href = '/user/alice';
		body.appendChild(link);
		await fireEvent.keyDown(link, { key: 'Enter' });
		expect(os.popupMenu).not.toHaveBeenCalled();
	});

	test('shows the avatar and footer when no place in a group is given', () => {
		const single = renderMessage({});
		expect(single.queryByTestId('avatar')).not.toBeNull();
		expect(single.queryByTestId('time')).not.toBeNull();
	});

	test('keeps the avatar and footer on search results', () => {
		const result = renderMessage({ firstInGroup: false, lastInGroup: false, isSearchResult: true });
		expect(result.queryByTestId('avatar')).not.toBeNull();
		expect(result.queryByTestId('time')).not.toBeNull();
	});
});
