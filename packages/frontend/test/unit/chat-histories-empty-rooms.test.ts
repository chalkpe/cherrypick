/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/vue';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => {
	class FakeChannel {
		on() {}
		off() {}
		dispose = vi.fn();
	}
	return {
		misskeyApi: vi.fn(),
		instance: { features: { voiceCall: true, remoteVoiceCall: false } },
		FakeChannel,
		poll: null as null | (() => void),
	};
});

vi.mock('@@/js/use-interval.js', () => ({
	useInterval: (fn: () => void) => {
		mocks.poll = fn;
	},
}));

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ on: vi.fn(), off: vi.fn(), useChannel: () => new mocks.FakeChannel() }) }));
vi.mock('@/instance.js', () => ({ instance: mocks.instance }));
vi.mock('@/i.js', () => ({ ensureSignin: () => ({ id: 'me', policies: { canVoiceCall: true } }) }));

import { i18n } from '@/i18n.js';
import MkChatHistories from '@/components/MkChatHistories.vue';

const stubs = {
	MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	MkAvatar: { props: ['user'], template: '<span class="avatar" :data-user="user.id"></span>' },
	MkUserName: { template: '<span></span>' },
	MkAcct: { template: '<span></span>' },
	MkTime: { template: '<span></span>' },
	MkResult: { template: '<div></div>' },
	MkLoading: { template: '<div></div>' },
};

const owner = { id: 'me', username: 'me' };
const mkRoom = (id: string, createdAt: string) => ({ id, name: `room ${id}`, description: '', createdAt, owner }) as any;
const mkMembership = (room: any, createdAt: string) => ({ id: `m-${room.id}`, roomId: room.id, room, createdAt }) as any;
const roomMessage = (room: any, createdAt: string) => ({
	id: `msg-${room.id}`, createdAt, text: 'hello', fromUserId: 'other', fromUser: { id: 'other' }, toRoomId: room.id, toRoom: room, isRead: false,
}) as any;

function setup(data: { history?: any[]; owned?: any[]; joining?: any[]; voice?: any[] }) {
	mocks.misskeyApi.mockImplementation(async (endpoint: string, params?: any) => {
		if (endpoint === 'chat/history') return params.room ? (data.history ?? []) : [];
		if (endpoint === 'chat/rooms/owned') return data.owned ?? [];
		if (endpoint === 'chat/rooms/joining') return data.joining ?? [];
		if (endpoint === 'chat/rooms/voice/states') return data.voice ?? [];
		return [];
	});
}

async function flush() {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

async function mount() {
	const result = render(MkChatHistories, { global: { stubs } });
	await flush();
	return result;
}

const calls = (endpoint: string) => mocks.misskeyApi.mock.calls.filter(c => c[0] === endpoint).length;

const hrefs = (container: Element) => [...container.querySelectorAll('a')].map(a => a.getAttribute('href'));

beforeEach(() => {
	mocks.instance.features.voiceCall = true;
	mocks.misskeyApi.mockReset();
});

afterEach(() => {
	cleanup();
});

describe('chat home with rooms without messages', () => {
	test('shows an owned room and a joined room that have no messages', async () => {
		const owned = mkRoom('o1', '2026-01-01T00:00:00Z');
		const joined = mkRoom('j1', '2026-01-02T00:00:00Z');
		setup({ owned: [owned], joining: [mkMembership(joined, '2026-01-03T00:00:00Z')] });
		const { container } = await mount();

		expect(hrefs(container)).toEqual(expect.arrayContaining(['/chat/room/o1', '/chat/room/j1']));
		expect(screen.getAllByText(i18n.ts._chat.noMessagesInRoom)).toHaveLength(2);
	});

	test('does not duplicate a room that has messages, and keeps it first', async () => {
		const withMessage = mkRoom('r1', '2026-01-01T00:00:00Z');
		const empty = mkRoom('r2', '2026-01-05T00:00:00Z');
		setup({
			history: [roomMessage(withMessage, '2026-01-01T00:00:00Z')],
			owned: [withMessage, empty],
			joining: [mkMembership(withMessage, '2026-01-01T00:00:00Z')],
		});
		const { container } = await mount();

		expect(hrefs(container)).toEqual(['/chat/room/r1', '/chat/room/r2']);
		expect(screen.getAllByText(i18n.ts._chat.noMessagesInRoom)).toHaveLength(1);
	});

	test('lists a room that is both owned and joined once', async () => {
		const both = mkRoom('b1', '2026-01-01T00:00:00Z');
		setup({ owned: [both], joining: [mkMembership(both, '2026-01-01T00:00:00Z')] });
		const { container } = await mount();

		expect(hrefs(container)).toEqual(['/chat/room/b1']);
	});

	test('orders message-less rooms newest first by room or membership date', async () => {
		const ownedOld = mkRoom('o-old', '2026-01-01T00:00:00Z');
		const ownedNew = mkRoom('o-new', '2026-01-04T00:00:00Z');
		// 部屋自体は古いが、参加は新しい
		const joinedLate = mkRoom('j-late', '2025-01-01T00:00:00Z');
		const joinedEarly = mkRoom('j-early', '2026-01-03T00:00:00Z');
		setup({
			owned: [ownedOld, ownedNew],
			joining: [mkMembership(joinedLate, '2026-01-05T00:00:00Z'), mkMembership(joinedEarly, '2026-01-02T00:00:00Z')],
		});
		const { container } = await mount();

		expect(hrefs(container)).toEqual(['/chat/room/j-late', '/chat/room/o-new', '/chat/room/j-early', '/chat/room/o-old']);
	});

	test('shows the call indicator on a room without messages', async () => {
		const empty = mkRoom('v1', '2026-01-01T00:00:00Z');
		setup({
			owned: [empty],
			voice: [{ roomId: 'v1', participants: [{ identity: 'a', user: { id: 'a' }, screenSharing: false }], updatedAt: 1 }],
		});
		await mount();

		expect(screen.getByLabelText(i18n.tsx._voiceCall.inCallCount({ n: 1 }))).toBeTruthy();
	});

	test('does not dim a room without messages', async () => {
		const empty = mkRoom('d1', '2026-01-01T00:00:00Z');
		const read = { ...roomMessage(mkRoom('d2', '2026-01-01T00:00:00Z'), '2026-01-01T00:00:00Z'), isRead: true };
		setup({ owned: [empty], history: [read] });
		const { container } = await mount();

		const [readRow, emptyRow] = [...container.querySelectorAll('a')];
		expect(readRow.className).toMatch(/isRead/);
		expect(emptyRow.className).not.toMatch(/isRead/);
	});

	test('uses the owner as the avatar of a room without messages', async () => {
		const empty = { ...mkRoom('a1', '2026-01-01T00:00:00Z'), owner: { id: 'the-owner' } };
		setup({ owned: [empty] });
		const { container } = await mount();

		expect(container.querySelector('.avatar')!.getAttribute('data-user')).toBe('the-owner');
	});

	test('skips a membership without a room', async () => {
		const ok = mkRoom('k1', '2026-01-01T00:00:00Z');
		setup({ joining: [{ id: 'm0', roomId: 'x', room: null, createdAt: '2026-01-09T00:00:00Z' }, mkMembership(ok, '2026-01-02T00:00:00Z')] });
		const { container } = await mount();

		expect(hrefs(container)).toEqual(['/chat/room/k1']);
	});

	test('moves a room to the history section once it gets its first message', async () => {
		const r = mkRoom('f1', '2026-01-01T00:00:00Z');
		setup({ owned: [r] });
		const { container } = await mount();
		expect(hrefs(container)).toEqual(['/chat/room/f1']);

		setup({ owned: [r], history: [roomMessage(r, '2026-01-02T00:00:00Z')] });
		mocks.poll!();
		await flush();

		expect(hrefs(container)).toEqual(['/chat/room/f1']);
		expect(screen.queryByText(i18n.ts._chat.noMessagesInRoom)).toBeNull();
	});

	test('still shows history when the room lists fail, and keeps polling', async () => {
		const r = mkRoom('e1', '2026-01-01T00:00:00Z');
		mocks.misskeyApi.mockImplementation(async (endpoint: string, params?: any) => {
			if (endpoint === 'chat/history') return params.room ? [roomMessage(r, '2026-01-01T00:00:00Z')] : [];
			if (endpoint === 'chat/rooms/voice/states') return [];
			throw new Error('boom');
		});
		const { container } = await mount();
		expect(hrefs(container)).toEqual(['/chat/room/e1']);

		const before = calls('chat/history');
		mocks.poll!();
		await flush();
		expect(calls('chat/history')).toBeGreaterThan(before);
	});

	test('recovers on the next poll after chat/history fails once', async () => {
		const r = mkRoom('h1', '2026-01-01T00:00:00Z');
		let failed = false;
		mocks.misskeyApi.mockImplementation(async (endpoint: string, params?: any) => {
			if (endpoint === 'chat/history') {
				if (!failed) {
					failed = true;
					throw new Error('boom');
				}
				return params.room ? [roomMessage(r, '2026-01-01T00:00:00Z')] : [];
			}
			return [];
		});
		const { container } = await mount();
		mocks.poll!();
		await flush();

		expect(hrefs(container)).toEqual(['/chat/room/h1']);
	});

	test('reloads the room lists only on every sixth poll', async () => {
		setup({ owned: [mkRoom('p1', '2026-01-01T00:00:00Z')] });
		await mount();
		expect([calls('chat/history'), calls('chat/rooms/owned'), calls('chat/rooms/joining')]).toEqual([2, 1, 1]);

		for (let i = 0; i < 6; i++) {
			mocks.poll!();
			await flush();
		}

		expect(calls('chat/history')).toBe(2 + 6 * 2);
		expect(calls('chat/rooms/owned')).toBe(2);
		expect(calls('chat/rooms/joining')).toBe(2);
	});
});
