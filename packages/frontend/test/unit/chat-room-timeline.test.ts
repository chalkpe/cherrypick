/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';

const mocks = vi.hoisted(() => {
	class FakeChannel {
		handlers = new Map<string, (payload: unknown) => void>();
		on(event: string, handler: (payload: unknown) => void) {
			this.handlers.set(event, handler);
		}
		off() {}
		send() {}
		dispose() {}
		emit(event: string, payload: unknown) {
			this.handlers.get(event)?.(payload);
		}
	}
	return {
		FakeChannel,
		channel: new FakeChannel(),
		me: { id: 'me', username: 'me', policies: { chatAvailability: 'available', canVoiceCall: false } },
		timeline: [] as unknown[],
		roomIsArchived: false,
		roomOwnerId: 'owner',
		roomShowFails: false,
		routerPush: vi.fn(),
		alert: vi.fn(),
		confirm: vi.fn(),
		popupMenu: vi.fn(),
		apiWithDialog: vi.fn(),
		selectUser: vi.fn(),
		membersMounts: { value: 0 },
		editMessage: { value: null as (() => void) | null },
		// 吹き出しごとの描画回数
		renders: new Map<string, number>(),
	};
});

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: vi.fn(async (endpoint: string) => {
		if (endpoint === 'chat/rooms/show' && mocks.roomShowFails) throw new Error('No such room.');
		if (endpoint === 'chat/rooms/show') return { id: 'r1', name: 'room 1', ownerId: mocks.roomOwnerId, owner: { id: mocks.roomOwnerId, username: 'owner', host: null }, isArchived: mocks.roomIsArchived };
		if (endpoint === 'users/show') return { id: 'alice', username: 'alice', host: null };
		if (endpoint === 'chat/messages/room-timeline' || endpoint === 'chat/messages/user-timeline') return mocks.timeline;
		return [];
	}),
}));
vi.mock('@/stream.js', () => ({ useStream: () => ({ on: vi.fn(), off: vi.fn(), useChannel: () => mocks.channel }) }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: true, 'voiceCall.stageChatSide': 'right' }) }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/os.js', () => ({ alert: mocks.alert, confirm: mocks.confirm, popupMenu: mocks.popupMenu, apiWithDialog: mocks.apiWithDialog, selectUser: mocks.selectUser }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: mocks.routerPush, useListener: vi.fn() }) }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));
// 通話や入力欄は吹き出しのまとまりと関係ないので空にする
vi.mock('@/composables/use-chat-room-voice-call.js', async () => {
	const { computed } = await import('vue');
	return { useChatRoomVoiceCall: () => ({ available: computed(() => false), inThisCall: computed(() => false), participants: computed(() => []), join: vi.fn() }) };
});
vi.mock('@/pages/chat/room.form.vue', async () => {
	const { h: hh } = await import('vue');
	return { default: { props: ['editingMessage'], render(this: { editingMessage: { id: string } | null }) { return hh('div', { 'data-testid': 'form', 'data-editing': this.editingMessage?.id ?? '' }); } } };
});
vi.mock('@/pages/chat/room.search.vue', () => ({ default: { render: () => null } }));
// 一覧は読み込むときにしか取得しないので、読み込み直された回数を数える
vi.mock('@/pages/chat/room.members.vue', async () => {
	const { h: hh, onMounted } = await import('vue');
	return {
		default: {
			emits: ['inviteUser'],
			setup(_: unknown, { emit }: { emit: (event: 'inviteUser') => void }) {
				onMounted(() => { mocks.membersMounts.value++; });
				return () => hh('button', { 'data-testid': 'members-invite', onClick: () => emit('inviteUser') });
			},
		},
	};
});
vi.mock('@/pages/chat/room.info.vue', async () => {
	const { h: hh } = await import('vue');
	return {
		default: {
			props: ['room'],
			emits: ['deleting', 'updated'],
			render(this: { room: object; $emit: (event: string, value: unknown) => void }) {
				return hh('div', [
					hh('button', { 'data-testid': 'info-delete', onClick: () => this.$emit('deleting', true) }),
					hh('button', { 'data-testid': 'info-archive', onClick: () => this.$emit('updated', { ...this.room, isArchived: true }) }),
				]);
			},
		},
	};
});
// 吹き出しは、受け取ったまとまりの位置を書き出し、描画した回数を数えるだけのものにする
vi.mock('@/pages/chat/XMessage.vue', async () => {
	const { defineComponent: define, h: hh } = await import('vue');
	return {
		default: define({
			props: {
				message: { type: Object, required: true },
				firstInGroup: { type: Boolean, default: true },
				lastInGroup: { type: Boolean, default: true },
				canEdit: { type: Boolean, default: false },
			},
			emits: ['edit'],
			setup(props, { emit }) {
				mocks.editMessage.value = () => emit('edit', props.message);
				return () => {
					const id = (props.message as { id: string }).id;
					mocks.renders.set(id, (mocks.renders.get(id) ?? 0) + 1);
					return hh('div', { 'data-testid': 'bubble', 'data-id': id, 'data-first': String(props.firstInGroup), 'data-last': String(props.lastInGroup), 'data-text': props.message.text, 'data-deleted': String(props.message.deletedAt != null), 'data-emojis': JSON.stringify(props.message.emojis), 'data-can-edit': String(props.canEdit) });
				};
			},
		}),
	};
});

import { provideMetadataReceiver } from '@/page.js';
import XRoomPage from '@/pages/chat/room.vue';
import { i18n } from '@/i18n.js';

const alert = mocks.alert;
const MINUTE = 60 * 1000;
const base = Date.parse('2026-10-27T12:00:00.000Z');
const userOf = (id: string) => ({ id, username: id, name: id, host: null });
const message = (id: string, fromUserId: string, after: number) => ({ id, fromUserId, fromUser: userOf(fromUserId), createdAt: new Date(base + after).toISOString(), text: id, reactions: [] });

const stubs = {
	// 本物と同じく、ページの中身はスクロールする箱に入る (新着時の追従がその箱を探す)
	PageWithHeader: { props: ['actions'], template: '<div style="overflow-y: scroll;"><button v-for="action in actions" :data-icon="action.icon" @click="action.handler($event)"></button><slot /><slot name="footer" /></div>' },
	MkStickyContainer: { template: '<div><slot name="header" /><slot /></div>' },
	MkLoading: { template: '<div></div>' },
	MkAvatar: true,
	// 本物の TransitionGroup で動かす (吹き出しに transition を付けるので、再描画の起き方が変わる)
	'transition-group': false,
	TransitionGroup: false,
};

async function flush() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

async function renderRoom(target: 'room' | 'user' = 'room') {
	const host = defineComponent({
		setup() {
			provideMetadataReceiver(() => {});
			return () => h(XRoomPage, target === 'room' ? { roomId: 'r1' } : { userId: 'alice' });
		},
	});
	const result = render(host, { global: { stubs, directives: { tooltip: {} } } });
	await flush();
	await flush();
	return result;
}

const bubbles = (container: Element) => [...container.querySelectorAll('[data-testid="bubble"]')].map(el => ({
	id: el.getAttribute('data-id'),
	first: el.getAttribute('data-first') === 'true',
	last: el.getAttribute('data-last') === 'true',
}));

beforeEach(() => {
	mocks.channel = new mocks.FakeChannel();
	mocks.renders.clear();
	mocks.roomIsArchived = false;
	mocks.roomOwnerId = 'owner';
	mocks.roomShowFails = false;
	mocks.routerPush.mockReset();
	mocks.alert.mockReset();
	mocks.confirm.mockReset().mockResolvedValue({ canceled: false });
	mocks.popupMenu.mockReset();
	mocks.apiWithDialog.mockReset().mockResolvedValue(undefined);
	mocks.selectUser.mockReset().mockResolvedValue({ id: 'invitee' });
	mocks.membersMounts.value = 0;
	// API は新しい順に返す
	mocks.timeline = [message('m3', 'alice', 2 * MINUTE), message('m2', 'alice', MINUTE), message('m1', 'bob', 0)];
});

afterEach(() => {
	cleanup();
});

describe('archived rooms on the room page', () => {
	const form = (container: Element) => container.querySelector('[data-testid="form"]');

	test('shows the message form in an active room', async () => {
		const { container } = await renderRoom();
		expect(form(container)).not.toBeNull();
	});

	test('replaces the message form with a notice in an archived room', async () => {
		mocks.roomIsArchived = true;
		const { container } = await renderRoom();
		expect(form(container)).toBeNull();
		expect(container.textContent).toContain(i18n.ts._chat.thisRoomIsArchived);
	});

	test('follows the archived state from the room stream', async () => {
		const { container } = await renderRoom();
		mocks.channel.emit('roomUpdated', { roomId: 'r1', name: 'room 1', description: '', isArchived: true });
		await flush();
		expect(form(container)).toBeNull();
		mocks.channel.emit('roomUpdated', { roomId: 'r1', name: 'room 1', description: '', isArchived: false });
		await flush();
		expect(form(container)).not.toBeNull();
	});
});

test('a removed member immediately loses the composer and returns to the chat list', async () => {
	const { container } = await renderRoom();
	mocks.channel.emit('membershipEnded', { userId: 'me' });
	await flush();
	expect(container.querySelector('[data-testid="form"]')).toBeNull();
	expect(mocks.routerPush).toHaveBeenCalledWith('/chat');
});

describe('leaving a room from the menu', () => {
	async function chooseLeave(container: Element) {
		await fireEvent.click(container.querySelector('[data-icon="ti ti-dots"]')!);
		const items = mocks.popupMenu.mock.lastCall![0] as { text: string; action: () => void }[];
		items.find(item => item.text === i18n.ts._chat.leave)!.action();
		await flush();
	}

	test('stays on the room when the request fails', async () => {
		mocks.apiWithDialog.mockRejectedValue(new Error('rate limit'));
		const { container } = await renderRoom();

		await chooseLeave(container);

		expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/leave', { roomId: 'r1' });
		expect(mocks.routerPush).not.toHaveBeenCalled();
		expect(container.querySelector('[data-testid="form"]')).not.toBeNull();
	});

	test('returns to the chat list when it succeeds', async () => {
		const { container } = await renderRoom();

		await chooseLeave(container);

		expect(mocks.routerPush).toHaveBeenCalledExactlyOnceWith('/chat');
	});

	test('my own leave arriving over the stream is not reported as being removed', async () => {
		let finish!: () => void;
		mocks.apiWithDialog.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
		const { container } = await renderRoom();

		await chooseLeave(container);
		mocks.channel.emit('membershipEnded', { userId: 'me' });
		await flush();
		finish();
		await flush();

		expect(mocks.alert).not.toHaveBeenCalled();
		expect(mocks.routerPush).toHaveBeenCalledExactlyOnceWith('/chat');
	});
});

test('another member leaving does not close my room', async () => {
	const { container } = await renderRoom();
	mocks.channel.emit('membershipEnded', { userId: 'someone-else' });
	await flush();
	expect(container.querySelector('[data-testid="form"]')).not.toBeNull();
	expect(mocks.routerPush).not.toHaveBeenCalled();
});

describe('a deleted room', () => {
	test('tells the member viewing it and returns to the chat list', async () => {
		const { container } = await renderRoom();
		mocks.channel.emit('roomDeleted', undefined);
		await flush();
		expect(alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.roomDeleted });
		expect(mocks.routerPush).toHaveBeenCalledWith('/chat');
		expect(container.querySelector('[data-testid="form"]')).toBeNull();
	});

	test('does not pull a member away from another page while it is cached', async () => {
		const visible = ref(true);
		const page = defineComponent({
			setup() {
				provideMetadataReceiver(() => {});
				return () => h(KeepAlive, null, { default: () => visible.value ? h(XRoomPage, { roomId: 'r1' }) : h('div') });
			},
		});
		const dispose = vi.spyOn(mocks.channel, 'dispose');
		render(page, { global: { stubs, directives: { tooltip: {} } } });
		await flush();
		await flush();
		visible.value = false;
		await flush();

		mocks.channel.emit('roomDeleted', undefined);
		await flush();

		expect(alert).not.toHaveBeenCalled();
		expect(mocks.routerPush).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalled();

		// 戻ってきたときに初めて知らせる
		visible.value = true;
		await flush();
		expect(alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.roomDeleted });
		expect(alert).toHaveBeenCalledTimes(1);
		expect(mocks.routerPush).toHaveBeenCalledWith('/chat');
	});

	test('does not announce the deletion to the member who is deleting it', async () => {
		const tabbedStubs = { ...stubs, PageWithHeader: { props: ['tab'], emits: ['update:tab'], template: '<div style="overflow-y: scroll;"><button data-testid="open-info" @click="$emit(\'update:tab\', \'info\')"/><slot /><slot name="footer" /></div>' } };
		const host = defineComponent({
			setup() {
				provideMetadataReceiver(() => {});
				return () => h(XRoomPage, { roomId: 'r1' });
			},
		});
		const { container } = render(host, { global: { stubs: tabbedStubs, directives: { tooltip: {} } } });
		await flush();
		await flush();
		await fireEvent.click(container.querySelector('[data-testid="open-info"]')!);
		await flush();
		await fireEvent.click(container.querySelector('[data-testid="info-delete"]')!);

		mocks.channel.emit('roomDeleted', undefined);
		await flush();

		expect(alert).not.toHaveBeenCalled();
	});
});

test('returning to a cached room after being removed explains why instead of showing an error', async () => {
	const visible = ref(true);
	const page = defineComponent({
		setup() {
			provideMetadataReceiver(() => {});
			return () => h(KeepAlive, null, { default: () => visible.value ? h(XRoomPage, { roomId: 'r1' }) : h('div') });
		},
	});
	render(page, { global: { stubs, directives: { tooltip: {} } } });
	await flush();
	await flush();
	visible.value = false;
	await flush();
	mocks.channel.emit('membershipEnded', { userId: 'me' });
	await flush();
	expect(alert).not.toHaveBeenCalled();

	mocks.roomShowFails = true;
	visible.value = true;
	await flush();
	await flush();

	expect(alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.removedFromRoom });
	expect(alert).toHaveBeenCalledTimes(1);
	expect(mocks.routerPush).toHaveBeenCalledWith('/chat');
});

test('archiving a room ends an edit in progress, so unarchiving does not reopen it', async () => {
	mocks.timeline = [message('m3', 'me', 2 * MINUTE)];
	const { container } = await renderRoom();
	mocks.editMessage.value?.();
	await flush();
	expect(container.querySelector('[data-testid="form"]')?.getAttribute('data-editing')).toBe('m3');

	mocks.channel.emit('roomUpdated', { roomId: 'r1', name: 'room 1', description: '', isArchived: true });
	await flush();
	mocks.channel.emit('roomUpdated', { roomId: 'r1', name: 'room 1', description: '', isArchived: false });
	await flush();

	expect(container.querySelector('[data-testid="form"]')?.getAttribute('data-editing')).toBe('');
});

test('archiving from the info tab also ends an edit in progress', async () => {
	mocks.timeline = [message('m3', 'me', 2 * MINUTE)];
	const tabbedStubs = { ...stubs, PageWithHeader: { props: ['tab'], emits: ['update:tab'], template: '<div style="overflow-y: scroll;"><button data-testid="open-info" @click="$emit(\'update:tab\', \'info\')"/><button data-testid="open-chat" @click="$emit(\'update:tab\', \'chat\')"/><slot /><slot name="footer" /></div>' } };
	const host = defineComponent({
		setup() {
			provideMetadataReceiver(() => {});
			return () => h(XRoomPage, { roomId: 'r1' });
		},
	});
	const { container } = render(host, { global: { stubs: tabbedStubs, directives: { tooltip: {} } } });
	await flush();
	await flush();
	mocks.editMessage.value?.();
	await flush();
	await fireEvent.click(container.querySelector('[data-testid="open-info"]')!);
	await flush();
	await fireEvent.click(container.querySelector('[data-testid="info-archive"]')!);
	await flush();
	mocks.channel.emit('roomUpdated', { roomId: 'r1', name: 'room 1', description: '', isArchived: false });
	await flush();
	await fireEvent.click(container.querySelector('[data-testid="open-chat"]')!);
	await flush();

	expect(container.querySelector('[data-testid="form"]')?.getAttribute('data-editing')).toBe('');
});

describe('inviting from an empty conversation', () => {
	const inviteButton = (container: Element) => [...container.querySelectorAll('button')].find(button => button.textContent?.includes(i18n.ts._chat.inviteUser));

	beforeEach(() => {
		mocks.timeline = [];
	});

	test('the owner can invite right where the hint is', async () => {
		mocks.roomOwnerId = 'me';
		const { container } = await renderRoom();

		await fireEvent.click(inviteButton(container)!);
		await flush();

		expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/invitations/create', { roomId: 'r1', userId: 'invitee' });
	});

	test('a member who cannot invite only sees the hint', async () => {
		const { container } = await renderRoom();

		expect(container.textContent).toContain(i18n.ts._chat.inviteUserToChat);
		expect(inviteButton(container)).toBeUndefined();
	});

	test('an owner whose chat is read-only is not offered a button that would fail', async () => {
		mocks.roomOwnerId = 'me';
		mocks.me.policies.chatAvailability = 'readonly';
		try {
			const { container } = await renderRoom();

			expect(inviteButton(container)).toBeUndefined();
		} finally {
			mocks.me.policies.chatAvailability = 'available';
		}
	});

	test('the owner cannot invite into an archived room', async () => {
		mocks.roomOwnerId = 'me';
		mocks.roomIsArchived = true;
		const { container } = await renderRoom();

		expect(inviteButton(container)).toBeUndefined();
	});
});

describe('inviting from the members tab', () => {
	async function openMembersTab() {
		const tabbedStubs = { ...stubs, PageWithHeader: { props: ['tab'], emits: ['update:tab'], template: '<div style="overflow-y: scroll;"><button data-testid="open-members" @click="$emit(\'update:tab\', \'members\')"/><slot /><slot name="footer" /></div>' } };
		const host = defineComponent({
			setup() {
				provideMetadataReceiver(() => {});
				return () => h(XRoomPage, { roomId: 'r1' });
			},
		});
		const { container } = render(host, { global: { stubs: tabbedStubs, directives: { tooltip: {} } } });
		await flush();
		await flush();
		await fireEvent.click(container.querySelector('[data-testid="open-members"]')!);
		await flush();
		expect(mocks.membersMounts.value).toBe(1);
		return container;
	}

	test('reloads the tab once the invitation exists, so it appears under sent invitations', async () => {
		const container = await openMembersTab();

		await fireEvent.click(container.querySelector('[data-testid="members-invite"]')!);
		await flush();

		expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/invitations/create', { roomId: 'r1', userId: 'invitee' });
		expect(mocks.membersMounts.value).toBe(2);
	});

	test('leaves the tab alone when the invitation fails', async () => {
		mocks.apiWithDialog.mockRejectedValue(new Error('request failed'));
		const container = await openMembersTab();

		await fireEvent.click(container.querySelector('[data-testid="members-invite"]')!);
		await flush();

		expect(mocks.membersMounts.value).toBe(1);
	});
});

test.each(['room', 'user'] as const)('the back button of a %s chat falls back to the chat list', async (target) => {
	const fallbackStubs = { ...stubs, PageWithHeader: { props: ['backFallback'], template: '<div style="overflow-y: scroll;" data-testid="page" :data-back-fallback="backFallback"><slot /><slot name="footer" /></div>' } };
	const host = defineComponent({
		setup() {
			provideMetadataReceiver(() => {});
			return () => h(XRoomPage, target === 'room' ? { roomId: 'r1' } : { userId: 'alice' });
		},
	});
	const { container } = render(host, { global: { stubs: fallbackStubs, directives: { tooltip: {} } } });
	await flush();

	expect(container.querySelector('[data-testid="page"]')?.getAttribute('data-back-fallback')).toBe('/chat');
});

test('rejoining a kicked room reinitializes its cached page and subscribes again', async () => {
	const visible = ref(true);
	const page = defineComponent({
		setup() {
			provideMetadataReceiver(() => {});
			return () => h(KeepAlive, null, { default: () => visible.value ? h(XRoomPage, { roomId: 'r1' }) : h('div') });
		},
	});
	const result = render(page, { global: { stubs } });
	await flush();
	await flush();
	mocks.channel.emit('membershipEnded', { userId: 'me' });
	await flush();
	expect(result.container.querySelector('[data-testid="form"]')).toBeNull();
	visible.value = false;
	await flush();
	mocks.channel = new mocks.FakeChannel();
	visible.value = true;
	await flush();
	await flush();
	expect(result.container.querySelector('[data-testid="form"]')).not.toBeNull();
	expect(mocks.channel.handlers.has('message')).toBe(true);
});

describe('chat bubbles on the room page', () => {
	test('enables editing for the conversation bubbles that have an edit handler', async () => {
		const { container } = await renderRoom();
		expect([...container.querySelectorAll('[data-testid="bubble"]')].every(el => el.getAttribute('data-can-edit') === 'true')).toBe(true);
	});

	test.each(['room', 'user'] as const)('refreshes emoji metadata on %s message updates and preserves it for older servers', async target => {
		mocks.timeline = [message('m1', 'alice', 0)];
		const { container } = await renderRoom(target);
		mocks.channel.emit('updated', { messageId: 'm1', text: ':new:', editedAt: '2026-11-01T00:00:00.000Z', emojis: { new: 'https://remote.test/new.png' } });
		await flush();
		const bubble = () => container.querySelector('[data-id="m1"]')!;
		expect(bubble().getAttribute('data-text')).toBe(':new:');
		expect(bubble().getAttribute('data-emojis')).toBe('{"new":"https://remote.test/new.png"}');
		mocks.channel.emit('updated', { messageId: 'm1', text: 'More :new:', editedAt: '2026-11-01T00:00:01.000Z' });
		await flush();
		expect(bubble().getAttribute('data-text')).toBe('More :new:');
		expect(bubble().getAttribute('data-emojis')).toBe('{"new":"https://remote.test/new.png"}');
	});

	test.each(['2026-11-01T00:00:00.000Z', '2026-11-01T00:00:01.000Z'])('does not overwrite a newer edit with a replay from %s', async editedAt => {
		mocks.timeline = [{ ...message('m1', 'alice', 0), text: 'Newest edit', editedAt: '2026-11-01T00:00:01.000Z' }];
		const { container } = await renderRoom();
		mocks.channel.emit('updated', { messageId: 'm1', text: 'Older edit', editedAt });
		await flush();
		expect(container.querySelector('[data-id="m1"]')!.getAttribute('data-text')).toBe('Newest edit');
	});

	test('passes the place in a group to each bubble as first/last flags', async () => {
		const { container } = await renderRoom();

		expect(bubbles(container)).toEqual([
			{ id: 'm1', first: true, last: true },
			{ id: 'm2', first: true, last: false },
			{ id: 'm3', first: false, last: true },
		]);
	});

	test('keeps same-sender bubbles separate across the room timeline date divider', async () => {
		// 日付境界をまたぐが、時間差はまとまりの範囲内に収める。
		const midnight = new Date(base);
		midnight.setHours(24, 0, 0, 0);
		const offset = midnight.getTime() - base;
		mocks.timeline = [message('m2', 'alice', offset), message('m1', 'alice', offset - MINUTE)];
		const { container } = await renderRoom();
		expect(bubbles(container)).toEqual([
			{ id: 'm1', first: true, last: true },
			{ id: 'm2', first: true, last: true },
		]);
	});

	test('a live deletion leaves the same placeholder as reloading the timeline', async () => {
		mocks.timeline = [message('m3', 'alice', 2 * MINUTE), message('m2', 'bob', MINUTE), message('m1', 'alice', 0)];
		const { container } = await renderRoom();
		mocks.channel.emit('deleted', 'm2');
		await flush();
		await waitFor(() => expect(container.querySelector('[data-id="m2"]')?.getAttribute('data-deleted')).toBe('true'));
		expect(container.querySelector('[data-id="m2"]')?.hasAttribute('data-text')).toBe(false);
		expect(bubbles(container).map(bubble => bubble.id)).toEqual(['m1', 'm2', 'm3']);
	});

	test.each(['room', 'user'] as const)('a delayed edit cannot restore deleted %s message content', async target => {
		mocks.timeline = [message('m1', 'alice', 0)];
		const { container } = await renderRoom(target);
		mocks.channel.emit('deleted', 'm1');
		mocks.channel.emit('updated', {
			messageId: 'm1',
			text: 'https://remote.test/deleted-content :wave:',
			editedAt: '2026-11-01T00:00:01.000Z',
			emojis: { wave: 'https://remote.test/wave.png' },
		});
		await flush();
		const bubble = container.querySelector('[data-id="m1"]')!;
		expect(bubble.getAttribute('data-deleted')).toBe('true');
		expect(bubble.hasAttribute('data-text')).toBe(false);
		expect(bubble.getAttribute('data-emojis')).toBe('{}');
	});

	test('a new message re-renders only the bubbles whose place in a group changed', async () => {
		const { container } = await renderRoom();
		const before = new Map(mocks.renders);

		// alice の続きなので、直前の m3 だけまとまりの最後でなくなる
		mocks.channel.emit('message', message('m4', 'alice', 3 * MINUTE));
		await flush();

		expect(bubbles(container).map(bubble => bubble.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
		expect(bubbles(container).find(bubble => bubble.id === 'm3')).toEqual({ id: 'm3', first: false, last: false });
		expect(mocks.renders.get('m1')).toBe(before.get('m1'));
		expect(mocks.renders.get('m2')).toBe(before.get('m2'));
		expect(mocks.renders.get('m3')).toBe(before.get('m3')! + 1);
		expect(mocks.renders.get('m4')).toBe(1);
	});
});
