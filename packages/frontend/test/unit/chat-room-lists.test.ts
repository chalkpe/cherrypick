/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/vue';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	channel: new Map<string, () => void>(),
	stream: new Map<string, () => void>(),
	dispose: vi.fn(),
	off: vi.fn(),
	me: { id: 'me', policies: { canVoiceCall: false } },
}));
vi.mock('@/i.js', () => ({ $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({}) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/os.js', () => ({ apiWithDialog: vi.fn() }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/composables/use-chat-room-voice-states.js', () => ({ useChatRoomVoiceStates: () => ref(new Map()) }));
vi.mock('@/stream.js', () => ({
	useStream: () => ({
		useChannel: () => ({
			on: (event: string, handler: () => void) => mocks.channel.set(event, handler),
			dispose: mocks.dispose,
		}),
		on: (event: string, handler: () => void) => mocks.stream.set(event, handler),
		off: mocks.off,
	}),
}));

import Invitations from '@/pages/chat/home.invitations.vue';
import JoiningRooms from '@/pages/chat/home.joiningRooms.vue';
import OwnedRooms from '@/pages/chat/home.ownedRooms.vue';

const roomStub = { props: ['room'], template: '<div>{{ room.name }}</div>' };
const stubs = {
	XRoom: roomStub,
	MkFolder: { template: '<div><slot name="label"/><slot/><slot name="footer"/></div>' },
	MkButton: { template: '<button><slot/></button>' },
	MkAvatar: { template: '<span/>' },
	MkUserName: { template: '<span/>' },
	MkTime: { template: '<span/>' },
	MkResult: { props: ['text'], template: '<p>{{ text }}</p>' },
	MkLoading: { template: '<p>loading</p>' },
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
};

const room = (name: string) => ({ id: name, name, owner: { id: 'owner' }, description: '', isArchived: false });
const cases = [
	['the invitation list', Invitations, 'chat/rooms/invitations/inbox', (name: string) => ({ id: name, room: room(name), createdAt: '2026-11-04T00:00:00.000Z' })],
	['the joined room list', JoiningRooms, 'chat/rooms/joining', (name: string) => ({ id: name, roomId: name, room: room(name) })],
	['the owned room list', OwnedRooms, 'chat/rooms/owned', (name: string) => room(name)],
] as const;

beforeEach(() => {
	vi.resetAllMocks();
	mocks.channel.clear();
	mocks.stream.clear();
});
afterEach(cleanup);

describe.each(cases)('%s', (_label, component, endpoint, item) => {
	function respondWith(...names: string[]) {
		mocks.api.mockImplementation(async (called: string) => (called === endpoint ? names.map(name => item(name)) : []));
	}

	test('reads again when the server says the list changed, without going back to the spinner', async () => {
		respondWith('first');
		render(component, { global: { stubs } });
		await screen.findByText('first');

		let answer: (value: unknown[]) => void = () => {};
		mocks.api.mockImplementation(() => new Promise(resolve => {
			answer = resolve;
		}));
		mocks.channel.get('chatRoomListChanged')!();
		await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
		expect(screen.queryByText('loading')).toBeNull();
		expect(screen.getByText('first')).toBeTruthy();

		answer([item('second')]);
		await screen.findByText('second');
		expect(screen.queryByText('first')).toBeNull();
	});

	test('reads again when the stream comes back, since what it missed will not be sent again', async () => {
		respondWith('first');
		render(component, { global: { stubs } });
		await screen.findByText('first');

		respondWith('second');
		mocks.stream.get('_connected_')!();

		await screen.findByText('second');
	});

	test('a slower older answer does not replace a newer one', async () => {
		respondWith('first');
		render(component, { global: { stubs } });
		await screen.findByText('first');

		const answers: ((value: unknown[]) => void)[] = [];
		mocks.api.mockImplementation(() => new Promise(resolve => {
			answers.push(resolve);
		}));
		mocks.channel.get('chatRoomListChanged')!();
		mocks.channel.get('chatRoomListChanged')!();
		await waitFor(() => expect(answers).toHaveLength(2));

		answers[1]([item('newer')]);
		await screen.findByText('newer');
		answers[0]([item('older')]);
		await new Promise(resolve => setTimeout(resolve));

		expect(screen.getByText('newer')).toBeTruthy();
		expect(screen.queryByText('older')).toBeNull();
	});

	test('keeps what it shows when reading again fails', async () => {
		respondWith('first');
		render(component, { global: { stubs } });
		await screen.findByText('first');

		mocks.api.mockRejectedValue(new Error('offline'));
		mocks.channel.get('chatRoomListChanged')!();
		await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
		await new Promise(resolve => setTimeout(resolve));

		expect(screen.getByText('first')).toBeTruthy();
	});

	test('stops listening when it goes away', async () => {
		respondWith('first');
		const { unmount } = render(component, { global: { stubs } });
		await screen.findByText('first');

		unmount();

		expect(mocks.dispose).toHaveBeenCalled();
		expect(mocks.off).toHaveBeenCalledWith('_connected_', mocks.stream.get('_connected_'));
	});
});
