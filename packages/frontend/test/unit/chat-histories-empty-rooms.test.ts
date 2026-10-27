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
	};
});

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ useChannel: () => new mocks.FakeChannel() }) }));
vi.mock('@/instance.js', () => ({ instance: mocks.instance }));
vi.mock('@/i.js', () => ({ ensureSignin: () => ({ id: 'me' }) }));

import { i18n } from '@/i18n.js';
import MkChatHistories from '@/components/MkChatHistories.vue';

const stubs = {
	MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	MkAvatar: { props: ['user'], template: '<span class="avatar"></span>' },
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
});
