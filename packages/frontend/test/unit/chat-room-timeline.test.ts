/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { defineAsyncComponent, defineComponent, h, KeepAlive, nextTick, ref } from 'vue';

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
		me: { id: 'me', username: 'me', policies: { chatAvailability: 'available', canVoiceCall: false }, hasUnreadChatMessages: false },
		store: { realtimeMode: true },
		chatEventsActive: true,
		chatGap: false,
		refreshCurrentAccount: vi.fn(),
		timeline: [] as unknown[],
		roomMembers: [] as unknown[],
		sentInvitations: [] as unknown[],
		roomIsArchived: false,
		roomOwnerId: 'owner',
		roomShowFails: false,
		roomInvitationExists: false,
		roomShowError: null as Error | null,
		userShowError: null as Error | null,
		roomShowGate: null as Promise<void> | null,
		timelineGate: null as Promise<void> | null,
		timelineError: null as Error | null,
		streamOn: vi.fn(),
		streamOff: vi.fn(),
		routerPush: vi.fn(),
		routerReplace: vi.fn(),
		routerCurrent: { value: { route: { path: '/chat/room/:roomId' }, props: new Map<string, string>([['roomId', 'r1']]) } },
		alert: vi.fn(),
		confirm: vi.fn(),
		popupMenu: vi.fn(),
		apiWithDialog: vi.fn(),
		selectUsers: vi.fn(),
		success: vi.fn(),
		membersMounts: { value: 0 },
		editMessage: { value: null as (() => void) | null },
		sendFromForm: { value: null as ((id: string) => void) | null },
		// 吹き出しごとの描画回数
		renders: new Map<string, number>(),
	};
});

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: vi.fn(async (endpoint: string) => {
		if (endpoint.endsWith('-timeline') && mocks.timelineGate != null) await mocks.timelineGate;
		if (endpoint === 'chat/rooms/show' && mocks.roomShowGate != null) await mocks.roomShowGate;
		if (endpoint === 'chat/rooms/show' && mocks.roomShowFails) throw new Error('No such room.');
		if (endpoint === 'chat/rooms/show' && mocks.roomShowError != null) throw mocks.roomShowError;
		if (endpoint === 'chat/messages/room-timeline' && mocks.timelineError != null) throw mocks.timelineError;
		if (endpoint === 'chat/rooms/show') return { id: 'r1', name: 'room 1', ownerId: mocks.roomOwnerId, owner: { id: mocks.roomOwnerId, username: 'owner', host: null }, isArchived: mocks.roomIsArchived, invitationExists: mocks.roomInvitationExists };
		if (endpoint === 'users/show' && mocks.userShowError != null) throw mocks.userShowError;
		if (endpoint === 'users/show') return { id: 'alice', username: 'alice', host: null };
		if (endpoint === 'chat/messages/room-timeline' || endpoint === 'chat/messages/user-timeline') return mocks.timeline;
		if (endpoint === 'chat/rooms/members') return mocks.roomMembers;
		if (endpoint === 'chat/rooms/invitations/outbox') return mocks.sentInvitations;
		return [];
	}),
}));
vi.mock('@/stream.js', () => ({ useStream: () => ({ on: mocks.streamOn, off: mocks.streamOff, useChannel: () => mocks.channel, state: 'connected' }) }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({ animation: true, 'voiceCall.stageChatSide': 'right' }) }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/store.js', () => ({ store: { s: mocks.store } }));
vi.mock('@/accounts.js', () => ({ refreshCurrentAccount: mocks.refreshCurrentAccount }));
// 購読の空白は会話画面の外で覚えている。試験ではその状態を直接置く
vi.mock('@/chat-unread-subscription.js', () => ({
	chatUnreadEventsActive: () => mocks.chatEventsActive,
	chatUnreadSubscriptionGap: () => mocks.chatGap,
	resolveChatUnreadGap: () => { mocks.chatGap = false; },
	beginChatUnreadRecheck: () => { mocks.chatGap = false; return { issue: true, failToken: 1 }; },
	restoreChatUnreadGapIfUnchanged: () => { mocks.chatGap = true; },
}));
vi.mock('@/os.js', () => ({ alert: mocks.alert, confirm: mocks.confirm, popupMenu: mocks.popupMenu, apiWithDialog: mocks.apiWithDialog, selectUsers: mocks.selectUsers, success: mocks.success, promiseDialog: (promise: Promise<unknown>) => promise }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerReplace, useListener: vi.fn(), currentRef: mocks.routerCurrent }) }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfx: vi.fn() }));
// 通話や入力欄は吹き出しのまとまりと関係ないので空にする
vi.mock('@/composables/use-chat-room-voice-call.js', async () => {
	const { computed } = await import('vue');
	return { useChatRoomVoiceCall: () => ({ available: computed(() => false), inThisCall: computed(() => false), participants: computed(() => []), join: vi.fn() }) };
});
vi.mock('@/pages/chat/room.form.vue', async () => {
	const { h: hh } = await import('vue');
	return {
		default: {
			props: ['editingMessage'],
			emits: ['sent'],
			setup(_: unknown, { emit }: { emit: (event: 'sent', id: string) => void }) {
				mocks.sendFromForm.value = id => emit('sent', id);
			},
			render(this: { editingMessage: { id: string } | null }) { return hh('div', { 'data-testid': 'form', 'data-editing': this.editingMessage?.id ?? '' }); },
		},
	};
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
					return hh('div', { 'data-testid': 'bubble', 'data-id': id, 'data-first': String(props.firstInGroup), 'data-last': String(props.lastInGroup), 'data-text': props.message.text, 'data-reactions': JSON.stringify(props.message.reactions.map((r: { reaction: string; user: { id: string } }) => `${r.reaction}/${r.user.id}`)), 'data-deleted': String(props.message.deletedAt != null), 'data-emojis': JSON.stringify(props.message.emojis), 'data-can-edit': String(props.canEdit) });
				};
			},
		}),
	};
});

import { provideMetadataReceiver } from '@/page.js';
import XRoomPage from '@/pages/chat/room.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { chatLeaveErrors } from '@/pages/chat/chat-errors.js';
import { installFakeResizeObserver, resizeObserved } from './fake-resize-observer.js';

// ルーターはページを非同期コンポーネントに包んでからキャッシュする (router.definition.ts の page())。
// 包まれたページの onActivated を、Vue はページが登録したのと逆の順に呼ぶ。キャッシュから戻る試験は、ルーターと同じ形で置いて確かめる
const RoutedRoomPage = defineAsyncComponent(() => Promise.resolve(XRoomPage));

const apiMock = vi.mocked(misskeyApi).getMockImplementation()!;

const alert = mocks.alert;
const MINUTE = 60 * 1000;
const base = Date.parse('2026-10-27T12:00:00.000Z');
const userOf = (id: string) => ({ id, username: id, name: id, host: null });
const message = (id: string, fromUserId: string, after: number) => ({ id, fromUserId, fromUser: userOf(fromUserId), createdAt: new Date(base + after).toISOString(), text: id, reactions: [] });

const stubs = {
	// 本物と同じく、ページの中身はスクロールする箱に入る (新着時の追従がその箱を探す)
	PageWithHeader: { props: ['actions', 'tab'], emits: ['update:tab'], template: '<div style="overflow-y: scroll;"><button v-for="action in actions" :data-icon="action.icon" @click="action.handler($event)"></button><button v-if="tab !== \'chat\'" data-testid="back-to-chat" @click="$emit(\'update:tab\', \'chat\')"></button><slot /><slot name="footer" /></div>' },
	MkStickyContainer: { template: '<div><slot name="header" /><slot /></div>' },
	MkLoading: { template: '<div></div>' },
	MkResult: { props: ['type'], template: '<div role="alert" :data-result-type="type"></div>' },
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
	mocks.routerCurrent.value = target === 'room'
		? { route: { path: '/chat/room/:roomId' }, props: new Map<string, string>([['roomId', 'r1']]) }
		: { route: { path: '/chat/user/:userId' }, props: new Map<string, string>([['userId', 'alice']]) };
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
	mocks.roomInvitationExists = false;
	mocks.roomShowError = null;
	mocks.userShowError = null;
	mocks.roomShowGate = null;
	mocks.timelineGate = null;
	mocks.timelineError = null;
	mocks.roomMembers = [];
	mocks.sentInvitations = [];
	mocks.streamOn.mockReset();
	mocks.streamOff.mockReset();
	mocks.routerPush.mockReset();
	mocks.routerReplace.mockReset();
	mocks.alert.mockReset();
	mocks.confirm.mockReset().mockResolvedValue({ canceled: false });
	mocks.popupMenu.mockReset();
	mocks.apiWithDialog.mockReset().mockResolvedValue(undefined);
	mocks.selectUsers.mockReset().mockResolvedValue([{ id: 'invitee', username: 'invitee', host: null, name: null }]);
	mocks.membersMounts.value = 0;
	mocks.me.hasUnreadChatMessages = false;
	mocks.store.realtimeMode = true;
	mocks.chatEventsActive = true;
	mocks.chatGap = false;
	mocks.refreshCurrentAccount.mockReset().mockResolvedValue(undefined);
	// API は新しい順に返す
	mocks.timeline = [message('m3', 'alice', 2 * MINUTE), message('m2', 'alice', MINUTE), message('m1', 'bob', 0)];
});

afterEach(() => {
	cleanup();
});

describe('following the newest message', () => {
	const FULL_PAGE = 20;

	// column-reverse: scrollTop is 0 at the newest message and negative above it.
	function positionScroller(container: Element, scrollTop: number) {
		const scroller = container.querySelector<HTMLElement>('[style*="overflow-y"]')!;
		Object.defineProperty(scroller, 'scrollTop', { value: scrollTop, configurable: true, writable: true });
		const scrollTo = vi.fn();
		scroller.scrollTo = scrollTo as typeof scroller.scrollTo;
		return scrollTo;
	}

	const moreButton = (container: Element) => [...container.querySelectorAll('button')].find(button => button.textContent.includes(i18n.ts.loadMore))!;
	const notice = (container: Element) => [...container.querySelectorAll('button')].find(button => button.textContent.includes(i18n.ts._chat.newMessage));
	const noticeShown = (container: Element) => {
		const shown = notice(container);
		return shown != null && shown.closest<HTMLElement>('[style*="display: none"]') == null;
	};

	async function arrive(newMessage: ReturnType<typeof message>) {
		mocks.channel.emit('message', newMessage);
		await flush();
		await flush();
	}

	async function readAgainAfterReconnect() {
		for (const [event, handler] of mocks.streamOn.mock.calls) {
			if (event === '_connected_') handler();
		}
		await flush();
		await flush();
	}

	beforeEach(() => {
		// Reading again sorts by id as text, as real ids sort.
		mocks.timeline = Array.from({ length: FULL_PAGE }, (_, i) => message(`m${String(100 - i).padStart(3, '0')}`, 'alice', (FULL_PAGE - i) * MINUTE));
	});

	test('follows a new message near the newest one', async () => {
		const { container } = await renderRoom();
		const scrollTo = positionScroller(container, -100);

		mocks.channel.emit('message', message('m101', 'alice', 100 * MINUTE));
		await flush();
		await flush();

		expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'instant' });
	});

	test('leaves someone reading far above alone', async () => {
		const { container } = await renderRoom();
		const scrollTo = positionScroller(container, -1000);

		mocks.channel.emit('message', message('m101', 'alice', 100 * MINUTE));
		await flush();
		await flush();

		expect(scrollTo).not.toHaveBeenCalled();
	});

	// The press draws a ripple inside the button. Scrolling for it moved the button away before the release, so no click happened.
	test('does not move a button while it is being pressed', async () => {
		const { container } = await renderRoom();
		const scrollTo = positionScroller(container, -167);

		await fireEvent.mouseDown(moreButton(container));
		await flush();
		await flush();

		expect(container.querySelector('[class*="ripple"] > *')).not.toBeNull();
		expect(scrollTo).not.toHaveBeenCalled();
	});

	test.each(['room', 'user'] as const)('asks for the marker of a deleted message, in a %s and in what loads later', async (target) => {
		const endpoint = target === 'room' ? 'chat/messages/room-timeline' : 'chat/messages/user-timeline';
		const { container } = await renderRoom(target);
		mocks.timeline = [message('m80', 'alice', 0)];

		await fireEvent.click(moreButton(container));
		await flush();

		const requests = vi.mocked(misskeyApi).mock.calls.filter(([called]) => called === endpoint).map(([, params]) => params);
		expect(requests.length).toBeGreaterThanOrEqual(2);
		expect(requests.every(params => (params as { includeDeleted?: boolean }).includeDeleted === true)).toBe(true);
	});

	test('stays in place when earlier messages load', async () => {
		const { container } = await renderRoom();
		const scrollTo = positionScroller(container, -167);
		mocks.timeline = [message('m80', 'alice', 0)];

		await fireEvent.click(moreButton(container));
		await flush();
		await flush();

		expect(container.querySelector('[data-id="m80"]')).not.toBeNull();
		expect(scrollTo).not.toHaveBeenCalled();
	});

	// The joint gets lower as it joins a group, and a browser that keeps its place by that bubble moves everything below it.
	test('puts back what the browser moved when earlier messages load', async () => {
		const { container } = await renderRoom();
		const scroller = container.querySelector<HTMLElement>('[style*="overflow-y"]')!;
		const written: number[] = [];
		Object.defineProperty(scroller, 'scrollTop', {
			get: () => container.querySelector('[data-id="m80"]') != null ? -2377 : -2396,
			set: (value: number) => { written.push(value); },
			configurable: true,
		});
		mocks.timeline = [message('m80', 'alice', 0)];

		await fireEvent.click(moreButton(container));
		await flush();
		await flush();

		expect(written).toEqual([-2396]);
	});

	test('still follows the first new message after earlier ones loaded', async () => {
		const { container } = await renderRoom();
		const scrollTo = positionScroller(container, -100);
		mocks.timeline = [message('m80', 'alice', 0)];
		await fireEvent.click(moreButton(container));
		await flush();
		await flush();

		mocks.channel.emit('message', message('m101', 'alice', 100 * MINUTE));
		await flush();
		await flush();

		expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'instant' });
	});

	// The browser keeps the place by moving scrollTop as soon as the new message is laid out, so it has to be read before that.
	test('follows a tall new message from near the newest one, though the browser has moved the position by then', async () => {
		const { container } = await renderRoom();
		const scroller = container.querySelector<HTMLElement>('[style*="overflow-y"]')!;
		Object.defineProperty(scroller, 'scrollTop', { get: () => container.querySelector('[data-id="m101"]') != null ? -646 : -100, configurable: true });
		const scrollTo = vi.fn();
		scroller.scrollTo = scrollTo as typeof scroller.scrollTo;

		await arrive(message('m101', 'alice', 100 * MINUTE));

		expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'instant' });
		expect(noticeShown(container)).toBe(false);
	});

	describe('a message sent from this window', () => {
		test('goes to the newest message from far above, when the answer to the send comes first', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);

			mocks.sendFromForm.value!('m101');
			await flush();
			// It is not on the screen yet, so there is nothing to go to.
			expect(scrollTo).not.toHaveBeenCalled();

			await arrive(message('m101', 'me', 100 * MINUTE));

			expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'instant' });
		});

		test('goes to the newest message from far above, when the message comes first', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);

			await arrive(message('m101', 'me', 100 * MINUTE));
			// Until the answer comes, it could have been sent from anywhere.
			expect(scrollTo).not.toHaveBeenCalled();

			mocks.sendFromForm.value!('m101');
			await flush();

			expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'instant' });
		});

		test('still goes there when someone else got in between, and that notice goes too', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);

			mocks.sendFromForm.value!('m101');
			await arrive(message('m102', 'alice', 101 * MINUTE));
			expect(scrollTo).not.toHaveBeenCalled();
			expect(noticeShown(container)).toBe(true);

			await arrive(message('m101', 'me', 100 * MINUTE));

			expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'instant' });
			expect(noticeShown(container)).toBe(false);
		});

		test('goes there when only reading again brings it', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);

			mocks.sendFromForm.value!('m101');
			await flush();
			mocks.timeline = [message('m101', 'me', 100 * MINUTE), ...mocks.timeline];
			await readAgainAfterReconnect();

			expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'instant' });
		});

		test('goes there only once, so that reading on afterwards stays possible', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);
			mocks.sendFromForm.value!('m101');
			await arrive(message('m101', 'me', 100 * MINUTE));
			scrollTo.mockClear();

			await readAgainAfterReconnect();
			mocks.channel.emit('react', { messageId: 'm101', reaction: '👍', user: userOf('alice') });
			await flush();

			expect(scrollTo).not.toHaveBeenCalled();
		});
	});

	describe('leaves someone reading far above where they are', () => {
		test('when a message of mine comes from another device or tab, and says nothing of it', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);

			await arrive(message('m101', 'me', 100 * MINUTE));

			expect(scrollTo).not.toHaveBeenCalled();
			expect(noticeShown(container)).toBe(false);
		});

		test.each([
			['an edit', 'updated', { messageId: 'm100', text: 'changed', editedAt: new Date(base + 200 * MINUTE).toISOString() }],
			['a reaction', 'react', { messageId: 'm100', reaction: '👍', user: userOf('alice') }],
			['a reaction taken back', 'unreact', { messageId: 'm100', reaction: '👍', user: userOf('alice') }],
			['a deletion', 'deleted', 'm100'],
		] as const)('when %s comes for the newest message, and says nothing of it', async (_what, event, payload) => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);

			mocks.channel.emit(event, payload);
			await flush();
			await flush();

			expect(scrollTo).not.toHaveBeenCalled();
			expect(noticeShown(container)).toBe(false);
		});

		test('when reading again after a reconnect brings nothing new, and says nothing of it', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);

			await readAgainAfterReconnect();

			expect(scrollTo).not.toHaveBeenCalled();
			expect(noticeShown(container)).toBe(false);
		});
	});

	// Safari up to 18 has no scroll anchoring: a message arriving below the reader keeps scrollTop and pushes the place up by its height.
	// Chromium and Safari 27 have it, but leave some things alone that get shorter below the reader.
	describe('keeping the place of someone reading far above', () => {
		const ITEM_HEIGHT = 100;
		const VIEW_BOTTOM = 800;
		// Longer than a scroll takes to count as over
		const AFTER_SCROLLING = 170;
		const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

		let heights: Map<string, number>;
		let restoreLayout: (() => void) | null = null;

		// happy-dom lays nothing out, so this computes what column-reverse does: the content hangs from the bottom edge of the
		// scroller, scrollTop is the distance from there, and nothing moves scrollTop unless someone writes it.
		// With anchoring, the browser keeps the topmost message it shows in place whenever the layout is read, as Chromium and Safari 27 do.
		// 'growth-only' leaves something that got shorter alone, and a number makes up for only that part of it.
		function layOut(container: Element, options: { roundsScrollTop?: boolean; anchoring?: 'full' | 'growth-only' | number } = {}) {
			const scroller = container.querySelector<HTMLElement>('[style*="overflow-y"]')!;
			const written: number[] = [];
			let top = 0;
			let below = 0;
			let edgeMoved = 0;
			let shortened = 0;
			// A browser tells about a scroll later, in the next frame
			const tell = () => { setTimeout(() => { scroller.dispatchEvent(new Event('scroll')); }, 0); };
			Object.defineProperty(scroller, 'scrollTop', {
				get: () => {
					layOutAgain();
					return top;
				},
				set: (value: number) => {
					written.push(value);
					top = options.roundsScrollTop ? Math.round(value) : value;
					anchorAgain();
					tell();
				},
				configurable: true,
			});
			scroller.scrollTo = ((to: ScrollToOptions) => { top = to.top!; anchorAgain(); tell(); }) as typeof scroller.scrollTo;

			const heightOf = (item: Element) => heights.get(item.querySelector('[data-testid="bubble"]')?.getAttribute('data-id') ?? '') ?? ITEM_HEIGHT;
			const isItem = (el: Element) => el.firstElementChild?.getAttribute('data-testid') === 'bubble';
			const bottomOf = (item: Element) => {
				let bottom = VIEW_BOTTOM - top - below - shortened;
				for (let next = item.nextElementSibling; next != null; next = next.nextElementSibling) bottom -= heightOf(next);
				return bottom;
			};
			const topmostShown = () => [...container.querySelector('[data-testid="bubble"]')?.parentElement?.parentElement?.children ?? []].find(item => isItem(item) && bottomOf(item) > 0) ?? null;
			let anchored: { item: Element; top: number } | null = null;
			const anchorAgain = () => {
				const item = topmostShown();
				anchored = item == null ? null : { item, top: bottomOf(item) - heightOf(item) };
			};
			const layOutAgain = () => {
				if (options.anchoring == null) return;
				if (anchored != null && anchored.item.isConnected && top !== 0) {
					const shift = bottomOf(anchored.item) - heightOf(anchored.item) - anchored.top;
					const share = shift <= 0 || options.anchoring === 'full' ? 1 : options.anchoring === 'growth-only' ? 0 : options.anchoring;
					if (Math.abs(shift * share) > 0.001) {
						top += shift * share;
						tell();
					}
				}
				anchorAgain();
			};
			const spy = vi.spyOn(window.Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
				const box = (from: number, to: number) => ({ top: from, bottom: to, left: 0, right: 0, x: 0, y: from, width: 0, height: to - from, toJSON: () => ({}) }) as DOMRect;
				layOutAgain();
				if (this === scroller) return box(0, VIEW_BOTTOM + edgeMoved);
				if (!isItem(this)) return box(0, 0);
				const bottom = bottomOf(this);
				const sliding = Number((this as HTMLElement).style.transform.match(/, ([\d.-]+)\)$/)?.[1] ?? 0);
				return box(bottom - heightOf(this) + sliding, bottom + sliding);
			});
			restoreLayout = () => spy.mockRestore();

			return {
				scroller,
				written,
				scrollTop: () => top,
				growBelow: (height: number) => { below += height; },
				moveBottomEdge: (height: number) => { edgeMoved += height; },
				shortenFromBelow: (height: number) => { shortened += height; edgeMoved -= height; },
				topOf: (id: string) => container.querySelector(`[data-id="${id}"]`)!.parentElement!.getBoundingClientRect().top,
				// Scrolling by hand, without writing scrollTop
				// A scroll that the browser has not told about yet
				jumpTo(scrollTop: number) {
					top = scrollTop;
					anchorAgain();
				},
				async scrollBy(distance: number) {
					top += distance;
					anchorAgain();
					scroller.dispatchEvent(new Event('scroll'));
					await flush();
				},
				async readAt(scrollTop: number) {
					top = scrollTop;
					anchorAgain();
					scroller.dispatchEvent(new Event('scroll'));
					await wait(AFTER_SCROLLING);
				},
			};
		}

		const CONTENT_RESIZED = 1000;

		beforeEach(() => {
			heights = new Map();
			installFakeResizeObserver();
		});

		afterEach(() => {
			restoreLayout?.();
			restoreLayout = null;
			vi.unstubAllGlobals();
		});

		test.each([
			['from someone else', 'alice'],
			['of mine from another device', 'me'],
		])('keeps the place when a message comes %s', async (_what, fromUserId) => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);
			const place = layout.topOf('m090');

			heights.set('m101', 160);
			await arrive(message('m101', fromUserId, 100 * MINUTE));

			expect(layout.topOf('m090')).toBe(place);
			expect(layout.scrollTop()).toBe(-1160);
		});

		test('keeps the place when reading again after a reconnect brings what was missed', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);
			const place = layout.topOf('m090');

			mocks.timeline = [message('m102', 'alice', 102 * MINUTE), message('m101', 'alice', 101 * MINUTE), ...mocks.timeline as ReturnType<typeof message>[]].slice(0, FULL_PAGE);
			await readAgainAfterReconnect();

			expect(layout.topOf('m090')).toBe(place);
		});

		// An edit, a reaction, a deletion or a picture that loads late only changes a height, which the observer tells about
		test.each([
			['grows', 260],
			['shrinks', 40],
		])('keeps the place when a message below it %s', async (_what, height) => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);
			const place = layout.topOf('m090');

			heights.set('m100', height);
			resizeObserved(CONTENT_RESIZED);
			await flush();

			expect(layout.topOf('m090')).toBe(place);
		});

		// The message box is stuck to the bottom of the same scroller and grows with what is typed in it
		test('keeps the place when something else inside the scroller grows below it, and does not jump at the next message', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);
			const place = layout.topOf('m090');
			const content = container.querySelector('[class*="chatTab"]')!;

			layout.growBelow(60);
			resizeObserved(CONTENT_RESIZED, content);
			await flush();
			expect(layout.topOf('m090')).toBe(place);

			await arrive(message('m101', 'alice', 101 * MINUTE));
			expect(layout.topOf('m090')).toBe(place);
		});

		// On a phone the bottom edge of the scroller and the message box move together when the box takes the focus, and nothing on screen moves
		test('writes nothing when the scroller changes but the place stays where it is on screen', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);
			const finger = container.querySelector('[data-id="m090"]')!;

			await fireEvent.touchStart(finger);
			layout.moveBottomEdge(56);
			await fireEvent.touchEnd(finger, { touches: [] });
			resizeObserved(CONTENT_RESIZED, layout.scroller);
			await flush();

			expect(layout.written).toEqual([]);
		});

		test('keeps the place when the scroller itself gets shorter and takes the content up with its bottom edge', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);
			const place = layout.topOf('m090');

			layout.shortenFromBelow(60);
			resizeObserved(CONTENT_RESIZED, layout.scroller);
			await flush();

			expect(layout.topOf('m090')).toBe(place);
		});

		test('does not drift over many messages when the browser rounds scrollTop', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container, { roundsScrollTop: true });
			await layout.readAt(-1000);
			const place = layout.topOf('m090');

			for (let i = 1; i <= 6; i++) {
				heights.set(`m1${String(i).padStart(2, '0')}`, 41.3);
				await arrive(message(`m1${String(i).padStart(2, '0')}`, 'alice', (100 + i) * MINUTE));
				// The scroll event of the write comes in between
				await wait(5);
			}

			expect(Math.abs(layout.topOf('m090') - place)).toBeLessThanOrEqual(0.5);
		});

		test('keeps up with messages that come right after each other', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);
			const place = layout.topOf('m090');

			await arrive(message('m101', 'alice', 101 * MINUTE));
			await wait(5);
			await arrive(message('m102', 'alice', 102 * MINUTE));

			expect(layout.topOf('m090')).toBe(place);
		});

		// The scroll is told in the next frame, and a message can come before that
		test.each([
			['without', undefined],
			['with', 'full'],
		] as const)('follows a message that comes right after going to the newest message, %s scroll anchoring', async (_with, anchoring) => {
			const { container } = await renderRoom();
			const layout = layOut(container, { anchoring });
			await layout.readAt(-1000);

			layout.jumpTo(0);
			await arrive(message('m101', 'alice', 101 * MINUTE));

			expect(layout.scrollTop()).toBe(0);
		});

		test('follows near the newest message as before, writing nothing of its own', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-100);

			await arrive(message('m101', 'alice', 101 * MINUTE));

			expect(layout.scrollTop()).toBe(0);
			expect(layout.written).toEqual([]);
		});

		test('leaves a change alone near the newest message', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-100);

			heights.set('m100', 260);
			resizeObserved(CONTENT_RESIZED);
			await flush();

			expect(layout.written).toEqual([]);
		});

		test.each([
			['the answer to the send', true],
			['the message', false],
		])('goes to the newest message after sending from here, when %s comes first', async (_first, answerFirst) => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);

			if (answerFirst) mocks.sendFromForm.value!('m101');
			await arrive(message('m101', 'me', 101 * MINUTE));
			if (!answerFirst) mocks.sendFromForm.value!('m101');
			await flush();
			await flush();
			await wait(AFTER_SCROLLING);

			expect(layout.scrollTop()).toBe(0);
		});

		test('goes to the newest message when the notice is pressed, and follows from there', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);
			await arrive(message('m101', 'alice', 101 * MINUTE));

			await fireEvent.click(notice(container)!);
			await wait(AFTER_SCROLLING);
			await arrive(message('m102', 'alice', 102 * MINUTE));

			expect(layout.scrollTop()).toBe(0);
		});

		// Writing scrollTop under a finger or during momentum stops the scroll on iOS
		test('writes nothing while a finger is on the screen, and puts the place back when it lifts', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);
			const place = layout.topOf('m090');
			const finger = container.querySelector('[data-id="m090"]')!;

			await fireEvent.touchStart(finger);
			await arrive(message('m101', 'alice', 101 * MINUTE));
			heights.set('m100', 260);
			resizeObserved(CONTENT_RESIZED);
			await flush();
			expect(layout.written).toEqual([]);

			await fireEvent.touchEnd(finger, { touches: [] });
			expect(layout.topOf('m090')).toBe(place);
		});

		test('writes nothing while the page keeps scrolling after the finger left, nor when it stops', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);

			await layout.scrollBy(-30);
			await arrive(message('m101', 'alice', 101 * MINUTE));
			await layout.scrollBy(-30);
			heights.set('m100', 260);
			resizeObserved(CONTENT_RESIZED);
			await flush();
			await layout.scrollBy(-30);
			await wait(AFTER_SCROLLING);

			// A jump at the moment it stops would be worse than the one that already happened
			expect(layout.written).toEqual([]);
		});

		test('keeps the place it stopped at once scrolling is over', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);
			await layout.scrollBy(-40);
			await wait(AFTER_SCROLLING);
			const place = layout.topOf('m090');

			await arrive(message('m101', 'alice', 101 * MINUTE));

			expect(layout.topOf('m090')).toBe(place);
		});

		// When the content gets shorter under someone at the very top, the browser pulls scrollTop in by itself and tells about it like about any scroll
		test('does not take that for scrolling when the browser pulls scrollTop in and the place stays on screen', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);
			const place = layout.topOf('m090');

			heights.set('m100', 40);
			await layout.scrollBy(60);
			expect(layout.topOf('m090')).toBe(place);
			await arrive(message('m101', 'alice', 101 * MINUTE));

			expect(layout.topOf('m090')).toBe(place);
		});

		// The joint gets lower as it joins a group. The place is below it and does not move, so nothing should correct for it
		test('writes nothing when earlier messages load, then or afterwards', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1200);
			const below = layout.topOf('m090');
			mocks.timeline = [message('m80', 'alice', 0)];
			heights.set('m081', 60);

			await fireEvent.click(moreButton(container));
			await flush();
			await flush();
			resizeObserved(CONTENT_RESIZED);
			await flush();

			expect(container.querySelector('[data-id="m80"]')).not.toBeNull();
			expect(layout.written).toEqual([]);
			expect(layout.topOf('m090')).toBe(below);
		});

		// The button goes before the earlier messages come in. TransitionGroup measures in between, and the browser pulls in a reader at the very top.
		test('puts back what the browser moved when the last earlier messages load', async () => {
			const { container } = await renderRoom();
			const scroller = container.querySelector<HTMLElement>('[style*="overflow-y"]')!;
			const written: number[] = [];
			let top = -1200;
			let pulledIn = false;
			Object.defineProperty(scroller, 'scrollTop', {
				get: () => {
					if (!pulledIn && container.querySelector('[data-id="m80"]') != null) {
						pulledIn = true;
						top = -1158;
					}
					return top;
				},
				set: (value: number) => { written.push(value); top = value; },
				configurable: true,
			});
			mocks.timeline = [message('m80', 'alice', 0)];

			await fireEvent.click(moreButton(container));
			await flush();
			await flush();

			expect(written).toEqual([-1200]);
		});

		// TransitionGroup slides a moved bubble from where it was with a transform that ends at nothing
		test('is not fooled by a bubble still sliding into place', async () => {
			vi.stubGlobal('DOMMatrixReadOnly', class { m42: number; constructor(transform: string) { this.m42 = Number(transform.match(/, ([\d.-]+)\)$/)![1]); } });
			const { container } = await renderRoom();
			const layout = layOut(container);
			const topmost = container.querySelector('[data-id="m082"]')!.parentElement!;
			topmost.style.transform = 'matrix(1, 0, 0, 1, 0, 42)';
			await layout.readAt(-1000);

			topmost.style.transform = 'matrix(1, 0, 0, 1, 0, 10)';
			resizeObserved(CONTENT_RESIZED);
			await flush();
			topmost.style.transform = '';
			resizeObserved(CONTENT_RESIZED);
			await flush();

			expect(layout.written).toEqual([]);
		});

		// Chromium and Safari 27 keep the place themselves when something below grows. Doing it again would move it twice
		test('writes nothing when the browser keeps the place itself', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container, { anchoring: 'full' });
			await layout.readAt(-1000);
			const place = layout.topOf('m090');

			heights.set('m101', 160);
			await arrive(message('m101', 'alice', 101 * MINUTE));
			heights.set('m100', 260);
			resizeObserved(CONTENT_RESIZED);
			await flush();
			heights.set('m100', 40);
			resizeObserved(CONTENT_RESIZED);
			await flush();
			await wait(5);

			expect(layout.topOf('m090')).toBe(place);
			expect(layout.written).toEqual([]);
		});

		// They leave alone a reaction taken back or an edit that shortens a message, or make up for only part of it
		test.each([
			['leaves it alone', 'growth-only'],
			['makes up for only part of it', 0.16],
		] as const)('keeps the place when something below gets shorter and the browser %s', async (_what, anchoring) => {
			const { container } = await renderRoom();
			const layout = layOut(container, { anchoring });
			await layout.readAt(-1000);
			const place = layout.topOf('m090');

			heights.set('m100', 40);
			resizeObserved(CONTENT_RESIZED);
			await flush();
			await wait(5);

			expect(layout.topOf('m090')).toBe(place);
		});

		// The browser keeps the place when the layout is read, and tells about it like about a scroll, before the observer is called
		test('does not take the scroll of the browser keeping the place for the reader scrolling', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container, { anchoring: 0.16 });
			await layout.readAt(-1000);
			const place = layout.topOf('m090');

			heights.set('m100', 40);
			layout.topOf('m095');
			await wait(5);
			resizeObserved(CONTENT_RESIZED);
			await flush();

			expect(layout.topOf('m090')).toBe(place);
		});

		test('keeps the place when something below gets shorter and a message comes right after', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container, { anchoring: 'growth-only' });
			await layout.readAt(-1000);
			const place = layout.topOf('m090');

			heights.set('m100', 40);
			resizeObserved(CONTENT_RESIZED);
			await arrive(message('m101', 'alice', 101 * MINUTE));
			await wait(5);

			expect(layout.topOf('m090')).toBe(place);
		});

		test('follows near the newest message in such a browser too, writing nothing of its own', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container, { anchoring: 'growth-only' });
			await layout.readAt(-100);

			heights.set('m100', 40);
			resizeObserved(CONTENT_RESIZED);
			await flush();
			await arrive(message('m101', 'alice', 101 * MINUTE));

			expect(layout.scrollTop()).toBe(0);
			expect(layout.written).toEqual([]);
		});

		test('goes to the newest message after sending from here in such a browser too', async () => {
			const { container } = await renderRoom();
			const layout = layOut(container, { anchoring: 'growth-only' });
			await layout.readAt(-1000);

			mocks.sendFromForm.value!('m101');
			await arrive(message('m101', 'me', 101 * MINUTE));
			await wait(AFTER_SCROLLING);

			expect(layout.scrollTop()).toBe(0);
		});

		test('stops listening when the page goes away', async () => {
			const added = vi.spyOn(window, 'addEventListener');
			const removed = vi.spyOn(window, 'removeEventListener');
			const { container, unmount } = await renderRoom();
			const layout = layOut(container);
			await layout.readAt(-1000);

			unmount();
			await wait(AFTER_SCROLLING);

			const count = (spy: typeof added, type: string) => spy.mock.calls.filter(([called]) => called === type).length;
			for (const type of ['scroll', 'touchstart', 'touchend', 'touchcancel']) {
				expect(count(added, type), type).toBeGreaterThan(0);
				expect(count(removed, type), type).toBe(count(added, type));
			}
			added.mockRestore();
			removed.mockRestore();
		});
	});

	describe('the notice of a new message', () => {
		test('says so when someone else writes while reading far above, without moving', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);
			expect(noticeShown(container)).toBe(false);

			await arrive(message('m101', 'alice', 100 * MINUTE));

			expect(noticeShown(container)).toBe(true);
			expect(scrollTo).not.toHaveBeenCalled();
		});

		test('says nothing near the newest message, which it follows instead', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -199);

			await arrive(message('m101', 'alice', 100 * MINUTE));

			expect(noticeShown(container)).toBe(false);
			expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'instant' });
		});

		test('says so when reading again brings a message from someone else', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);
			mocks.timeline = [message('m101', 'alice', 100 * MINUTE), ...mocks.timeline];

			await readAgainAfterReconnect();

			expect(noticeShown(container)).toBe(true);
			expect(scrollTo).not.toHaveBeenCalled();
		});

		test('says nothing when reading again brings only what I wrote elsewhere', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);
			mocks.timeline = [message('m101', 'me', 100 * MINUTE), ...mocks.timeline];

			await readAgainAfterReconnect();

			expect(noticeShown(container)).toBe(false);
			expect(scrollTo).not.toHaveBeenCalled();
		});

		test('goes to the newest message and away when pressed', async () => {
			const { container } = await renderRoom();
			const scrollTo = positionScroller(container, -1000);
			await arrive(message('m101', 'alice', 100 * MINUTE));

			await fireEvent.click(notice(container)!);
			await flush();

			expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'instant' });
			expect(noticeShown(container)).toBe(false);
		});

		test('goes away on reaching the newest message, and not on the way there', async () => {
			const { container } = await renderRoom();
			const scroller = container.querySelector<HTMLElement>('[style*="overflow-y"]')!;
			positionScroller(container, -1000);
			await arrive(message('m101', 'alice', 100 * MINUTE));

			Object.defineProperty(scroller, 'scrollTop', { value: -150, configurable: true });
			scroller.dispatchEvent(new Event('scroll'));
			await flush();
			expect(noticeShown(container)).toBe(true);

			// The position can stop a fraction short of zero.
			Object.defineProperty(scroller, 'scrollTop', { value: -0.5, configurable: true });
			scroller.dispatchEvent(new Event('scroll'));
			await flush();
			expect(noticeShown(container)).toBe(false);
		});

		test('starts over after looking at another tab of the room', async () => {
			const { container } = await renderRoom();
			positionScroller(container, -1000);
			await arrive(message('m101', 'alice', 100 * MINUTE));
			expect(noticeShown(container)).toBe(true);

			await fireEvent.click(container.querySelector('[data-icon="ti ti-dots"]')!);
			(mocks.popupMenu.mock.calls[0][0] as { text: string; action: () => void }[]).find(item => item.text === i18n.ts.search)!.action();
			await flush();
			await fireEvent.click(container.querySelector('[data-testid="back-to-chat"]')!);
			await flush();

			expect(noticeShown(container)).toBe(false);
		});

		test('starts over after going to another page and back, and a message that comes meanwhile breaks nothing', async () => {
			const visible = ref(true);
			const host = defineComponent({
				setup() {
					provideMetadataReceiver(() => {});
					return () => h(KeepAlive, null, { default: () => visible.value ? h(RoutedRoomPage, { roomId: 'r1' }) : h('div') });
				},
			});
			const { container } = render(host, { global: { stubs, directives: { tooltip: {} } } });
			await flush();
			await flush();
			positionScroller(container, -1000);
			await arrive(message('m101', 'alice', 100 * MINUTE));
			expect(noticeShown(container)).toBe(true);

			visible.value = false;
			await flush();
			await arrive(message('m102', 'alice', 101 * MINUTE));

			visible.value = true;
			await flush();
			await flush();

			expect(container.querySelector('[data-id="m102"]')).not.toBeNull();
			expect(noticeShown(container)).toBe(false);
		});
	});
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
	expect(mocks.routerReplace).toHaveBeenCalledWith('/chat');
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

		expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/leave', { roomId: 'r1' }, undefined, chatLeaveErrors);
		expect(mocks.routerPush).not.toHaveBeenCalled();
		expect(mocks.confirm).toHaveBeenCalledWith({ type: 'warning', text: i18n.tsx._chat.leaveRoomConfirm({ name: 'room 1' }) });
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

test('a refused invitation returns to the chat list instead of loading forever', async () => {
	mocks.roomInvitationExists = true;
	mocks.apiWithDialog.mockRejectedValue(new Error('This room is archived.'));

	const { container } = await renderRoom();

	expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/join', { roomId: 'r1' }, undefined, expect.anything());
	expect(mocks.routerPush).toHaveBeenCalledExactlyOnceWith('/chat');
	expect(container.querySelector('[data-testid="form"]')).toBeNull();
});

test('the owner finds the way to the room info, where deleting is, in the menu', async () => {
	mocks.roomOwnerId = 'me';
	const { container } = await renderRoom();

	const menu = [...container.querySelectorAll('button')].find(button => button.getAttribute('data-icon') === 'ti ti-dots')!;
	await fireEvent.click(menu);
	const items = mocks.popupMenu.mock.calls[0][0] as { text: string; action: () => void }[];
	items.find(item => item.text === i18n.ts._chat.roomInfoAndDelete)!.action();
	await flush();

	expect(container.querySelector('[data-testid="info-delete"]')).not.toBeNull();
});

test('a member who does not own the room is not offered it', async () => {
	mocks.roomOwnerId = 'owner';
	const { container } = await renderRoom();

	const menu = [...container.querySelectorAll('button')].find(button => button.getAttribute('data-icon') === 'ti ti-dots')!;
	await fireEvent.click(menu);
	const items = mocks.popupMenu.mock.calls[0][0] as { text: string }[];

	expect(items.map(item => item.text)).not.toContain(i18n.ts._chat.roomInfoAndDelete);
});

describe('after the stream reconnects', () => {
	const form = (container: Element) => container.querySelector('[data-testid="form"]');
	const ids = (container: Element) => bubbles(container).map(bubble => bubble.id);
	// 新しい順で、同じ接頭辞の中では番号の大きいものが新しい
	const pageOf = (prefix: string, count: number, after = 0) => Array.from({ length: count }, (_, i) => message(`${prefix}${String(count - i).padStart(2, '0')}`, 'alice', after + (count - i) * MINUTE));

	async function reconnect() {
		emitConnected();
		await flush();
		await flush();
	}

	function emitConnected() {
		for (const [event, handler] of mocks.streamOn.mock.calls) {
			if (event === '_connected_') handler();
		}
	}

	test('shows what changed while it was disconnected', async () => {
		const { container } = await renderRoom();
		mocks.timeline = [
			message('m4', 'alice', 3 * MINUTE),
			{ ...message('m3', 'alice', 2 * MINUTE), text: 'edited', editedAt: new Date(base + 2 * MINUTE).toISOString() },
			{ ...message('m2', 'alice', MINUTE), text: null, deletedAt: new Date(base + 2 * MINUTE).toISOString() },
			message('m1', 'bob', 0),
		];

		await reconnect();

		expect(ids(container)).toEqual(['m1', 'm2', 'm3', 'm4']);
		expect(container.querySelector('[data-id="m3"]')!.getAttribute('data-text')).toBe('edited');
		expect(container.querySelector('[data-id="m2"]')!.getAttribute('data-deleted')).toBe('true');
	});

	test('does the same in a direct conversation', async () => {
		const { container } = await renderRoom('user');
		mocks.timeline = [message('m4', 'alice', 3 * MINUTE), ...mocks.timeline];

		await reconnect();

		expect(ids(container)).toEqual(['m1', 'm2', 'm3', 'm4']);
	});

	test('keeps older messages that the latest page connects to', async () => {
		mocks.timeline = pageOf('a', 20);
		const { container } = await renderRoom();
		mocks.timeline = [message('b01', 'alice', 100 * MINUTE), ...pageOf('a', 20).slice(0, 19)];

		await reconnect();

		expect(ids(container)).toHaveLength(21);
		expect(ids(container)[0]).toBe('a01');
		expect(ids(container)[20]).toBe('b01');
	});

	test('leaves no hole when more was missed than one page holds', async () => {
		mocks.timeline = pageOf('a', 3);
		const { container } = await renderRoom();
		expect(container.textContent).not.toContain(i18n.ts.loadMore);
		mocks.timeline = pageOf('b', 20, 1000 * MINUTE);

		await reconnect();

		// 捨てた吹き出しは退場のトランジションが終わるまで DOM に残る
		await waitFor(() => expect(ids(container)).toEqual(pageOf('b', 20, 1000 * MINUTE).map(m => m.id).toReversed()));
		expect(container.textContent).toContain(i18n.ts.loadMore);
	});

	test('keeps a message that arrives while catching up', async () => {
		const { container } = await renderRoom();

		emitConnected();
		mocks.channel.emit('message', message('m9', 'alice', 9 * MINUTE));
		await flush();
		await flush();

		expect(ids(container)).toEqual(['m1', 'm2', 'm3', 'm9']);
	});

	test('ends an edit of a message deleted in the meantime', async () => {
		mocks.timeline = [message('m1', 'me', 0)];
		const { container } = await renderRoom();
		mocks.editMessage.value!();
		await flush();
		expect(form(container)!.getAttribute('data-editing')).toBe('m1');
		mocks.timeline = [{ ...message('m1', 'me', 0), text: null, deletedAt: new Date(base + MINUTE).toISOString() }];

		await reconnect();

		expect(form(container)!.getAttribute('data-editing')).toBe('');
	});

	test('follows a room change made in the meantime', async () => {
		const { container } = await renderRoom();
		mocks.roomIsArchived = true;

		await reconnect();

		expect(form(container)).toBeNull();
		expect(container.textContent).toContain(i18n.ts._chat.thisRoomIsArchived);
	});

	test('closes a room that is gone by now', async () => {
		const { container } = await renderRoom();
		mocks.roomShowError = Object.assign(new Error('No such room.'), { code: 'NO_SUCH_ROOM' });

		await reconnect();

		expect(form(container)).toBeNull();
		expect(mocks.alert).toHaveBeenCalledExactlyOnceWith({ type: 'info', text: i18n.ts._chat.removedFromRoom });
		expect(mocks.routerReplace).toHaveBeenCalledExactlyOnceWith('/chat');
	});

	test('says so when the room was deleted while the stream was down', async () => {
		const { container } = await renderRoom();
		mocks.roomShowError = Object.assign(new Error('This room was deleted.'), { code: 'ROOM_DELETED' });

		await reconnect();

		expect(form(container)).toBeNull();
		expect(mocks.alert).toHaveBeenCalledExactlyOnceWith({ type: 'info', text: i18n.ts._chat.roomDeleted });
		expect(mocks.routerReplace).toHaveBeenCalledExactlyOnceWith('/chat');
	});

	test('says so when the timeline answers first that the room is gone and the room was deleted', async () => {
		const { container } = await renderRoom();
		mocks.timelineError = Object.assign(new Error('No such room.'), { code: 'NO_SUCH_ROOM' });
		mocks.roomShowError = Object.assign(new Error('This room was deleted.'), { code: 'ROOM_DELETED' });

		await reconnect();

		expect(form(container)).toBeNull();
		expect(mocks.alert).toHaveBeenCalledExactlyOnceWith({ type: 'info', text: i18n.ts._chat.roomDeleted });
	});

	test('says so when a deleted room is opened again', async () => {
		mocks.roomShowError = Object.assign(new Error('This room was deleted.'), { code: 'ROOM_DELETED' });

		await renderRoom();

		expect(mocks.alert).toHaveBeenCalledExactlyOnceWith({ type: 'info', text: i18n.ts._chat.roomDeleted });
		expect(mocks.routerReplace).toHaveBeenCalledExactlyOnceWith('/chat');
	});

	test('explains a room that cannot be opened, which may be gone or may just not be theirs', async () => {
		mocks.roomShowError = Object.assign(new Error('No such room.'), { code: 'NO_SUCH_ROOM' });

		await renderRoom();

		expect(mocks.alert).toHaveBeenCalledExactlyOnceWith({ type: 'info', text: i18n.ts._chat.roomUnavailable });
		expect(mocks.routerReplace).toHaveBeenCalledExactlyOnceWith('/chat');
	});

	test('shows a room fetch failure in the conversation', async () => {
		mocks.roomShowError = new Error('Failed to fetch');

		const { container } = await renderRoom();

		expect(container.querySelector('[data-result-type="error"]')).not.toBeNull();
		expect(form(container)).toBeNull();
		expect(mocks.alert).not.toHaveBeenCalled();
		expect(mocks.routerReplace).not.toHaveBeenCalled();
	});

	test.each([
		{ code: 'NO_SUCH_USER', result: 'notFound' },
		{ code: 'INTERNAL_ERROR', result: 'error' },
	])('shows $result when a direct conversation cannot load', async ({ code, result }) => {
		mocks.userShowError = Object.assign(new Error('Cannot load user'), { code });

		const { container } = await renderRoom('user');

		expect(container.querySelector(`[data-result-type="${result}"]`)).not.toBeNull();
		expect(form(container)).toBeNull();
	});

	test('offers the invitation of someone removed and invited again in the meantime', async () => {
		const { container } = await renderRoom();
		mocks.roomInvitationExists = true;
		mocks.timelineError = Object.assign(new Error('No such room.'), { code: 'NO_SUCH_ROOM' });
		mocks.confirm.mockResolvedValue({ canceled: true });

		await reconnect();

		expect(mocks.confirm).toHaveBeenCalledOnce();
		expect(form(container)).toBeNull();
		expect(mocks.routerPush).toHaveBeenCalledExactlyOnceWith('/chat');
	});

	test('stays as it is when the requests fail for another reason', async () => {
		const { container } = await renderRoom();
		mocks.roomShowError = new Error('Failed to fetch');

		await reconnect();

		expect(ids(container)).toEqual(['m1', 'm2', 'm3']);
		expect(form(container)).not.toBeNull();
		expect(mocks.alert).not.toHaveBeenCalled();

		// 次の機会に取り直す
		mocks.roomShowError = null;
		mocks.timeline = [message('m4', 'alice', 3 * MINUTE), ...mocks.timeline];
		window.document.dispatchEvent(new Event('visibilitychange'));
		await flush();
		await flush();

		expect(ids(container)).toEqual(['m1', 'm2', 'm3', 'm4']);
	});

	// タイムラインを取得すると既読になる
	test('waits for a hidden tab to be looked at', async () => {
		const { container } = await renderRoom();
		mocks.timeline = [message('m4', 'alice', 3 * MINUTE), ...mocks.timeline];
		const hidden = vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true);

		try {
			await reconnect();
			expect(ids(container)).toEqual(['m1', 'm2', 'm3']);

			hidden.mockReturnValue(false);
			window.document.dispatchEvent(new Event('visibilitychange'));
			await flush();
			await flush();

			expect(ids(container)).toEqual(['m1', 'm2', 'm3', 'm4']);
		} finally {
			hidden.mockRestore();
		}
	});

	test('waits for a cached page to be opened again, and only fetches if the stream reconnected', async () => {
		const timelineFetches = () => vi.mocked(misskeyApi).mock.calls.filter(([endpoint]) => endpoint === 'chat/messages/room-timeline').length;
		const visible = ref(true);
		const page = defineComponent({
			setup() {
				provideMetadataReceiver(() => {});
				return () => h(KeepAlive, null, { default: () => visible.value ? h(RoutedRoomPage, { roomId: 'r1' }) : h('div') });
			},
		});
		const { container } = render(page, { global: { stubs, directives: { tooltip: {} } } });
		await flush();
		await flush();
		const fetchesBefore = timelineFetches();

		visible.value = false;
		await flush();
		visible.value = true;
		await flush();
		await flush();
		expect(timelineFetches()).toBe(fetchesBefore);

		visible.value = false;
		await flush();
		mocks.timeline = [message('m4', 'alice', 3 * MINUTE), ...mocks.timeline];
		await reconnect();
		expect(timelineFetches()).toBe(fetchesBefore);

		visible.value = true;
		await flush();
		await flush();
		expect(timelineFetches()).toBe(fetchesBefore + 1);
		expect(ids(container)).toEqual(['m1', 'm2', 'm3', 'm4']);
	});

	test('stops listening when the page goes away', async () => {
		const { unmount } = await renderRoom();
		const listener = mocks.streamOn.mock.calls.find(([event]) => event === '_connected_')![1];

		unmount();

		expect(mocks.streamOff).toHaveBeenCalledWith('_connected_', listener);
	});
});

describe('telling the server what was read', () => {
	const reads = (send: { mock: { calls: unknown[][] } }) => send.mock.calls.filter(([type]) => type === 'read').map(([, body]) => body);

	async function arrive(newMessage: ReturnType<typeof message>) {
		mocks.channel.emit('message', newMessage);
		await flush();
	}

	async function lookAtTab(hidden: { mockReturnValue: (value: boolean) => unknown }) {
		hidden.mockReturnValue(false);
		window.document.dispatchEvent(new Event('visibilitychange'));
		await flush();
	}

	function cachedPage() {
		const visible = ref(true);
		const page = defineComponent({
			setup() {
				provideMetadataReceiver(() => {});
				return () => h(KeepAlive, null, { default: () => visible.value ? h(RoutedRoomPage, { userId: 'alice' }) : h('div') });
			},
		});
		return { page, visible };
	}

	test('marks a message read as it arrives in the conversation being looked at', async () => {
		const send = vi.spyOn(mocks.channel, 'send');
		await renderRoom('user');

		await arrive(message('m4', 'alice', 3 * MINUTE));

		expect(reads(send)).toEqual([{ id: 'm4' }]);
	});

	test('leaves a message unread while the tab is hidden, and marks it read once the tab is looked at', async () => {
		const send = vi.spyOn(mocks.channel, 'send');
		await renderRoom('user');
		const hidden = vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true);

		try {
			await arrive(message('m4', 'alice', 3 * MINUTE));
			await arrive(message('m5', 'alice', 4 * MINUTE));
			expect(reads(send)).toEqual([]);

			await lookAtTab(hidden);

			// サーバーは会話ごとに既読にするので、最後の一通を伝えれば足りる
			expect(reads(send)).toEqual([{ id: 'm5' }]);
		} finally {
			hidden.mockRestore();
		}
	});

	test('marks what arrived while another page was open as read once the cached page is opened again', async () => {
		const send = vi.spyOn(mocks.channel, 'send');
		const { page, visible } = cachedPage();
		render(page, { global: { stubs, directives: { tooltip: {} } } });
		await flush();
		await flush();

		visible.value = false;
		await flush();
		await arrive(message('m4', 'alice', 3 * MINUTE));
		expect(reads(send)).toEqual([]);

		visible.value = true;
		await flush();

		expect(reads(send)).toEqual([{ id: 'm4' }]);
	});

	test('waits for the tab too when a cached page is opened again behind a hidden tab', async () => {
		const send = vi.spyOn(mocks.channel, 'send');
		const { page, visible } = cachedPage();
		render(page, { global: { stubs, directives: { tooltip: {} } } });
		await flush();
		await flush();
		visible.value = false;
		await flush();
		await arrive(message('m4', 'alice', 3 * MINUTE));
		const hidden = vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true);

		try {
			visible.value = true;
			await flush();
			expect(reads(send)).toEqual([]);

			await lookAtTab(hidden);

			expect(reads(send)).toEqual([{ id: 'm4' }]);
		} finally {
			hidden.mockRestore();
		}
	});

	test('sends nothing on coming back when nothing arrived meanwhile', async () => {
		const send = vi.spyOn(mocks.channel, 'send');
		await renderRoom('user');
		const hidden = vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true);

		try {
			// 自分がほかの端末から送ったものは、読むものではない
			await arrive(message('m4', 'me', 3 * MINUTE));
			await lookAtTab(hidden);
			hidden.mockReturnValue(true);
			await lookAtTab(hidden);

			expect(reads(send)).toEqual([]);
		} finally {
			hidden.mockRestore();
		}
	});

	test('does not repeat the read each time the tab is looked at', async () => {
		const send = vi.spyOn(mocks.channel, 'send');
		await renderRoom('user');
		const hidden = vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true);

		try {
			await arrive(message('m4', 'alice', 3 * MINUTE));
			await lookAtTab(hidden);
			hidden.mockReturnValue(true);
			await lookAtTab(hidden);

			expect(reads(send)).toEqual([{ id: 'm4' }]);
		} finally {
			hidden.mockRestore();
		}
	});
});

describe('the unread sign with realtime mode off', () => {
	// 부팅 때 실시간 모드가 꺼져 있으면 쪽지 이벤트 핸들러가 등록되지 않는다
	beforeEach(() => {
		mocks.chatEventsActive = false;
	});

	test('refreshes the sign after returning to a cached conversation without reconnecting', async () => {
		mocks.store.realtimeMode = false;
		mocks.me.hasUnreadChatMessages = true;
		const visible = ref(true);
		const page = defineComponent({
			setup() {
				provideMetadataReceiver(() => {});
				return () => h(KeepAlive, null, { default: () => visible.value ? h(RoutedRoomPage, { userId: 'alice' }) : h('div') });
			},
		});
		render(page, { global: { stubs, directives: { tooltip: {} } } });
		await flush();
		await flush();
		visible.value = false;
		await flush();
		mocks.channel.emit('message', message('m4', 'alice', 3 * MINUTE));
		await flush();
		mocks.refreshCurrentAccount.mockClear();

		visible.value = true;
		await flush();
		await flush();

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
	});

	// メインのチャンネルを聞いていないので、既読になった知らせは届かない
	test('asks the server about the sign after a conversation is opened and read', async () => {
		mocks.store.realtimeMode = false;
		mocks.me.hasUnreadChatMessages = true;

		await renderRoom('user');

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
	});

	test('asks about a room as well', async () => {
		mocks.store.realtimeMode = false;
		mocks.me.hasUnreadChatMessages = true;

		await renderRoom('room');

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
	});

	test('asks again after reading what came while the stream was away', async () => {
		mocks.store.realtimeMode = false;
		mocks.me.hasUnreadChatMessages = true;
		await renderRoom('user');
		mocks.refreshCurrentAccount.mockClear();

		for (const [event, handler] of mocks.streamOn.mock.calls) {
			if (event === '_connected_') handler();
		}
		await flush();
		await flush();

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
	});

	test('does not ask while the sign is off', async () => {
		mocks.store.realtimeMode = false;

		await renderRoom('user');

		expect(mocks.refreshCurrentAccount).not.toHaveBeenCalled();
	});
});

// 既読になった知らせはバージョン付きイベントで届く。健康的な購読のあいだは会話を読んでもアカウントを問い合わせない。
// ページを開いた直後やつなぎ直した直後は、購読が済む前にサーバーが知らせを出してしまうことがあり、その知らせはあとから流れてこない
describe('the unread sign in realtime mode', () => {
	test.each(['user', 'room'] as const)('trusts the versioned events after a %s conversation is opened and read', async kind => {
		mocks.me.hasUnreadChatMessages = true;

		await renderRoom(kind);

		expect(mocks.refreshCurrentAccount).not.toHaveBeenCalled();
	});

	test('asks the server when the page opened before the stream connected', async () => {
		mocks.chatGap = true;
		mocks.me.hasUnreadChatMessages = true;

		await renderRoom('user');

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
	});

	// 会話画面が無いあいだに起きた空白も、あとから開いた画面が確かめ直す
	test('asks when the gap happened before the conversation was opened', async () => {
		mocks.me.hasUnreadChatMessages = true;
		mocks.chatGap = true;

		await renderRoom('user');

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
		expect(mocks.chatGap).toBe(false);
	});

	// 読み直し自身が購読と競合することがある。最初の取得中に購読が済んでも、
	// その取得がサーバーで既読に変えたあとに出た知らせは届かないことがあるので、読み直しの開始時点で確かめ直す
	test('asks when the subscription completes while the first read is in flight', async () => {
		mocks.me.hasUnreadChatMessages = true;
		mocks.chatGap = true;
		let openGate!: () => void;
		mocks.timelineGate = new Promise<void>(resolve => { openGate = resolve; });

		const rendered = renderRoom('user');
		await flush();
		// 取得の途中で購読完了の知らせが届く
		mocks.chatGap = false;
		openGate();
		await rendered;
		await flush();

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
		expect(mocks.refreshCurrentAccount).toHaveBeenCalledWith({ protectChatUnread: true, rejectOnFailure: true });
	});

	test('asks when the subscription completes while a reconnect read is in flight', async () => {
		mocks.me.hasUnreadChatMessages = true;
		await renderRoom('user');
		mocks.refreshCurrentAccount.mockClear();

		mocks.chatGap = true;
		let openGate!: () => void;
		mocks.timelineGate = new Promise<void>(resolve => { openGate = resolve; });
		for (const [event, handler] of mocks.streamOn.mock.calls) {
			if (event === '_connected_') handler();
		}
		await flush();
		mocks.chatGap = false;
		openGate();
		await flush();
		await flush();

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
		expect(mocks.chatGap).toBe(false);
	});

	// 부팅 뒤 실시간 모드를 켜고 새로고침을 건너뛰면 이벤트 핸들러가 없는 상태다. 이때도 서버에 확인한다
	test('asks when realtime mode was turned on after boot without a reload', async () => {
		mocks.me.hasUnreadChatMessages = true;
		mocks.store.realtimeMode = true;
		mocks.chatEventsActive = false;

		await renderRoom('user');

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
	});

	test('asks again after reading what came while the stream was away', async () => {
		mocks.me.hasUnreadChatMessages = true;
		await renderRoom('user');
		mocks.refreshCurrentAccount.mockClear();

		mocks.chatGap = true;
		for (const [event, handler] of mocks.streamOn.mock.calls) {
			if (event === '_connected_') handler();
		}
		await flush();
		await flush();

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
		expect(mocks.chatGap).toBe(false);
	});

	test('does not ask again once the gap was checked', async () => {
		mocks.me.hasUnreadChatMessages = true;
		await renderRoom('user');

		mocks.chatGap = true;
		for (const [event, handler] of mocks.streamOn.mock.calls) {
			if (event === '_connected_') handler();
		}
		await flush();
		await flush();
		mocks.refreshCurrentAccount.mockClear();

		for (const [event, handler] of mocks.streamOn.mock.calls) {
			if (event === '_connected_') handler();
		}
		await flush();
		await flush();

		expect(mocks.refreshCurrentAccount).not.toHaveBeenCalled();
	});

	test('does not ask on returning to a hidden tab when the subscription stayed healthy', async () => {
		mocks.me.hasUnreadChatMessages = true;
		await renderRoom('user');
		const hidden = vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true);

		try {
			mocks.channel.emit('message', message('m4', 'alice', 3 * MINUTE));
			await flush();
			mocks.refreshCurrentAccount.mockClear();

			hidden.mockReturnValue(false);
			window.document.dispatchEvent(new Event('visibilitychange'));
			await flush();
			await flush();

			expect(mocks.refreshCurrentAccount).not.toHaveBeenCalled();
		} finally {
			hidden.mockRestore();
		}
	});

	test('does not ask while the sign is off', async () => {
		await renderRoom('user');

		expect(mocks.refreshCurrentAccount).not.toHaveBeenCalled();
	});

	// 실패한 보호 확인이 공백을 되돌리면, 목록에 갔다 같은 대화로 돌아와도 확인 의무가 남아 있어야 한다.
	// 캐시된 화면은 다시 들어와도 초기화를 거치지 않으므로, 돌아온 화면이 공백을 이어받는다
	test('asks again on returning to a cached conversation when a failed check restored the gap', async () => {
		mocks.me.hasUnreadChatMessages = true;
		mocks.chatGap = true;
		mocks.refreshCurrentAccount.mockRejectedValueOnce(new Error('server error'));
		const visible = ref(true);
		const page = defineComponent({
			setup() {
				provideMetadataReceiver(() => {});
				return () => h(KeepAlive, null, { default: () => visible.value ? h(RoutedRoomPage, { userId: 'alice' }) : h('div') });
			},
		});
		render(page, { global: { stubs, directives: { tooltip: {} } } });
		await flush();
		await flush();
		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
		expect(mocks.chatGap).toBe(true);

		visible.value = false;
		await flush();
		visible.value = true;
		await flush();
		await flush();

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledTimes(2);
		expect(mocks.refreshCurrentAccount).toHaveBeenLastCalledWith({ protectChatUnread: true, rejectOnFailure: true });
		expect(mocks.chatGap).toBe(false);
	});

	test('does not ask on returning to a cached conversation when there is no gap', async () => {
		mocks.me.hasUnreadChatMessages = true;
		const visible = ref(true);
		const page = defineComponent({
			setup() {
				provideMetadataReceiver(() => {});
				return () => h(KeepAlive, null, { default: () => visible.value ? h(RoutedRoomPage, { userId: 'alice' }) : h('div') });
			},
		});
		render(page, { global: { stubs, directives: { tooltip: {} } } });
		await flush();
		await flush();

		visible.value = false;
		await flush();
		visible.value = true;
		await flush();
		await flush();

		expect(mocks.refreshCurrentAccount).not.toHaveBeenCalled();
	});

	// 돌아온 김에 읽는 대화가 있다면, 그 읽기가 공백을 보고 확인한다. 돌아온 화면이 또 확인하면 요청이 겹친다
	test('does not double-ask when returning brings a read that checks the gap itself', async () => {
		mocks.me.hasUnreadChatMessages = true;
		const visible = ref(true);
		const page = defineComponent({
			setup() {
				provideMetadataReceiver(() => {});
				return () => h(KeepAlive, null, { default: () => visible.value ? h(RoutedRoomPage, { userId: 'alice' }) : h('div') });
			},
		});
		render(page, { global: { stubs, directives: { tooltip: {} } } });
		await flush();
		await flush();

		visible.value = false;
		await flush();
		mocks.channel.emit('message', message('m4', 'alice', 3 * MINUTE));
		await flush();
		mocks.chatGap = true;

		visible.value = true;
		await flush();
		await flush();

		expect(mocks.refreshCurrentAccount).toHaveBeenCalledOnce();
		expect(mocks.chatGap).toBe(false);
	});
});

test('another member leaving does not close my room', async () => {
	const { container } = await renderRoom();
	mocks.channel.emit('membershipEnded', { userId: 'someone-else' });
	await flush();
	expect(container.querySelector('[data-testid="form"]')).not.toBeNull();
	expect(mocks.routerReplace).not.toHaveBeenCalled();
});

describe('a deleted room', () => {
	test('tells the member viewing it and returns to the chat list', async () => {
		const { container } = await renderRoom();
		mocks.channel.emit('roomDeleted', undefined);
		await flush();
		expect(alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.roomDeleted });
		expect(mocks.routerReplace).toHaveBeenCalledWith('/chat');
		expect(container.querySelector('[data-testid="form"]')).toBeNull();
	});

	test('does not pull a member away from another page while it is cached', async () => {
		const visible = ref(true);
		const page = defineComponent({
			setup() {
				provideMetadataReceiver(() => {});
				return () => h(KeepAlive, null, { default: () => visible.value ? h(RoutedRoomPage, { roomId: 'r1' }) : h('div') });
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
		expect(mocks.routerReplace).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalled();

		// 戻ってきたときに初めて知らせる
		visible.value = true;
		await flush();
		expect(alert).toHaveBeenCalledWith({ type: 'info', text: i18n.ts._chat.roomDeleted });
		expect(alert).toHaveBeenCalledTimes(1);
		expect(mocks.routerReplace).toHaveBeenCalledWith('/chat');
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
			return () => h(KeepAlive, null, { default: () => visible.value ? h(RoutedRoomPage, { roomId: 'r1' }) : h('div') });
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
	expect(mocks.routerReplace).toHaveBeenCalledWith('/chat');
});

test('someone who moved on before the room answered is told when they return, not pulled away', async () => {
	let answer!: () => void;
	mocks.roomShowGate = new Promise<void>(resolve => { answer = resolve; });
	mocks.roomShowError = Object.assign(new Error('No such room.'), { code: 'NO_SUCH_ROOM' });
	const visible = ref(true);
	const page = defineComponent({
		setup() {
			provideMetadataReceiver(() => {});
			return () => h(KeepAlive, null, { default: () => visible.value ? h(RoutedRoomPage, { roomId: 'r1' }) : h('div') });
		},
	});
	render(page, { global: { stubs, directives: { tooltip: {} } } });
	await flush();
	visible.value = false;
	await flush();

	answer();
	await flush();
	await flush();

	expect(alert).not.toHaveBeenCalled();
	expect(mocks.routerReplace).not.toHaveBeenCalled();

	mocks.roomShowGate = null;
	visible.value = true;
	await flush();
	await flush();

	expect(alert).toHaveBeenCalledExactlyOnceWith({ type: 'info', text: i18n.ts._chat.roomUnavailable });
	expect(mocks.routerReplace).toHaveBeenCalledExactlyOnceWith('/chat');
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

		expect(misskeyApi).toHaveBeenCalledWith('chat/rooms/invitations/create', { roomId: 'r1', userId: 'invitee' });
	});

	test('a member who cannot invite is not asked to', async () => {
		const { container } = await renderRoom();

		expect(container.textContent).toContain(i18n.ts._chat.noMessagesYet);
		expect(container.textContent).not.toContain(i18n.ts._chat.inviteUserToChat);
		expect(inviteButton(container)).toBeUndefined();
		expect(vi.mocked(misskeyApi).mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/invitations/outbox')).toEqual([]);
	});

	describe('what the owner is told once someone is invited', () => {
		const waiting = (n: number) => i18n.tsx._chat.roomInvitationsWaiting({ n });
		const joined = (n: number) => i18n.tsx._chat.roomMembersJoined({ n });
		const viewMembers = (container: Element) => [...container.querySelectorAll('button')].find(button => button.textContent?.includes(i18n.ts._chat.viewMembers));
		const invitation = { id: 'i1', userId: 'invitee' };
		const member = { id: 'ms1', userId: 'invitee' };

		beforeEach(() => {
			mocks.roomOwnerId = 'me';
			mocks.roomMembers = [];
			mocks.sentInvitations = [];
		});

		test('nobody invited yet: asks, and has nothing to show in the members tab', async () => {
			const { container } = await renderRoom();

			expect(container.textContent).toContain(i18n.ts._chat.inviteUserToChat);
			expect(viewMembers(container)).toBeUndefined();
		});

		test('right after inviting: stops asking, says who answers what, and keeps the way to invite more', async () => {
			const { container } = await renderRoom();
			mocks.sentInvitations = [invitation];

			await fireEvent.click(inviteButton(container)!);
			await flush();
			await flush();

			expect(container.textContent).not.toContain(i18n.ts._chat.inviteUserToChat);
			expect(container.textContent).toContain(waiting(1));
			expect(inviteButton(container)).toBeDefined();
		});

		test('opening the room again says the same', async () => {
			mocks.sentInvitations = [invitation];

			const { container } = await renderRoom();

			expect(container.textContent).toContain(waiting(1));
			expect(container.textContent).not.toContain(i18n.ts._chat.inviteUserToChat);
		});

		test('an acceptance shows up while looking at it', async () => {
			mocks.sentInvitations = [invitation];
			const { container } = await renderRoom();
			mocks.sentInvitations = [];
			mocks.roomMembers = [member];

			mocks.channel.emit('membershipStarted', { userId: 'invitee' });
			await flush();
			await flush();

			expect(container.textContent).toContain(joined(1));
			expect(container.textContent).not.toContain(waiting(1));
			expect(container.textContent).not.toContain(i18n.ts._chat.inviteUserToChat);
		});

		test('a refusal shows up while looking at it, though no room event carries it', async () => {
			mocks.sentInvitations = [invitation];
			const { container } = await renderRoom();
			mocks.sentInvitations = [];

			mocks.channel.emit('chatRoomListChanged', undefined);
			await flush();
			await flush();

			expect(container.textContent).toContain(i18n.ts._chat.inviteUserToChat);
			expect(container.textContent).not.toContain(waiting(1));
		});

		test('someone leaving shows up while looking at it', async () => {
			mocks.roomMembers = [member];
			const { container } = await renderRoom();
			mocks.roomMembers = [];

			mocks.channel.emit('membershipEnded', { userId: 'invitee' });
			await flush();
			await flush();

			expect(container.textContent).toContain(i18n.ts._chat.inviteUserToChat);
			expect(container.textContent).not.toContain(joined(1));
		});

		test('the way to the members tab opens it', async () => {
			mocks.sentInvitations = [invitation];
			const { container } = await renderRoom();

			await fireEvent.click(viewMembers(container)!);
			await flush();
			expect(mocks.membersMounts.value).toBeGreaterThan(0);
		});

		test('an answer that comes late does not replace a newer one', async () => {
			mocks.sentInvitations = [invitation];
			const { container } = await renderRoom();
			let releaseOld = () => {};
			const old = new Promise<unknown[]>(resolve => { releaseOld = () => resolve([invitation]); });
			vi.mocked(misskeyApi).mockImplementationOnce(async () => []).mockImplementationOnce(async () => await old);
			mocks.channel.emit('membershipStarted', { userId: 'a' });
			mocks.sentInvitations = [];
			mocks.channel.emit('membershipStarted', { userId: 'b' });
			await flush();
			await flush();

			releaseOld();
			await flush();
			await flush();

			expect(container.textContent).not.toContain(waiting(1));
		});

		test('a failed read keeps what is on screen', async () => {
			mocks.sentInvitations = [invitation];
			const { container } = await renderRoom();
			vi.mocked(misskeyApi).mockImplementationOnce(async () => { throw new Error('offline'); });

			mocks.channel.emit('membershipStarted', { userId: 'a' });
			await flush();
			await flush();

			expect(container.textContent).toContain(waiting(1));
		});
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

		expect(misskeyApi).toHaveBeenCalledWith('chat/rooms/invitations/create', { roomId: 'r1', userId: 'invitee' });
		expect(mocks.membersMounts.value).toBe(2);
	});

	test('reloads the tab when the stream reconnects, as a change may have been missed', async () => {
		await openMembersTab();

		for (const [event, handler] of mocks.streamOn.mock.calls) {
			if (event === '_connected_') handler();
		}
		await flush();
		await flush();

		expect(mocks.membersMounts.value).toBe(2);
	});

	test('leaves the tab alone when the invitation fails', async () => {
		const answering = vi.mocked(misskeyApi).getMockImplementation()!;
		vi.mocked(misskeyApi).mockImplementation(async (endpoint: string, ...rest: unknown[]) => {
			if (endpoint === 'chat/rooms/invitations/create') throw new Error('request failed');
			return (answering as (...args: unknown[]) => unknown)(endpoint, ...rest);
		});
		try {
			const container = await openMembersTab();

			await fireEvent.click(container.querySelector('[data-testid="members-invite"]')!);
			await flush();

			expect(misskeyApi).toHaveBeenCalledWith('chat/rooms/invitations/create', { roomId: 'r1', userId: 'invitee' });
			expect(mocks.alert).toHaveBeenCalled();
			expect(mocks.membersMounts.value).toBe(1);
		} finally {
			vi.mocked(misskeyApi).mockImplementation(answering);
		}
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
			return () => h(KeepAlive, null, { default: () => visible.value ? h(RoutedRoomPage, { roomId: 'r1' }) : h('div') });
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

describe.each(['room', 'user'] as const)('a %s conversation that has just opened', target => {
	const ids = (container: Element) => bubbles(container).map(bubble => bubble.id);
	const reads = () => vi.mocked(misskeyApi).mock.calls.filter(([endpoint]) => endpoint === `chat/messages/${target}-timeline`).length;
	const newer = (id: string, after: number) => message(id, 'alice', after * MINUTE);
	const newest = () => [newer('m5', 4), newer('m4', 3), message('m3', 'alice', 2 * MINUTE), message('m2', 'alice', MINUTE), message('m1', 'bob', 0)];

	async function subscribed() {
		mocks.channel.emit('_subscribed_', undefined);
		await flush();
		await flush();
	}

	beforeEach(() => {
		vi.mocked(misskeyApi).mockClear();
	});

	test('reads again once the channel is connected, and shows what came in between', async () => {
		const { container } = await renderRoom(target);
		expect(ids(container)).toEqual(['m1', 'm2', 'm3']);
		mocks.timeline = newest();

		await subscribed();

		expect(ids(container)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
	});

	test('a message that both the read and the channel bring shows once', async () => {
		const { container } = await renderRoom(target);
		mocks.timeline = newest();
		await subscribed();

		mocks.channel.emit('message', newer('m5', 4));
		await flush();

		expect(ids(container)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
	});

	test('a message the channel brings after a newer one from the read goes where it belongs', async () => {
		const { container } = await renderRoom(target);
		mocks.timeline = [newer('m5', 4), message('m3', 'alice', 2 * MINUTE), message('m2', 'alice', MINUTE), message('m1', 'bob', 0)];
		await subscribed();

		mocks.channel.emit('message', newer('m4', 3));
		await flush();

		expect(ids(container)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
	});

	test('a reaction that both bring counts once', async () => {
		const { container } = await renderRoom(target);
		const reactor = target === 'room' ? userOf('bob') : mocks.me;
		mocks.timeline = [{ ...message('m3', 'alice', 2 * MINUTE), reactions: [{ reaction: '👍', user: reactor }] }, message('m2', 'alice', MINUTE), message('m1', 'bob', 0)];
		await subscribed();

		mocks.channel.emit('react', { messageId: 'm3', reaction: '👍', user: target === 'room' ? userOf('bob') : undefined });
		await flush();

		expect(container.querySelector('[data-id="m3"]')!.getAttribute('data-reactions')).toBe(JSON.stringify([`👍/${reactor.id}`]));
	});

	test('a read that is on its way is not joined by another, and one more follows if it was asked for', async () => {
		await renderRoom(target);
		const before = reads();
		let release = () => {};
		mocks.timelineGate = new Promise<void>(resolve => { release = resolve; });

		mocks.channel.emit('_subscribed_', undefined);
		await flush();
		mocks.channel.emit('_subscribed_', undefined);
		await flush();
		expect(reads()).toBe(before + 1);

		mocks.timelineGate = null;
		release();
		await flush();
		await flush();
		await flush();

		expect(reads()).toBe(before + 2);
	});

	test('a change that crosses the read on its way is read again, so the older answer does not stay', async () => {
		const { container } = await renderRoom(target);
		const before = reads();
		let release = () => {};
		mocks.timelineGate = new Promise<void>(resolve => { release = resolve; });
		mocks.channel.emit('_subscribed_', undefined);
		await flush();

		mocks.channel.emit('deleted', 'm3');
		await flush();
		mocks.timelineGate = null;
		const answer = mocks.timeline;
		mocks.timeline = [{ ...message('m3', 'alice', 2 * MINUTE), text: null, deletedAt: new Date(base).toISOString() }, ...(answer as unknown[]).slice(1)];
		release();
		await flush();
		await flush();
		await flush();

		expect(reads()).toBe(before + 2);
		expect(container.querySelector('[data-id="m3"]')!.getAttribute('data-deleted')).toBe('true');
	});

	test('a read that fails waits for the next chance instead of repeating at once', async () => {
		await renderRoom(target);
		const before = reads();
		vi.mocked(misskeyApi).mockImplementation(async (endpoint: string) => {
			if (endpoint === `chat/messages/${target}-timeline`) throw new Error('offline');
			return endpoint === 'chat/rooms/show' ? { id: 'r1', name: 'room 1', ownerId: 'owner', owner: userOf('owner') } : [];
		});
		try {
			await subscribed();
			await flush();
			expect(reads()).toBe(before + 1);
		} finally {
			vi.mocked(misskeyApi).mockImplementation(apiMock);
		}
	});
});
