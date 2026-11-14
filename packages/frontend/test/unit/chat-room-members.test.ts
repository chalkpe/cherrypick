/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';

const mocks = vi.hoisted(() => ({ api: vi.fn().mockResolvedValue([]), apiWithDialog: vi.fn(), confirm: vi.fn(), me: { id: 'owner', policies: {} } }));
vi.mock('@/components/MkUserCardMini.vue', () => ({ default: { props: ['user'], template: '<span>{{ user.username }}</span>' } }));
vi.mock('@/i.js', () => ({ $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({}) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog, confirm: mocks.confirm }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import Members from '@/pages/chat/room.members.vue';
import { i18n } from '@/i18n.js';
import { chatBanDeleteErrors, chatCancelInvitationErrors, chatKickErrors } from '@/pages/chat/chat-errors.js';

const room = { id: 'room', ownerId: 'owner', owner: { id: 'owner', username: 'owner' }, isArchived: false } as any;
const membership = { id: 'membership', userId: 'member', user: { id: 'member', name: 'Member', username: 'member', host: 'remote.test' } };
const stubs = {
	MkButton: { emits: ['click'], template: '<button @click="$emit(\'click\')"><slot/></button>' },
	MkA: { template: '<a><slot/></a>' },
	MkUserCardMini: { props: ['user'], template: '<span>{{ user.username }}</span>' },
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.api.mockImplementation(async endpoint => endpoint === 'chat/rooms/members' ? [membership] : []);
	mocks.confirm.mockResolvedValue({ canceled: false });
	mocks.apiWithDialog.mockResolvedValue(undefined);
});
afterEach(cleanup);

test('the owner confirms the named member and removes that row after success', async () => {
	render(Members, { props: { room }, global: { stubs } });
	await fireEvent.click(await screen.findByRole('button', { name: i18n.ts._chat.kickMember }));
	expect(mocks.confirm).toHaveBeenCalledWith({ type: 'warning', text: i18n.tsx._chat.kickMemberConfirm({ name: 'Member', room: room.name }), room });
	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/kick', { roomId: 'room', userId: 'member' }, undefined, chatKickErrors));
	await waitFor(() => expect(screen.queryByText('member')).toBeNull());
});

test('canceling keeps the member and makes no request', async () => {
	mocks.confirm.mockResolvedValue({ canceled: true });
	render(Members, { props: { room }, global: { stubs } });
	await fireEvent.click(await screen.findByRole('button', { name: i18n.ts._chat.kickMember }));
	expect(mocks.apiWithDialog).not.toHaveBeenCalled();
	expect(screen.getByText('member')).toBeTruthy();
});

test('a failed kick keeps the member and re-enables the action', async () => {
	mocks.apiWithDialog.mockRejectedValue(new Error('request failed'));
	render(Members, { props: { room }, global: { stubs } });
	await fireEvent.click(await screen.findByRole('button', { name: i18n.ts._chat.kickMember }));
	await waitFor(() => expect((screen.getByRole('button', { name: i18n.ts._chat.kickMember }) as HTMLButtonElement).disabled).toBe(false));
	expect(screen.getByText('member')).toBeTruthy();
});

test('only the owner sees a kick action, including in an archived room', async () => {
	const result = render(Members, { props: { room: { ...room, ownerId: 'other' } }, global: { stubs } });
	await screen.findByText('member');
	expect(screen.queryByRole('button', { name: i18n.ts._chat.kickMember })).toBeNull();
	await result.rerender({ room: { ...room, isArchived: true } });
	expect(screen.getByRole('button', { name: i18n.ts._chat.kickMember })).toBeTruthy();
});

test('the button that cancels an invitation says whose invitation it cancels', async () => {
	mocks.api.mockImplementation(async endpoint => endpoint === 'chat/rooms/invitations/outbox' ? [{ id: 'invitation', user: { id: 'invitee', username: 'invitee' } }] : []);
	render(Members, { props: { room }, global: { stubs } });
	await fireEvent.click(await screen.findByRole('button', { name: i18n.tsx._chat.cancelInvitationTo({ x: 'invitee' }) }));
	expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/invitations/cancel', { invitationId: 'invitation' }, undefined, chatCancelInvitationErrors);
});

describe('people the owner removed', () => {
	const ban = { id: 'ban', roomId: 'room', userId: 'removed', createdAt: '2026-11-13T00:00:00.000Z', user: { id: 'removed', name: 'Removed', username: 'removed', host: null } };

	function serve(bans: unknown[]) {
		mocks.api.mockImplementation(async endpoint => {
			if (endpoint === 'chat/rooms/members') return [membership];
			if (endpoint === 'chat/rooms/bans/list') return bans;
			return [];
		});
	}

	const requested = () => mocks.api.mock.calls.map(call => call[0]);

	test('only the owner sees them, in the same rows as the members', async () => {
		serve([ban]);
		render(Members, { props: { room }, global: { stubs } });

		expect(await screen.findByText('removed')).toBeTruthy();
		expect(screen.getByText(i18n.ts._chat.bannedUsers)).toBeTruthy();
		expect(mocks.api).toHaveBeenCalledWith('chat/rooms/bans/list', { roomId: 'room', limit: 100 });
	});

	test('nobody else asks for them or sees them, whether or not the group has channels', async () => {
		serve([ban]);
		render(Members, { props: { room: { ...room, ownerId: 'other', hasChannels: true } }, global: { stubs } });

		await screen.findByText('member');
		expect(requested()).not.toContain('chat/rooms/bans/list');
		expect(screen.queryByText(i18n.ts._chat.bannedUsers)).toBeNull();
		expect(screen.queryByRole('button', { name: i18n.ts._chat.pardon })).toBeNull();
	});

	test('the owner of a group with channels manages them the same way', async () => {
		serve([ban]);
		render(Members, { props: { room: { ...room, hasChannels: true } }, global: { stubs } });

		expect(await screen.findByRole('button', { name: i18n.ts._chat.pardon })).toBeTruthy();
	});

	test('a pardon is confirmed, lifts the ban, and does nothing more', async () => {
		serve([ban]);
		const result = render(Members, { props: { room }, global: { stubs } });
		const button = await screen.findByRole('button', { name: i18n.ts._chat.pardon });
		const callsBefore = mocks.api.mock.calls.length;

		await fireEvent.click(button);

		expect(mocks.confirm).toHaveBeenCalledWith({ type: 'warning', text: i18n.tsx._chat.pardonConfirm({ name: 'Removed' }) });
		await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/bans/delete', { roomId: 'room', userId: 'removed' }, undefined, chatBanDeleteErrors));
		await waitFor(() => expect(screen.queryByText('removed')).toBeNull());
		expect(mocks.apiWithDialog).toHaveBeenCalledTimes(1);
		expect(mocks.api.mock.calls.length).toBe(callsBefore);
		expect(result.emitted().inviteUser).toBeUndefined();
	});

	test('canceling the pardon keeps the ban', async () => {
		serve([ban]);
		mocks.confirm.mockResolvedValue({ canceled: true });
		render(Members, { props: { room }, global: { stubs } });

		await fireEvent.click(await screen.findByRole('button', { name: i18n.ts._chat.pardon }));

		expect(mocks.apiWithDialog).not.toHaveBeenCalled();
		expect(screen.getByText('removed')).toBeTruthy();
	});

	test('a member the owner just removed shows up among them', async () => {
		let current: unknown[] = [];
		mocks.api.mockImplementation(async endpoint => endpoint === 'chat/rooms/members' ? [membership] : endpoint === 'chat/rooms/bans/list' ? current : []);
		mocks.apiWithDialog.mockImplementation(async endpoint => {
			if (endpoint === 'chat/rooms/kick') current = [{ ...ban, userId: 'member', user: membership.user }];
		});
		render(Members, { props: { room }, global: { stubs } });

		await fireEvent.click(await screen.findByRole('button', { name: i18n.ts._chat.kickMember }));

		expect(await screen.findByRole('button', { name: i18n.ts._chat.pardon })).toBeTruthy();
		expect(screen.queryByRole('button', { name: i18n.ts._chat.kickMember })).toBeNull();
		expect(screen.getByText('member')).toBeTruthy();
	});

	test('a long list is read page by page', async () => {
		const page = Array.from({ length: 100 }, (_, i) => ({ ...ban, id: `ban${String(i).padStart(3, '0')}`, userId: `u${i}`, user: { ...ban.user, id: `u${i}`, username: `u${i}` } }));
		serve(page);
		render(Members, { props: { room }, global: { stubs } });
		await screen.findByText('u99');
		serve([{ ...ban, id: 'ban-last', userId: 'last', user: { ...ban.user, id: 'last', username: 'last' } }]);

		await fireEvent.click(screen.getByRole('button', { name: i18n.ts.loadMore }));

		expect(await screen.findByText('last')).toBeTruthy();
		expect(mocks.api).toHaveBeenLastCalledWith('chat/rooms/bans/list', { roomId: 'room', limit: 100, untilId: 'ban099' });
	});
});
