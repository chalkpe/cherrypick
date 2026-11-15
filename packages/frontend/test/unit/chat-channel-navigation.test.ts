/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({ api: vi.fn().mockResolvedValue([]), replace: vi.fn(), alert: vi.fn(), width: 400, me: { id: 'me', policies: { chatAvailability: 'available' } }, handlers: new Map<string, (data: unknown) => void>() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ replace: mocks.replace, replaceByPath: mocks.replace }) }));
vi.mock('@/os.js', () => ({ alert: mocks.alert }));
vi.mock('@/i.js', () => ({ ensureSignin: () => mocks.me }));
vi.mock('@/composables/use-element-width.js', () => ({ useElementWidth: () => ref(mocks.width) }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ useChannel: () => ({ on: (name: string, handler: (data: unknown) => void) => mocks.handlers.set(name, handler), dispose: vi.fn() }) }) }));
vi.mock('@/pages/chat/room.vue', () => ({ default: { props: ['roomId', 'channelId'], template: '<div data-testid="conversation">{{ roomId }}/{{ channelId }}</div>' } }));
vi.mock('@/pages/chat/room.info.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));

import Channels from '@/pages/chat/room.channels.vue';
import MkSuperMenu from '@/components/MkSuperMenu.vue';
import { i18n } from '@/i18n.js';

const room = { id: 'r', hasChannels: true, name: 'Group' };
const channels = [{ id: 'c1', roomId: 'r', name: 'First' }, { id: 'c2', roomId: 'r', name: 'Second' }];
const stubs = { PageWithHeader: { template: '<main><slot/></main>' }, MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' }, MkLoading: true, MkResult: true, MkAvatar: true };
beforeEach(() => { vi.clearAllMocks(); mocks.width = 400; mocks.me.policies.chatAvailability = 'available'; mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds: [], notificationChannelIds: [] } : channels); });
afterEach(cleanup);

test('opens a channel list at narrow width without fetching or reading a timeline', async () => {
	render(Channels, { props: { roomId: 'r' }, global: { stubs } });
	await screen.findByRole('link', { name: 'First' });

	expect(screen.getByRole('link', { name: 'Second' }).getAttribute('href')).toBe('/chat/room/r/channels/c2');
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
	await screen.findByRole('link', { name: 'Other channel' });
	finish(room);
	await Promise.resolve();

	expect(screen.queryByRole('link', { name: 'First' })).toBeNull();
	expect(mocks.replace).not.toHaveBeenCalled();
});

test('preserves the room-deleted notice while viewing the channel list', async () => {
	render(Channels, { props: { roomId: 'r' }, global: { stubs } });
	await screen.findByRole('link', { name: 'First' });
	mocks.handlers.get('roomDeleted')!(undefined);

	expect(mocks.alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.roomDeleted });
	expect(mocks.replace).toHaveBeenCalledWith('/chat');
});

test('preserves the removal notice while viewing the channel list', async () => {
	render(Channels, { props: { roomId: 'r' }, global: { stubs } });
	await screen.findByRole('link', { name: 'First' });
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
	const second = await screen.findByRole('link', { name: 'Second' });
	await waitFor(() => expect(second.querySelector('.itemIndicator')).not.toBeNull());
	expect(screen.getByRole('link', { name: 'First' }).querySelector('.itemIndicator')).toBeNull();
	unread = [];
	mocks.handlers.get('chatUnread')!({ version: 1 });
	await waitFor(() => expect(second.querySelector('.itemIndicator')).toBeNull());
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
	await screen.findByRole('link', { name: 'First' });
	await waitFor(() => expect(finish).toBeTypeOf('function'));
	await view.rerender({ roomId: 'other' });
	const other = await screen.findByRole('link', { name: 'Other channel' });
	finish({ unreadChannelIds: ['oc'], notificationChannelIds: ['oc'] });
	await Promise.resolve();
	expect(other.querySelector('.itemIndicator')).toBeNull();
});

const ownedRoom = { ...room, ownerId: 'me' };

function mockRoom(roomValue: unknown, unreadChannelIds: string[] = []) {
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? roomValue : endpoint === 'chat/rooms/unread' ? { unreadChannelIds, notificationChannelIds: [] } : channels);
}

function railDragSource(link: HTMLElement): HTMLElement {
	return link.parentElement!.querySelector('[draggable="true"]') as HTMLElement;
}

function railDropAreaOf(link: HTMLElement, side: 'forward' | 'backward'): HTMLElement {
	const item = link.parentElement!.parentElement!.parentElement!;
	return (side === 'forward' ? item.firstElementChild : item.lastElementChild) as HTMLElement;
}

test('owner reorders rail channels by dragging and keeps the conversation address', async () => {
	mocks.width = 1000;
	mockRoom(ownedRoom);
	render(Channels, { props: { roomId: 'r', channelId: 'c1' }, global: { stubs } });
	const first = await screen.findByRole('link', { name: 'First' });
	const second = screen.getByRole('link', { name: 'Second' });
	expect(first.getAttribute('href')).toBe('/chat/room/r/channels/c1');

	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(railDragSource(first), { dataTransfer });
	await fireEvent.drop(railDropAreaOf(second, 'backward'), { dataTransfer });
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/reorder', { roomId: 'r', channelIds: ['c2', 'c1'] }));
});

test('rail channels are draggable for the owner but not for other members', async () => {
	mocks.width = 1000;
	mockRoom(ownedRoom);
	const ownerView = render(Channels, { props: { roomId: 'r', channelId: 'c1' }, global: { stubs } });
	const ownerLink = await screen.findByRole('link', { name: 'First' });
	expect(railDragSource(ownerLink)).not.toBeNull();
	expect(ownerLink.getAttribute('draggable')).toBe('false');
	ownerView.unmount();

	mockRoom({ ...room, ownerId: 'other' });
	render(Channels, { props: { roomId: 'r', channelId: 'c1' }, global: { stubs } });
	const memberLink = await screen.findByRole('link', { name: 'First' });
	expect(memberLink.closest('[draggable="true"]')).toBeNull();
});

test('keeps unread and current-channel markers on the right channels after a drag', async () => {
	mocks.width = 1000;
	mockRoom(ownedRoom, ['c2']);
	render(Channels, { props: { roomId: 'r', channelId: 'c1' }, global: { stubs } });
	const first = await screen.findByRole('link', { name: 'First' });
	const second = screen.getByRole('link', { name: 'Second' });
	await waitFor(() => expect(second.querySelector('.itemIndicator')).not.toBeNull());
	expect(first.className).toContain('active');

	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(railDragSource(first), { dataTransfer });
	await fireEvent.drop(railDropAreaOf(second, 'backward'), { dataTransfer });
	await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('chat/rooms/channels/reorder', { roomId: 'r', channelIds: ['c2', 'c1'] }));

	await waitFor(() => {
		const links = screen.getAllByRole('link');
		expect(links[0].textContent).toContain('Second');
		expect(links[0].querySelector('.itemIndicator')).not.toBeNull();
		expect(links[1].textContent).toContain('First');
		expect(links[1].className).toContain('active');
	});
});

test('restores the server order and alerts when a rail drag reorder fails', async () => {
	mocks.width = 1000;
	mocks.api.mockImplementation(async (endpoint: string) => {
		if (endpoint === 'chat/rooms/show') return ownedRoom;
		if (endpoint === 'chat/rooms/unread') return { unreadChannelIds: [], notificationChannelIds: [] };
		if (endpoint === 'chat/rooms/channels/reorder') throw new Error('reorder failed');
		return channels;
	});
	render(Channels, { props: { roomId: 'r', channelId: 'c1' }, global: { stubs } });
	const first = await screen.findByRole('link', { name: 'First' });
	const second = screen.getByRole('link', { name: 'Second' });

	const listCallsBefore = mocks.api.mock.calls.filter(call => call[0] === 'chat/rooms/channels/list').length;
	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(railDragSource(first), { dataTransfer });
	await fireEvent.drop(railDropAreaOf(second, 'backward'), { dataTransfer });
	await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith({ type: 'error', text: i18n.ts._chat.actionFailed }));
	await waitFor(() => expect(mocks.api.mock.calls.filter(call => call[0] === 'chat/rooms/channels/list').length).toBeGreaterThan(listCallsBefore));
	await waitFor(() => {
		const links = screen.getAllByRole('link');
		expect(links[0].textContent).toContain('First');
		expect(links[1].textContent).toContain('Second');
	});
});

test('does not offer rail dragging for an archived room or without chat availability', async () => {
	mocks.width = 1000;
	mockRoom({ ...ownedRoom, isArchived: true });
	const archived = render(Channels, { props: { roomId: 'r', channelId: 'c1' }, global: { stubs } });
	await screen.findByRole('link', { name: 'First' });
	expect(screen.queryAllByRole('button', { name: i18n.ts.dragToReorder })).toHaveLength(0);
	archived.unmount();

	mocks.me.policies.chatAvailability = 'unavailable';
	mockRoom(ownedRoom);
	render(Channels, { props: { roomId: 'r', channelId: 'c1' }, global: { stubs } });
	await screen.findByRole('link', { name: 'First' });
	expect(screen.queryAllByRole('button', { name: i18n.ts.dragToReorder })).toHaveLength(0);
});

test('does not offer rail dragging while a reorder is in flight', async () => {
	mocks.width = 1000;
	let finish!: () => void;
	mocks.api.mockImplementation(async (endpoint: string) => {
		if (endpoint === 'chat/rooms/show') return ownedRoom;
		if (endpoint === 'chat/rooms/unread') return { unreadChannelIds: [], notificationChannelIds: [] };
		if (endpoint === 'chat/rooms/channels/reorder') return new Promise<void>(resolve => { finish = resolve; });
		return channels;
	});
	render(Channels, { props: { roomId: 'r', channelId: 'c1' }, global: { stubs } });
	const first = await screen.findByRole('link', { name: 'First' });
	const second = screen.getByRole('link', { name: 'Second' });

	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(railDragSource(first), { dataTransfer });
	await fireEvent.drop(railDropAreaOf(second, 'backward'), { dataTransfer });
	await waitFor(() => expect(screen.queryAllByRole('button', { name: i18n.ts.dragToReorder })).toHaveLength(0));
	finish();
	await waitFor(() => expect(screen.getAllByRole('button', { name: i18n.ts.dragToReorder })).toHaveLength(2));
});

test('shows the narrow channel list as the settings-style menu grid', async () => {
	render(Channels, { props: { roomId: 'r' }, global: { stubs } });
	const first = await screen.findByRole('link', { name: 'First' });
	expect(first.closest('.rrevdjwu')?.classList.contains('grid')).toBe(true);
});

test('shows the wide rail as a menu without the grid layout', async () => {
	mocks.width = 1000;
	mockRoom({ ...room, ownerId: 'other' });
	render(Channels, { props: { roomId: 'r', channelId: 'c1' }, global: { stubs } });
	const first = await screen.findByRole('link', { name: 'First' });
	const menu = first.closest('.rrevdjwu');
	expect(menu?.classList.contains('grid')).toBe(false);
	expect(menu?.closest('aside')).not.toBeNull();
});

test('super menu renders plain items without drag handles by default', () => {
	render(MkSuperMenu, { props: { def: [{ items: [{ id: 'a', to: '/a', icon: 'ti ti-hash', text: 'A' }] }] }, global: { stubs } });
	expect(screen.getByRole('link', { name: 'A' })).toBeTruthy();
	expect(document.querySelector('[draggable="true"]')).toBeNull();
});

test('super menu emits the reordered items when dragging is enabled', async () => {
	const items = [{ id: 'a', to: '/a', icon: 'ti ti-hash', text: 'A' }, { id: 'b', to: '/b', icon: 'ti ti-hash', text: 'B' }];
	const view = render(MkSuperMenu, { props: { def: [{ items }], draggable: true }, global: { stubs } });
	const links = screen.getAllByRole('link');

	const dataTransfer = new DataTransfer();
	await fireEvent.dragStart(links[0].parentElement!.querySelector('[draggable="true"]')!, { dataTransfer });
	const item = links[1].parentElement!.parentElement!.parentElement!;
	await fireEvent.drop(item.lastElementChild!, { dataTransfer });
	expect(view.emitted('reorder')).toEqual([[0, [items[1], items[0]]]]);
});

test('blinks unread dots only for notification targets in the member rail', async () => {
	mocks.width = 1000;
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? { ...room, ownerId: 'other' } : endpoint === 'chat/rooms/unread' ? { unreadChannelIds: ['c1', 'c2'], notificationChannelIds: ['c1'] } : channels);
	render(Channels, { props: { roomId: 'r', channelId: 'c1' }, global: { stubs } });
	const first = await screen.findByRole('link', { name: 'First' });
	await waitFor(() => expect(first.querySelector('.itemIndicator')).not.toBeNull());
	expect(first.querySelector('.itemIndicator')!.classList.contains('_blink')).toBe(true);
	const second = screen.getByRole('link', { name: 'Second' });
	await waitFor(() => expect(second.querySelector('.itemIndicator')).not.toBeNull());
	expect(second.querySelector('.itemIndicator')!.classList.contains('_blink')).toBe(false);
});

test('keeps mention-only unread dots static and marks the current channel in the drag rail', async () => {
	mocks.width = 1000;
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? ownedRoom : endpoint === 'chat/rooms/unread' ? { unreadChannelIds: ['c2'], notificationChannelIds: [] } : channels);
	render(Channels, { props: { roomId: 'r', channelId: 'c1' }, global: { stubs } });
	const first = await screen.findByRole('link', { name: 'First' });
	const second = screen.getByRole('link', { name: 'Second' });
	await waitFor(() => expect(second.querySelector('.itemIndicator')).not.toBeNull());
	expect(second.querySelector('.itemIndicator')!.classList.contains('_blink')).toBe(false);
	expect(first.getAttribute('aria-current')).toBe('page');
	expect(second.getAttribute('aria-current')).toBeNull();
});

test('marks the current channel link with aria-current in the member rail', async () => {
	mocks.width = 1000;
	mockRoom({ ...room, ownerId: 'other' });
	render(Channels, { props: { roomId: 'r', channelId: 'c2' }, global: { stubs } });
	const second = await screen.findByRole('link', { name: 'Second' });
	expect(second.getAttribute('aria-current')).toBe('page');
	expect(screen.getByRole('link', { name: 'First' }).getAttribute('aria-current')).toBeNull();
});

test('shows static unread dots for mention-only channels in the narrow grid', async () => {
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds: ['c2'], notificationChannelIds: [] } : channels);
	render(Channels, { props: { roomId: 'r' }, global: { stubs } });
	const second = await screen.findByRole('link', { name: 'Second' });
	await waitFor(() => expect(second.querySelector('.itemIndicator')).not.toBeNull());
	expect(second.querySelector('.itemIndicator')!.classList.contains('_blink')).toBe(false);
});

test('super menu blinks indicated items by default and leaves aria-current unset', () => {
	render(MkSuperMenu, { props: { def: [{ items: [{ id: 'a', to: '/a', icon: 'ti ti-hash', text: 'A', indicated: true }] }] }, global: { stubs } });
	const link = screen.getByRole('link', { name: 'A' });
	expect(link.querySelector('.itemIndicator')!.classList.contains('_blink')).toBe(true);
	expect(link.getAttribute('aria-current')).toBeNull();
});

test('super menu shows a static dot when pulsing is off and passes aria-current through', () => {
	render(MkSuperMenu, { props: { def: [{ items: [{ id: 'a', to: '/a', icon: 'ti ti-hash', text: 'A', indicated: true, pulsing: false, ariaCurrent: 'page' }] }] }, global: { stubs } });
	const link = screen.getByRole('link', { name: 'A' });
	expect(link.querySelector('.itemIndicator')!.classList.contains('_blink')).toBe(false);
	expect(link.getAttribute('aria-current')).toBe('page');
});

test('super menu keeps static dots and aria-current in drag mode', () => {
	render(MkSuperMenu, { props: { def: [{ items: [{ id: 'a', to: '/a', icon: 'ti ti-hash', text: 'A', indicated: true, pulsing: false, ariaCurrent: 'page' }, { id: 'b', to: '/b', icon: 'ti ti-hash', text: 'B', indicated: true }] }], draggable: true }, global: { stubs } });
	const links = screen.getAllByRole('link');
	expect(links[0].querySelector('.itemIndicator')!.classList.contains('_blink')).toBe(false);
	expect(links[0].getAttribute('aria-current')).toBe('page');
	expect(links[1].querySelector('.itemIndicator')!.classList.contains('_blink')).toBe(true);
	expect(links[1].getAttribute('aria-current')).toBeNull();
});
