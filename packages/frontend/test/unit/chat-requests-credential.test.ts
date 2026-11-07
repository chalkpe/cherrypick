/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { defineComponent, h } from 'vue';

// 画面からサーバーへの要求までを本物でつなぎ、外に出る本文に自分の資格情報が入っているかを見る。
// os や misskeyApi をモックすると、資格情報を消してしまう引数の渡し方を見逃す
const mocks = vi.hoisted(() => {
	const state = {
		me: { id: 'me', username: 'me', token: 'my-token', policies: { chatAvailability: 'available', canVoiceCall: false } },
		room: { id: 'r1', name: 'room 1', description: '', ownerId: 'owner', owner: { id: 'owner', username: 'owner', host: null }, isArchived: false, invitationExists: false },
		selectUsers: vi.fn(),
		confirm: vi.fn(),
		bodies: [] as { endpoint: string; body: Record<string, unknown> }[],
	};
	// 読み込みの時点で出る要求 (設定の読み込みなど) も本物へ行かないよう、import より先に差し替える。画面を閉じたあとの要求のために戻さない
	vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
		const endpoint = url.slice(url.indexOf('/api/') + '/api/'.length);
		state.bodies.push({ endpoint, body: JSON.parse(init.body) });
		if (endpoint === 'chat/rooms/invitations/inbox') {
			return new Response(JSON.stringify([{ id: 'i1', createdAt: '2026-11-04T00:00:00.000Z', roomId: 'r1', room: state.room, userId: 'me' }]), { status: 200 });
		}
		if (endpoint === 'chat/rooms/show') {
			// 参加したあとに読み直すと、もう招待はない
			const joined = state.bodies.some(request => request.endpoint === 'chat/rooms/join');
			return new Response(JSON.stringify({ ...state.room, invitationExists: state.room.invitationExists && !joined }), { status: 200 });
		}
		if (endpoint === 'chat/rooms/join' || endpoint === 'chat/rooms/invitations/create') return new Response(null, { status: 204 });
		return new Response('[]', { status: 200 });
	}));
	return state;
});

vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ on: vi.fn(), off: vi.fn(), useChannel: () => ({ on: vi.fn(), off: vi.fn(), send: vi.fn(), dispose: vi.fn() }) }) }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), useListener: vi.fn() }) }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false, 'voiceCall.stageChatSide': 'right' }) }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));
// apiWithDialog は本物のまま。利用者の答えを待つものだけを差し替える
vi.mock('@/os.js', async importOriginal => ({ ...await importOriginal<typeof import('@/os.js')>(), confirm: mocks.confirm, selectUsers: mocks.selectUsers }));
vi.mock('@/composables/use-chat-room-voice-call.js', async () => {
	const { computed } = await import('vue');
	return { useChatRoomVoiceCall: () => ({ available: computed(() => false), inThisCall: computed(() => false), participants: computed(() => []), join: vi.fn(), leave: vi.fn() }) };
});
vi.mock('@/pages/chat/room.form.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/room.search.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/room.members.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/room.info.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/XMessage.vue', () => ({ default: { render: () => null } }));

import { provideMetadataReceiver } from '@/page.js';
import XRoomPage from '@/pages/chat/room.vue';
import XInvitations from '@/pages/chat/home.invitations.vue';
import { i18n } from '@/i18n.js';

const stubs = {
	PageWithHeader: { template: '<div><slot/></div>' },
	MkStickyContainer: { template: '<div><slot name="header"/><slot/></div>' },
	MkLoading: { template: '<div></div>' },
	MkAvatar: true,
	MkFolder: { template: '<div><slot name="label"/><slot name="footer"/><slot/></div>' },
	MkUserName: true,
	MkTime: true,
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
	MkResult: true,
};

function requestsTo(endpoint: string) {
	return mocks.bodies.filter(request => request.endpoint === endpoint);
}

function renderRoom() {
	const host = defineComponent({
		setup() {
			provideMetadataReceiver(() => {});
			return () => h(XRoomPage, { roomId: 'r1' });
		},
	});
	return render(host, { global: { stubs, directives: { tooltip: {} } } });
}

beforeEach(() => {
	mocks.bodies.length = 0;
	mocks.room.ownerId = 'owner';
	mocks.room.invitationExists = false;
	mocks.confirm.mockReset().mockResolvedValue({ canceled: false });
	mocks.selectUsers.mockReset().mockResolvedValue([{ id: 'invitee' }, { id: 'remote-invitee' }]);
});

afterEach(cleanup);

describe('what leaves for the server carries my credential', () => {
	test('joining from the invitations tab', async () => {
		render(XInvitations, { global: { stubs } });

		await fireEvent.click(await screen.findByRole('button', { name: i18n.ts._chat.join }));

		await waitFor(() => expect(requestsTo('chat/rooms/join')).toHaveLength(1));
		expect(requestsTo('chat/rooms/join')[0].body).toEqual({ roomId: 'r1', i: 'my-token' });
	});

	test('joining from the room an invitation points to', async () => {
		mocks.room.invitationExists = true;

		renderRoom();

		await waitFor(() => expect(requestsTo('chat/rooms/join')).toHaveLength(1));
		expect(requestsTo('chat/rooms/join')[0].body).toEqual({ roomId: 'r1', i: 'my-token' });
	});

	test('inviting several people to my room', async () => {
		mocks.room.ownerId = 'me';

		renderRoom();

		await fireEvent.click(await screen.findByRole('button', { name: i18n.ts._chat.inviteUser }));

		await waitFor(() => expect(requestsTo('chat/rooms/invitations/create')).toHaveLength(2));
		expect(requestsTo('chat/rooms/invitations/create').map(request => request.body)).toEqual([
			{ roomId: 'r1', userId: 'invitee', i: 'my-token' },
			{ roomId: 'r1', userId: 'remote-invitee', i: 'my-token' },
		]);
	});

	test('reading who is already in my room, to keep them from being picked', async () => {
		mocks.room.ownerId = 'me';

		renderRoom();

		await fireEvent.click(await screen.findByRole('button', { name: i18n.ts._chat.inviteUser }));

		await waitFor(() => expect(requestsTo('chat/rooms/invitations/create')).toHaveLength(2));
		for (const endpoint of ['chat/rooms/members', 'chat/rooms/invitations/outbox']) {
			expect(requestsTo(endpoint).length).toBeGreaterThan(0);
			expect(requestsTo(endpoint).every(request => request.body.i === 'my-token')).toBe(true);
		}
	});
});
