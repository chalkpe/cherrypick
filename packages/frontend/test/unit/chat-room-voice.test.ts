/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/vue';
import { defineComponent, h, KeepAlive, nextTick, reactive, ref } from 'vue';

const mocks = vi.hoisted(() => {
	class FakeChannel {
		handlers = new Map<string, (payload: unknown) => void>();
		on(event: string, handler: (payload: unknown) => void) {
			this.handlers.set(event, handler);
		}
		off() {}
		send() {}
		dispose = vi.fn();
		emit(event: string, payload: unknown) {
			this.handlers.get(event)?.(payload);
		}
	}
	return {
		FakeChannel,
		channel: new FakeChannel(),
		misskeyApi: vi.fn().mockResolvedValue([]),
		apiWithDialog: vi.fn(),
		confirm: vi.fn(),
		popupMenu: vi.fn(),
		popup: vi.fn(),
		launchUploader: vi.fn(),
		instance: { features: { voiceCall: true, remoteVoiceCall: false } } as { features: { voiceCall: boolean; remoteVoiceCall: boolean } },
		me: { id: 'me', username: 'me', policies: { canVoiceCall: true, canScreenShare: true, chatAvailability: 'available' } },
		joinVoiceCall: vi.fn(),
		leaveVoiceCall: vi.fn(),
		setMicEnabled: vi.fn(),
		setDeafened: vi.fn(),
		resumeAudio: vi.fn(),
		watchScreenShare: vi.fn(),
		unwatchScreenShare: vi.fn(),
		toggleScreenShareWatch: vi.fn(),
		// 返す detach も記録して、外し忘れが無いかを見る
		attachScreenShare: vi.fn((_identity: string, _element: HTMLVideoElement, _options?: { preview?: boolean }) => vi.fn()),
		startScreenShare: vi.fn(),
		stopScreenShare: vi.fn(),
		setParticipantVolume: vi.fn(),
		requestFullscreen: vi.fn(),
		refreshStickyLayout: vi.fn(),
	};
});

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ on: vi.fn(), off: vi.fn(), useChannel: () => mocks.channel }) }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/instance.js', () => ({ instance: mocks.instance }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog, confirm: mocks.confirm, popupMenu: mocks.popupMenu, popup: mocks.popup, launchUploader: mocks.launchUploader, toast: vi.fn(), claimZIndex: () => 1000 }));
vi.mock('@/utility/fullscreen.js', () => ({ requestFullscreen: mocks.requestFullscreen }));
// 画面遷移の前にシートの focus trap を解放することを確かめるため、router の change リスナーを拾っておく
const routerListeners = vi.hoisted(() => ({ change: [] as ((payload: unknown) => void)[] }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn(), useListener: (event: string, listener: (payload: unknown) => void) => { if (event === 'change') routerListeners.change.push(listener); } }) }));
// ルーム画面のテストでは通話以外の部分は関係ないので空のコンポーネントに差し替える
vi.mock('@/pages/chat/XMessage.vue', () => ({ default: { render: () => null } }));
// 入力欄は並べ方が変わっても作り直さないことを確かめるので本物を使う。ブラウザの入力まわりに触る部品だけ差し替える
vi.mock('@/utility/autocomplete.js', () => ({ Autocomplete: class { detach() {} } }));
vi.mock('@/utility/emoji-picker.js', () => ({ emojiPicker: { show: vi.fn() } }));
vi.mock('@/utility/drive.js', () => ({ selectFile: vi.fn() }));
vi.mock('@/pages/chat/room.search.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/room.members.vue', () => ({ default: { render: () => null } }));
vi.mock('@/pages/chat/room.info.vue', () => ({ default: { render: () => null } }));
vi.mock('@/utility/voice-call.js', async () => {
	const { reactive } = await import('vue');
	const voiceCall = reactive({
		status: 'idle',
		room: null as unknown,
		micEnabled: false,
		deafened: false,
		audioBlocked: false,
		speakingIdentities: [] as string[],
		screenSharing: false,
		screenShareIdentities: [] as string[],
		watchingIdentities: [] as string[],
	});
	return {
		voiceCall,
		joinVoiceCall: mocks.joinVoiceCall,
		leaveVoiceCall: mocks.leaveVoiceCall,
		setMicEnabled: mocks.setMicEnabled,
		setDeafened: mocks.setDeafened,
		resumeAudio: mocks.resumeAudio,
		watchScreenShare: mocks.watchScreenShare,
		unwatchScreenShare: mocks.unwatchScreenShare,
		toggleScreenShareWatch: mocks.toggleScreenShareWatch,
		startScreenShare: mocks.startScreenShare,
		stopScreenShare: mocks.stopScreenShare,
		setParticipantVolume: mocks.setParticipantVolume,
		canShareScreen: () => true,
		attachScreenShare: mocks.attachScreenShare,
		selectAudioDevice: vi.fn(),
		activeAudioDeviceId: () => 'default',
		localIdentityOf: (userId: string) => `https://local.test/users/${userId}`,
	};
});

import type { FakePrefer } from './fake-prefer.js';
import { installFakeResizeObserver, resizeObserved } from './fake-resize-observer.js';
import { i18n } from '@/i18n.js';
import { prefer as mockedPrefer } from '@/preferences.js';
import { voiceCall } from '@/utility/voice-call.js';
import XRoomPage from '@/pages/chat/room.vue';
import { useChatRoomVoiceCall } from '@/composables/use-chat-room-voice-call.js';
import { provideMetadataReceiver } from '@/page.js';
import { updateDeviceKind } from '@/utility/device-kind.js';
import XVoiceCallBar from '@/ui/_common_/voice-call-bar.vue';
import XScreen from '@/pages/chat/room.voice.screen.vue';
import XParticipant from '@/pages/chat/room.voice.participant.vue';
import XPreview from '@/pages/chat/room.voice.preview.vue';
import XTile from '@/pages/chat/room.voice.tile.vue';
import XShare from '@/pages/chat/room.voice.share.vue';
import XRoster from '@/pages/chat/room.voice.roster.vue';
import XScreens from '@/pages/chat/room.voice.screens.vue';

const stubs = {
	MkDraggable: { props: ['modelValue'], template: '<div><slot v-for="item in modelValue" :item="item"/></div>' },
	MkDriveFileThumbnail: { props: ['file'], template: '<img :alt="file.name" />' },
	// decorations を渡されたかどうかを見られるようにする (渡されなければ MkAvatar はユーザーの装飾をそのまま描く)
	MkAvatar: { props: ['user', 'decorations'], template: '<span class="avatar" :data-decorations="decorations === undefined ? \'user\' : JSON.stringify(decorations)"></span>' },
	MkUserName: { props: ['user'], template: '<span>{{ user.name ?? user.username }}</span>' },
	MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	MkButton: { emits: ['click'], template: '<button @click="$emit(\'click\', $event)"><slot /></button>' },
};

const room = { id: 'r1', name: 'room 1', ownerId: 'owner', owner: { id: 'owner', username: 'owner', host: null } } as any;
const mirror = { ...room, owner: { id: 'remote-owner', username: 'owner', host: 'remote.test' } };
const alice = { id: 'alice', username: 'alice', name: 'Alice', host: null };
const bob = { id: 'bob', username: 'bob', name: 'Bob', host: null };
const carol = { id: 'carol', username: 'carol', name: 'Carol', host: null };
const dave = { id: 'dave', username: 'dave', name: 'Dave', host: null };
const erin = { id: 'erin', username: 'erin', name: 'Erin', host: null };
// ログインしている自分 (mocks.me と同じ id)
const me = { id: 'me', username: 'me', name: 'Me', host: null };
const identityOf = (user: typeof alice) => `https://local.test/users/${user.id}`;
const participant = (user: typeof alice, screenSharing = false) => ({ identity: identityOf(user), user, screenSharing }) as any;
// 見ている共有画面は、誰の画面かの名前のついたまとまりになっている
const viewerOf = (user: typeof alice) => screen.getByRole('group', { name: i18n.tsx._voiceCall.screenShareOf({ name: user.name }) });
const queryViewerOf = (user: typeof alice) => screen.queryByRole('group', { name: i18n.tsx._voiceCall.screenShareOf({ name: user.name }) });
// 参加者のチップやタイルも、その人の名前のついたまとまりになっている
const participantGroup = (user: typeof alice) => screen.getByRole('group', { name: user.name });
const watchToggleOf = (user: typeof alice) => screen.getByRole('button', { name: i18n.tsx._voiceCall.watchScreenOf({ name: user.name }) });
const hasClass = (el: Element, name: string) => [...el.classList].some(c => c.includes(name));
const focusButtonOf = (user: typeof alice) => within(viewerOf(user)).getByRole('button', { name: i18n.ts._voiceCall.focusScreen });

// happy-dom には全画面とピクチャーインピクチャーの API が無いので、今どの要素がそうなっているかをテストから決める
const fullscreenDescriptor = Object.getOwnPropertyDescriptor(window.document, 'fullscreenElement');
const pipDescriptor = Object.getOwnPropertyDescriptor(window.document, 'pictureInPictureElement');
const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
let fullscreenElement: Element | null = null;
let pictureInPictureElement: Element | null = null;
Object.defineProperty(window.document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
Object.defineProperty(window.document, 'pictureInPictureElement', { configurable: true, get: () => pictureInPictureElement });

function setFullscreen(el: Element | null) {
	fullscreenElement = el;
	window.document.dispatchEvent(new Event('fullscreenchange'));
}

const callState = voiceCall as unknown as Record<string, unknown>;
const prefer = mockedPrefer as unknown as FakePrefer;

// ルーム画面は自分の幅を ResizeObserver で測って、通話を横に並べるかを決める
installFakeResizeObserver();

beforeEach(() => {
	routerListeners.change.length = 0;
	mocks.channel = new mocks.FakeChannel();
	mocks.instance.features.voiceCall = true;
	mocks.instance.features.remoteVoiceCall = false;
	prefer.reset({
		'voiceCall.acknowledgedRemoteHosts': [],
		'voiceCall.inputDeviceId': null,
		'voiceCall.outputDeviceId': null,
		'voiceCall.echoCancellation': true,
		'voiceCall.noiseSuppression': true,
		'voiceCall.autoGainControl': true,
		'voiceCall.screenShareQuality': 'sharp',
		'voiceCall.screenShareAudio': true,
		'voiceCall.participantVolumes': {},
		'voiceCall.screenShareVolumes': {},
		'voiceCall.stageChatSide': 'right',
	});
	mocks.misskeyApi.mockReset().mockResolvedValue([]);
	for (const fn of [mocks.joinVoiceCall, mocks.leaveVoiceCall, mocks.setMicEnabled, mocks.setDeafened, mocks.resumeAudio, mocks.watchScreenShare, mocks.unwatchScreenShare, mocks.toggleScreenShareWatch, mocks.startScreenShare, mocks.stopScreenShare, mocks.apiWithDialog, mocks.confirm, mocks.popupMenu]) fn.mockReset();
	mocks.attachScreenShare.mockClear();
	Object.assign(callState, { status: 'idle', room: null, micEnabled: false, deafened: false, audioBlocked: false, speakingIdentities: [], screenSharing: false, screenShareIdentities: [], watchingIdentities: [] });
});

afterEach(() => {
	cleanup();
	fullscreenElement = null;
	pictureInPictureElement = null;
	// 入力欄の書きかけはテストをまたいで残さない
	window.localStorage.clear();
});

afterAll(() => {
	for (const [target, key, descriptor] of [
		[window.document, 'fullscreenElement', fullscreenDescriptor],
		[window.document, 'pictureInPictureElement', pipDescriptor],
		[globalThis, 'ResizeObserver', resizeObserverDescriptor],
	] as const) {
		if (descriptor) Object.defineProperty(target, key, descriptor);
		else Reflect.deleteProperty(target, key);
	}
});

async function flush() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

describe('voice call roster', () => {
	function rosterFor(target: typeof room) {
		mocks.popup.mockReturnValue({ dispose: vi.fn() });
		let call!: ReturnType<typeof useChatRoomVoiceCall>;
		render(defineComponent({ setup() { call = useChatRoomVoiceCall(() => target); return () => h('div'); } }));
		return {
			async open() {
				await flush();
				call.openRoster();
				const props = reactive(mocks.popup.mock.calls.at(-1)![1]);
				// 本物の MkModal は背景を押したときだけ click を発する (行のクリックは伝わらない)
				render(XRoster, { props, global: { directives: { tooltip: {} }, stubs: { ...stubs, MkModal: { emits: ['click', 'closed', 'esc'], template: '<div><slot/></div>' } } } });
			},
		};
	}

	test('keeps roster refs intact through the reactive popup host', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice), participant(bob)] }]);
		await rosterFor(room).open();
		expect(screen.getByText('Alice')).toBeTruthy();
		expect(screen.getByText('Bob')).toBeTruthy();
	});

	// 通話に入っておらず持ち主でもなければ、参加者のメニューに出すものが無い。押しても何も起きないボタンにはしない
	test('lists participants without buttons for a member who has no menu for them', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice)] }]);
		await rosterFor(room).open();
		expect(screen.getByText('Alice')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Alice/ })).toBeNull();
	});

	test('lists participants as menu buttons for the room owner', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice)] }]);
		await rosterFor({ ...room, ownerId: 'me' }).open();
		await fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
		expect(openedItems().map(item => item.text)).toContain(i18n.ts._voiceCall.kick);
	});
});

const pageStubs = {
	...stubs,
	// 本物の MkPageHeader / CPPageHeader と同じく、アクションは action.text をラベルにしたアイコンのボタンで出し、タブで v-model:tab を切り替える
	PageWithHeader: {
		props: ['actions', 'tabs', 'tab'],
		methods: { refreshStickyLayout: mocks.refreshStickyLayout },
		emits: ['update:tab'],
		template: `<div style="overflow-y: scroll;">
			<div role="tablist"><button v-for="t in tabs" :key="t.key" role="tab" :aria-selected="t.key === tab" @click="$emit('update:tab', t.key)">{{ t.title }}</button></div>
			<div data-testid="header-actions"><button v-for="action in actions" class="_button" :aria-label="action.text" @click.stop="action.handler"><i :class="action.icon"></i></button></div>
			<slot />
			<div data-testid="page-footer"><slot name="footer" /></div>
		</div>`,
	},
	// カードが MkStickyContainer のヘッダーに置かれているか (= スクロールしても上に貼り付くか) を見る
	MkStickyContainer: { methods: { refresh() {} }, template: '<div><div data-testid="sticky-header"><slot name="header" /></div><slot /></div>' },
	MkLoading: { template: '<div></div>' },
};

// shown を渡すと、本物と同じく KeepAlive の中に置き、false にすると裏に回す
async function renderRoom(target: typeof room, states: unknown[] | Promise<unknown[]>, shown?: ReturnType<typeof ref<boolean>>, options: { bar?: boolean; visible?: ReturnType<typeof ref<boolean>> } = {}) {
	mocks.misskeyApi.mockImplementation((endpoint: string) => {
		if (endpoint === 'chat/rooms/show') return Promise.resolve(target);
		if (endpoint === 'chat/rooms/voice/states') return states instanceof Promise ? states : Promise.resolve(states);
		return Promise.resolve([]);
	});
	const host = defineComponent({
		setup() {
			provideMetadataReceiver(() => {});
			return () => h('div', [
				h('section', { style: { display: options.visible?.value === false ? 'none' : '' } }, [
					shown == null ? h(XRoomPage, { roomId: target.id }) : h(KeepAlive, null, [shown.value ? h(XRoomPage, { roomId: target.id, key: 'room' }) : h('div', { key: 'other' })]),
				]),
				options.bar ? h(XVoiceCallBar) : null,
			]);
		},
	});
	const result = render(host, { global: { directives: { tooltip: {} }, stubs: pageStubs } });
	await flush();
	await flush();
	return result;
}

const openedItems = () => mocks.popupMenu.mock.calls.at(-1)![0] as { type?: string; text?: string; action?: () => unknown; props?: any }[];
const menuButtonOf = (user: typeof alice) => within(participantGroup(user)).getByRole('button', { name: i18n.ts.menu });
const headerIcons = () => [...screen.getByTestId('header-actions').querySelectorAll('button')].map(el => el.querySelector('i')!.className);

async function openTab(title: string) {
	await fireEvent.click(screen.getByRole('tab', { name: title }));
	await flush();
}

const headerJoin = () => within(screen.getByTestId('header-actions')).queryByLabelText(i18n.ts._voiceCall.join);
const stickyCard = () => within(screen.getByTestId('sticky-header'));

async function setPageWidth(width: number) { resizeObserved(width); await flush(); }

describe('voice call on the room page', () => {
	test('keeps the full-width chat and a join banner before I join, even with other callers', async () => {
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
		expect(screen.queryByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeNull();
		expect(screen.getByRole('button', { name: i18n.ts._voiceCall.join })).toBeTruthy();
		// 通話に入っておらず持ち主でもなければ参加者のメニューに出すものが無いので、アバターはボタンにしない
		expect(stickyCard().queryByRole('button', { name: alice.name })).toBeNull();
		expect(screen.getByTestId('sticky-header').querySelectorAll('.avatar')).toHaveLength(1);
		expect(screen.queryByRole('group', { name: alice.name })).toBeNull();
	});
	test('makes the banner avatars menu buttons for the room owner', async () => {
		await renderRoom({ ...room, ownerId: 'me' }, [{ roomId: 'r1', participants: [participant(alice)] }]);
		await fireEvent.click(stickyCard().getByRole('button', { name: alice.name }));
		expect(openedItems().map(item => item.text)).toContain(i18n.ts._voiceCall.kick);
	});
	// 誰もいない通話は「参加」ではなく「開始」と呼ぶ。既存の通話に入るのか自分が始めるのかを迷わせない
	test('offers to start, not join, the call while nobody is in it', async () => {
		await renderRoom(room, []);
		expect(screen.getByRole('button', { name: i18n.ts._voiceCall.start })).toBeTruthy();
		expect(screen.queryByRole('button', { name: i18n.ts._voiceCall.join })).toBeNull();
		expect(stickyCard().queryByRole('button', { name: alice.name })).toBeNull();
		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [participant(alice)] });
		await flush();
		expect(screen.getByRole('button', { name: i18n.ts._voiceCall.join })).toBeTruthy();
		expect(screen.queryByRole('button', { name: i18n.ts._voiceCall.start })).toBeNull();
	});
	test('joins muted by default and passes the explicit prejoin choice', async () => {
		await renderRoom(room, []);
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.start }));
		expect(mocks.joinVoiceCall).toHaveBeenLastCalledWith(room, { micEnabled: false });
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.unmute }));
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.start }));
		expect(mocks.joinVoiceCall).toHaveBeenLastCalledWith(room, { micEnabled: true });
	});
	test('has one messages tab and puts search in the room menu', async () => {
		await renderRoom(room, []);
		expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([i18n.ts._chat.messages, i18n.ts._chat.members, i18n.ts.info]);
		expect(screen.queryByRole('tab', { name: i18n.ts.search })).toBeNull();
		await fireEvent.click(within(screen.getByTestId('header-actions')).getByRole('button', { name: i18n.ts.menu }));
		expect(openedItems().find(item => item.text === i18n.ts.search)).toBeTruthy();
	});
	test('shows the stage only after I join and keeps one chat form', async () => {
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
		const textarea = screen.getByRole('textbox');
		await fireEvent.update(textarea, 'draft before joining');
		Object.assign(callState, { status: 'connected', room });
		await flush();
		expect(participantGroup(alice)).toBeTruthy();
		expect(screen.getAllByRole('textbox')).toEqual([textarea]);
		expect((textarea as HTMLTextAreaElement).value).toBe('draft before joining');
		expect(screen.queryByRole('button', { name: i18n.ts._voiceCall.join })).toBeNull();
	});
	test('puts my card after shared screens and before other speakers', async () => {
		Object.assign(callState, { status: 'connected', room, micEnabled: true, speakingIdentities: [identityOf(alice)] });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true), participant(bob), participant(me)] }]);
		const mine = participantGroup(me);
		expect(watchToggleOf(alice).compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(mine.compareDocumentPosition(participantGroup(alice)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
	test.each([390, 320])('keeps readable card widths while watching at %ipx and omits excess cards', async width => {
		Object.assign(callState, { status: 'connected', room, watchingIdentities: [identityOf(alice)] });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true), participant(bob, true), participant(carol, true), participant(dave, true), participant(erin, true), participant(me)] }]);
		const stage = document.querySelector('[data-voice-call-room]')!;
		resizeObserved(width, stage, 669);
		await flush();
		const mine = participantGroup(me);
		const cards = mine.parentElement!.parentElement!;
		expect(parseFloat(cards.style.getPropertyValue('--card-width'))).toBeGreaterThanOrEqual(160);
		expect(parseFloat(cards.style.getPropertyValue('--card-height'))).toBeGreaterThanOrEqual(160);
		expect(cards.children.length).toBeLessThanOrEqual(4);
	});
	test.each([[570, 989], [390, 759]])('keeps stage cards square at %i×%i', async (width, height) => {
		Object.assign(callState, { status: 'connected', room });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true), participant(bob, true), participant(carol, true), participant(dave, true), participant(erin, true), participant(me)] }]);
		resizeObserved(width, document.querySelector('[data-voice-call-room]')!, height);
		await flush();
		const cards = participantGroup(me).parentElement!.parentElement!;
		expect(cards.style.getPropertyValue('--card-width')).toBe(cards.style.getPropertyValue('--card-height'));
	});
	test('accepts a file dropped on the chat pane outside the composer', async () => {
		mocks.launchUploader.mockResolvedValueOnce([{ id: 'dropped-image', name: 'pane.png' }]);
		await renderRoom(room, []);
		const pane = document.querySelector(`[aria-label="${i18n.ts._chat.messages}"]`)!;
		const image = new File(['image'], 'pane.png', { type: 'image/png' });
		const event = new Event('drop', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'dataTransfer', { value: { files: [image] } });
		await fireEvent(pane, event);
		await flush();
		expect(event.defaultPrevented).toBe(true);
		expect(mocks.launchUploader).toHaveBeenCalledWith([image], { multiple: false });
		expect(screen.getByRole('img', { name: 'pane.png' })).toBeTruthy();
	});
	test('toggles the desktop chat panel without changing its icon or losing the draft', async () => {
		Object.assign(callState, { status: 'connected', room });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.update(textarea, 'kept');
		const close = screen.getByRole('button', { name: i18n.ts._voiceCall.closeChat });
		const icon = close.querySelector('i')!.className;
		await fireEvent.click(close);
		expect(screen.queryByRole('textbox')).toBeNull();
		const open = screen.getByRole('button', { name: i18n.ts._voiceCall.openChat });
		expect(open.querySelector('i')!.className).toBe(icon);
		await fireEvent.click(open);
		expect(screen.getByRole('textbox')).toBe(textarea);
		expect(textarea.value).toBe('kept');
	});
	test('moves the desktop chat while preserving the watched video node', async () => {
		Object.assign(callState, { status: 'connected', room, watchingIdentities: [identityOf(alice)] });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true)] }]);
		const video = viewerOf(alice).querySelector('video');
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.moveChatLeft }));
		expect(prefer.commit).toHaveBeenCalledWith('voiceCall.stageChatSide', 'left');
		expect(viewerOf(alice).querySelector('video')).toBe(video);
		expect(screen.getByRole('button', { name: i18n.ts._voiceCall.moveChatRight })).toBeTruthy();
	});
	test('keeps microphone, deafen and screen share in one group and leave in its own group', async () => {
		Object.assign(callState, { status: 'connected', room, micEnabled: true });
		await renderRoom(room, []);
		const mic = screen.getByRole('button', { name: i18n.ts._voiceCall.mute });
		const deafen = screen.getByRole('button', { name: i18n.ts._voiceCall.deafen });
		const share = screen.getByRole('button', { name: i18n.ts._voiceCall.shareScreen });
		const leave = screen.getByRole('button', { name: i18n.ts._voiceCall.leave });
		expect(mic.parentElement).toBe(deafen.parentElement);
		expect(mic.parentElement).toBe(share.parentElement);
		expect(leave.parentElement).not.toBe(mic.parentElement);
		await fireEvent.click(leave);
		expect(mocks.leaveVoiceCall).toHaveBeenCalledTimes(1);
	});
	test('renders independent screen choices and keeps voice volume in the person menu', async () => {
		Object.assign(callState, { status: 'connected', room });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true), participant(bob, true)] }]);
		await fireEvent.click(watchToggleOf(alice));
		expect(mocks.toggleScreenShareWatch).toHaveBeenCalledWith(identityOf(alice));
		await fireEvent.click(menuButtonOf(bob));
		expect(openedItems().filter(item => item.type === 'component').map(item => item.props.audio)).toEqual(['voice']);
		expect(screen.queryByRole('button', { name: i18n.ts.volume })).toBeNull();
	});
	test('keeps shared video alive while participants are collapsed', async () => {
		Object.assign(callState, { status: 'connected', room, watchingIdentities: [identityOf(alice)] });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true)] }]);
		const video = viewerOf(alice).querySelector('video');
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.hideParticipants }));
		expect(viewerOf(alice).querySelector('video')).toBe(video);
		expect(screen.getByRole('button', { name: i18n.ts._voiceCall.showParticipants })).toBeTruthy();
	});
	test('keeps one chat form when the call ends', async () => {
		Object.assign(callState, { status: 'connected', room });
		await renderRoom(room, []);
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		await fireEvent.update(textarea, 'still here');
		Object.assign(callState, { status: 'idle', room: null });
		await flush();
		expect(screen.getByRole('textbox')).toBe(textarea);
		expect(textarea.value).toBe('still here');
		expect(screen.getByRole('button', { name: i18n.ts._voiceCall.start })).toBeTruthy();
	});
	test('mobile joins into the call and opens chat as a sheet', async () => {
		const originalWidth = window.innerWidth;
		try {
			window.innerWidth = 400;
			window.dispatchEvent(new Event('resize'));
			await renderRoom(room, []);
			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			await fireEvent.update(textarea, 'mobile draft');
			Object.assign(callState, { status: 'connected', room });
			await flush();
			expect(screen.queryByRole('textbox')).toBeNull();
			await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.openChat }));
			expect(screen.getByRole('dialog', { name: i18n.ts._chat.messages })).toBeTruthy();
			expect(screen.getByRole('textbox')).toBe(textarea);
			expect(textarea.value).toBe('mobile draft');
			const backdrop = screen.getByRole('dialog').previousElementSibling as HTMLElement;
			expect(backdrop.hasAttribute('inert')).toBe(false);
			await fireEvent.click(backdrop);
			expect(screen.queryByRole('dialog')).toBeNull();
			await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.openChat }));
			expect(screen.getByRole('textbox')).toBe(textarea);
			await fireEvent.click(screen.getByRole('button', { name: i18n.ts.close }));
			expect(screen.queryByRole('dialog')).toBeNull();
		} finally { window.innerWidth = originalWidth; window.dispatchEvent(new Event('resize')); }
	});
	// シートの背景 (v-if) は閉じると先に DOM から消える。その後の解放で周囲の inert が残ると画面全体が操作不能になる
	describe('chat sheet focus trap', () => {
		async function openSheet() {
			await renderRoom(room, []);
			Object.assign(callState, { status: 'connected', room });
			await flush();
			await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.openChat }));
			await flush();
			expect(screen.getByRole('dialog', { name: i18n.ts._chat.messages })).toBeTruthy();
			expect(document.querySelectorAll('[inert]').length).toBeGreaterThan(0);
		}

		let originalWidth = window.innerWidth;
		beforeEach(() => { originalWidth = window.innerWidth; window.innerWidth = 400; window.dispatchEvent(new Event('resize')); });
		afterEach(() => { window.innerWidth = originalWidth; window.dispatchEvent(new Event('resize')); });

		test('leaves nothing inert after the sheet is closed with its close button', async () => {
			await openSheet();
			await fireEvent.click(screen.getByRole('button', { name: i18n.ts.close }));
			await flush();
			expect(screen.queryByRole('dialog')).toBeNull();
			expect(document.querySelectorAll('[inert]')).toHaveLength(0);
		});

		test('leaves nothing inert after the sheet is closed from its backdrop', async () => {
			await openSheet();
			await fireEvent.click(screen.getByRole('dialog').previousElementSibling as HTMLElement);
			await flush();
			expect(screen.queryByRole('dialog')).toBeNull();
			expect(document.querySelectorAll('[inert]')).toHaveLength(0);
		});

		test('closes the sheet and releases every trap before the router leaves the room', async () => {
			await openSheet();
			expect(routerListeners.change.length).toBeGreaterThan(0);
			for (const listener of routerListeners.change) listener({});
			await flush();
			expect(screen.queryByRole('dialog')).toBeNull();
			expect(document.querySelectorAll('[inert]')).toHaveLength(0);
		});
	});
	describe('room owned on another server', () => {
		test('shows the call for a mirror room when remote calls are allowed', async () => {
			mocks.instance.features.remoteVoiceCall = true;
			await renderRoom(mirror, [{ roomId: 'r1', participants: [participant(alice)] }]);
			expect(screen.getByRole('button', { name: i18n.ts._voiceCall.join })).toBeTruthy();
			expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/states', { roomIds: ['r1'] });
		});

		test('hides the call for a mirror room when remote calls are not allowed', async () => {
			await renderRoom(mirror, [{ roomId: 'r1', participants: [participant(alice)] }]);
			expect(screen.queryByRole('button', { name: i18n.ts._voiceCall.join })).toBeNull();
			expect(screen.queryByRole('button', { name: i18n.ts._voiceCall.start })).toBeNull();
			expect(mocks.misskeyApi).not.toHaveBeenCalledWith('chat/rooms/voice/states', expect.anything());
		});

		test('asks once before joining a call on another server', async () => {
			mocks.instance.features.remoteVoiceCall = true;
			mocks.confirm.mockResolvedValue({ canceled: false });
			await renderRoom(mirror, [{ roomId: 'r1', participants: [participant(alice)] }]);

			await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.join }));
			await flush();
			expect(mocks.confirm).toHaveBeenCalledTimes(1);
			expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ text: i18n.tsx._voiceCall.remoteHostNotice({ host: 'remote.test' }) }));
			expect(prefer.commit).toHaveBeenCalledWith('voiceCall.acknowledgedRemoteHosts', ['remote.test']);
			expect(mocks.joinVoiceCall).toHaveBeenCalledTimes(1);
			expect(mocks.joinVoiceCall).toHaveBeenCalledWith(mirror, { micEnabled: false });

			await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.join }));
			await flush();
			expect(mocks.confirm).toHaveBeenCalledTimes(1);
			expect(mocks.joinVoiceCall).toHaveBeenCalledTimes(2);
		});

		test('ignores a second click while the notice is still open', async () => {
			mocks.instance.features.remoteVoiceCall = true;
			let answer!: (value: { canceled: boolean }) => void;
			mocks.confirm.mockReturnValue(new Promise(resolve => { answer = resolve; }));
			await renderRoom(mirror, [{ roomId: 'r1', participants: [participant(alice)] }]);

			await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.join }));
			await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.join }));
			answer({ canceled: false });
			await flush();

			expect(mocks.confirm).toHaveBeenCalledTimes(1);
			expect(mocks.joinVoiceCall).toHaveBeenCalledTimes(1);
		});

		test('does not join when the notice is cancelled', async () => {
			mocks.instance.features.remoteVoiceCall = true;
			mocks.confirm.mockResolvedValue({ canceled: true });
			await renderRoom(mirror, [{ roomId: 'r1', participants: [participant(alice)] }]);

			await fireEvent.click(screen.getByRole('button', { name: i18n.ts._voiceCall.join }));
			await flush();
			expect(mocks.joinVoiceCall).not.toHaveBeenCalled();
			expect(prefer.commit).not.toHaveBeenCalledWith('voiceCall.acknowledgedRemoteHosts', expect.anything());
		});
	});

	test.each(['connecting', 'reconnecting'] as const)('announces the call status (%s) from the stage for screen readers', async status => {
		Object.assign(callState, { status, room });
		await renderRoom(room, []);
		const title = screen.getByText(i18n.ts._voiceCall[status]);
		expect(title.closest('[aria-live="polite"]')).not.toBeNull();
	});

	test('lets the stage announce, then hands announcements back to the global bar when the room goes away', async () => {
		Object.assign(callState, { status: 'reconnecting', room });
		const page = await renderRoom(room, []);
		render(XVoiceCallBar, { global: { directives: { tooltip: {} }, stubs } });
		await flush();
		const live = () => [...document.querySelectorAll('[aria-live="polite"]')].filter(el => el.textContent === i18n.ts._voiceCall.reconnecting);
		expect(live()).toHaveLength(1);
		expect(live()[0].closest('[role="region"]')).toBeNull();
		page.unmount();
		await flush();
		expect(live()).toHaveLength(1);
		expect(live()[0].closest('[role="region"]')).not.toBeNull();
	});

	test('offers no call when voice calls are disabled on this server', async () => {
		mocks.instance.features.voiceCall = false;
		await renderRoom(room, []);
		expect(screen.queryByRole('button', { name: i18n.ts._voiceCall.start })).toBeNull();
		expect(mocks.misskeyApi).not.toHaveBeenCalledWith('chat/rooms/voice/states', expect.anything());
	});

	// 通話中にルームへ戻ったときなど、ページの幅が分かる前から通話に入っていると、幅が分かった途端にシートが勝手に開いてフォーカスを奪っていた
	test('does not open the chat sheet by itself when the page turns out narrow after joining', async () => {
		Object.assign(callState, { status: 'connected', room });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(me)] }]);
		await setPageWidth(800);
		expect(screen.queryByRole('dialog', { name: i18n.ts._chat.messages })).toBeNull();
		expect(document.querySelectorAll('[inert]')).toHaveLength(0);
		expect(screen.getByRole('button', { name: i18n.ts._voiceCall.openChat })).toBeTruthy();
	});

	test('closes the chat beside the stage instead of turning it into an open sheet when the page narrows during a call', async () => {
		await renderRoom(room, []);
		await setPageWidth(1280);
		Object.assign(callState, { status: 'connected', room });
		await flush();
		expect(screen.getByRole('textbox')).toBeTruthy();
		await setPageWidth(800);
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.querySelectorAll('[inert]')).toHaveLength(0);
		expect(screen.getByRole('button', { name: i18n.ts._voiceCall.openChat })).toBeTruthy();
	});

		describe('watching several shares', () => {
			const sharers = [alice, bob, carol, dave, erin];

			async function renderStageWatching(count: number) {
				Object.assign(callState, { status: 'connected', room, micEnabled: true, watchingIdentities: sharers.slice(0, count).map(identityOf) });
				await renderRoom(room, [{ roomId: 'r1', participants: sharers.map(user => participant(user, true)) }]);
				await setPageWidth(1280);
			}

			test('shows every watched share on the stage', async () => {
				await renderStageWatching(2);

				expect(viewerOf(alice)).toBeTruthy();
				expect(viewerOf(bob)).toBeTruthy();
				expect(queryViewerOf(carol)).toBeNull();
				// 参加者のタイルは画面の下に並べたまま押せる
				expect(watchToggleOf(carol)).toBeTruthy();
			});

			test.each([
				[1, 'layout1'],
				[2, 'layout2'],
				[3, 'layout4'],
				[4, 'layout4'],
				[5, 'layoutMany'],
			])('lays out %i watched shares as %s', async (count, layout) => {
				await renderStageWatching(count);

				const grid = viewerOf(alice).parentElement!;
				expect(hasClass(grid, layout)).toBe(true);
				expect(grid.querySelectorAll('video')).toHaveLength(count);
			});

			test('clicking a share focuses it large with the others in a strip, and clicking it again goes back to the grid', async () => {
				await renderStageWatching(3);
				const focusButton = (user: typeof alice) => within(viewerOf(user)).getByRole('button', { name: i18n.ts._voiceCall.focusScreen });

				await fireEvent.click(focusButton(bob));
				await flush();
				expect(focusButton(bob).getAttribute('aria-pressed')).toBe('true');
				expect(hasClass(viewerOf(bob), 'focused')).toBe(true);
				expect(hasClass(viewerOf(alice), 'stripItem')).toBe(true);
				expect(hasClass(viewerOf(carol), 'stripItem')).toBe(true);
				// 帯の画面を押すと、そちらを大きくする
				await fireEvent.click(focusButton(alice));
				await flush();
				expect(hasClass(viewerOf(alice), 'focused')).toBe(true);
				expect(hasClass(viewerOf(bob), 'stripItem')).toBe(true);

				await fireEvent.click(focusButton(alice));
				await flush();
				expect(hasClass(viewerOf(alice), 'focused')).toBe(false);
				expect(hasClass(viewerOf(alice).parentElement!, 'layout4')).toBe(true);
			});

			test('drops the focus when the focused share is no longer watched', async () => {
				await renderStageWatching(3);
				await fireEvent.click(within(viewerOf(bob)).getByRole('button', { name: i18n.ts._voiceCall.focusScreen }));
				await flush();

				callState.watchingIdentities = [identityOf(alice), identityOf(carol)];
				await flush();

				expect(queryViewerOf(bob)).toBeNull();
				expect(hasClass(viewerOf(alice).parentElement!, 'layout2')).toBe(true);
			});

			test('offers no focus while only one share is watched', async () => {
				await renderStageWatching(1);

				expect(within(viewerOf(alice)).queryByRole('button', { name: i18n.ts._voiceCall.focusScreen })).toBeNull();
			});

			test('keeps every viewer, its video and the keyboard focus when the focus moves', async () => {
				await renderStageWatching(3);
				const viewers = [alice, bob, carol].map(viewerOf);
				const videos = viewers.map(viewer => viewer.querySelector('video'));
				const bobFocus = focusButtonOf(bob);
				bobFocus.focus();

				await fireEvent.click(bobFocus);
				await flush();
				expect(window.document.activeElement).toBe(bobFocus);
				await fireEvent.click(focusButtonOf(carol));
				await flush();
				await fireEvent.click(focusButtonOf(carol));
				await flush();

				// 画面を作り直すと、全画面やピクチャーインピクチャーが解け、映像も一瞬消える
				expect([alice, bob, carol].map(viewerOf)).toEqual(viewers);
				expect(viewers.map(viewer => viewer.querySelector('video'))).toEqual(videos);
				for (const video of videos) expect(video!.isConnected).toBe(true);
				expect(focusButtonOf(bob)).toBe(bobFocus);
			});

			test('keeps a share in picture-in-picture playing while another share is focused', async () => {
				await renderStageWatching(2);
				const bobVideo = viewerOf(bob).querySelector('video')!;
				pictureInPictureElement = bobVideo;

				await fireEvent.click(focusButtonOf(alice));
				await flush();

				expect(viewerOf(bob).querySelector('video')).toBe(bobVideo);
				expect(bobVideo.isConnected).toBe(true);
				// 映している要素から外していない
				const bobAttach = mocks.attachScreenShare.mock.calls.findIndex(([, element]) => element === bobVideo);
				expect(bobAttach).toBeGreaterThanOrEqual(0);
				expect(mocks.attachScreenShare.mock.results[bobAttach].value).not.toHaveBeenCalled();
			});

			test('a click on a fullscreen share neither changes the layout nor leaves fullscreen', async () => {
				await renderStageWatching(2);
				const viewer = viewerOf(alice);
				setFullscreen(viewer);
				await flush();

				// 全画面のあいだは、画面全体を覆う「大きくする」ボタンを置かない
				expect(within(viewer).queryByRole('button', { name: i18n.ts._voiceCall.focusScreen })).toBeNull();
				await fireEvent.click(viewer.querySelector('video')!);
				await flush();

				expect(viewerOf(alice)).toBe(viewer);
				expect(viewer.isConnected).toBe(true);
				expect(hasClass(viewer, 'focused')).toBe(false);
				expect(hasClass(viewer.parentElement!, 'layout2')).toBe(true);

				setFullscreen(null);
				await flush();
				expect(focusButtonOf(alice)).toBeTruthy();
			});

			test('forgets the focus once fewer than two shares are watched', async () => {
				await renderStageWatching(2);
				await fireEvent.click(focusButtonOf(alice));
				await flush();

				callState.watchingIdentities = [identityOf(alice)];
				await flush();
				callState.watchingIdentities = [identityOf(alice), identityOf(bob)];
				await flush();

				// また 2 つ見始めても、前に大きくしていた画面が勝手に大きくならない
				expect(hasClass(viewerOf(alice), 'focused')).toBe(false);
				expect(hasClass(viewerOf(alice).parentElement!, 'layout2')).toBe(true);
			});
		});
});

// 見えているカードは入れ替えない。隠れている人が話し続けたときだけ、いちばん長く黙っている人と席を替える
describe('stage card order', () => {
	const others = [alice, bob, carol, dave];
	// カードは要素で包まれているので、並びの入れ物はその親
	const cards = () => participantGroup(me).parentElement!.parentElement!;
	const visibleNames = () => [...cards().querySelectorAll('[role="group"]')].map(el => el.getAttribute('aria-label'));

	// 自分と他 2 人しか載らない狭さのステージに 5 人を出す
	async function renderCrowdedStage() {
		Object.assign(callState, { status: 'connected', room, micEnabled: true });
		await renderRoom(room, [{ roomId: 'r1', participants: [...others.map(user => participant(user)), participant(me)] }]);
		resizeObserved(390, document.querySelector('[data-voice-call-room]')!, 400);
		await flush();
		expect(visibleNames()).toEqual([me.name, alice.name, bob.name]);
	}

	async function speak(users: (typeof alice)[], ms: number) {
		callState.speakingIdentities = users.map(identityOf);
		await flush();
		await vi.advanceTimersByTimeAsync(ms);
		await flush();
	}

	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	test('keeps visible cards where they are when one of them speaks', async () => {
		await renderCrowdedStage();
		await speak([bob], 1500);
		expect(visibleNames()).toEqual([me.name, alice.name, bob.name]);
	});

	test('brings a hidden speaker in after they keep talking, in place of the visible person silent the longest', async () => {
		await renderCrowdedStage();
		await speak([bob], 1500);
		await speak([], 1500);
		await speak([carol], 300);
		expect(visibleNames()).toEqual([me.name, alice.name, bob.name]);
		await speak([carol], 700);
		expect(visibleNames()).toEqual([me.name, carol.name, bob.name]);
	});

	test('ignores a short remark from a hidden participant', async () => {
		await renderCrowdedStage();
		await speak([carol], 300);
		await speak([], 2000);
		expect(visibleNames()).toEqual([me.name, alice.name, bob.name]);
	});

	test('does not take the place of a visible participant who is still talking', async () => {
		await renderCrowdedStage();
		await speak([alice, bob, carol], 1500);
		expect(visibleNames()).toEqual([me.name, alice.name, bob.name]);
		await speak([alice, carol], 0);
		expect(visibleNames()).toEqual([me.name, alice.name, carol.name]);
	});

	test('holds the order while a participant menu is open and catches up once it closes', async () => {
		await renderCrowdedStage();
		let closeMenu!: () => void;
		mocks.popupMenu.mockReturnValueOnce(new Promise<void>(resolve => { closeMenu = resolve; }));
		await fireEvent.click(menuButtonOf(alice));
		await speak([carol], 1500);
		expect(visibleNames()).toEqual([me.name, alice.name, bob.name]);
		closeMenu();
		await flush();
		expect(visibleNames()).toEqual([me.name, alice.name, carol.name]);
	});

	test('holds the order while the pointer rests on a card and catches up once it leaves', async () => {
		await renderCrowdedStage();
		await fireEvent.pointerOver(participantGroup(alice));
		await speak([carol], 1500);
		expect(visibleNames()).toEqual([me.name, alice.name, bob.name]);
		await fireEvent.pointerLeave(cards());
		await flush();
		expect(visibleNames()).toEqual([me.name, alice.name, carol.name]);
	});

	// デスクトップではマウスをステージの上に置いたままにしがちなので、カードの隙間に置かれているだけでは止めない
	test('keeps bringing speakers in while the pointer rests beside the cards', async () => {
		await renderCrowdedStage();
		await fireEvent.pointerOver(cards());
		await speak([carol], 1500);
		expect(visibleNames()).toEqual([me.name, alice.name, carol.name]);
	});

	test('keeps the same order rules when the cards animate as a transition group', async () => {
		prefer.s.animation = true;
		try {
			await renderCrowdedStage();
			await speak([carol], 1500);
			expect(visibleNames()).toEqual([me.name, alice.name, carol.name]);
		} finally { prefer.s.animation = false; }
	});
});

// LiveKit を持たず、他のサーバーの通話にだけ参加するサーバー
describe('on a server without its own LiveKit', () => {
	beforeEach(() => {
		mocks.instance.features.voiceCall = false;
		mocks.instance.features.remoteVoiceCall = true;
	});

	test('shows who is in a mirror room\'s call', async () => {
		await renderRoom(mirror, [{ roomId: 'r1', participants: [participant(alice)] }]);
		expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/states', { roomIds: ['r1'] });
		expect(screen.getByTestId('sticky-header').querySelectorAll('.avatar')).toHaveLength(1);
		expect(screen.getByRole('button', { name: i18n.ts._voiceCall.join })).toBeTruthy();
	});

	test('follows a mirror room\'s call through the main stream', async () => {
		await renderRoom(mirror, []);
		expect(screen.getByRole('button', { name: i18n.ts._voiceCall.start })).toBeTruthy();
		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [participant(bob)] });
		await flush();
		expect(screen.getByRole('button', { name: i18n.ts._voiceCall.join })).toBeTruthy();
		expect(screen.getByTestId('sticky-header').querySelectorAll('.avatar')).toHaveLength(1);
	});

	test('lets me watch a participant sharing their screen after joining a mirror room\'s call', async () => {
		Object.assign(callState, { status: 'connected', room: mirror });
		await renderRoom(mirror, [{ roomId: 'r1', participants: [participant(alice, true)] }]);
		await fireEvent.click(watchToggleOf(alice));
		expect(mocks.toggleScreenShareWatch).toHaveBeenCalledWith(identityOf(alice));
	});

	test('still offers no call in a room owned here, since this server cannot host its call', async () => {
		await renderRoom(room, []);
		expect(screen.queryByRole('button', { name: i18n.ts._voiceCall.start })).toBeNull();
		expect(mocks.misskeyApi).not.toHaveBeenCalledWith('chat/rooms/voice/states', expect.anything());
	});
});

describe('screen share on the stage', () => {
	test('keeps participant identity passive and watches only from the share card', async () => {
		Object.assign(callState, { status: 'connected', room });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true)] }]);

		await fireEvent.click(within(participantGroup(alice)).getByText('Alice'));
		expect(mocks.toggleScreenShareWatch).not.toHaveBeenCalled();
		await fireEvent.click(watchToggleOf(alice));
		expect(mocks.toggleScreenShareWatch).toHaveBeenLastCalledWith(identityOf(alice));
	});

	test('keeps the live preview in the share card, not on the sharer\'s tile', async () => {
		Object.assign(callState, { status: 'connected', room });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true), participant(bob)] }]);

		const preview = watchToggleOf(alice).querySelector('video');
		expect(preview).not.toBeNull();
		expect(mocks.attachScreenShare).toHaveBeenCalledWith(identityOf(alice), preview, { preview: true });
		expect(within(participantGroup(alice)).getByText('Alice')).toBeTruthy();
		expect(participantGroup(alice).querySelector('video')).toBeNull();
		expect(participantGroup(bob).querySelector('video')).toBeNull();
	});

	// 共有している本人も、送っている画面を確かめられるようにする (違う窓を映していても気付ける)
	// 参加者の一覧はサーバーを経て届くので、共有を始めても少し遅れて変わる (他のサーバーのルームでは 10 秒以上)。それを待たずに映す
	test.each([true, false])('shows a live preview of my own share, which toggles watching it like anyone else\'s (listed as sharing yet: %s)', async listed => {
		Object.assign(callState, { status: 'connected', room, screenSharing: true });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(me, listed), participant(alice, true)] }]);

		const preview = watchToggleOf(me).querySelector('video');
		expect(preview).not.toBeNull();
		expect(mocks.attachScreenShare).toHaveBeenCalledWith(identityOf(me), preview, { preview: true });
		await fireEvent.click(watchToggleOf(me));
		expect(mocks.toggleScreenShareWatch).toHaveBeenLastCalledWith(identityOf(me));

		callState.watchingIdentities = [identityOf(me)];
		await flush();
		expect(within(viewerOf(me)).getByLabelText(i18n.ts._voiceCall.fullscreen)).toBeTruthy();
	});

	// 参加者の一覧はサーバーを経て届くので、共有をやめてから少し遅れて変わる。それを待たずにプレビューを外す
	test('takes my preview away as soon as I stop sharing', async () => {
		Object.assign(callState, { status: 'connected', room, screenSharing: true });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(me, true)] }]);
		expect(watchToggleOf(me).querySelector('video')).not.toBeNull();
		const detach = mocks.attachScreenShare.mock.results.at(-1)!.value as ReturnType<typeof vi.fn>;

		callState.screenSharing = false;
		await flush();

		expect(detach).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole('button', { name: i18n.tsx._voiceCall.watchScreenOf({ name: me.name }) })).toBeNull();
		// 共有のアイコンも、自分の共有ボタンと同じく手元の状態に合わせて消す
		expect(within(participantGroup(me)).queryByLabelText(i18n.ts._voiceCall.sharingScreen)).toBeNull();
	});

	// 一覧に自分がまだいない (参加した直後) あいだは、自分のタイルを作って足しはしない
	test('does not make up a tile for me before the list has me', async () => {
		Object.assign(callState, { status: 'connected', room, screenSharing: true });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true)] }]);

		expect(screen.queryByRole('group', { name: me.name })).toBeNull();
		expect(mocks.attachScreenShare).not.toHaveBeenCalledWith(identityOf(me), expect.anything(), expect.anything());

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [participant(me, false), participant(alice, true)] });
		await flush();
		expect(watchToggleOf(me).querySelector('video')).not.toBeNull();
	});

	// 手元の状態は通話中のルームのもの。ほかのルームでは届いたとおりに出し、通話に入るまでは共有画面を受け取れないのでプレビューも出さない
	test('does not offer to watch or preview before joining the call', async () => {
		Object.assign(callState, { status: 'connected', room: { ...room, id: 'other-room' }, screenSharing: true });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(me, false), participant(alice, true)] }]);

		expect(screen.queryByRole('button', { name: i18n.tsx._voiceCall.watchScreenOf({ name: 'Alice' }) })).toBeNull();
		expect(screen.queryByRole('button', { name: i18n.tsx._voiceCall.watchScreenOf({ name: me.name }) })).toBeNull();
		expect(mocks.attachScreenShare).not.toHaveBeenCalled();
	});

	test('opens the participant menu from the ⋯ button, not from the tile', async () => {
		Object.assign(callState, { status: 'connected', room });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true), participant(bob)] }]);

		await fireEvent.click(within(participantGroup(bob)).getByText('Bob'));
		await fireEvent.click(within(participantGroup(alice)).getByText('Alice'));
		expect(mocks.popupMenu).not.toHaveBeenCalled();

		await fireEvent.click(within(participantGroup(alice)).getByLabelText(i18n.ts.menu));
		expect(mocks.popupMenu).toHaveBeenCalledTimes(1);
		expect(mocks.toggleScreenShareWatch).not.toHaveBeenCalled();
		await fireEvent.click(within(participantGroup(bob)).getByLabelText(i18n.ts.menu));
		expect(mocks.popupMenu).toHaveBeenCalledTimes(2);
	});

	describe('closing a watched share', () => {
		const sharers = [alice, bob, carol];

		async function renderStageWatching(count: number) {
			Object.assign(callState, { status: 'connected', room, watchingIdentities: sharers.slice(0, count).map(identityOf) });
			// 見るのをやめると、その人の共有カードが並びに戻る
			mocks.unwatchScreenShare.mockImplementation((identity: string) => { callState.watchingIdentities = (callState.watchingIdentities as string[]).filter(id => id !== identity); });
			await renderRoom(room, [{ roomId: 'r1', participants: sharers.map(user => participant(user, true)) }]);
			await setPageWidth(1280);
		}

		test('shows each watched share with its own name, fullscreen, picture-in-picture and close', async () => {
			Object.defineProperty(window.document, 'pictureInPictureEnabled', { configurable: true, value: true });
			try {
				await renderStageWatching(2);
			} finally {
				Reflect.deleteProperty(window.document, 'pictureInPictureEnabled');
			}

			for (const user of [alice, bob]) {
				const viewer = within(viewerOf(user));
				expect(viewer.getByText(user.name)).toBeTruthy();
				expect(viewer.getByLabelText(i18n.ts._voiceCall.fullscreen)).toBeTruthy();
				expect(viewer.getByLabelText(i18n.ts._voiceCall.pictureInPicture)).toBeTruthy();
			}
			expect(queryViewerOf(carol)).toBeNull();

			await fireEvent.click(within(viewerOf(bob)).getByLabelText(i18n.ts._voiceCall.stopWatching));
			expect(mocks.unwatchScreenShare).toHaveBeenCalledWith(identityOf(bob));
		});

		test('closing a share from the keyboard moves the focus to the sharer\'s card', async () => {
			await renderStageWatching(2);
			const close = within(viewerOf(alice)).getByLabelText(i18n.ts._voiceCall.stopWatching);
			close.focus();

			await fireEvent.click(close);
			await flush();

			expect(window.document.activeElement).toBe(watchToggleOf(alice));
		});

		test('closing skips a hidden mounted copy of the same call toggle', async () => {
			await renderStageWatching(2);
			const hidden = document.createElement('div');
			hidden.style.display = 'none';
			hidden.append(watchToggleOf(carol).cloneNode(true));
			(hidden.firstElementChild as HTMLElement).dataset.voiceCallWatchToggle = identityOf(alice);
			document.body.prepend(hidden);
			try {
				await fireEvent.click(within(viewerOf(alice)).getByLabelText(i18n.ts._voiceCall.stopWatching));
				await flush();
				expect(document.activeElement).toBe(watchToggleOf(alice));
			} finally {
				hidden.remove();
			}
		});
	});
});

describe('screen share viewer', () => {
	test('sizes itself to the shared video and keeps the bar right under it', async () => {
		render(XScreen, { props: { participant: participant(alice, true), fill: true }, global: { directives: { tooltip: {} }, stubs } });
		await flush();
		const viewer = viewerOf(alice);
		const video = viewer.querySelector('video')!;
		Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1600 });
		Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1200 });

		await fireEvent(video, new Event('resize'));
		await flush();

		// 枠を映像の縦横比に合わせるので、背の高い置き場所でも映像と操作の列のあいだが空かない
		expect(Number(viewer.style.getPropertyValue('--voiceCallScreenRatio'))).toBeCloseTo(4 / 3);
		const bar = within(viewer).getByLabelText(i18n.ts._voiceCall.fullscreen).parentElement!;
		expect(bar.parentElement).not.toBe(viewer);
		expect(frameOf(viewer).contains(bar)).toBe(true);
	});

	// 操作の列 (左右の余白 8px、32px のボタン、ボタンのあいだ 4px) が収まる幅
	const barMinWidth = (bar: Element) => {
		const buttons = bar.querySelectorAll('button').length;
		return 16 + buttons * 32 + Math.max(0, buttons - 1) * 4;
	};
	const frameOf = (viewer: HTMLElement) => viewer.querySelector('video')!.parentElement!.parentElement!;

	test.each([true, false])('in the narrow card, shows the name on the video and keeps the bar to the controls (picture-in-picture: %s)', async pictureInPicture => {
		if (pictureInPicture) Object.defineProperty(window.document, 'pictureInPictureEnabled', { configurable: true, value: true });
		try {
			render(XScreen, { props: { participant: participant(alice, true) }, global: { directives: { tooltip: {} }, stubs } });
			await flush();
		} finally {
			Reflect.deleteProperty(window.document, 'pictureInPictureEnabled');
		}
		const viewer = viewerOf(alice);
		const bar = within(viewer).getByLabelText(i18n.ts._voiceCall.fullscreen).parentElement!;

		// 狭い画面では、操作の列に名前を並べると一文字ほどに縮んでしまうので、映像の左上に重ねる
		const name = within(viewer).getByText('Alice');
		expect(bar.contains(name)).toBe(false);
		expect(viewer.querySelector('video')!.parentElement!.contains(name)).toBe(true);
		expect(bar.textContent?.trim()).toBe('');
		expect(within(viewer).getByLabelText(i18n.ts._voiceCall.sharingScreen)).toBeTruthy();

		// 枠は操作の列より狭くならない (狭いときは映像の方を縮めて上下か左右を空ける) ので、全画面・PiP・✕ が切れない
		const frame = frameOf(viewer);
		expect(frame.contains(bar)).toBe(true);
		expect(parseFloat(frame.style.minWidth)).toBeGreaterThanOrEqual(barMinWidth(bar));
	});

	test('on the wide stage, keeps the name inset in the video outside the controls', async () => {
		render(XScreen, { props: { participant: participant(alice, true), fill: true }, global: { directives: { tooltip: {} }, stubs } });
		await flush();
		const viewer = viewerOf(alice);
		const bar = within(viewer).getByLabelText(i18n.ts._voiceCall.fullscreen).parentElement!;

		expect(bar.contains(within(viewer).getByText('Alice'))).toBe(false);
		expect(parseFloat(frameOf(viewer).style.minWidth)).toBeGreaterThanOrEqual(barMinWidth(bar));
	});

	test('uses plain buttons that never submit a form', async () => {
		Object.defineProperty(window.document, 'pictureInPictureEnabled', { configurable: true, value: true });
		try {
			render(XScreen, { props: { participant: participant(alice, true), fill: true, focusable: true }, global: { directives: { tooltip: {} }, stubs } });
			await flush();
		} finally {
			Reflect.deleteProperty(window.document, 'pictureInPictureEnabled');
		}

		const buttons = within(viewerOf(alice)).getAllByRole('button');
		expect(buttons.length).toBe(5);
		for (const button of buttons) expect(button.getAttribute('type')).toBe('button');
	});

	test('stops showing the share when it goes away', async () => {
		const { unmount } = render(XScreen, { props: { participant: participant(alice, true) }, global: { directives: { tooltip: {} }, stubs } });
		await flush();
		const detach = mocks.attachScreenShare.mock.results[mocks.attachScreenShare.mock.results.length - 1].value as ReturnType<typeof vi.fn>;
		expect(detach).not.toHaveBeenCalled();

		unmount();
		expect(detach).toHaveBeenCalledTimes(1);
	});

	test('closing one of several shares moves the focus to the next one when there is no chip to go back to', async () => {
		render(XScreens, { props: { participants: [participant(alice, true), participant(bob, true)] }, global: { directives: { tooltip: {} }, stubs } });
		await flush();
		const close = within(viewerOf(alice)).getByLabelText(i18n.ts._voiceCall.stopWatching);
		close.focus();

		await fireEvent.click(close);
		await flush();

		expect(viewerOf(bob).contains(window.document.activeElement)).toBe(true);
	});

	test('goes fullscreen through the shared helper so iPhone Safari works too', async () => {
		render(XScreen, { props: { participant: participant(alice, true) }, global: { directives: { tooltip: {} }, stubs } });
		await flush();

		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.fullscreen));

		expect(mocks.requestFullscreen).toHaveBeenCalledWith(expect.objectContaining({ videoEl: expect.any(HTMLVideoElement), playerEl: expect.any(HTMLElement) }));
	});

	test('labels the stream as a screen share for screen readers', async () => {
		render(XScreen, { props: { participant: participant(alice, true) }, global: { directives: { tooltip: {} }, stubs } });
		await flush();

		expect(screen.getAllByLabelText(i18n.ts._voiceCall.sharingScreen).length).toBeGreaterThan(0);
		expect(viewerOf(alice)).toBeTruthy();
	});

	test('shows the watched share at full quality, not as a preview', async () => {
		render(XScreen, { props: { participant: participant(alice, true) }, global: { directives: { tooltip: {} }, stubs } });
		await flush();

		expect(mocks.attachScreenShare).toHaveBeenCalledWith(identityOf(alice), expect.any(HTMLVideoElement));
		expect(mocks.attachScreenShare).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), { preview: true });
	});
});

describe('screen share preview', () => {
	test('stops showing the share when the chip or tile goes away', async () => {
		const { unmount } = render(XPreview, { props: { identity: identityOf(alice) } });
		await flush();
		expect(mocks.attachScreenShare).toHaveBeenLastCalledWith(identityOf(alice), expect.any(HTMLVideoElement), { preview: true });
		const detach = mocks.attachScreenShare.mock.results[mocks.attachScreenShare.mock.results.length - 1].value as ReturnType<typeof vi.fn>;

		unmount();
		expect(detach).toHaveBeenCalledTimes(1);
	});
});

describe.each([
	['shared screen card', XShare],
] as const)('%s watch toggle', (_label, component) => {
	// トグルのボタンは名前を変えず、見ているかどうかは aria-pressed と枠で伝える
	test.each([false, true])('keeps the same tooltip as the accessible name while watching: %s', async watching => {
		render(component, { props: { participant: participant(alice, true), watchable: true, watching }, global: { directives: { tooltip: { mounted: (el, binding) => { el.dataset.tooltip = binding.value; el.dataset.tooltipMfm = String(binding.modifiers.mfm); } } }, stubs } });
		await flush();

		const toggle = watchToggleOf(alice);
		expect(toggle.getAttribute('title')).toBeNull();
		expect(toggle.dataset.tooltip).toBe(toggle.getAttribute('aria-label'));
		expect(toggle.dataset.tooltipMfm).toBe('true');
		expect(toggle.getAttribute('aria-pressed')).toBe(String(watching));
	});
});

describe('participant chip', () => {
	// 話している人はチップ全体 (アバターと名前を包む外側) の枠で示すので、speaking のクラスはチップの一番外側に付く。
	// 枠そのものは CSS なので、ここでは見られない
	test.each([true, false])('has the speaking class on the chip root: %s', async speaking => {
		const { container } = render(XParticipant, { props: { participant: participant(alice), speaking }, global: { directives: { tooltip: {} }, stubs } });
		await flush();

		const chip = container.firstElementChild!;
		expect(chip.textContent).toContain('Alice');
		expect([...chip.classList].some(name => name.includes('speaking'))).toBe(speaking);
	});
});

describe.each([['mobile row', XParticipant, {}], ['compact stage row', XTile, { small: true }]] as const)('%s information and actions', (_label, component, extra) => {
	test('keeps identity and status outside the explicit screen, volume and menu buttons', async () => {
		const { emitted } = render(component, { props: {
			...extra, participant: { ...participant(alice, true), micMuted: true, deafened: true },
			speaking: false, menuable: true,
		}, global: { directives: { tooltip: {} }, stubs } });
		const group = participantGroup(alice);
		const buttons = within(group).getAllByRole('button');
		expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
			i18n.ts.menu,
		]);
		expect(buttons.every(button => !button.contains(within(participantGroup(alice)).getByText('Alice')))).toBe(true);
		expect(within(group).queryByLabelText(i18n.ts._voiceCall.micMuted)).toBeNull();
		for (const state of [i18n.ts._voiceCall.deafened]) {
			const indicator = within(group).getByLabelText(state);
			expect(indicator.closest('button')).toBeNull();
			expect(within(group).queryByText(state)).toBeNull();
		}
		await fireEvent.click(within(participantGroup(alice)).getByText('Alice'));
		expect(emitted().toggleWatch).toBeUndefined();
		await fireEvent.click(buttons[0]);
		expect(emitted().openMenu).toHaveLength(1);
	});
});

describe('participant tile layout changes', () => {
	test.each(['menu'] as const)('preserves keyboard focus on the %s control in both directions', async control => {
		const { rerender } = render(XTile, { props: {
			participant: participant(alice, true), speaking: false, menuable: true, small: false,
		}, global: { directives: { tooltip: {} }, stubs } });
		const label = i18n.ts.menu;
		within(participantGroup(alice)).getByRole('button', { name: label }).focus();
		for (const small of [true, false]) {
			await rerender({ small });
			await flush();
			expect(document.activeElement).toBe(within(participantGroup(alice)).getByRole('button', { name: label }));
		}
	});
});

describe('participant chip shape', () => {
	// チップの角の丸みは中のアバターの形に合わせる。MkAvatar と同じ規則でアバターを角丸の四角で描くときだけ、チップに squareAvatar のクラスが付く
	test.each([
		[{ squareAvatars: true, setFederationAvatarShape: false }, {}, true],
		[{ squareAvatars: false, setFederationAvatarShape: false }, {}, false],
		[{ squareAvatars: true, setFederationAvatarShape: true }, { setFederationAvatarShape: false }, true],
		[{ squareAvatars: true, setFederationAvatarShape: true }, { setFederationAvatarShape: true, isSquareAvatars: false }, false],
		[{ squareAvatars: false, setFederationAvatarShape: true }, { setFederationAvatarShape: true, isSquareAvatars: true }, true],
	])('prefs %o and user %o give a square chip: %s', async (prefs, shape, square) => {
		prefer.reset({ ...prefer.s, ...prefs });
		const { container } = render(XParticipant, { props: { participant: participant({ ...alice, ...shape } as typeof alice), speaking: false }, global: { directives: { tooltip: {} }, stubs } });
		await flush();

		expect(hasClass(container.firstElementChild!, 'squareAvatar')).toBe(square);
	});
});

describe('avatar decorations in the call', () => {
	// 装飾はアバターの 2 倍の大きさで描かれるので、小さなチップでははみ出して枠や隣のチップに重なる。チップでは描かない
	test.each([false, true])('the compact participant keeps avatar decorations inside its reserved slot (sharing: %s)', async sharing => {
		const { container } = render(XParticipant, { props: { participant: participant(alice, sharing), speaking: false }, global: { directives: { tooltip: {} }, stubs } });
		await flush();

		const avatars = container.querySelectorAll('.avatar');
		expect(avatars.length).toBe(1);
		expect(avatars[0].getAttribute('data-decorations')).toBe('user');
	});

	// 広い画面のタイルの大きなアバターには装飾を描く。共有している人のタイルで名前の横に添える小さなアバターには描かない
	test('the stage tile draws decorations on its large avatar', async () => {
		const { container } = render(XTile, { props: { participant: participant(alice), speaking: false }, global: { directives: { tooltip: {} }, stubs } });
		await flush();

		expect(container.querySelector('.avatar')!.getAttribute('data-decorations')).toBe('user');
	});

	test('keeps the same full-size decorated avatar when a participant shares a screen', async () => {
		const { container } = render(XTile, { props: { participant: participant(alice, true), speaking: false }, global: { directives: { tooltip: {} }, stubs } });
		await flush();

		const avatars = container.querySelectorAll('.avatar');
		expect(avatars.length).toBe(1);
		expect(avatars[0].getAttribute('data-decorations')).toBe('user');
	});
});

describe.each([['chip', XParticipant], ['tile', XTile]] as const)('%s status and volume controls', (_name, component) => {
	test('shows shared mute settings and opens only the menu from its button', async () => {
		const { emitted } = render(component, { props: {
			participant: { ...participant(alice), micMuted: true, deafened: true },
			speaking: false, menuable: true,
		}, global: { directives: { tooltip: {} }, stubs } });
		expect(screen.queryByLabelText(i18n.ts._voiceCall.micMuted)).toBeNull();
		expect(screen.getByLabelText(i18n.ts._voiceCall.deafened)).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: i18n.ts.menu }));
		expect(emitted().openMenu).toHaveLength(1);
	});

	test('does not show mute indicators when older servers supply no settings', () => {
		render(component, { props: { participant: participant(alice), speaking: false }, global: { directives: { tooltip: {} }, stubs } });
		expect(screen.queryByLabelText(i18n.ts._voiceCall.micMuted)).toBeNull();
		expect(screen.queryByLabelText(i18n.ts._voiceCall.deafened)).toBeNull();
	});
});

describe('participant menu', () => {
	test('lets the room owner remove a participant after confirming', async () => {
		mocks.confirm.mockResolvedValue({ canceled: false });
		await renderRoom({ ...room, ownerId: 'me' }, [{ roomId: 'r1', participants: [participant(bob)] }]);

		await fireEvent.click(stickyCard().getByRole('button', { name: bob.name }));
		const kick = openedItems().find(item => item.text === i18n.ts._voiceCall.kick)!;
		await kick.action!();

		expect(mocks.confirm).toHaveBeenCalled();
		expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/voice/kick', { roomId: 'r1', userId: 'bob' });
	});

	test('lets the room owner mute a participant for everyone', async () => {
		await renderRoom({ ...room, ownerId: 'me' }, [{ roomId: 'r1', participants: [participant(bob)] }]);

		await fireEvent.click(stickyCard().getByRole('button', { name: bob.name }));
		await openedItems().find(item => item.text === i18n.ts._voiceCall.forceMute)!.action!();

		expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/voice/mute', { roomId: 'r1', userId: 'bob' });
	});

	test('does not offer moderation to other members', async () => {
		Object.assign(callState, { status: 'connected', room });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(bob)] }]);

		await fireEvent.click(menuButtonOf(bob));
		const texts = openedItems().map(item => item.text);
		expect(texts).not.toContain(i18n.ts._voiceCall.kick);
		expect(texts).not.toContain(i18n.ts._voiceCall.forceMute);
	});

	test('offers a volume control only for others while in the call', async () => {
		Object.assign(callState, { status: 'connected', room });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(me), participant(bob)] }]);

		// 自分のメニューはマイクとスピーカーの切り替えだけで、音量は出さない
		await fireEvent.click(menuButtonOf(me));
		expect(openedItems().filter(item => item.type === 'component')).toEqual([]);

		await fireEvent.click(menuButtonOf(bob));
		expect(openedItems().filter(item => item.type === 'component').map(item => item.props)).toEqual([
			{ identity: 'https://local.test/users/bob', audio: 'voice' },
		]);
	});

	test('keeps screen audio out of the participant menu while sharing', async () => {
		Object.assign(callState, { status: 'connected', room });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(me), participant(bob, true)] }]);

		await fireEvent.click(menuButtonOf(bob));
		expect(openedItems().filter(item => item.type === 'component').map(item => item.props)).toEqual([
			{ identity: 'https://local.test/users/bob', audio: 'voice' },
		]);
	});
});

describe('voice call bar', () => {
	test('starts and stops sharing the screen', async () => {
		Object.assign(callState, { status: 'connected', room });
		render(XVoiceCallBar, { global: { directives: { tooltip: {} }, stubs } });
		await flush();

		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.shareScreen));
		expect(mocks.startScreenShare).toHaveBeenCalled();

		callState.screenSharing = true;
		await flush();
		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.stopSharing));
		expect(mocks.stopScreenShare).toHaveBeenCalled();
	});

	test('offers to enable audio when the browser blocks playback', async () => {
		Object.assign(callState, { status: 'connected', room, audioBlocked: true });
		render(XVoiceCallBar, { global: { directives: { tooltip: {} }, stubs } });
		await flush();

		await fireEvent.click(screen.getByText(i18n.ts._voiceCall.enableAudio));
		expect(mocks.resumeAudio).toHaveBeenCalled();
	});

	test('leaves the call and shows reconnecting state', async () => {
		Object.assign(callState, { status: 'reconnecting', room });
		render(XVoiceCallBar, { global: { directives: { tooltip: {} }, stubs } });
		await flush();

		expect(screen.getByText(i18n.ts._voiceCall.reconnecting)).toBeTruthy();
		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.leave));
		expect(mocks.leaveVoiceCall).toHaveBeenCalled();
	});
});
