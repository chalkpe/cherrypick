/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { ref } from 'vue';

const mocks = vi.hoisted(() => {
	type Handler = (data: unknown) => void;
	type RouteLike = { route: { path: string }; props: Map<string, string> };
	const connections: { channel: string; params: unknown; handlers: Map<string, Handler>; disposed: boolean }[] = [];
	const streamHandlers = new Map<string, Set<Handler>>();
	// 서버가 현재 가진 채널. 재연결 때 이 목록에 없는 채널의 구독은 실제 서버처럼 거부(NO_SUCH_CHANNEL)해 확인을 보내지 않는다.
	let serverChannelIds = ['c1', 'c2'];
	let routerRef: { value: RouteLike } | null = null;
	const channelsRoute = (roomId: string, channelId?: string): RouteLike => ({
		route: { path: '/chat/room/:roomId/channels/:channelId?' },
		props: new Map(channelId != null ? [['roomId', roomId], ['channelId', channelId]] : [['roomId', roomId]]),
	});
	return {
		api: vi.fn().mockResolvedValue([]), replace: vi.fn(), alert: vi.fn(), width: 400,
		me: { id: 'me', policies: { chatAvailability: 'available' } },
		handlers: new Map<string, Handler>(),
		connections,
		streamHandlers,
		preferS: { 'experimental.stackingRouterView': false } as Record<string, boolean>,
		setServerChannelIds(ids: string[]) { serverChannelIds = ids; },
		bindRouter(ref: { value: RouteLike }) { routerRef = ref; },
		// 라우트 이동은 currentRef로 반영한다. 스택 라우터처럼 인스턴스는 마운트된 채 남는다.
		navigate(roomId: string, channelId?: string) { routerRef!.value = channelsRoute(roomId, channelId); },
		navigateAway() { routerRef!.value = { route: { path: '/settings' }, props: new Map() }; },
		// 연결 복구(_connected_)를 먼저 알리고, 서버가 승인하는 구독에만 확인(_subscribed_)을 보낸다.
		reconnect() {
			for (const handler of streamHandlers.get('_connected_') ?? []) handler(undefined);
			for (const connection of connections) {
				if (connection.disposed || connection.params == null) continue;
				const channelId = (connection.params as { channelId?: string }).channelId;
				if (channelId != null && !serverChannelIds.includes(channelId)) continue;
				connection.handlers.get('_subscribed_')?.(undefined);
			}
		},
	};
});
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/router.js', () => {
	const currentRef = ref({ route: { path: '/chat/room/:roomId/channels/:channelId?' }, props: new Map([['roomId', 'r']]) });
	mocks.bindRouter(currentRef);
	return { useRouter: () => ({ replace: mocks.replace, replaceByPath: mocks.replace, pushByPath: mocks.replace, currentRef }) };
});
vi.mock('@/preferences.js', () => ({ prefer: { s: mocks.preferS } }));
vi.mock('@/os.js', () => ({ alert: mocks.alert }));
vi.mock('@/i.js', () => ({ ensureSignin: () => mocks.me }));
vi.mock('@/composables/use-element-width.js', () => ({ useElementWidth: () => ref(mocks.width) }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ useChannel: (channel: string, params?: unknown) => {
	const handlers = new Map<string, (data: unknown) => void>();
	const connection = { channel, params, handlers, disposed: false };
	mocks.connections.push(connection);
	return {
		on: (name: string, handler: (data: unknown) => void) => { handlers.set(name, handler); mocks.handlers.set(name, handler); },
		dispose: () => { connection.disposed = true; },
	};
},
on: (name: string, handler: (data: unknown) => void) => {
	let handlers = mocks.streamHandlers.get(name);
	if (!handlers) { handlers = new Set(); mocks.streamHandlers.set(name, handlers); }
	handlers.add(handler);
},
off: (name: string, handler: (data: unknown) => void) => { mocks.streamHandlers.get(name)?.delete(handler); },
}) }));
vi.mock('@/pages/chat/room.vue', () => ({ default: { props: ['roomId', 'channelId'], template: '<div data-testid="conversation">{{ roomId }}/{{ channelId }}</div>' } }));
vi.mock('@/pages/chat/room.info.vue', () => ({ default: { template: '<div/>' } }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));

import Channels from '@/pages/chat/room.channels.vue';
import MkSuperMenu from '@/components/MkSuperMenu.vue';
import { i18n } from '@/i18n.js';

const room = { id: 'r', hasChannels: true, name: 'Group' };
const channels = [{ id: 'c1', roomId: 'r', name: 'First' }, { id: 'c2', roomId: 'r', name: 'Second' }];
const stubs = { PageWithHeader: { template: '<main><slot/></main>' }, MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' }, MkLoading: true, MkResult: true, MkAvatar: true };
beforeEach(() => { vi.clearAllMocks(); mocks.width = 400; mocks.connections.length = 0; mocks.streamHandlers.clear(); mocks.setServerChannelIds(['c1', 'c2']); mocks.me.policies.chatAvailability = 'available'; mocks.preferS['experimental.stackingRouterView'] = false; mocks.navigate('r'); mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds: [], notificationChannelIds: [] } : channels); });
afterEach(cleanup);

// 라우트는 렌더하는 목록의 경로와 맞춰 준다(실제 라우터처럼 경로가 props를 결정한다).
function renderChannels(props: { roomId: string; channelId?: string }) {
	mocks.navigate(props.roomId, props.channelId);
	return render(Channels, { props, global: { stubs } });
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function roomDeletedError() {
	const err = new Error('room deleted') as Error & { code: string };
	err.code = 'ROOM_DELETED';
	return err;
}

test('opens a channel list at narrow width without fetching or reading a timeline', async () => {
	renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });

	expect(screen.getByRole('link', { name: 'Second' }).getAttribute('href')).toBe('/chat/room/r/channels/c2');
	expect(mocks.api.mock.calls.map(call => call[0])).toEqual(['chat/rooms/show', 'chat/rooms/channels/list', 'chat/rooms/unread']);
	expect(mocks.replace).not.toHaveBeenCalled();
});

test('keeps direct addresses and redirects deleted channels to the first remaining one', async () => {
	const view = renderChannels({ roomId: 'r', channelId: 'c2' });
	await screen.findByText('r/c2');
	expect(mocks.replace).not.toHaveBeenCalled();
	mocks.navigate('r', 'gone');
	await view.rerender({ roomId: 'r', channelId: 'gone' });

	await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/chat/room/r/channels/c1'));
	expect(mocks.alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat._channels.deletedNotice });
});

test('shows the rail on a wide page and opens its first conversation', async () => {
	mocks.width = 1000;
	renderChannels({ roomId: 'r' });

	await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/chat/room/r/channels/c1'));
});

test('discards an old room response after navigating to another group', async () => {
	let finish!: (value: unknown) => void;
	mocks.api.mockImplementation((endpoint: string, params: { roomId: string }) => {
		if (endpoint === 'chat/rooms/unread') return Promise.resolve({ unreadChannelIds: [], notificationChannelIds: [] });
		if (params.roomId === 'r' && endpoint === 'chat/rooms/show') return new Promise(resolve => { finish = resolve; });
		return Promise.resolve(endpoint === 'chat/rooms/show' ? { id: 'other', hasChannels: true, name: 'Other' } : [{ id: 'oc', roomId: 'other', name: 'Other channel' }]);
	});
	const view = renderChannels({ roomId: 'r' });
	mocks.navigate('other');
	await view.rerender({ roomId: 'other' });
	await screen.findByRole('link', { name: 'Other channel' });
	finish(room);
	await Promise.resolve();

	expect(screen.queryByRole('link', { name: 'First' })).toBeNull();
	expect(mocks.replace).not.toHaveBeenCalled();
});

test('preserves the room-deleted notice while viewing the channel list', async () => {
	renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });
	mocks.handlers.get('roomDeleted')!(undefined);

	expect(mocks.alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.roomDeleted });
	expect(mocks.replace).toHaveBeenCalledWith('/chat');
});

test('preserves the removal notice while viewing the channel list', async () => {
	renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });
	mocks.handlers.get('membershipEnded')!({ userId: 'me' });

	expect(mocks.alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.removedFromRoom });
	expect(mocks.replace).toHaveBeenCalledWith('/chat');
});

test('lets the conversation handle room closure without a duplicate navigation', async () => {
	renderChannels({ roomId: 'r', channelId: 'c2' });
	await screen.findByText('r/c2');
	mocks.handlers.get('roomDeleted')!(undefined);

	expect(mocks.replace).not.toHaveBeenCalled();
});

test('shows static unread channels from the shared API and refreshes after read events', async () => {
	let unread = ['c2'];
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds: unread, notificationChannelIds: ['c1'] } : channels);
	renderChannels({ roomId: 'r' });
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
	const view = renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });
	await waitFor(() => expect(finish).toBeTypeOf('function'));
	mocks.navigate('other');
	await view.rerender({ roomId: 'other' });
	const other = await screen.findByRole('link', { name: 'Other channel' });
	finish({ unreadChannelIds: ['oc'], notificationChannelIds: ['oc'] });
	await Promise.resolve();
	expect(other.querySelector('.itemIndicator')).toBeNull();
});

test('re-reads unread markers after the stream reconnects on the narrow channel list', async () => {
	let unreadChannelIds: string[] = [];
	let notificationChannelIds: string[] = [];
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds, notificationChannelIds } : channels);
	renderChannels({ roomId: 'r' });
	const second = await screen.findByRole('link', { name: 'Second' });
	await waitFor(() => expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(1));
	expect(second.querySelector('.itemIndicator')).toBeNull();

	// 연결이 끊긴 동안 다른 계정이 멘션만 받는 채널에 멘션을 만들었다.
	unreadChannelIds = ['c2'];
	notificationChannelIds = ['c2'];
	mocks.reconnect();

	await waitFor(() => expect(second.querySelector('.itemIndicator')).not.toBeNull());
	expect(second.querySelector('.itemIndicator')!.classList.contains('_blink')).toBe(true);
});

test('clears unread markers after the stream reconnects when another device read them', async () => {
	let unreadChannelIds = ['c2'];
	let notificationChannelIds = ['c2'];
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds, notificationChannelIds } : channels);
	renderChannels({ roomId: 'r' });
	const second = await screen.findByRole('link', { name: 'Second' });
	await waitFor(() => expect(second.querySelector('.itemIndicator')).not.toBeNull());
	expect(second.querySelector('.itemIndicator')!.classList.contains('_blink')).toBe(true);

	// 끊긴 동안 다른 기기에서 읽었다.
	unreadChannelIds = [];
	notificationChannelIds = [];
	mocks.reconnect();

	await waitFor(() => expect(second.querySelector('.itemIndicator')).toBeNull());
});

test('re-reads unread markers after the stream reconnects in the wide rail', async () => {
	mocks.width = 1000;
	let unreadChannelIds: string[] = [];
	let notificationChannelIds: string[] = [];
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? { ...room, ownerId: 'other' } : endpoint === 'chat/rooms/unread' ? { unreadChannelIds, notificationChannelIds } : channels);
	renderChannels({ roomId: 'r', channelId: 'c1' });
	const second = await screen.findByRole('link', { name: 'Second' });
	await waitFor(() => expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(1));
	expect(second.querySelector('.itemIndicator')).toBeNull();

	unreadChannelIds = ['c2'];
	notificationChannelIds = ['c2'];
	mocks.reconnect();

	await waitFor(() => expect(second.querySelector('.itemIndicator')).not.toBeNull());
	expect(second.querySelector('.itemIndicator')!.classList.contains('_blink')).toBe(true);
});

test('re-reads the list and unread markers after the stream reconnects when the subscribed channel was deleted', async () => {
	let list = channels;
	let unreadChannelIds: string[] = [];
	let notificationChannelIds: string[] = [];
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds, notificationChannelIds } : list);
	renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });
	await screen.findByRole('link', { name: 'Second' });
	await waitFor(() => expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(1));

	// 끊긴 동안 그룹장이 구독 기준인 맨 위 채널을 삭제하고, 남은 채널에 멘션이 도착했다.
	list = [channels[1]];
	mocks.setServerChannelIds(['c2']);
	unreadChannelIds = ['c2'];
	notificationChannelIds = ['c2'];
	mocks.reconnect();

	await waitFor(() => expect(screen.queryByRole('link', { name: 'First' })).toBeNull());
	await waitFor(() => expect(screen.getByRole('link', { name: 'Second' }).querySelector('.itemIndicator')?.classList.contains('_blink')).toBe(true));
	// 재연결 한 번에 다시 읽기는 한 번이고, 구독 대상은 남은 채널로 다시 고른다.
	expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(2);
	const live = mocks.connections.filter(connection => !connection.disposed && connection.channel === 'chatRoom');
	expect(live.at(-1)?.params).toEqual({ roomId: 'r', channelId: 'c2' });
});

test('re-reads the rail list and unread markers after the stream reconnects when the subscribed channel was deleted', async () => {
	mocks.width = 1000;
	let list = channels;
	let unreadChannelIds: string[] = [];
	let notificationChannelIds: string[] = [];
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? { ...room, ownerId: 'other' } : endpoint === 'chat/rooms/unread' ? { unreadChannelIds, notificationChannelIds } : list);
	renderChannels({ roomId: 'r', channelId: 'c2' });
	await screen.findByText('r/c2');
	await screen.findByRole('link', { name: 'Second' });
	await waitFor(() => expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(1));

	// 끊긴 동안 구독 기준인 맨 위 채널이 삭제되고, 보고 있는 채널에 멘션이 도착했다.
	list = [channels[1]];
	mocks.setServerChannelIds(['c2']);
	unreadChannelIds = ['c2'];
	notificationChannelIds = ['c2'];
	mocks.reconnect();

	await waitFor(() => expect(screen.queryByRole('link', { name: 'First' })).toBeNull());
	await waitFor(() => expect(screen.getByRole('link', { name: 'Second' }).querySelector('.itemIndicator')?.classList.contains('_blink')).toBe(true));
	expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(2);
	const live = mocks.connections.filter(connection => !connection.disposed && connection.channel === 'chatRoom');
	expect(live.at(-1)?.params).toEqual({ roomId: 'r', channelId: 'c2' });
});

test('stops re-reading on reconnect after the list unmounts', async () => {
	const view = renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });
	await waitFor(() => expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(1));
	view.unmount();
	const callsAfterUnmount = mocks.api.mock.calls.length;

	mocks.reconnect();
	await Promise.resolve();

	expect(mocks.api.mock.calls.length).toBe(callsAfterUnmount);
});

test('stops re-reading on reconnect while the list is deactivated and resumes on activation', async () => {
	const wrapper = { props: ['show'], components: { Channels }, template: '<KeepAlive><Channels v-if="show" roomId="r"/></KeepAlive>' };
	const view = render(wrapper, { props: { show: true }, global: { stubs } });
	await screen.findByRole('link', { name: 'First' });
	await waitFor(() => expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(1));
	await view.rerender({ show: false });
	const callsAfterDeactivate = mocks.api.mock.calls.length;

	mocks.reconnect();
	await Promise.resolve();
	expect(mocks.api.mock.calls.length).toBe(callsAfterDeactivate);

	await view.rerender({ show: true });
	await screen.findByRole('link', { name: 'First' });
	await waitFor(() => expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread').length).toBeGreaterThan(1));
});

test('does not re-read or navigate on reconnect while the list is behind another screen in the stacking router', async () => {
	mocks.preferS['experimental.stackingRouterView'] = true;
	renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });
	await waitFor(() => expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(1));

	// 설정 화면으로 이동해 목록을 스택 뒤에 남긴다. 인스턴스는 마운트된 채 유지된다.
	mocks.navigateAway();
	mocks.api.mockImplementation(async (endpoint: string) => {
		if (endpoint === 'chat/rooms/show') throw roomDeletedError();
		return endpoint === 'chat/rooms/unread' ? { unreadChannelIds: [], notificationChannelIds: [] } : channels;
	});
	const callsAfterNavigate = mocks.api.mock.calls.length;

	mocks.reconnect();
	await flush();

	expect(mocks.api.mock.calls.length).toBe(callsAfterNavigate);
	expect(mocks.replace).not.toHaveBeenCalled();
	expect(mocks.alert).not.toHaveBeenCalled();
});

test('does not re-read on reconnect while the rail is behind another screen in the stacking router', async () => {
	mocks.width = 1000;
	mocks.preferS['experimental.stackingRouterView'] = true;
	renderChannels({ roomId: 'r', channelId: 'c2' });
	await screen.findByText('r/c2');
	await waitFor(() => expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(1));
	mocks.navigateAway();
	const callsAfterNavigate = mocks.api.mock.calls.length;

	mocks.reconnect();
	await flush();

	expect(mocks.api.mock.calls.length).toBe(callsAfterNavigate);
	expect(mocks.replace).not.toHaveBeenCalled();
	expect(mocks.alert).not.toHaveBeenCalled();
});

test('reads the latest state and handles the deleted room when returning to the front in the stacking router', async () => {
	mocks.preferS['experimental.stackingRouterView'] = true;
	renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });
	mocks.navigateAway();
	mocks.api.mockImplementation(async (endpoint: string) => {
		if (endpoint === 'chat/rooms/show') throw roomDeletedError();
		return endpoint === 'chat/rooms/unread' ? { unreadChannelIds: [], notificationChannelIds: [] } : channels;
	});
	mocks.reconnect();
	await flush();
	expect(mocks.replace).not.toHaveBeenCalled();

	// 목록이 현재 경로로 돌아오면 그때 최신 상태를 읽어 삭제를 처리한다.
	mocks.navigate('r');
	await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.roomDeleted }));
	expect(mocks.replace).toHaveBeenCalledWith('/chat');
});

test('re-reads the list when returning to the front in the stacking router', async () => {
	mocks.preferS['experimental.stackingRouterView'] = true;
	let unreadChannelIds: string[] = [];
	let notificationChannelIds: string[] = [];
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds, notificationChannelIds } : channels);
	renderChannels({ roomId: 'r' });
	const second = await screen.findByRole('link', { name: 'Second' });
	await waitFor(() => expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(1));

	mocks.navigateAway();
	unreadChannelIds = ['c2'];
	notificationChannelIds = ['c2'];
	const callsAway = mocks.api.mock.calls.length;
	mocks.reconnect();
	await flush();
	expect(mocks.api.mock.calls.length).toBe(callsAway);

	mocks.navigate('r');
	await waitFor(() => expect(second.querySelector('.itemIndicator')?.classList.contains('_blink')).toBe(true));
});

test('discards a reconnect error response that arrives after leaving the screen in the stacking router', async () => {
	mocks.preferS['experimental.stackingRouterView'] = true;
	let delayShow = false;
	let finish!: () => void;
	mocks.api.mockImplementation((endpoint: string) => {
		if (endpoint === 'chat/rooms/show') {
			if (delayShow) return new Promise((_, reject) => { finish = () => reject(roomDeletedError()); });
			return Promise.resolve(room);
		}
		return Promise.resolve(endpoint === 'chat/rooms/unread' ? { unreadChannelIds: [], notificationChannelIds: [] } : channels);
	});
	renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });

	delayShow = true;
	mocks.reconnect();
	await waitFor(() => expect(finish).toBeTypeOf('function'));
	// 조회 도중 다른 화면으로 이동한다.
	mocks.navigateAway();
	finish();
	await flush();

	expect(mocks.replace).not.toHaveBeenCalled();
	expect(mocks.alert).not.toHaveBeenCalled();
});

test('does not swap subscriptions when a reconnect list response arrives after leaving the screen', async () => {
	mocks.preferS['experimental.stackingRouterView'] = true;
	let delayList = false;
	let finish!: (value: unknown) => void;
	mocks.api.mockImplementation((endpoint: string) => {
		if (endpoint === 'chat/rooms/channels/list' && delayList) return new Promise(resolve => { finish = resolve; });
		return Promise.resolve(endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds: [], notificationChannelIds: [] } : channels);
	});
	renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });
	const liveBefore = mocks.connections.filter(connection => !connection.disposed && connection.channel === 'chatRoom');
	expect(liveBefore.at(-1)?.params).toEqual({ roomId: 'r', channelId: 'c1' });

	delayList = true;
	mocks.reconnect();
	await waitFor(() => expect(finish).toBeTypeOf('function'));
	mocks.navigateAway();
	finish([channels[1]]);
	await flush();

	const live = mocks.connections.filter(connection => !connection.disposed && connection.channel === 'chatRoom');
	expect(live.at(-1)?.params).toEqual({ roomId: 'r', channelId: 'c1' });
	expect(mocks.replace).not.toHaveBeenCalled();
});

test('re-reads on reconnect while the list is the frontmost screen in the stacking router', async () => {
	mocks.preferS['experimental.stackingRouterView'] = true;
	let unreadChannelIds: string[] = [];
	let notificationChannelIds: string[] = [];
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds, notificationChannelIds } : channels);
	renderChannels({ roomId: 'r' });
	const second = await screen.findByRole('link', { name: 'Second' });
	await waitFor(() => expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(1));

	unreadChannelIds = ['c2'];
	notificationChannelIds = ['c2'];
	mocks.reconnect();

	await waitFor(() => expect(second.querySelector('.itemIndicator')?.classList.contains('_blink')).toBe(true));
	expect(mocks.api.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/unread')).toHaveLength(2);
});

test('does not close the list on a realtime deletion while it is behind another screen in the stacking router', async () => {
	mocks.preferS['experimental.stackingRouterView'] = true;
	renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });
	mocks.navigateAway();

	mocks.handlers.get('roomDeleted')!(undefined);
	await flush();

	expect(mocks.replace).not.toHaveBeenCalled();
	expect(mocks.alert).not.toHaveBeenCalled();

	// 목록이 현재 경로로 돌아오면 그때 다시 읽어 삭제를 처리한다.
	mocks.api.mockImplementation(async (endpoint: string) => {
		if (endpoint === 'chat/rooms/show') throw roomDeletedError();
		return endpoint === 'chat/rooms/unread' ? { unreadChannelIds: [], notificationChannelIds: [] } : channels;
	});
	mocks.navigate('r');
	await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.roomDeleted }));
	expect(mocks.replace).toHaveBeenCalledWith('/chat');
});

test('does not close the list on a realtime removal while it is behind another screen in the stacking router', async () => {
	mocks.preferS['experimental.stackingRouterView'] = true;
	renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });
	mocks.navigateAway();

	mocks.handlers.get('membershipEnded')!({ userId: 'me' });
	await flush();

	expect(mocks.replace).not.toHaveBeenCalled();
	expect(mocks.alert).not.toHaveBeenCalled();

	mocks.api.mockImplementation(async (endpoint: string) => {
		if (endpoint === 'chat/rooms/show') { const err = new Error('No such room.') as Error & { code: string }; err.code = 'NO_SUCH_ROOM'; throw err; }
		return endpoint === 'chat/rooms/unread' ? { unreadChannelIds: [], notificationChannelIds: [] } : channels;
	});
	mocks.navigate('r');
	await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.roomUnavailable }));
	expect(mocks.replace).toHaveBeenCalledWith('/chat');
});

test('still closes the list on a realtime deletion while it is the frontmost screen in the stacking router', async () => {
	mocks.preferS['experimental.stackingRouterView'] = true;
	renderChannels({ roomId: 'r' });
	await screen.findByRole('link', { name: 'First' });

	mocks.handlers.get('roomDeleted')!(undefined);
	await flush();

	expect(mocks.alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.roomDeleted });
	expect(mocks.replace).toHaveBeenCalledWith('/chat');
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
	renderChannels({ roomId: 'r', channelId: 'c1' });
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
	const ownerView = renderChannels({ roomId: 'r', channelId: 'c1' });
	const ownerLink = await screen.findByRole('link', { name: 'First' });
	expect(railDragSource(ownerLink)).not.toBeNull();
	expect(ownerLink.getAttribute('draggable')).toBe('false');
	ownerView.unmount();

	mockRoom({ ...room, ownerId: 'other' });
	renderChannels({ roomId: 'r', channelId: 'c1' });
	const memberLink = await screen.findByRole('link', { name: 'First' });
	expect(memberLink.closest('[draggable="true"]')).toBeNull();
});

test('keeps unread and current-channel markers on the right channels after a drag', async () => {
	mocks.width = 1000;
	mockRoom(ownedRoom, ['c2']);
	renderChannels({ roomId: 'r', channelId: 'c1' });
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
	renderChannels({ roomId: 'r', channelId: 'c1' });
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
	const archived = renderChannels({ roomId: 'r', channelId: 'c1' });
	await screen.findByRole('link', { name: 'First' });
	expect(screen.queryAllByRole('button', { name: i18n.ts.dragToReorder })).toHaveLength(0);
	archived.unmount();

	mocks.me.policies.chatAvailability = 'unavailable';
	mockRoom(ownedRoom);
	renderChannels({ roomId: 'r', channelId: 'c1' });
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
	renderChannels({ roomId: 'r', channelId: 'c1' });
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
	renderChannels({ roomId: 'r' });
	const first = await screen.findByRole('link', { name: 'First' });
	expect(first.closest('.rrevdjwu')?.classList.contains('grid')).toBe(true);
});

test('shows the wide rail as a menu without the grid layout', async () => {
	mocks.width = 1000;
	mockRoom({ ...room, ownerId: 'other' });
	renderChannels({ roomId: 'r', channelId: 'c1' });
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
	renderChannels({ roomId: 'r', channelId: 'c1' });
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
	renderChannels({ roomId: 'r', channelId: 'c1' });
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
	renderChannels({ roomId: 'r', channelId: 'c2' });
	const second = await screen.findByRole('link', { name: 'Second' });
	expect(second.getAttribute('aria-current')).toBe('page');
	expect(screen.getByRole('link', { name: 'First' }).getAttribute('aria-current')).toBeNull();
});

test('shows static unread dots for mention-only channels in the narrow grid', async () => {
	mocks.api.mockImplementation(async (endpoint: string) => endpoint === 'chat/rooms/show' ? room : endpoint === 'chat/rooms/unread' ? { unreadChannelIds: ['c2'], notificationChannelIds: [] } : channels);
	renderChannels({ roomId: 'r' });
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
