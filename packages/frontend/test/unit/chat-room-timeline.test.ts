/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/vue';
import { defineComponent, h, nextTick } from 'vue';

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
		// 吹き出しごとの描画回数
		renders: new Map<string, number>(),
	};
});

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: vi.fn(async (endpoint: string) => {
		if (endpoint === 'chat/rooms/show') return { id: 'r1', name: 'room 1', ownerId: 'owner', owner: { id: 'owner', username: 'owner', host: null } };
		if (endpoint === 'chat/messages/room-timeline') return mocks.timeline;
		return [];
	}),
}));
vi.mock('@/stream.js', () => ({ useStream: () => ({ on: vi.fn(), off: vi.fn(), useChannel: () => mocks.channel }) }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: true, 'voiceCall.stageChatSide': 'right' }) }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/os.js', () => ({ alert: vi.fn(), confirm: vi.fn(), popupMenu: vi.fn() }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));
// 通話や入力欄は吹き出しのまとまりと関係ないので空にする
vi.mock('@/composables/use-chat-room-voice-call.js', async () => {
	const { computed } = await import('vue');
	return { useChatRoomVoiceCall: () => ({ available: computed(() => false), inThisCall: computed(() => false), participants: computed(() => []), showCard: computed(() => false), join: vi.fn() }) };
});
vi.mock('@/pages/chat/room.voice.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/room.form.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/room.search.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/room.members.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/room.info.vue', () => ({ default: { render: () => null } }));
// 吹き出しは、受け取ったまとまりの位置を書き出し、描画した回数を数えるだけのものにする
vi.mock('@/pages/chat/XMessage.vue', async () => {
	const { defineComponent: define, h: hh } = await import('vue');
	return {
		default: define({
			props: {
				message: { type: Object, required: true },
				firstInGroup: { type: Boolean, default: true },
				lastInGroup: { type: Boolean, default: true },
			},
			setup(props) {
				return () => {
					const id = (props.message as { id: string }).id;
					mocks.renders.set(id, (mocks.renders.get(id) ?? 0) + 1);
					return hh('div', { 'data-testid': 'bubble', 'data-id': id, 'data-first': String(props.firstInGroup), 'data-last': String(props.lastInGroup) });
				};
			},
		}),
	};
});

import { provideMetadataReceiver } from '@/page.js';
import XRoomPage from '@/pages/chat/room.vue';

const MINUTE = 60 * 1000;
const base = Date.parse('2026-10-27T12:00:00.000Z');
const userOf = (id: string) => ({ id, username: id, name: id, host: null });
const message = (id: string, fromUserId: string, after: number) => ({ id, fromUserId, fromUser: userOf(fromUserId), createdAt: new Date(base + after).toISOString(), text: id, reactions: [] });

const stubs = {
	// 本物と同じく、ページの中身はスクロールする箱に入る (新着時の追従がその箱を探す)
	PageWithHeader: { template: '<div style="overflow-y: scroll;"><slot /><slot name="footer" /></div>' },
	MkStickyContainer: { template: '<div><slot name="header" /><slot /></div>' },
	MkLoading: { template: '<div></div>' },
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

async function renderRoom() {
	const host = defineComponent({
		setup() {
			provideMetadataReceiver(() => {});
			return () => h(XRoomPage, { roomId: 'r1' });
		},
	});
	const result = render(host, { global: { stubs } });
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
	// API は新しい順に返す
	mocks.timeline = [message('m3', 'alice', 2 * MINUTE), message('m2', 'alice', MINUTE), message('m1', 'bob', 0)];
});

afterEach(() => {
	cleanup();
});

describe('chat bubbles on the room page', () => {
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

	test('updates group flags when a message between two senders is deleted', async () => {
		mocks.timeline = [message('m3', 'alice', 2 * MINUTE), message('m2', 'bob', MINUTE), message('m1', 'alice', 0)];
		const { container } = await renderRoom();
		mocks.channel.emit('deleted', 'm2');
		await flush();
		await waitFor(() => expect(bubbles(container)).toEqual([
			{ id: 'm1', first: true, last: false },
			{ id: 'm3', first: false, last: true },
		]));
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
