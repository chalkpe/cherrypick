/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { preferState } from '../setup.unit.js';
import { getChatMessageGroupPositions } from '@/utility/chat-message-grouping.js';
import XMessage from '@/pages/chat/XMessage.vue';
import type { NormalizedChatMessage } from '@/pages/chat/room.vue';

const me = vi.hoisted(() => ({ id: 'me', username: 'me', policies: { chatAvailability: 'available' } }));

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

	afterEach(() => {
		cleanup();
	});

	test('drops the footer before the last bubble and the avatar after the first one', () => {
		preferState['chat.showSenderName'] = true;

		const head = renderMessage({ firstInGroup: true, lastInGroup: false });
		expect(head.queryByTestId('avatar')).not.toBeNull();
		expect(head.queryByTestId('name')).not.toBeNull();
		expect(head.container.querySelector('svg')).not.toBeNull();
		expect(head.queryByTestId('time')).toBeNull();
		expect(head.container.querySelector('.ti-dots-circle-horizontal')).toBeNull();
		head.unmount();

		const tail = renderMessage({ firstInGroup: false, lastInGroup: true });
		expect(tail.queryByTestId('avatar')).toBeNull();
		expect(tail.queryByTestId('name')).toBeNull();
		expect(tail.container.querySelector('svg')).toBeNull();
		expect(tail.queryByTestId('time')).not.toBeNull();
		expect(tail.container.querySelector('.ti-dots-circle-horizontal')).not.toBeNull();
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
