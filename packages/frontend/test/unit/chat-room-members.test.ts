/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
	expect(mocks.confirm).toHaveBeenCalledWith({ type: 'warning', text: i18n.tsx._chat.kickMemberConfirm({ name: 'Member' }) });
	await waitFor(() => expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/kick', { roomId: 'room', userId: 'member' }));
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
