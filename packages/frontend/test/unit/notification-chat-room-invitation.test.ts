/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(async () => ({})) }));
const me = vi.hoisted(() => ({ id: 'me', username: 'me', policies: {} }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: me, ensureSignin: () => me }));
// この通知では使わない部品。読み込むとノートやユーザーのメニューまで連なって読み込まれるので差し替える
vi.mock('@/components/MkFollowButton.vue', () => ({ default: {} }));
vi.mock('@/components/MkReactionIcon.vue', () => ({ default: {} }));

import MkNotification from '@/components/MkNotification.vue';
import { misskeyApi } from '@/utility/misskey-api.js';

const stubs = {
	MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	MkAvatar: { props: ['user'], template: '<span class="avatar"></span>' },
	MkUserName: { props: ['user'], template: '<span>{{ user.username }}</span>' },
	MkTime: true,
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
};

const owner = { id: 'owner', username: 'owner', host: null };
const api = vi.mocked(misskeyApi);

const notification = {
	id: 'n1',
	createdAt: '2026-10-27T13:14:35.741Z',
	type: 'chatRoomInvitationReceived',
	userId: owner.id,
	user: owner,
	invitation: {
		id: 'i1',
		createdAt: '2026-10-27T13:14:35.725Z',
		roomId: 'room1',
		room: { id: 'room1', name: 'room 1', description: '', ownerId: owner.id, owner },
		userId: 'me',
	},
} as any;

function renderNotification(full = false) {
	return render(MkNotification, {
		props: { notification, full },
		global: { stubs },
	});
}

beforeEach(() => {
	api.mockClear();
});

afterEach(cleanup);

test('opens the room the invitation is for', () => {
	renderNotification();

	expect(screen.getByText('room 1').closest('a')?.getAttribute('href')).toBe('/chat/room/room1');
});

test('offers join and reject actions in the full notification view', () => {
	renderNotification(true);

	expect(screen.getAllByRole('button')).toHaveLength(2);
});

test('joins the room from the notification', async () => {
	renderNotification(true);

	await fireEvent.click(screen.getAllByRole('button')[0]);

	expect(api).toHaveBeenCalledWith('chat/rooms/join', { roomId: 'room1' });
	expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('rejects the invitation from the notification', async () => {
	renderNotification(true);

	await fireEvent.click(screen.getAllByRole('button')[1]);

	expect(api).toHaveBeenCalledWith('chat/rooms/invitations/reject', { roomId: 'room1' });
	expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('does not offer actions in the compact notification view', () => {
	renderNotification();

	expect(screen.queryAllByRole('button')).toHaveLength(0);
});
