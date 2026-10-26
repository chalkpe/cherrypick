/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/vue';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => {
	class FakeChannel {
		handlers = new Map<string, (payload: unknown) => void>();
		on(event: string, handler: (payload: unknown) => void) {
			this.handlers.set(event, handler);
		}
		off() {}
		dispose = vi.fn();
		emit(event: string, payload: unknown) {
			this.handlers.get(event)?.(payload);
		}
	}
	return {
		FakeChannel,
		channel: new FakeChannel(),
		misskeyApi: vi.fn(),
		instance: { features: { voiceCall: true, remoteVoiceCall: false } },
	};
});

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ useChannel: () => mocks.channel }) }));
vi.mock('@/instance.js', () => ({ instance: mocks.instance }));

import { i18n } from '@/i18n.js';
import XRoom from '@/pages/chat/XRoom.vue';
import XJoiningRooms from '@/pages/chat/home.joiningRooms.vue';

const stubs = {
	MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	MkAvatar: { props: ['user'], template: '<span class="avatar" :data-user="user.id"></span>' },
};

const room = { id: 'r1', name: 'room 1', description: '', owner: { id: 'owner', username: 'owner' } } as any;
const participant = (id: string) => ({ identity: `https://local.test/users/${id}`, user: { id, username: id }, screenSharing: false }) as any;

async function flush() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

beforeEach(() => {
	mocks.channel = new mocks.FakeChannel();
	mocks.instance.features.voiceCall = true;
	mocks.instance.features.remoteVoiceCall = false;
	mocks.misskeyApi.mockReset().mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
});

describe('room list voice indicator', () => {
	test('shows up to three people in the call and how many more', () => {
		const { container } = render(XRoom, {
			props: { room, voiceState: { roomId: 'r1', participants: ['a', 'b', 'c', 'd'].map(participant), updatedAt: 0 } },
			global: { stubs },
		});

		expect(screen.getByLabelText(i18n.tsx._voiceCall.inCallCount({ n: 4 }))).toBeTruthy();
		const shown = [...container.querySelectorAll('[aria-label] .avatar')].map(el => el.getAttribute('data-user'));
		expect(shown).toEqual(['a', 'b', 'c']);
		expect(screen.getByText('+1')).toBeTruthy();
	});

	test('shows nothing when no one is in the call', () => {
		render(XRoom, { props: { room }, global: { stubs } });

		expect(screen.queryByLabelText(i18n.tsx._voiceCall.inCallCount({ n: 0 }))).toBeNull();
		expect(screen.queryByText('+1')).toBeNull();
	});
});

// LiveKit を持たず、他のサーバーの通話にだけ参加するサーバー
describe('room list on a server without its own LiveKit', () => {
	const mirror = { ...room, owner: { id: 'remote-owner', username: 'owner', host: 'remote.test' } };
	const listStubs = { ...stubs, MkResult: { template: '<div></div>' }, MkLoading: { template: '<div></div>' } };

	beforeEach(() => {
		mocks.instance.features.voiceCall = false;
		mocks.instance.features.remoteVoiceCall = true;
		mocks.misskeyApi.mockImplementation(async (endpoint: string) => {
			if (endpoint === 'chat/rooms/joining') return [{ id: 'm1', roomId: 'r1', room: mirror }];
			if (endpoint === 'chat/rooms/voice/states') return [{ roomId: 'r1', participants: [participant('a')] }];
			return [];
		});
	});

	test('shows that a mirror room has a call', async () => {
		render(XJoiningRooms, { global: { stubs: listStubs } });
		await flush();

		expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/states', { roomIds: ['r1'] });
		expect(screen.getByLabelText(i18n.tsx._voiceCall.inCallCount({ n: 1 }))).toBeTruthy();
	});

	test('follows changes to the call through the main stream', async () => {
		render(XJoiningRooms, { global: { stubs: listStubs } });
		await flush();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: ['a', 'b'].map(participant) });
		await flush();
		expect(screen.getByLabelText(i18n.tsx._voiceCall.inCallCount({ n: 2 }))).toBeTruthy();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [] });
		await flush();
		expect(screen.queryByLabelText(i18n.tsx._voiceCall.inCallCount({ n: 2 }))).toBeNull();
	});
});
