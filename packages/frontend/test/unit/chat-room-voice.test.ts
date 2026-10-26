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
		watchingIdentity: null as string | null,
	});
	return {
		voiceCall,
		joinVoiceCall: mocks.joinVoiceCall,
		leaveVoiceCall: mocks.leaveVoiceCall,
		setMicEnabled: mocks.setMicEnabled,
		setDeafened: mocks.setDeafened,
		resumeAudio: mocks.resumeAudio,
		watchScreenShare: mocks.watchScreenShare,
		startScreenShare: mocks.startScreenShare,
		stopScreenShare: mocks.stopScreenShare,
		setParticipantVolume: mocks.setParticipantVolume,
		canShareScreen: () => true,
		attachScreenShare: () => () => {},
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

const stubs = {
	MkAvatar: { props: ['user'], template: '<span class="avatar"></span>' },
	MkUserName: { props: ['user'], template: '<span>{{ user.name ?? user.username }}</span>' },
	MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	MkButton: { emits: ['click'], template: '<button @click="$emit(\'click\', $event)"><slot /></button>' },
};

const room = { id: 'r1', name: 'room 1', ownerId: 'owner', owner: { id: 'owner', username: 'owner', host: null } } as any;
const mirror = { ...room, owner: { id: 'remote-owner', username: 'owner', host: 'remote.test' } };
const alice = { id: 'alice', username: 'alice', name: 'Alice', host: null };
const bob = { id: 'bob', username: 'bob', name: 'Bob', host: null };
const participant = (user: typeof alice, screenSharing = false) => ({ identity: `https://local.test/users/${user.id}`, user, screenSharing }) as any;
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
	for (const fn of [mocks.joinVoiceCall, mocks.leaveVoiceCall, mocks.setMicEnabled, mocks.setDeafened, mocks.resumeAudio, mocks.watchScreenShare, mocks.startScreenShare, mocks.stopScreenShare, mocks.apiWithDialog, mocks.confirm, mocks.popupMenu]) fn.mockReset();
	Object.assign(callState, { status: 'idle', room: null, micEnabled: false, deafened: false, audioBlocked: false, speakingIdentities: [], screenSharing: false, screenShareIdentities: [], watchingIdentity: null });
});

afterEach(() => {
	cleanup();
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

		test('clicking a sharer\'s tile watches the stream', async () => {
			Object.assign(callState, { status: 'connected', room, micEnabled: true });
			await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true)] }]);
			await setPageWidth(1280);

			const tileName = screen.getByText('Alice');
			await fireEvent.click(tileName);
			expect(mocks.watchScreenShare).toHaveBeenLastCalledWith('https://local.test/users/alice');

			// 見ている画面はステージに大きく出し、タイルをもう一度押すと見るのをやめる
			callState.watchingIdentity = 'https://local.test/users/alice';
			await flush();
			expect(screen.getByLabelText(i18n.ts._voiceCall.fullscreen)).toBeTruthy();
			await fireEvent.click(tileName);
			expect(mocks.watchScreenShare).toHaveBeenLastCalledWith(null);
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
			let fullscreenElement: Element | null = null;

			beforeEach(() => {
				// happy-dom には全画面の API が無いので、全画面になっている要素をテストから決める
				Object.defineProperty(window.document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
			});

			afterEach(() => {
				fullscreenElement = null;
				Reflect.deleteProperty(window.document, 'fullscreenElement');
			});

			function setFullscreen(el: Element | null) {
				fullscreenElement = el;
				window.document.dispatchEvent(new Event('fullscreenchange'));
			}

			async function nextFrames() {
				await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
				await flush();
			}

			// 狭いページの通話カードで共有画面を見て、その画面を全画面にする
			async function enterFullscreenFromCard() {
				Object.assign(callState, { status: 'connected', room, micEnabled: true, watchingIdentity: 'https://local.test/users/alice' });
				await renderRoom(room, [{ roomId: 'r1', participants: [participant(alice, true)] }]);
				await setPageWidth(700);
				const video = screen.getByTestId('sticky-header').querySelector('video')!;
				setFullscreen(video.parentElement);
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

		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.watchStream));
		expect(mocks.watchScreenShare).toHaveBeenCalledWith('https://local.test/users/alice');
	});

	test('still hides the card of a room owned here, since this server cannot host its call', async () => {
		renderCard(room);
		await flush();

		expect(screen.queryByText(i18n.ts._voiceCall.join)).toBeNull();
		expect(mocks.misskeyApi).not.toHaveBeenCalled();
	});
});

describe('screen share in the room panel', () => {
	test('offers to watch a participant who is sharing their screen', async () => {
		Object.assign(callState, { status: 'connected', room });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice, true)] }]);
		renderCard();
		await flush();

		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.watchStream));
		expect(mocks.watchScreenShare).toHaveBeenCalledWith('https://local.test/users/alice');
	});

	test('does not offer to watch before joining the call', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice, true)] }]);
		renderCard();
		await flush();

		expect(screen.queryByLabelText(i18n.ts._voiceCall.watchStream)).toBeNull();
		expect(screen.getByLabelText(i18n.ts._voiceCall.sharingScreen)).toBeTruthy();
	});
});

describe('screen share viewer', () => {
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

describe('participant menu', () => {
	const me = { id: 'me', username: 'me', name: 'Me', host: null };
	type MenuItemLike = { type?: string; text?: string; action?: () => unknown; props?: Record<string, unknown> };
	const openedItems = () => mocks.popupMenu.mock.calls[mocks.popupMenu.mock.calls.length - 1][0] as MenuItemLike[];

	test('lets the room owner remove a participant after confirming', async () => {
		const ownedRoom = { ...room, ownerId: 'me' };
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(bob)] }]);
		mocks.confirm.mockResolvedValue({ canceled: false });
		renderCard(ownedRoom);
		await flush();

		await fireEvent.click(screen.getByText('Bob'));
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

		await fireEvent.click(screen.getByText('Bob'));
		await openedItems().find(item => item.text === i18n.ts._voiceCall.forceMute)!.action!();

		expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/voice/mute', { roomId: 'r1', userId: 'bob' });
	});

	test('does not offer moderation to other members', async () => {
		Object.assign(callState, { status: 'connected', room });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(bob)] }]);
		renderCard();
		await flush();

		await fireEvent.click(screen.getByText('Bob'));
		const texts = openedItems().map(item => item.text);
		expect(texts).not.toContain(i18n.ts._voiceCall.kick);
		expect(texts).not.toContain(i18n.ts._voiceCall.forceMute);
	});

	test('offers a volume control only for others while in the call', async () => {
		Object.assign(callState, { status: 'connected', room });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(me), participant(bob)] }]);
		renderCard();
		await flush();

		await fireEvent.click(screen.getByText('Me'));
		expect(mocks.popupMenu).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByText('Bob'));
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
