/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/vue';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';

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
	};
});

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ useChannel: () => mocks.channel }) }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/instance.js', () => ({ instance: mocks.instance }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog, confirm: mocks.confirm, popupMenu: mocks.popupMenu, toast: vi.fn(), claimZIndex: () => 1000 }));
vi.mock('@/utility/fullscreen.js', () => ({ requestFullscreen: mocks.requestFullscreen }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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
import XVoice from '@/pages/chat/room.voice.vue';
import XRoomPage from '@/pages/chat/room.vue';
import { useChatRoomVoiceCall } from '@/composables/use-chat-room-voice-call.js';
import { provideMetadataReceiver } from '@/page.js';
import { updateDeviceKind } from '@/utility/device-kind.js';
import XVoiceCallBar from '@/ui/_common_/voice-call-bar.vue';
import XScreen from '@/pages/chat/room.voice.screen.vue';
import XParticipant from '@/pages/chat/room.voice.participant.vue';
import XPreview from '@/pages/chat/room.voice.preview.vue';
import XTile from '@/pages/chat/room.voice.tile.vue';
import XScreens from '@/pages/chat/room.voice.screens.vue';

const stubs = {
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
const identityOf = (user: typeof alice) => `https://local.test/users/${user.id}`;
const participant = (user: typeof alice, screenSharing = false) => ({ identity: identityOf(user), user, screenSharing }) as any;
// 見ている共有画面は、誰の画面かの名前のついたまとまりになっている
const viewerOf = (user: typeof alice) => screen.getByRole('group', { name: i18n.tsx._voiceCall.screenShareOf({ name: user.name }) });
const queryViewerOf = (user: typeof alice) => screen.queryByRole('group', { name: i18n.tsx._voiceCall.screenShareOf({ name: user.name }) });
// 参加者のチップやタイルも、その人の名前のついたまとまりになっている
const participantGroup = (user: typeof alice) => screen.getByRole('group', { name: user.name });
const watchToggleOf = (user: typeof alice) => within(participantGroup(user)).getByRole('button', { name: i18n.tsx._voiceCall.watchScreenOf({ name: user.name }) });
const hasClass = (el: Element, name: string) => [...el.classList].some(c => c.includes(name));
const focusButtonOf = (user: typeof alice) => within(viewerOf(user)).getByRole('button', { name: i18n.ts._voiceCall.focusScreen });

// happy-dom には全画面とピクチャーインピクチャーの API が無いので、今どの要素がそうなっているかをテストから決める
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

async function flush() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

// ページと同じく、カードに渡す通話の状態は外で作る
function renderCard(target: typeof room = room) {
	const host = defineComponent({
		setup() {
			const call = useChatRoomVoiceCall(() => target);
			return () => h(XVoice, { room: target, call });
		},
	});
	return render(host, { global: { stubs } });
}

describe('room voice panel', () => {
	test('shows who is in the call and a join button', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice)] }]);
		renderCard();
		await flush();

		expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/states', { roomIds: ['r1'] });
		expect(screen.getByText('Alice')).toBeTruthy();
		await fireEvent.click(screen.getByText(i18n.ts._voiceCall.join));
		expect(mocks.joinVoiceCall).toHaveBeenCalledWith(room);
	});

	test('updates the participant list from the shared main stream', async () => {
		renderCard();
		await flush();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [participant(bob)] });
		await flush();

		expect(screen.getByText('Bob')).toBeTruthy();
	});

	test('shows in-call controls when this room is the active call', async () => {
		Object.assign(callState, { status: 'connected', room, micEnabled: true });
		renderCard();
		await flush();

		expect(screen.queryByText(i18n.ts._voiceCall.join)).toBeNull();
		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.leave));
		expect(mocks.leaveVoiceCall).toHaveBeenCalled();
		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.mute));
		expect(mocks.setMicEnabled).toHaveBeenCalledWith(false);
	});

	describe('room owned on another server', () => {
		test('shows the panel for a mirror room when remote calls are allowed', async () => {
			mocks.instance.features.remoteVoiceCall = true;
			mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice)] }]);
			renderCard(mirror);
			await flush();

			expect(screen.getByText(i18n.ts._voiceCall.join)).toBeTruthy();
			expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/states', { roomIds: ['r1'] });
		});

		test('hides the panel for a mirror room when remote calls are not allowed', async () => {
			renderCard(mirror);
			await flush();

			expect(screen.queryByText(i18n.ts._voiceCall.join)).toBeNull();
			expect(mocks.misskeyApi).not.toHaveBeenCalled();
		});

		test('asks once before joining a call on another server', async () => {
			mocks.instance.features.remoteVoiceCall = true;
			mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice)] }]);
			mocks.confirm.mockResolvedValue({ canceled: false });
			renderCard(mirror);
			await flush();

			await fireEvent.click(screen.getByText(i18n.ts._voiceCall.join));
			await flush();
			expect(mocks.confirm).toHaveBeenCalledTimes(1);
			expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ text: i18n.tsx._voiceCall.remoteHostNotice({ host: 'remote.test' }) }));
			expect(prefer.commit).toHaveBeenCalledWith('voiceCall.acknowledgedRemoteHosts', ['remote.test']);
			expect(mocks.joinVoiceCall).toHaveBeenCalledTimes(1);

			await fireEvent.click(screen.getByText(i18n.ts._voiceCall.join));
			await flush();
			expect(mocks.confirm).toHaveBeenCalledTimes(1);
			expect(mocks.joinVoiceCall).toHaveBeenCalledTimes(2);
		});

		test('ignores a second click while the notice is still open', async () => {
			mocks.instance.features.remoteVoiceCall = true;
			let answer!: (value: { canceled: boolean }) => void;
			mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice)] }]);
			mocks.confirm.mockReturnValue(new Promise(resolve => { answer = resolve; }));
			renderCard(mirror);
			await flush();

			await fireEvent.click(screen.getByText(i18n.ts._voiceCall.join));
			await fireEvent.click(screen.getByText(i18n.ts._voiceCall.join));
			answer({ canceled: false });
			await flush();

			expect(mocks.confirm).toHaveBeenCalledTimes(1);
			expect(mocks.joinVoiceCall).toHaveBeenCalledTimes(1);
		});

		test('does not join when the notice is cancelled', async () => {
			mocks.instance.features.remoteVoiceCall = true;
			mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice)] }]);
			mocks.confirm.mockResolvedValue({ canceled: true });
			renderCard(mirror);
			await flush();

			await fireEvent.click(screen.getByText(i18n.ts._voiceCall.join));
			await flush();
			expect(mocks.joinVoiceCall).not.toHaveBeenCalled();
			expect(prefer.commit).not.toHaveBeenCalled();
		});
	});

	test.each(['connecting', 'reconnecting'] as const)('shows the call status (%s) in the card title for screen readers too', async status => {
		Object.assign(callState, { status, room });
		renderCard();
		await flush();

		const title = screen.getByText(i18n.ts._voiceCall[status]);
		expect(title.closest('[aria-live="polite"]')).not.toBeNull();
		expect(screen.queryByText(i18n.ts._voiceCall.inCall)).toBeNull();
	});

	test('renders nothing when voice calls are disabled on this server', async () => {
		mocks.instance.features.voiceCall = false;
		renderCard();
		await flush();

		expect(screen.queryByText(i18n.ts._voiceCall.join)).toBeNull();
		expect(mocks.misskeyApi).not.toHaveBeenCalled();
	});
});

describe('voice call on the room page', () => {
	const pageStubs = {
		...stubs,
		// 本物の MkPageHeader / CPPageHeader と同じく、アクションは action.text をラベルにしたアイコンのボタンで出し、タブで v-model:tab を切り替える
		PageWithHeader: {
			props: ['actions', 'tabs', 'tab'],
			emits: ['update:tab'],
			template: `<div>
				<div role="tablist"><button v-for="t in tabs" :key="t.key" role="tab" :aria-selected="t.key === tab" @click="$emit('update:tab', t.key)">{{ t.title }}</button></div>
				<div data-testid="header-actions"><button v-for="action in actions" class="_button" :aria-label="action.text" @click.stop="action.handler"><i :class="action.icon"></i></button></div>
				<slot />
				<div data-testid="page-footer"><slot name="footer" /></div>
			</div>`,
		},
		// カードが MkStickyContainer のヘッダーに置かれているか (= スクロールしても上に貼り付くか) を見る
		MkStickyContainer: { template: '<div><div data-testid="sticky-header"><slot name="header" /></div><slot /></div>' },
		MkLoading: { template: '<div></div>' },
	};

	// shown を渡すと、本物と同じく KeepAlive の中に置き、false にすると裏に回す
	async function renderRoom(target: typeof room, states: unknown[] | Promise<unknown[]>, shown?: ReturnType<typeof ref<boolean>>) {
		mocks.misskeyApi.mockImplementation((endpoint: string) => {
			if (endpoint === 'chat/rooms/show') return Promise.resolve(target);
			if (endpoint === 'chat/rooms/voice/states') return states instanceof Promise ? states : Promise.resolve(states);
			return Promise.resolve([]);
		});
		const host = defineComponent({
			setup() {
				provideMetadataReceiver(() => {});
				if (shown == null) return () => h(XRoomPage, { roomId: target.id });
				return () => h(KeepAlive, null, [shown.value ? h(XRoomPage, { roomId: target.id, key: 'room' }) : h('div', { key: 'other' })]);
			},
		});
		render(host, { global: { stubs: pageStubs } });
		await flush();
		await flush();
	}

	const headerIcons = () => [...screen.getByTestId('header-actions').querySelectorAll('button')].map(el => el.querySelector('i')!.className);

	async function openTab(title: string) {
		await fireEvent.click(screen.getByRole('tab', { name: title }));
		await flush();
	}

	const headerJoin = () => within(screen.getByTestId('header-actions')).queryByLabelText(i18n.ts._voiceCall.join);
	const stickyCard = () => within(screen.getByTestId('sticky-header'));

	test('hides the card when nobody is in the call', async () => {
		await renderRoom(room, []);

		expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/states', { roomIds: ['r1'] });
		expect(screen.getByTestId('sticky-header').textContent?.trim()).toBe('');
		expect(screen.queryByText(i18n.ts._voiceCall.join)).toBeNull();
	});

	test('shows the card when someone is in the call', async () => {
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);

		expect(stickyCard().getByText('Alice')).toBeTruthy();
		expect(stickyCard().getByText(room.name)).toBeTruthy();
		expect(stickyCard().getByText(i18n.ts._voiceCall.join)).toBeTruthy();
	});

	test('shows the card while I am in the call even before the participant list arrives', async () => {
		Object.assign(callState, { status: 'connected', room, micEnabled: true });
		await renderRoom(room, new Promise(() => {}));

		expect(stickyCard().getByText(i18n.ts._voiceCall.inCall)).toBeTruthy();
		expect(stickyCard().getByLabelText(i18n.ts._voiceCall.leave)).toBeTruthy();
		expect(headerJoin()).toBeNull();
	});

	test('offers a join action in the header only when nobody is in the call', async () => {
		await renderRoom(room, []);

		expect(headerIcons()).toEqual(['ti ti-phone', 'ti ti-dots']);
		await fireEvent.click(headerJoin()!);
		await flush();
		expect(mocks.joinVoiceCall).toHaveBeenCalledWith(room);

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [participant(alice)] });
		await flush();

		expect(headerIcons()).toEqual(['ti ti-dots']);
		expect(stickyCard().getByText(i18n.ts._voiceCall.join)).toBeTruthy();
	});

	test('offers the header join on the other tabs whenever I am not in the call', async () => {
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
		// メッセージのタブでは通話カードから参加できるので、ヘッダーには出さない
		expect(headerIcons()).toEqual(['ti ti-dots']);

		for (const title of [i18n.ts._chat.members, i18n.ts.search, i18n.ts.info]) {
			await openTab(title);
			expect(headerIcons()).toEqual(['ti ti-phone', 'ti ti-dots']);
		}

		await fireEvent.click(headerJoin()!);
		await flush();
		expect(mocks.joinVoiceCall).toHaveBeenCalledWith(room);

		await openTab(i18n.ts._chat.messages);
		expect(headerIcons()).toEqual(['ti ti-dots']);
	});

	test('names the header menu action', async () => {
		await renderRoom(room, []);

		const menu = within(screen.getByTestId('header-actions')).getByLabelText(i18n.ts.menu);
		expect(menu.querySelector('i')!.className).toBe('ti ti-dots');
	});

	test('does not offer the header join on the other tabs while I am in the call', async () => {
		Object.assign(callState, { status: 'connected', room, micEnabled: true });
		await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);

		await openTab(i18n.ts._chat.members);
		expect(headerIcons()).toEqual(['ti ti-dots']);
	});

	describe('on a wide page', () => {
		async function setPageWidth(width: number) {
			resizeObserved(width);
			await flush();
		}

		// a が b より前 (広い画面では左) にあるか
		const precedes = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
		// メッセージの欄 (まだメッセージが無いので、その旨の文言で見分ける)
		const chatPane = () => screen.getByText(i18n.ts._chat.noMessagesYet);

		test('uses the two-pane call view on a wide page while someone is in the call', async () => {
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
			await setPageWidth(1280);

			// 通話カードは出さず、ステージに参加者を大きく並べる
			expect(screen.getByTestId('sticky-header').textContent?.trim()).toBe('');
			expect(screen.getByText('Alice')).toBeTruthy();
			expect(screen.getByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeTruthy();
			expect(chatPane()).toBeTruthy();
		});

		test('keeps the sticky card on a narrow page', async () => {
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
			await setPageWidth(959);

			expect(stickyCard().getByText('Alice')).toBeTruthy();
			expect(screen.queryByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeNull();
		});

		test('keeps the single column while nobody is in the call', async () => {
			await renderRoom(room, []);
			await setPageWidth(1280);

			expect(screen.queryByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeNull();
			expect(headerIcons()).toEqual(['ti ti-phone', 'ti ti-dots']);

			mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [participant(alice)] });
			await flush();

			expect(screen.getByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeTruthy();
			expect(headerIcons()).toEqual(['ti ti-dots']);
		});

		test('puts the chat on the right by default and on the left when preferred', async () => {
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
			await setPageWidth(1280);
			expect(precedes(screen.getByText('Alice'), chatPane())).toBe(true);

			await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.moveChatLeft));
			await flush();

			expect(prefer.commit).toHaveBeenCalledWith('voiceCall.stageChatSide', 'left');
			expect(precedes(chatPane(), screen.getByText('Alice'))).toBe(true);
			expect(screen.getByLabelText(i18n.ts._voiceCall.moveChatRight)).toBeTruthy();
		});

		test('opens with the chat on the left when that was chosen before', async () => {
			prefer.reset({ ...prefer.s, 'voiceCall.stageChatSide': 'left' });
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
			await setPageWidth(1280);

			expect(precedes(chatPane(), screen.getByText('Alice'))).toBe(true);
		});

		test('shows a join button on the stage when I am not in the call', async () => {
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
			await setPageWidth(1280);
			expect(screen.getByTestId('sticky-header').textContent?.trim()).toBe('');

			await fireEvent.click(screen.getByText(i18n.ts._voiceCall.join));
			await flush();
			expect(mocks.joinVoiceCall).toHaveBeenCalledWith(room);
			expect(headerJoin()).toBeNull();
		});

		test('keeps the call controls on the stage while I am in the call', async () => {
			Object.assign(callState, { status: 'connected', room, micEnabled: true });
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
			await setPageWidth(1280);
			expect(screen.getByTestId('sticky-header').textContent?.trim()).toBe('');

			expect(screen.queryByText(i18n.ts._voiceCall.join)).toBeNull();
			await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.mute));
			expect(mocks.setMicEnabled).toHaveBeenCalledWith(false);
			await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.leave));
			expect(mocks.leaveVoiceCall).toHaveBeenCalled();
		});

		test('clicking anywhere on a sharer\'s tile toggles watching the stream', async () => {
			Object.assign(callState, { status: 'connected', room, micEnabled: true });
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true)] }]);
			await setPageWidth(1280);

			const tileName = screen.getByText('Alice');
			await fireEvent.click(tileName);
			expect(mocks.toggleScreenShareWatch).toHaveBeenLastCalledWith(identityOf(alice));
			expect(watchToggleOf(alice).getAttribute('aria-pressed')).toBe('false');

			// 見ている画面はステージに大きく出し、タイルは枠で目立たせる。タイルをもう一度押すと見るのをやめる
			callState.watchingIdentities = [identityOf(alice)];
			await flush();
			expect(within(viewerOf(alice)).getByLabelText(i18n.ts._voiceCall.fullscreen)).toBeTruthy();
			expect(watchToggleOf(alice).getAttribute('aria-pressed')).toBe('true');
			expect(hasClass(participantGroup(alice), 'watching')).toBe(true);
			await fireEvent.click(tileName);
			expect(mocks.toggleScreenShareWatch).toHaveBeenCalledTimes(2);
		});

		test('shows a small live preview on a sharer\'s tile without any extra text', async () => {
			Object.assign(callState, { status: 'connected', room, micEnabled: true });
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true), participant(bob)] }]);
			await setPageWidth(1280);

			const preview = participantGroup(alice).querySelector('video');
			expect(preview).not.toBeNull();
			expect(mocks.attachScreenShare).toHaveBeenCalledWith(identityOf(alice), preview, { preview: true });
			expect(participantGroup(alice).textContent?.trim()).toBe('Alice');
			expect(participantGroup(bob).querySelector('video')).toBeNull();
		});

		test('opens the participant menu from the ⋯ button, not from the tile', async () => {
			Object.assign(callState, { status: 'connected', room, micEnabled: true });
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true), participant(bob)] }]);
			await setPageWidth(1280);

			await fireEvent.click(screen.getByText('Bob'));
			await fireEvent.click(screen.getByText('Alice'));
			expect(mocks.popupMenu).not.toHaveBeenCalled();

			await fireEvent.click(within(participantGroup(alice)).getByLabelText(i18n.ts.menu));
			expect(mocks.popupMenu).toHaveBeenCalledTimes(1);
			expect(mocks.toggleScreenShareWatch).toHaveBeenCalledTimes(1);
			await fireEvent.click(within(participantGroup(bob)).getByLabelText(i18n.ts.menu));
			expect(mocks.popupMenu).toHaveBeenCalledTimes(2);
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

			test('closing a share from the keyboard moves the focus to the sharer\'s tile and scrolls it into view', async () => {
				await renderStageWatching(2);
				const close = within(viewerOf(bob)).getByLabelText(i18n.ts._voiceCall.stopWatching);
				close.focus();
				// タイルの帯は横にスクロールするので、フォーカスを移したタイルが帯の外に隠れていることがある
				const scrolled: { el: Element; options: unknown }[] = [];
				const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
					scrolled.push({ el: this, options });
				});

				try {
					await fireEvent.click(close);
					await flush();
				} finally {
					scrollSpy.mockRestore();
				}

				expect(mocks.unwatchScreenShare).toHaveBeenCalledWith(identityOf(bob));
				expect(window.document.activeElement).toBe(watchToggleOf(bob));
				expect(scrolled).toEqual([{ el: watchToggleOf(bob), options: { block: 'nearest', inline: 'nearest' } }]);
			});
		});

		test('lets the room owner open a participant menu from a tile', async () => {
			const ownedRoom = { ...room, ownerId: 'me' };
			mocks.confirm.mockResolvedValue({ canceled: false });
			await renderRoom(ownedRoom, [{ roomId: 'r1', participants: [participant(bob)] }]);
			await setPageWidth(1280);

			// タイルは参加者の名前のついたまとまりなので、中のボタンが誰のものか読み上げで分かる
			await fireEvent.click(within(screen.getByRole('group', { name: 'Bob' })).getByLabelText(i18n.ts.menu));
			const items = mocks.popupMenu.mock.calls[mocks.popupMenu.mock.calls.length - 1][0] as { text?: string; action?: () => unknown }[];
			await items.find(item => item.text === i18n.ts._voiceCall.kick)!.action!();

			expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/voice/kick', { roomId: 'r1', userId: 'bob' });
		});

		test.each(['connecting', 'reconnecting'] as const)('shows the call status (%s) in the stage title for screen readers too', async status => {
			Object.assign(callState, { status, room });
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
			await setPageWidth(1280);
			expect(screen.getByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeTruthy();

			const title = screen.getByText(i18n.ts._voiceCall[status]);
			expect(title.closest('[aria-live="polite"]')).not.toBeNull();
			expect(screen.queryByText(i18n.ts._voiceCall.inCall)).toBeNull();
		});

		test('opens straight into the two-pane view when coming back to the messages tab', async () => {
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
			await setPageWidth(1280);

			await openTab(i18n.ts._chat.members);
			await openTab(i18n.ts._chat.messages);

			// 測り直す前から、前に測った幅で並べる (狭い形を一度出してから切り替えない)
			expect(screen.getByTestId('sticky-header').textContent?.trim()).toBe('');
			expect(screen.getByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeTruthy();
		});

		test('ignores the size reported while the page waits in the background', async () => {
			const shown = ref(true);
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }], shown);
			await setPageWidth(1280);

			shown.value = false;
			await flush();
			// KeepAlive で裏に回ったページはどこにも描かれないので、幅 0 と知らされる
			await setPageWidth(0);

			shown.value = true;
			await flush();
			expect(screen.getByTestId('sticky-header').textContent?.trim()).toBe('');
			expect(screen.getByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeTruthy();
		});

		test('never puts the call beside the chat on a phone', async () => {
			updateDeviceKind('smartphone');
			try {
				await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
				await setPageWidth(1280);

				expect(stickyCard().getByText('Alice')).toBeTruthy();
				expect(screen.queryByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeNull();
			} finally {
				updateDeviceKind(null);
			}
		});

		describe('while a shared screen is fullscreen', () => {
			async function nextFrames() {
				await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
				await flush();
			}

			// 狭いページの通話カードで共有画面を見て、その画面を全画面にする
			async function enterFullscreenFromCard() {
				Object.assign(callState, { status: 'connected', room, micEnabled: true, watchingIdentities: [identityOf(alice)] });
				await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true)] }]);
				await setPageWidth(700);
				// チップの小さなプレビューではなく、見ている画面の video
				const viewer = stickyCard().getByRole('group', { name: i18n.tsx._voiceCall.screenShareOf({ name: alice.name }) });
				const video = viewer.querySelector('video')!;
				setFullscreen(viewer);
				await flush();
				return video;
			}

			test('keeps the card when going fullscreen widens the page', async () => {
				const video = await enterFullscreenFromCard();
				// 全画面にするとページの幅も画面いっぱいに広がる
				await setPageWidth(1280);

				// カードを外すと全画面の要素も消えて全画面が解けてしまうので、並べ方を変えない
				expect(video.isConnected).toBe(true);
				expect(stickyCard().getByLabelText(i18n.ts._voiceCall.fullscreen)).toBeTruthy();
				expect(screen.queryByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeNull();
			});

			test('picks the layout from the width again after leaving fullscreen', async () => {
				await enterFullscreenFromCard();
				await setPageWidth(1280);

				setFullscreen(null);
				await nextFrames();

				expect(screen.getByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeTruthy();
			});

			test('does not flash the two-pane view while the page shrinks back after fullscreen', async () => {
				const video = await enterFullscreenFromCard();
				await setPageWidth(1280);

				// 全画面が解けたことは、ページの幅が戻ったと知らされるより先に届く
				setFullscreen(null);
				await flush();
				await setPageWidth(700);
				await nextFrames();

				expect(video.isConnected).toBe(true);
				expect(screen.queryByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeNull();
			});
		});

		describe('chat form', () => {
			const pageFooter = () => screen.getByTestId('page-footer');
			const theTextarea = () => {
				const textareas = window.document.querySelectorAll('textarea');
				expect(textareas).toHaveLength(1);
				return textareas[0];
			};
			const joins = async (...users: (typeof alice)[]) => {
				mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: users.map(user => participant(user)) });
				await flush();
			};

			// focus() が呼ばれた瞬間に、その要素か祖先が display: none だったかを記録する。
			// ブラウザは隠れた要素への focus() を無視し、あとで見えるようになってもフォーカスを移さないが、happy-dom は隠れていてもフォーカスできてしまう
			type FocusCall = { el: HTMLElement; hidden: boolean };
			let focusCalls: FocusCall[] = [];
			let focusSpy: { mockRestore: () => void } | null = null;

			const isHiddenWithAncestors = (target: HTMLElement) => {
				for (let el: HTMLElement | null = target; el != null; el = el.parentElement) {
					if (window.getComputedStyle(el).display === 'none') return true;
				}
				return false;
			};

			beforeEach(() => {
				focusCalls = [];
				const original = HTMLElement.prototype.focus;
				focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
					focusCalls.push({ el: this, hidden: isHiddenWithAncestors(this) });
					original.call(this, options);
				});
			});

			afterEach(() => {
				focusSpy?.mockRestore();
				focusSpy = null;
			});

			test('renders exactly once in either layout', async () => {
				await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
				await setPageWidth(700);
				expect(pageFooter().contains(theTextarea())).toBe(true);

				// 並べているときは、メッセージの欄の下に置く
				await setPageWidth(1280);
				expect(pageFooter().contains(theTextarea())).toBe(false);
				expect(precedes(chatPane(), theTextarea())).toBe(true);
				expect(precedes(screen.getByLabelText(i18n.ts._voiceCall.moveChatLeft), theTextarea())).toBe(true);

				await setPageWidth(700);
				expect(pageFooter().contains(theTextarea())).toBe(true);
			});

			test('stays the same form, keeping its focus, when people join and leave the call', async () => {
				await renderRoom(room, []);
				await setPageWidth(1280);
				const textarea = theTextarea();
				await fireEvent.update(textarea, 'hello');
				textarea.focus();
				textarea.setSelectionRange(1, 3);

				focusCalls = [];

				await joins(alice);
				expect(screen.getByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeTruthy();
				expect(theTextarea()).toBe(textarea);
				// 移した先がもう見えている状態でフォーカスを戻す
				expect(focusCalls.splice(0)).toEqual([{ el: textarea, hidden: false }]);
				expect(window.document.activeElement).toBe(textarea);
				expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 3]);

				await joins();
				expect(screen.queryByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeNull();
				expect(theTextarea()).toBe(textarea);
				expect(focusCalls.splice(0)).toEqual([{ el: textarea, hidden: false }]);
				expect(window.document.activeElement).toBe(textarea);
				expect(textarea.value).toBe('hello');
			});

			test('waits for the text being composed before switching the layout', async () => {
				await renderRoom(room, []);
				await setPageWidth(1280);
				const textarea = theTextarea();
				textarea.focus();

				await fireEvent.compositionStart(textarea);
				await joins(alice);
				// 入力欄を動かすと変換中の文字が確定されたり消えたりするので、変換が終わるまで並べ方を変えない
				expect(screen.queryByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeNull();
				expect(pageFooter().contains(textarea)).toBe(true);
				focusCalls = [];

				await fireEvent.compositionEnd(textarea);
				await flush();
				expect(screen.getByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeTruthy();
				expect(theTextarea()).toBe(textarea);
				expect(focusCalls.splice(0)).toEqual([{ el: textarea, hidden: false }]);
				expect(window.document.activeElement).toBe(textarea);
			});

			test('forgets an unfinished composition when the page goes to the background', async () => {
				const shown = ref(true);
				await renderRoom(room, [], shown);
				await setPageWidth(1280);
				const textarea = theTextarea();
				textarea.focus();
				await fireEvent.compositionStart(textarea);

				// 変換を終えないまま (compositionend が届かないまま) ページが裏に回る
				shown.value = false;
				await flush();
				shown.value = true;
				await flush();

				await joins(alice);
				expect(screen.getByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeTruthy();
			});

			test('does not send a message twice when the layout switches while it is being sent', async () => {
				await renderRoom(room, []);
				await setPageWidth(1280);
				const respond = mocks.misskeyApi.getMockImplementation()!;
				mocks.misskeyApi.mockImplementation((endpoint: string, ...rest: unknown[]) => endpoint === 'chat/messages/create-to-room' ? new Promise(() => {}) : respond(endpoint, ...rest));

				await fireEvent.update(theTextarea(), 'hello');
				await fireEvent.click(screen.getByTitle(i18n.ts.send));
				await joins(alice);
				await fireEvent.click(screen.getByTitle(i18n.ts.send));

				expect(mocks.misskeyApi.mock.calls.filter(([endpoint]) => endpoint === 'chat/messages/create-to-room')).toHaveLength(1);
			});
		});

		test('goes back to the sticky card when the page gets narrow', async () => {
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice)] }]);
			await setPageWidth(1280);
			expect(screen.getByTestId('sticky-header').textContent?.trim()).toBe('');

			await setPageWidth(700);
			expect(stickyCard().getByText('Alice')).toBeTruthy();
			expect(screen.queryByLabelText(i18n.ts._voiceCall.moveChatLeft)).toBeNull();
		});
	});

	test('does not offer a header join where calls are not available', async () => {
		await renderRoom(mirror, []);

		expect(headerIcons()).toEqual(['ti ti-dots']);
		expect(mocks.misskeyApi).not.toHaveBeenCalledWith('chat/rooms/voice/states', expect.anything());
	});

	test('the header join asks once before joining a call on another server', async () => {
		mocks.instance.features.remoteVoiceCall = true;
		mocks.confirm.mockResolvedValue({ canceled: false });
		await renderRoom(mirror, []);

		await fireEvent.click(headerJoin()!);
		await flush();
		expect(mocks.confirm).toHaveBeenCalledTimes(1);
		expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ text: i18n.tsx._voiceCall.remoteHostNotice({ host: 'remote.test' }) }));
		expect(prefer.commit).toHaveBeenCalledWith('voiceCall.acknowledgedRemoteHosts', ['remote.test']);
		expect(mocks.joinVoiceCall).toHaveBeenCalledTimes(1);
		expect(mocks.joinVoiceCall).toHaveBeenCalledWith(mirror);

		await fireEvent.click(headerJoin()!);
		await flush();
		expect(mocks.confirm).toHaveBeenCalledTimes(1);
		expect(mocks.joinVoiceCall).toHaveBeenCalledTimes(2);
	});

	test('ignores a second header click while the notice is still open', async () => {
		mocks.instance.features.remoteVoiceCall = true;
		let answer!: (value: { canceled: boolean }) => void;
		mocks.confirm.mockReturnValue(new Promise(resolve => { answer = resolve; }));
		await renderRoom(mirror, []);

		await fireEvent.click(headerJoin()!);
		await fireEvent.click(headerJoin()!);
		answer({ canceled: false });
		await flush();

		expect(mocks.confirm).toHaveBeenCalledTimes(1);
		expect(mocks.joinVoiceCall).toHaveBeenCalledTimes(1);
	});
});

// LiveKit を持たず、他のサーバーの通話にだけ参加するサーバー
describe('on a server without its own LiveKit', () => {
	beforeEach(() => {
		mocks.instance.features.voiceCall = false;
		mocks.instance.features.remoteVoiceCall = true;
	});

	test('shows who is in a mirror room\'s call', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice)] }]);
		renderCard(mirror);
		await flush();

		expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/states', { roomIds: ['r1'] });
		expect(screen.getByText('Alice')).toBeTruthy();
		expect(screen.getByText(i18n.ts._voiceCall.join)).toBeTruthy();
	});

	test('follows a mirror room\'s call through the main stream', async () => {
		renderCard(mirror);
		await flush();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [participant(bob)] });
		await flush();

		expect(screen.getByText('Bob')).toBeTruthy();
	});

	test('lets me watch a participant sharing their screen after joining a mirror room\'s call', async () => {
		Object.assign(callState, { status: 'connected', room: mirror });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice, true)] }]);
		renderCard(mirror);
		await flush();

		await fireEvent.click(watchToggleOf(alice));
		expect(mocks.toggleScreenShareWatch).toHaveBeenCalledWith(identityOf(alice));
	});

	test('still hides the card of a room owned here, since this server cannot host its call', async () => {
		renderCard(room);
		await flush();

		expect(screen.queryByText(i18n.ts._voiceCall.join)).toBeNull();
		expect(mocks.misskeyApi).not.toHaveBeenCalled();
	});
});

describe('screen share in the room panel', () => {
	test('clicking anywhere on a sharer\'s chip toggles watching their screen', async () => {
		Object.assign(callState, { status: 'connected', room });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice, true)] }]);
		renderCard();
		await flush();

		await fireEvent.click(screen.getByText('Alice'));
		expect(mocks.toggleScreenShareWatch).toHaveBeenLastCalledWith(identityOf(alice));
		expect(watchToggleOf(alice).getAttribute('aria-pressed')).toBe('false');
		expect(hasClass(participantGroup(alice), 'watching')).toBe(false);

		// 見ているチップは枠で目立たせる (文言は足さない)
		callState.watchingIdentities = [identityOf(alice)];
		await flush();
		expect(watchToggleOf(alice).getAttribute('aria-pressed')).toBe('true');
		expect(hasClass(participantGroup(alice), 'watching')).toBe(true);
		await fireEvent.click(watchToggleOf(alice));
		expect(mocks.toggleScreenShareWatch).toHaveBeenCalledTimes(2);
	});

	test('shows a small live preview on a sharer\'s chip without any extra text', async () => {
		Object.assign(callState, { status: 'connected', room });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice, true), participant(bob)] }]);
		renderCard();
		await flush();

		const preview = participantGroup(alice).querySelector('video');
		expect(preview).not.toBeNull();
		expect(mocks.attachScreenShare).toHaveBeenCalledWith(identityOf(alice), preview, { preview: true });
		expect(participantGroup(alice).textContent?.trim()).toBe('Alice');
		expect(participantGroup(bob).querySelector('video')).toBeNull();
	});

	test('does not offer to watch before joining the call', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice, true)] }]);
		renderCard();
		await flush();

		expect(screen.queryByRole('button', { name: i18n.tsx._voiceCall.watchScreenOf({ name: 'Alice' }) })).toBeNull();
		expect(screen.getByLabelText(i18n.ts._voiceCall.sharingScreen)).toBeTruthy();
		// 通話に入るまでは共有画面を受け取れないので、プレビューも出さない
		expect(mocks.attachScreenShare).not.toHaveBeenCalled();
	});

	test('opens the participant menu from the ⋯ button, not from the chip', async () => {
		Object.assign(callState, { status: 'connected', room });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice, true), participant(bob)] }]);
		renderCard();
		await flush();

		await fireEvent.click(screen.getByText('Bob'));
		await fireEvent.click(screen.getByText('Alice'));
		expect(mocks.popupMenu).not.toHaveBeenCalled();

		await fireEvent.click(within(participantGroup(alice)).getByLabelText(i18n.ts.menu));
		expect(mocks.popupMenu).toHaveBeenCalledTimes(1);
		expect(mocks.toggleScreenShareWatch).toHaveBeenCalledTimes(1);
		await fireEvent.click(within(participantGroup(bob)).getByLabelText(i18n.ts.menu));
		expect(mocks.popupMenu).toHaveBeenCalledTimes(2);
	});

	describe('watching several shares', () => {
		const sharers = [alice, bob, carol, dave, erin];

		async function renderCardWatching(count: number) {
			Object.assign(callState, { status: 'connected', room, watchingIdentities: sharers.slice(0, count).map(identityOf) });
			mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: sharers.map(user => participant(user, true)) }]);
			renderCard();
			await flush();
		}

		test('shows each watched share with its own name, fullscreen, picture-in-picture and close', async () => {
			Object.defineProperty(window.document, 'pictureInPictureEnabled', { configurable: true, value: true });
			try {
				await renderCardWatching(2);
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
			// 狭いカードでは大きくする操作は出さない
			expect(within(viewerOf(alice)).queryByRole('button', { name: i18n.ts._voiceCall.focusScreen })).toBeNull();

			await fireEvent.click(within(viewerOf(bob)).getByLabelText(i18n.ts._voiceCall.stopWatching));
			expect(mocks.unwatchScreenShare).toHaveBeenCalledWith(identityOf(bob));
		});

		test('closing a share from the keyboard moves the focus to the sharer\'s chip', async () => {
			await renderCardWatching(2);
			const close = within(viewerOf(alice)).getByLabelText(i18n.ts._voiceCall.stopWatching);
			close.focus();

			await fireEvent.click(close);
			await flush();

			expect(window.document.activeElement).toBe(watchToggleOf(alice));
		});

		test.each([
			[1, 'layout1'],
			[2, 'layout2'],
			[3, 'layout4'],
			[4, 'layout4'],
			[5, 'layoutMany'],
		])('lays out %i watched shares as %s', async (count, layout) => {
			await renderCardWatching(count);

			const grid = viewerOf(alice).parentElement!;
			expect(hasClass(grid, layout)).toBe(true);
			// カードは高さの上限を一覧全体にかける
			expect(hasClass(grid, 'capped')).toBe(true);
			expect(grid.querySelectorAll('video')).toHaveLength(count);
		});
	});
});

describe('screen share viewer', () => {
	test('sizes itself to the shared video and keeps the bar right under it', async () => {
		render(XScreen, { props: { participant: participant(alice, true), fill: true }, global: { stubs } });
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
		expect(bar.parentElement!.contains(video)).toBe(true);
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
			render(XScreen, { props: { participant: participant(alice, true) }, global: { stubs } });
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

	test('on the wide stage, keeps the name in the bar', async () => {
		render(XScreen, { props: { participant: participant(alice, true), fill: true }, global: { stubs } });
		await flush();
		const viewer = viewerOf(alice);
		const bar = within(viewer).getByLabelText(i18n.ts._voiceCall.fullscreen).parentElement!;

		expect(bar.contains(within(viewer).getByText('Alice'))).toBe(true);
		expect(parseFloat(frameOf(viewer).style.minWidth)).toBeGreaterThanOrEqual(barMinWidth(bar));
	});

	test('uses plain buttons that never submit a form', async () => {
		Object.defineProperty(window.document, 'pictureInPictureEnabled', { configurable: true, value: true });
		try {
			render(XScreen, { props: { participant: participant(alice, true), fill: true, focusable: true }, global: { stubs } });
			await flush();
		} finally {
			Reflect.deleteProperty(window.document, 'pictureInPictureEnabled');
		}

		const buttons = within(viewerOf(alice)).getAllByRole('button');
		expect(buttons.length).toBe(4);
		for (const button of buttons) expect(button.getAttribute('type')).toBe('button');
	});

	test('stops showing the share when it goes away', async () => {
		const { unmount } = render(XScreen, { props: { participant: participant(alice, true) }, global: { stubs } });
		await flush();
		const detach = mocks.attachScreenShare.mock.results[mocks.attachScreenShare.mock.results.length - 1].value as ReturnType<typeof vi.fn>;
		expect(detach).not.toHaveBeenCalled();

		unmount();
		expect(detach).toHaveBeenCalledTimes(1);
	});

	test('closing one of several shares moves the focus to the next one when there is no chip to go back to', async () => {
		render(XScreens, { props: { participants: [participant(alice, true), participant(bob, true)] }, global: { stubs } });
		await flush();
		const close = within(viewerOf(alice)).getByLabelText(i18n.ts._voiceCall.stopWatching);
		close.focus();

		await fireEvent.click(close);
		await flush();

		expect(viewerOf(bob).contains(window.document.activeElement)).toBe(true);
	});

	test('goes fullscreen through the shared helper so iPhone Safari works too', async () => {
		render(XScreen, { props: { participant: participant(alice, true) }, global: { stubs } });
		await flush();

		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.fullscreen));

		expect(mocks.requestFullscreen).toHaveBeenCalledWith(expect.objectContaining({ videoEl: expect.any(HTMLVideoElement), playerEl: expect.any(HTMLElement) }));
	});

	test('labels the stream as a screen share for screen readers', async () => {
		render(XScreen, { props: { participant: participant(alice, true) }, global: { stubs } });
		await flush();

		expect(screen.getByLabelText(i18n.ts._voiceCall.sharingScreen)).toBeTruthy();
		expect(viewerOf(alice)).toBeTruthy();
	});

	test('shows the watched share at full quality, not as a preview', async () => {
		render(XScreen, { props: { participant: participant(alice, true) }, global: { stubs } });
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
	['participant chip', XParticipant],
	['stage tile', XTile],
] as const)('%s watch toggle', (_label, component) => {
	// トグルのボタンは名前を変えず、見ているかどうかは aria-pressed と枠で伝える
	test.each([false, true])('keeps the same tooltip as the accessible name while watching: %s', async watching => {
		render(component, { props: { participant: participant(alice, true), speaking: false, watchable: true, watching }, global: { stubs } });
		await flush();

		const toggle = watchToggleOf(alice);
		expect(toggle.getAttribute('title')).toBe(toggle.getAttribute('aria-label'));
		expect(toggle.getAttribute('aria-pressed')).toBe(String(watching));
	});
});

describe('participant chip', () => {
	// 話している人はチップ全体 (アバターと名前を包む外側) の枠で示すので、speaking のクラスはチップの一番外側に付く。
	// 枠そのものは CSS なので、ここでは見られない
	test.each([true, false])('has the speaking class on the chip root: %s', async speaking => {
		const { container } = render(XParticipant, { props: { participant: participant(alice), speaking }, global: { stubs } });
		await flush();

		const chip = container.firstElementChild!;
		expect(chip.textContent).toContain('Alice');
		expect([...chip.classList].some(name => name.includes('speaking'))).toBe(speaking);
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
		const { container } = render(XParticipant, { props: { participant: participant({ ...alice, ...shape } as typeof alice), speaking: false }, global: { stubs } });
		await flush();

		expect(hasClass(container.firstElementChild!, 'squareAvatar')).toBe(square);
	});
});

describe('avatar decorations in the call', () => {
	// 装飾はアバターの 2 倍の大きさで描かれるので、小さなチップでははみ出して枠や隣のチップに重なる。チップでは描かない
	test.each([false, true])('the participant chip draws no decorations (sharing: %s)', async sharing => {
		const { container } = render(XParticipant, { props: { participant: participant(alice, sharing), speaking: false, watchable: true }, global: { stubs } });
		await flush();

		const avatars = container.querySelectorAll('.avatar');
		expect(avatars.length).toBe(1);
		expect(avatars[0].getAttribute('data-decorations')).toBe('[]');
	});

	// 広い画面のタイルの大きなアバターには装飾を描く。共有している人のタイルで名前の横に添える小さなアバターには描かない
	test('the stage tile draws decorations on its large avatar', async () => {
		const { container } = render(XTile, { props: { participant: participant(alice), speaking: false }, global: { stubs } });
		await flush();

		expect(container.querySelector('.avatar')!.getAttribute('data-decorations')).toBe('user');
	});

	test('the stage tile of a sharer draws no decorations on the small avatar beside the name', async () => {
		const { container } = render(XTile, { props: { participant: participant(alice, true), speaking: false, watchable: true }, global: { stubs } });
		await flush();

		const avatars = container.querySelectorAll('.avatar');
		expect(avatars.length).toBe(1);
		expect(avatars[0].getAttribute('data-decorations')).toBe('[]');
	});
});

describe('participant menu', () => {
	const me = { id: 'me', username: 'me', name: 'Me', host: null };
	type MenuItemLike = { type?: string; text?: string; action?: () => unknown; props?: Record<string, unknown> };
	const openedItems = () => mocks.popupMenu.mock.calls[mocks.popupMenu.mock.calls.length - 1][0] as MenuItemLike[];
	const menuButtonOf = (user: typeof alice) => within(participantGroup(user)).getByLabelText(i18n.ts.menu);

	test('lets the room owner remove a participant after confirming', async () => {
		const ownedRoom = { ...room, ownerId: 'me' };
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(bob)] }]);
		mocks.confirm.mockResolvedValue({ canceled: false });
		renderCard(ownedRoom);
		await flush();

		await fireEvent.click(menuButtonOf(bob));
		const kick = openedItems().find(item => item.text === i18n.ts._voiceCall.kick)!;
		await kick.action!();

		expect(mocks.confirm).toHaveBeenCalled();
		expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/voice/kick', { roomId: 'r1', userId: 'bob' });
	});

	test('lets the room owner mute a participant for everyone', async () => {
		const ownedRoom = { ...room, ownerId: 'me' };
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(bob)] }]);
		renderCard(ownedRoom);
		await flush();

		await fireEvent.click(menuButtonOf(bob));
		await openedItems().find(item => item.text === i18n.ts._voiceCall.forceMute)!.action!();

		expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/voice/mute', { roomId: 'r1', userId: 'bob' });
	});

	test('does not offer moderation to other members', async () => {
		Object.assign(callState, { status: 'connected', room });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(bob)] }]);
		renderCard();
		await flush();

		await fireEvent.click(menuButtonOf(bob));
		const texts = openedItems().map(item => item.text);
		expect(texts).not.toContain(i18n.ts._voiceCall.kick);
		expect(texts).not.toContain(i18n.ts._voiceCall.forceMute);
	});

	test('offers a volume control only for others while in the call', async () => {
		Object.assign(callState, { status: 'connected', room });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(me), participant(bob)] }]);
		renderCard();
		await flush();

		// 自分のチップにはメニューを出さない
		expect(within(participantGroup(me)).queryByLabelText(i18n.ts.menu)).toBeNull();

		await fireEvent.click(menuButtonOf(bob));
		expect(openedItems().find(item => item.type === 'component')?.props).toEqual({ identity: 'https://local.test/users/bob' });
	});
});

describe('voice call bar', () => {
	test('starts and stops sharing the screen', async () => {
		Object.assign(callState, { status: 'connected', room });
		render(XVoiceCallBar, { global: { stubs } });
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
		render(XVoiceCallBar, { global: { stubs } });
		await flush();

		await fireEvent.click(screen.getByText(i18n.ts._voiceCall.enableAudio));
		expect(mocks.resumeAudio).toHaveBeenCalled();
	});

	test('leaves the call and shows reconnecting state', async () => {
		Object.assign(callState, { status: 'reconnecting', room });
		render(XVoiceCallBar, { global: { stubs } });
		await flush();

		expect(screen.getByText(i18n.ts._voiceCall.reconnecting)).toBeTruthy();
		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.leave));
		expect(mocks.leaveVoiceCall).toHaveBeenCalled();
	});
});
