/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { defineComponent, h } from 'vue';

// 画面からサーバーへの要求までを本物でつなぎ、断られたときに画面に出る文言を見る。
// 出ていく本文には自分の資格情報が入っていなければならない。os や misskeyApi をモックすると、どちらも見逃す
const mocks = vi.hoisted(() => {
	const state = {
		me: { id: 'me', username: 'me', token: 'my-token', isAdmin: false, isModerator: false, policies: { chatAvailability: 'available', canVoiceCall: false } },
		room: { id: 'r1', name: 'room 1', description: '', ownerId: 'me', owner: { id: 'me', username: 'me', host: null }, isArchived: false, isMuted: false, invitationExists: false } as Record<string, unknown>,
		confirm: vi.fn(),
		popupMenu: vi.fn(),
		bodies: [] as { endpoint: string; body: Record<string, unknown> }[],
		// 断る要求と、そのときの本文
		refusal: { endpoint: '', error: null as Record<string, string> | 'network' | null },
	};
	vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
		const endpoint = url.slice(url.indexOf('/api/') + '/api/'.length);
		state.bodies.push({ endpoint, body: JSON.parse(init.body) });
		if (endpoint === state.refusal.endpoint && state.refusal.error != null) {
			if (state.refusal.error === 'network') throw new TypeError('Failed to fetch');
			return new Response(JSON.stringify({ error: state.refusal.error }), { status: 400 });
		}
		if (endpoint === 'chat/rooms/show') return new Response(JSON.stringify(state.room), { status: 200 });
		if (endpoint === 'chat/rooms/members') return new Response(JSON.stringify([{ id: 'ms1', userId: 'member', user: { id: 'member', username: 'member', host: null } }]), { status: 200 });
		if (endpoint === 'chat/rooms/invitations/outbox') return new Response(JSON.stringify([{ id: 'i1', userId: 'invitee', user: { id: 'invitee', username: 'invitee', host: null } }]), { status: 200 });
		if (endpoint === 'chat/rooms/invitations/inbox') return new Response(JSON.stringify([{ id: 'i1', createdAt: '2026-11-04T00:00:00.000Z', roomId: 'r1', room: state.room, userId: 'me' }]), { status: 200 });
		return new Response('[]', { status: 200 });
	}));
	return state;
});

vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ on: vi.fn(), off: vi.fn(), useChannel: () => ({ on: vi.fn(), off: vi.fn(), send: vi.fn(), dispose: vi.fn() }) }) }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), useListener: vi.fn(), currentRef: { value: { route: { path: '/chat/room/:roomId' }, props: new Map([['roomId', 'r1']]) } } }) }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: false, 'voiceCall.stageChatSide': 'right' }) }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));
// apiWithDialog は本物のまま。利用者の答えを待つものだけを差し替える
vi.mock('@/os.js', async importOriginal => ({ ...await importOriginal<typeof import('@/os.js')>(), confirm: mocks.confirm, popupMenu: mocks.popupMenu }));
vi.mock('@/composables/use-chat-room-voice-call.js', async () => {
	const { computed } = await import('vue');
	return { useChatRoomVoiceCall: () => ({ available: computed(() => false), inThisCall: computed(() => false), participants: computed(() => []), join: vi.fn() }) };
});
vi.mock('@/pages/chat/room.form.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/room.search.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/XMessage.vue', () => ({ default: { render: () => null } }));

import * as os from '@/os.js';
import { provideMetadataReceiver } from '@/page.js';
import XRoomPage from '@/pages/chat/room.vue';
import XInvitations from '@/pages/chat/home.invitations.vue';
import XMembers from '@/pages/chat/room.members.vue';
import XInfo from '@/pages/chat/room.info.vue';
import { i18n } from '@/i18n.js';
import {
	chatCancelInvitationErrors, chatInviteErrors, chatJoinErrors, chatKickErrors, chatLeaveErrors,
	chatMuteErrors, chatRejectErrors, chatRoomDeleteErrors, chatRoomUpdateErrors,
} from '@/pages/chat/chat-errors.js';
import type { ApiWithDialogCustomErrors } from '@/os.js';

const stubs = {
	PageWithHeader: { props: ['actions'], template: '<div><button v-for="action in actions" :data-icon="action.icon" @click="action.handler($event)"></button><slot/></div>' },
	MkStickyContainer: { template: '<div><slot name="header"/><slot/></div>' },
	MkLoading: { template: '<div></div>' },
	MkAvatar: true,
	MkFolder: { template: '<div><slot name="label"/><slot name="footer"/><slot/></div>' },
	MkUserName: true,
	MkUserCardMini: { props: ['user'], template: '<span>{{ user.username }}</span>' },
	MkA: { template: '<a><slot/></a>' },
	MkTime: true,
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
	MkResult: true,
	MkInput: { props: ['modelValue'], template: '<input :value="modelValue">' },
	MkTextarea: { props: ['modelValue'], template: '<textarea :value="modelValue"></textarea>' },
	MkSwitch: { props: ['modelValue'], emits: ['update:modelValue'], template: '<button data-testid="switch" :data-on="String(modelValue)" @click="$emit(\'update:modelValue\', !modelValue)"><slot name="label"/></button>' },
	MkKeyValue: true,
};

// 本物の os.alert が開こうとしたダイアログ。ここに出す文言だけが利用者に見える
function shownDialog(): { title?: string; text?: string } | undefined {
	return os.popups.value.map(popup => popup.props as { type?: string; title?: string; text?: string }).findLast(props => props.type === 'error');
}

function requestTo(endpoint: string) {
	return mocks.bodies.findLast(request => request.endpoint === endpoint);
}

function roomPage() {
	const host = defineComponent({
		setup() {
			provideMetadataReceiver(() => {});
			return () => h(XRoomPage, { roomId: 'r1' });
		},
	});
	return render(host, { global: { stubs, directives: { tooltip: {} } } });
}

async function clickButton(name: string) {
	await fireEvent.click(await screen.findByRole('button', { name }));
}

// 画面ごとの操作。古いタブから押したのと同じことになる
const actions: Record<string, () => Promise<void>> = {
	'chat/rooms/leave': async () => {
		mocks.room.ownerId = 'owner';
		const { container } = roomPage();
		// ルームを読み終えるまでは、メニューに退出が出ない
		let leave: { action: () => void } | undefined;
		await waitFor(async () => {
			mocks.popupMenu.mockClear();
			await fireEvent.click(container.querySelector('[data-icon="ti ti-dots"]')!);
			const items = mocks.popupMenu.mock.calls[0][0] as (Record<string, unknown> | null)[];
			leave = items.find(item => item?.text === i18n.ts._chat.leave) as unknown as { action: () => void } | undefined;
			expect(leave).toBeDefined();
		});
		leave!.action();
	},
	'chat/rooms/kick': async () => {
		render(XMembers, { props: { room: mocks.room as never }, global: { stubs } });
		await clickButton(i18n.ts._chat.kickMember);
	},
	'chat/rooms/invitations/cancel': async () => {
		render(XMembers, { props: { room: mocks.room as never }, global: { stubs } });
		await clickButton(i18n.tsx._chat.cancelInvitationTo({ x: 'invitee' }));
	},
	'chat/rooms/update': async () => {
		render(XInfo, { props: { room: mocks.room as never }, global: { stubs } });
		await clickButton(i18n.ts.save);
	},
	'chat/rooms/delete': async () => {
		render(XInfo, { props: { room: mocks.room as never }, global: { stubs } });
		await clickButton(i18n.ts._chat.deleteRoom);
	},
	'chat/rooms/mute': async () => {
		mocks.room.ownerId = 'owner';
		render(XInfo, { props: { room: mocks.room as never }, global: { stubs } });
		await fireEvent.click(await screen.findByTestId('switch'));
	},
	'chat/rooms/invitations/reject': async () => {
		render(XInvitations, { global: { stubs } });
		await clickButton(i18n.ts._chat.reject);
	},
};

const REFUSED: [string, Record<string, string>, string][] = [
	['chat/rooms/leave', { message: 'No such room.', code: 'NO_SUCH_ROOM', id: 'cb7f3179-50e8-4389-8c30-dbe2650a67c9' }, i18n.ts._chat.roomUnavailable],
	['chat/rooms/kick', { message: 'No such removable member.', code: 'NO_SUCH_MEMBER', id: 'b4c87e54-c36a-40f4-99c7-b72032c48482' }, i18n.ts._chat.memberAlreadyGone],
	['chat/rooms/invitations/cancel', { message: 'No such invitation.', code: 'NO_SUCH_INVITATION', id: '8c8f38f0-3b7e-4f5e-9c6d-2e3f4a5b6c7d' }, i18n.ts._chat.invitationGone],
	['chat/rooms/update', { message: 'No such room.', code: 'NO_SUCH_ROOM', id: 'fcdb0f92-bda6-47f9-bd05-343e0e020932' }, i18n.ts._chat.roomUnavailable],
	['chat/rooms/delete', { message: 'No such room.', code: 'NO_SUCH_ROOM', id: 'd4e3753d-97bf-4a19-ab8e-21080fbc0f4b' }, i18n.ts._chat.roomUnavailable],
	['chat/rooms/mute', { message: 'No such room.', code: 'NO_SUCH_ROOM', id: 'c2cde4eb-8d0f-42f1-8f2f-c4d6bfc8e5df' }, i18n.ts._chat.roomUnavailable],
	['chat/rooms/invitations/reject', { message: 'No such room.', code: 'NO_SUCH_ROOM', id: '5130557e-5a11-4cfb-9cc5-fe60cda5de0d' }, i18n.ts._chat.invitationGone],
];

beforeEach(() => {
	mocks.bodies.length = 0;
	mocks.room.ownerId = 'me';
	mocks.refusal.endpoint = '';
	mocks.refusal.error = null;
	mocks.confirm.mockReset().mockResolvedValue({ canceled: false });
	mocks.popupMenu.mockReset();
	os.popups.value = [];
});

afterEach(cleanup);

describe.each(REFUSED)('%s refused by the server', (endpoint, error, words) => {
	test('says so in the language of the screen, and the request carried my credential', async () => {
		mocks.refusal.endpoint = endpoint;
		mocks.refusal.error = error;

		await actions[endpoint]();

		await waitFor(() => expect(shownDialog()).toBeDefined());
		expect(shownDialog()!.text).toBe(words);
		expect(shownDialog()!.text).not.toContain(error.message);
		expect(shownDialog()!.text).not.toContain(error.id);
		expect(requestTo(endpoint)!.body.i).toBe('my-token');
	});
});

describe.each(REFUSED.map(([endpoint]) => endpoint))('%s failing in a way nobody listed', endpoint => {
	test('an error of no known kind does not show its English', async () => {
		mocks.refusal.endpoint = endpoint;
		mocks.refusal.error = { message: 'Something new went wrong.', code: 'SOMETHING_NEW', id: '00000000-0000-4000-8000-000000000000' };

		await actions[endpoint]();

		await waitFor(() => expect(shownDialog()).toBeDefined());
		expect(shownDialog()!.text).toBe(i18n.ts._chat.actionFailed);
	});

	test('losing the network still tells the user', async () => {
		mocks.refusal.endpoint = endpoint;
		mocks.refusal.error = 'network';

		await actions[endpoint]();

		await waitFor(() => expect(shownDialog()).toBeDefined());
		expect(shownDialog()!.text).toBe(i18n.ts._chat.actionFailed);
	});
});

test('a mute that failed puts the switch back', async () => {
	mocks.refusal.endpoint = 'chat/rooms/mute';
	mocks.refusal.error = REFUSED.find(([endpoint]) => endpoint === 'chat/rooms/mute')![1];

	await actions['chat/rooms/mute']();

	await waitFor(() => expect(shownDialog()).toBeDefined());
	await waitFor(() => expect(screen.getByTestId('switch').getAttribute('data-on')).toBe('false'));
});

test('an invitation already gone leaves the tab it was shown in', async () => {
	mocks.refusal.endpoint = 'chat/rooms/invitations/reject';
	mocks.refusal.error = REFUSED.find(([endpoint]) => endpoint === 'chat/rooms/invitations/reject')![1];

	await actions['chat/rooms/invitations/reject']();

	await waitFor(() => expect(screen.queryByRole('button', { name: i18n.ts._chat.reject })).toBeNull());
});

// サーバーに新しい断り方が増えたら、ここで気づく
test.each<[string, ApiWithDialogCustomErrors]>([
	['chat/rooms/join', chatJoinErrors],
	['chat/rooms/invitations/create', chatInviteErrors],
	['chat/rooms/leave', chatLeaveErrors],
	['chat/rooms/kick', chatKickErrors],
	['chat/rooms/update', chatRoomUpdateErrors],
	['chat/rooms/delete', chatRoomDeleteErrors],
	['chat/rooms/mute', chatMuteErrors],
	['chat/rooms/invitations/cancel', chatCancelInvitationErrors],
	['chat/rooms/invitations/reject', chatRejectErrors],
])('%s: every refusal the server declares has its own words', (endpoint, errors) => {
	const source = readFileSync(resolve(process.cwd(), `../backend/src/server/api/endpoints/${endpoint}.ts`), 'utf8');
	const declared = [...source.matchAll(/\bid: '([0-9a-f-]{36})'/g)].map(match => match[1]).toSorted();

	expect(Object.keys(errors).filter(id => id !== 'default').toSorted()).toEqual(declared);
});
