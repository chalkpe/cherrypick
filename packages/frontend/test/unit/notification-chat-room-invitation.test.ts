/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn(async () => ({})) }));
vi.mock('@/os.js', () => ({ alert: vi.fn() }));
const me = vi.hoisted(() => ({ id: 'me', username: 'me', policies: {} }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: me, ensureSignin: () => me }));
// この通知では使わない部品。読み込むとノートやユーザーのメニューまで連なって読み込まれるので差し替える
vi.mock('@/components/MkFollowButton.vue', () => ({ default: {} }));
vi.mock('@/components/MkReactionIcon.vue', () => ({ default: {} }));

import { alert } from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import MkNotification from '@/components/MkNotification.vue';
import { globalEvents } from '@/events.js';
import { i18n } from '@/i18n.js';

const stubs = {
	MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	MkAvatar: { props: ['user'], template: '<span class="avatar"></span>' },
	MkUserName: { props: ['user'], template: '<span>{{ user.name ?? user.username }}</span>' },
	MkAcct: { props: ['user'], template: '<span>@{{ user.username }}{{ user.host ? `@${user.host}` : "" }}</span>' },
	MkTime: true,
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
};

const flushPromises = () => new Promise<void>(resolve => setTimeout(resolve, 0));

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

function renderNotification(full = false, shown = notification) {
	return render(MkNotification, {
		props: { notification: shown, full },
		global: { stubs, directives: { userPreview: {} } },
	});
}

function withOwner(person: Record<string, unknown>) {
	return { ...notification, invitation: { ...notification.invitation, room: { ...notification.invitation.room, owner: person } } };
}

beforeEach(() => {
	vi.mocked(alert).mockClear();
	api.mockReset();
	api.mockResolvedValue({} as never);
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

	await flushPromises();
	expect(api).toHaveBeenCalledWith('chat/rooms/join', { roomId: 'room1' });
	expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('rejects the invitation from the notification', async () => {
	renderNotification(true);

	await fireEvent.click(screen.getAllByRole('button')[1]);

	await flushPromises();
	expect(api).toHaveBeenCalledWith('chat/rooms/invitations/reject', { roomId: 'room1' });
	expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('drops the actions when the same invitation is answered in another list', async () => {
	renderNotification(true);
	expect(screen.queryAllByRole('button')).toHaveLength(2);

	globalEvents.emit('chatRoomInvitationHandled', 'another room', 'joined');
	await flushPromises();
	expect(screen.queryAllByRole('button')).toHaveLength(2);

	globalEvents.emit('chatRoomInvitationHandled', 'room1', 'rejected');
	await flushPromises();
	expect(screen.queryAllByRole('button')).toHaveLength(0);
	expect(screen.getByText(i18n.ts._chat.invitationRejected)).toBeTruthy();
});

test.each([
	[0, 'joined', 'invitationJoined'],
	[1, 'rejected', 'invitationRejected'],
] as const)('says what action %i chose, and tells the other lists', async (action, result, label) => {
	const handled = vi.fn();
	globalEvents.on('chatRoomInvitationHandled', handled);
	renderNotification(true);

	await fireEvent.click(screen.getAllByRole('button')[action]);
	await flushPromises();
	globalEvents.off('chatRoomInvitationHandled', handled);

	expect(handled).toHaveBeenCalledExactlyOnceWith('room1', result);
	expect(screen.getByText(i18n.ts._chat[label])).toBeTruthy();
});

test('does not offer actions in the compact notification view', () => {
	renderNotification();

	expect(screen.queryAllByRole('button')).toHaveLength(0);
});

for (const action of [0, 1]) {
	test(`keeps invitation actions available after action ${action} fails`, async () => {
		api.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		renderNotification(true);
		await fireEvent.click(screen.getAllByRole('button')[action]);
		await flushPromises();
		expect(vi.mocked(alert)).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
		expect(screen.getAllByRole('button')).toHaveLength(2);
		expect(screen.getAllByRole('button').every(button => !(button as HTMLButtonElement).disabled)).toBe(true);
		await fireEvent.click(screen.getAllByRole('button')[action]);
		await flushPromises();
		expect(api.mock.calls.filter(([endpoint]) => endpoint !== 'chat/rooms/show')).toHaveLength(2);
		expect(screen.queryAllByRole('button')).toHaveLength(0);
	});

	// 招待一覧や別の端末で応じた (または取り消された) 招待は、押し直しても同じく失敗するのでボタンを下げる
	test(`drops invitation actions without an error when action ${action} finds the invitation already gone`, async () => {
		api.mockImplementation(((endpoint: string) => endpoint === 'chat/rooms/show'
			? Promise.resolve({ id: 'room1', invitationExists: false })
			: Promise.reject({ code: 'INTERNAL_ERROR' })) as never);
		renderNotification(true);
		await fireEvent.click(screen.getAllByRole('button')[action]);
		await flushPromises();
		expect(api).toHaveBeenCalledWith('chat/rooms/show', { roomId: 'room1' });
		expect(vi.mocked(alert)).not.toHaveBeenCalled();
		expect(screen.queryAllByRole('button')).toHaveLength(0);
	});

	// 断った・取り消された招待のルームは、メンバーでなければ見えない
	test(`drops invitation actions when action ${action} fails and the room is no longer visible`, async () => {
		api.mockImplementation(((endpoint: string) => Promise.reject({ code: endpoint === 'chat/rooms/show' ? 'NO_SUCH_ROOM' : 'INTERNAL_ERROR' })) as never);
		renderNotification(true);
		await fireEvent.click(screen.getAllByRole('button')[action]);
		await flushPromises();
		expect(vi.mocked(alert)).not.toHaveBeenCalled();
		expect(screen.queryAllByRole('button')).toHaveLength(0);
	});
}

// 招待の一覧と同じく、アーカイブされたルームには入れないので断ることだけできる
test('does not offer joining an archived room, only rejecting', () => {
	renderNotification(true, { ...notification, invitation: { ...notification.invitation, room: { ...notification.invitation.room, isArchived: true } } });

	expect(screen.queryByRole('button', { name: i18n.ts._chat.join })).toBeNull();
	expect(screen.getByRole('button', { name: i18n.ts._chat.reject })).toBeTruthy();
});

// 通知が届いたあとでアーカイブされると、通知の中のルームはまだアーカイブされていない
test('says why when the room was archived after the notification came', async () => {
	api.mockImplementation(((endpoint: string) => endpoint === 'chat/rooms/show'
		? Promise.resolve({ id: 'room1', invitationExists: true })
		: Promise.reject({ code: 'ROOM_IS_ARCHIVED', id: 'c60a4f18-d3b2-4e75-9c06-7a1e58d3f2b9' })) as never);
	renderNotification(true);

	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat.join }));
	await flushPromises();

	expect(vi.mocked(alert)).toHaveBeenCalledExactlyOnceWith({ type: 'error', text: i18n.ts._chat.thisRoomIsArchived });
});

test('still reports another failure the way it did', async () => {
	api.mockImplementation(((endpoint: string) => endpoint === 'chat/rooms/show'
		? Promise.resolve({ id: 'room1', invitationExists: true })
		: Promise.reject({ code: 'INTERNAL_ERROR', id: 'something-else' })) as never);
	renderNotification(true);

	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat.join }));
	await flushPromises();

	expect(vi.mocked(alert)).toHaveBeenCalledExactlyOnceWith({ type: 'error', text: i18n.ts.somethingHappened });
});

test('disables both actions until the pending request succeeds', async () => {
	let resolve!: () => void;
	api.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }) as never);
	renderNotification(true);
	await fireEvent.click(screen.getAllByRole('button')[0]);
	expect(screen.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled)).toBe(true);
	await fireEvent.click(screen.getAllByRole('button')[1]);
	expect(api).toHaveBeenCalledTimes(1);
	resolve();
	await flushPromises();
	expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test.each([[false], [true]])('says who invited, with or without the buttons (full: %s)', full => {
	const { container } = renderNotification(full, withOwner({ id: 'o2', username: 'sora', name: 'Sora Kim', host: 'far.example' }));

	expect(container.textContent).toContain(i18n.ts._chat.invitedBy);
	expect(container.textContent).toContain('Sora Kim');
	expect(container.textContent).toContain('@sora@far.example');
});

test('someone without a display name is not named twice', () => {
	const { container } = renderNotification(false, withOwner({ id: 'o3', username: 'sora', name: null, host: 'far.example' }));

	expect(container.textContent).toContain('@sora@far.example');
	expect(container.textContent?.match(/sora/g)).toHaveLength(1);
});

test('the name leads to who invited, and the room name still leads to the room', () => {
	const { container } = renderNotification(false, withOwner({ id: 'o2', username: 'sora', name: 'Sora Kim', host: 'far.example' }));

	const links = [...container.querySelectorAll('a')].map(a => a.getAttribute('href'));
	expect(links).toContain('/chat/room/room1');
	expect(links.some(href => href?.includes('@sora@far.example'))).toBe(true);
});

test('still says who invited after answering', async () => {
	api.mockResolvedValue({} as never);
	const { container } = renderNotification(true, withOwner({ id: 'o2', username: 'sora', name: 'Sora Kim', host: 'far.example' }));

	await fireEvent.click(screen.getByRole('button', { name: i18n.ts._chat.join }));
	await flushPromises();

	expect(container.textContent).toContain(i18n.ts._chat.invitationJoined);
	expect(container.textContent).toContain('Sora Kim');
});
