/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/vue';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({ api: vi.fn().mockResolvedValue([]), replace: vi.fn(), alert: vi.fn(), width: 400, handlers: new Map<string, (data: unknown) => void>() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ replace: mocks.replace, replaceByPath: mocks.replace }) }));
vi.mock('@/os.js', () => ({ alert: mocks.alert }));
vi.mock('@/i.js', () => ({ ensureSignin: () => ({ id: 'me' }) }));
vi.mock('@/composables/use-element-width.js', () => ({ useElementWidth: () => ref(mocks.width) }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ useChannel: () => ({ on: (name: string, handler: (data: unknown) => void) => mocks.handlers.set(name, handler), dispose: vi.fn() }) }) }));
vi.mock('@/pages/chat/room.vue', () => ({ default: { props: ['roomId', 'channelId'], template: '<div data-testid="conversation">{{ roomId }}/{{ channelId }}</div>' } }));
vi.mock('@/pages/chat/room.info.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));

import Channels from '@/pages/chat/room.channels.vue';
import { i18n } from '@/i18n.js';

const room = { id: 'r', hasChannels: true, name: 'Group' };
const channels = [{ id: 'c1', roomId: 'r', name: 'First' }, { id: 'c2', roomId: 'r', name: 'Second' }];
const stubs = { PageWithHeader: { template: '<main><slot/></main>' }, MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' }, MkLoading: true, MkResult: true, MkAvatar: true };
beforeEach(() => { vi.clearAllMocks(); mocks.width = 400; mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds: [], notificationChannelIds: [] } : channels); });
afterEach(cleanup);

test('opens a channel list at narrow width without fetching or reading a timeline', async () => {
	render(Channels, { props: { roomId: 'r' }, global: { stubs } });
	await screen.findByRole('link', { name: '#First' });

	expect(screen.getByRole('link', { name: '#Second' }).getAttribute('href')).toBe('/chat/room/r/channels/c2');
	expect(mocks.api.mock.calls.map(call => call[0])).toEqual(['chat/rooms/show', 'chat/rooms/channels/list', 'chat/rooms/unread']);
	expect(mocks.replace).not.toHaveBeenCalled();
});

test('keeps direct addresses and redirects deleted channels to the first remaining one', async () => {
	const view = render(Channels, { props: { roomId: 'r', channelId: 'c2' }, global: { stubs } });
	await screen.findByText('r/c2');
	expect(mocks.replace).not.toHaveBeenCalled();
	await view.rerender({ roomId: 'r', channelId: 'gone' });

	await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/chat/room/r/channels/c1'));
	expect(mocks.alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat._channels.deletedNotice });
});

test('shows the rail on a wide page and opens its first conversation', async () => {
	mocks.width = 1000;
	render(Channels, { props: { roomId: 'r' }, global: { stubs } });

	await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/chat/room/r/channels/c1'));
});

test('discards an old room response after navigating to another group', async () => {
	let finish!: (value: unknown) => void;
	mocks.api.mockImplementation((endpoint: string, params: { roomId: string }) => {
		if (endpoint === 'chat/rooms/unread') return Promise.resolve({ unreadChannelIds: [], notificationChannelIds: [] });
		if (params.roomId === 'r' && endpoint === 'chat/rooms/show') return new Promise(resolve => { finish = resolve; });
		return Promise.resolve(endpoint === 'chat/rooms/show' ? { id: 'other', hasChannels: true, name: 'Other' } : [{ id: 'oc', roomId: 'other', name: 'Other channel' }]);
	});
	const view = render(Channels, { props: { roomId: 'r' }, global: { stubs } });
	await view.rerender({ roomId: 'other' });
	await screen.findByRole('link', { name: '#Other channel' });
	finish(room);
	await Promise.resolve();

	expect(screen.queryByRole('link', { name: '#First' })).toBeNull();
	expect(mocks.replace).not.toHaveBeenCalled();
});

test('preserves the room-deleted notice while viewing the channel list', async () => {
	render(Channels, { props: { roomId: 'r' }, global: { stubs } });
	await screen.findByRole('link', { name: '#First' });
	mocks.handlers.get('roomDeleted')!(undefined);

	expect(mocks.alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.roomDeleted });
	expect(mocks.replace).toHaveBeenCalledWith('/chat');
});

test('preserves the removal notice while viewing the channel list', async () => {
	render(Channels, { props: { roomId: 'r' }, global: { stubs } });
	await screen.findByRole('link', { name: '#First' });
	mocks.handlers.get('membershipEnded')!({ userId: 'me' });

	expect(mocks.alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.removedFromRoom });
	expect(mocks.replace).toHaveBeenCalledWith('/chat');
});

test('lets the conversation handle room closure without a duplicate navigation', async () => {
	render(Channels, { props: { roomId: 'r', channelId: 'c2' }, global: { stubs } });
	await screen.findByText('r/c2');
	mocks.handlers.get('roomDeleted')!(undefined);

	expect(mocks.replace).not.toHaveBeenCalled();
});

test('shows static unread channels from the shared API and refreshes after read events', async () => {
	let unread = ['c2'];
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds: unread, notificationChannelIds: ['c1'] } : channels);
	render(Channels, { props: { roomId: 'r' }, global: { stubs } });
	const second = await screen.findByRole('link', { name: '#Second' });
	await waitFor(() => expect(second.className).toContain('unread'));
	expect(screen.getByRole('link', { name: '#First' }).className).not.toContain('unread');
	unread = [];
	mocks.handlers.get('chatUnread')!({ version: 1 });
	await waitFor(() => expect(second.className).not.toContain('unread'));
	expect(mocks.api.mock.calls.some(([endpoint]) => endpoint.includes('timeline') || endpoint === 'chat/rooms/read')).toBe(false);
});

test('does not apply another group’s late unread response', async () => {
	let finish!: (value: unknown) => void;
	mocks.api.mockImplementation((endpoint: string, params: { roomId: string }) => {
		if (endpoint === 'chat/rooms/unread') return params.roomId === 'r' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ unreadChannelIds: [], notificationChannelIds: [] });
		if (endpoint === 'chat/rooms/show') return Promise.resolve(params.roomId === 'r' ? room : { id: 'other', hasChannels: true, name: 'Other' });
		return Promise.resolve(params.roomId === 'r' ? channels : [{ id: 'oc', roomId: 'other', name: 'Other channel' }]);
	});
	const view = render(Channels, { props: { roomId: 'r' }, global: { stubs } });
	await screen.findByRole('link', { name: '#First' });
	await waitFor(() => expect(finish).toBeTypeOf('function'));
	await view.rerender({ roomId: 'other' });
	const other = await screen.findByRole('link', { name: '#Other channel' });
	finish({ unreadChannelIds: ['oc'], notificationChannelIds: ['oc'] });
	await Promise.resolve();
	expect(other.className).not.toContain('unread');
});
