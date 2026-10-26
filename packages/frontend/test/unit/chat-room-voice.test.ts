/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/vue';
import { nextTick } from 'vue';

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
		instance: { features: { voiceCall: true } } as { features: { voiceCall: boolean } },
		me: { id: 'me', username: 'me', policies: { canVoiceCall: true, canScreenShare: true } },
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
vi.mock('@/instance.js', () => ({ instance: mocks.instance }));
vi.mock('@/i.js', async importOriginal => ({ ...await importOriginal<typeof import('@/i.js')>(), $i: mocks.me, ensureSignin: () => mocks.me }));
vi.mock('@/os.js', () => ({ apiWithDialog: mocks.apiWithDialog, confirm: mocks.confirm, popupMenu: mocks.popupMenu, toast: vi.fn(), claimZIndex: () => 1000 }));
vi.mock('@/utility/fullscreen.js', () => ({ requestFullscreen: mocks.requestFullscreen }));
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
		localIdentityOf: (userId: string) => `https://local.test/users/${userId}`,
	};
});

import { i18n } from '@/i18n.js';
import { voiceCall } from '@/utility/voice-call.js';
import XVoice from '@/pages/chat/room.voice.vue';
import XVoiceCallBar from '@/ui/_common_/voice-call-bar.vue';
import XScreen from '@/pages/chat/room.voice.screen.vue';

const stubs = {
	MkAvatar: { props: ['user'], template: '<span class="avatar"></span>' },
	MkUserName: { props: ['user'], template: '<span>{{ user.name ?? user.username }}</span>' },
	MkA: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	MkButton: { template: '<button @click="$emit(\'click\', $event)"><slot /></button>' },
};

const room = { id: 'r1', name: 'room 1', ownerId: 'owner' } as any;
const alice = { id: 'alice', username: 'alice', name: 'Alice', host: null };
const bob = { id: 'bob', username: 'bob', name: 'Bob', host: null };
const participant = (user: typeof alice, screenSharing = false) => ({ identity: `https://local.test/users/${user.id}`, user, screenSharing }) as any;
const callState = voiceCall as unknown as Record<string, unknown>;

beforeEach(() => {
	mocks.channel = new mocks.FakeChannel();
	mocks.instance.features.voiceCall = true;
	mocks.misskeyApi.mockReset().mockResolvedValue([]);
	for (const fn of [mocks.joinVoiceCall, mocks.leaveVoiceCall, mocks.setMicEnabled, mocks.setDeafened, mocks.resumeAudio, mocks.watchScreenShare, mocks.startScreenShare, mocks.stopScreenShare, mocks.apiWithDialog, mocks.confirm, mocks.popupMenu]) fn.mockReset();
	Object.assign(callState, { status: 'idle', room: null, micEnabled: false, deafened: false, audioBlocked: false, speakingIdentities: [], screenSharing: false, screenShareIdentities: [], watchingIdentity: null });
});

afterEach(() => {
	cleanup();
});

async function flush() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

describe('room voice panel', () => {
	test('shows who is in the call and a join button', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice)] }]);
		render(XVoice, { props: { room }, global: { stubs } });
		await flush();

		expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/states', { roomIds: ['r1'] });
		expect(screen.getByText('Alice')).toBeTruthy();
		await fireEvent.click(screen.getByText(i18n.ts._voiceCall.join));
		expect(mocks.joinVoiceCall).toHaveBeenCalledWith(room);
	});

	test('updates the participant list from the shared main stream', async () => {
		render(XVoice, { props: { room }, global: { stubs } });
		await flush();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [participant(bob)] });
		await flush();

		expect(screen.getByText('Bob')).toBeTruthy();
	});

	test('shows in-call controls when this room is the active call', async () => {
		Object.assign(callState, { status: 'connected', room, micEnabled: true });
		render(XVoice, { props: { room }, global: { stubs } });
		await flush();

		expect(screen.queryByText(i18n.ts._voiceCall.join)).toBeNull();
		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.leave));
		expect(mocks.leaveVoiceCall).toHaveBeenCalled();
		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.mute));
		expect(mocks.setMicEnabled).toHaveBeenCalledWith(false);
	});

	test('renders nothing when voice calls are disabled on this server', async () => {
		mocks.instance.features.voiceCall = false;
		render(XVoice, { props: { room }, global: { stubs } });
		await flush();

		expect(screen.queryByText(i18n.ts._voiceCall.join)).toBeNull();
		expect(mocks.misskeyApi).not.toHaveBeenCalled();
	});
});

describe('screen share in the room panel', () => {
	test('offers to watch a participant who is sharing their screen', async () => {
		Object.assign(callState, { status: 'connected', room });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice, true)] }]);
		render(XVoice, { props: { room }, global: { stubs } });
		await flush();

		await fireEvent.click(screen.getByLabelText(i18n.ts._voiceCall.watchStream));
		expect(mocks.watchScreenShare).toHaveBeenCalledWith('https://local.test/users/alice');
	});

	test('does not offer to watch before joining the call', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(alice, true)] }]);
		render(XVoice, { props: { room }, global: { stubs } });
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

describe('participant menu', () => {
	const me = { id: 'me', username: 'me', name: 'Me', host: null };
	type MenuItemLike = { type?: string; text?: string; action?: () => unknown; props?: Record<string, unknown> };
	const openedItems = () => mocks.popupMenu.mock.calls[mocks.popupMenu.mock.calls.length - 1][0] as MenuItemLike[];

	test('lets the room owner remove a participant after confirming', async () => {
		const ownedRoom = { ...room, ownerId: 'me' };
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(bob)] }]);
		mocks.confirm.mockResolvedValue({ canceled: false });
		render(XVoice, { props: { room: ownedRoom }, global: { stubs } });
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
		render(XVoice, { props: { room: ownedRoom }, global: { stubs } });
		await flush();

		await fireEvent.click(screen.getByText('Bob'));
		await openedItems().find(item => item.text === i18n.ts._voiceCall.forceMute)!.action!();

		expect(mocks.apiWithDialog).toHaveBeenCalledWith('chat/rooms/voice/mute', { roomId: 'r1', userId: 'bob' });
	});

	test('does not offer moderation to other members', async () => {
		Object.assign(callState, { status: 'connected', room });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(bob)] }]);
		render(XVoice, { props: { room }, global: { stubs } });
		await flush();

		await fireEvent.click(screen.getByText('Bob'));
		const texts = openedItems().map(item => item.text);
		expect(texts).not.toContain(i18n.ts._voiceCall.kick);
		expect(texts).not.toContain(i18n.ts._voiceCall.forceMute);
	});

	test('offers a volume control only for others while in the call', async () => {
		Object.assign(callState, { status: 'connected', room });
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [participant(me), participant(bob)] }]);
		render(XVoice, { props: { room }, global: { stubs } });
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
