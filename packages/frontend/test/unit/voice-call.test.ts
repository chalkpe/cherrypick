/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { computed, nextTick } from 'vue';
import type { FakePrefer } from './fake-prefer.js';

const lk = vi.hoisted(() => {
	class Emitter {
		private handlers = new Map<string, Set<(...args: any[]) => void>>();
		on(event: string, handler: (...args: any[]) => void) {
			if (!this.handlers.has(event)) this.handlers.set(event, new Set());
			this.handlers.get(event)!.add(handler);
			return this;
		}
		off(event: string, handler: (...args: any[]) => void) {
			this.handlers.get(event)?.delete(handler);
			return this;
		}
		emit(event: string, ...args: any[]) {
			for (const handler of this.handlers.get(event) ?? []) handler(...args);
			return true;
		}
	}

	const RoomEvent = {
		Reconnecting: 'reconnecting',
		Reconnected: 'reconnected',
		Disconnected: 'disconnected',
		ParticipantConnected: 'participantConnected',
		ParticipantDisconnected: 'participantDisconnected',
		TrackPublished: 'trackPublished',
		TrackUnpublished: 'trackUnpublished',
		TrackSubscribed: 'trackSubscribed',
		TrackUnsubscribed: 'trackUnsubscribed',
		TrackMuted: 'trackMuted',
		LocalTrackPublished: 'localTrackPublished',
		LocalTrackUnpublished: 'localTrackUnpublished',
		ActiveSpeakersChanged: 'activeSpeakersChanged',
		AudioPlaybackStatusChanged: 'audioPlaybackChanged',
	};
	const DisconnectReason = { UNKNOWN_REASON: 0, CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, SERVER_SHUTDOWN: 3, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5 };
	const Track = {
		Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio', Unknown: 'unknown' },
		Kind: { Audio: 'audio', Video: 'video', Unknown: 'unknown' },
	};
	const preset = (width: number, height: number, maxBitrate: number, fps: number) => ({ width, height, resolution: { width, height, frameRate: fps }, encoding: { maxBitrate, maxFramerate: fps } });
	class VideoPreset {
		width: number;
		height: number;
		encoding: { maxBitrate: number; maxFramerate?: number; priority?: string };
		constructor(width: number, height: number, maxBitrate: number, maxFramerate?: number, priority?: string) {
			this.width = width;
			this.height = height;
			this.encoding = { maxBitrate, maxFramerate, priority };
		}
	}
	const VideoQuality = { LOW: 0, MEDIUM: 1, HIGH: 2 };
	const ScreenSharePresets = {
		// 値は本物の ScreenSharePresets と同じ
		h720fps15: preset(1280, 720, 1_500_000, 15),
		h720fps30: preset(1280, 720, 2_000_000, 30),
		h1080fps15: preset(1920, 1080, 2_500_000, 15),
		h1080fps30: preset(1920, 1080, 5_000_000, 30),
	};

	class FakeRemoteParticipant extends Emitter {
		trackPublications = new Map<string, any>();
		setVolume = vi.fn();
		constructor(public identity: string) {
			super();
		}
	}

	class FakeRoom extends Emitter {
		static instances: FakeRoom[] = [];
		static setup: ((room: FakeRoom) => void) | null = null;
		remoteParticipants = new Map<string, FakeRemoteParticipant>();
		canPlaybackAudio = true;
		localParticipant = {
			identity: 'https://local.test/users/me',
			// 本物と同じく、画面共有の映像を送っているあいだ true になる
			isScreenShareEnabled: false,
			setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
			setScreenShareEnabled: vi.fn(async (enabled: boolean, ..._options: unknown[]) => {
				this.localParticipant.isScreenShareEnabled = enabled;
			}),
		};
		connect = vi.fn().mockResolvedValue(undefined);
		disconnect = vi.fn(async () => {
			this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
		});
		startAudio = vi.fn(async () => {
			this.canPlaybackAudio = true;
		});
		switchActiveDevice = vi.fn().mockResolvedValue(true);
		getActiveDevice = vi.fn((_kind: string): string | undefined => undefined);
		constructor(public options: unknown) {
			super();
			FakeRoom.instances.push(this);
			FakeRoom.setup?.(this);
		}
	}

	return { Emitter, RoomEvent, DisconnectReason, Track, ScreenSharePresets, VideoPreset, VideoQuality, FakeRoom, FakeRemoteParticipant };
});

vi.mock('livekit-client', () => ({
	Room: lk.FakeRoom,
	RoomEvent: lk.RoomEvent,
	DisconnectReason: lk.DisconnectReason,
	Track: lk.Track,
	ScreenSharePresets: lk.ScreenSharePresets,
	VideoPreset: lk.VideoPreset,
	VideoQuality: lk.VideoQuality,
}));

const mocks = vi.hoisted(() => ({
	misskeyApi: vi.fn(),
	toast: vi.fn(),
	alert: vi.fn(),
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/os.js', () => ({ toast: mocks.toast, alert: mocks.alert }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));

import { i18n } from '@/i18n.js';
import { prefer as mockedPrefer } from '@/preferences.js';
import { activeAudioDeviceId, attachScreenShare, joinVoiceCall, leaveVoiceCall, participantVolume, resumeAudio, selectAudioDevice, setDeafened, setMicEnabled, setParticipantVolume, startScreenShare, stopScreenShare, toggleScreenShareWatch, unwatchScreenShare, voiceCall, watchScreenShare } from '@/utility/voice-call.js';

const prefer = mockedPrefer as unknown as FakePrefer;
const room1 = { id: 'r1', name: 'room 1' } as any;
const room2 = { id: 'r2', name: 'room 2' } as any;
const lastRoom = () => lk.FakeRoom.instances[lk.FakeRoom.instances.length - 1];

function remoteParticipant(identity: string) {
	const participant = new lk.FakeRemoteParticipant(identity);
	lastRoom().remoteParticipants.set(identity, participant);
	return participant;
}

beforeEach(() => {
	lk.FakeRoom.instances.length = 0;
	lk.FakeRoom.setup = null;
	mocks.misskeyApi.mockReset().mockResolvedValue({ url: 'https://local.test/livekit', token: 't' });
	mocks.toast.mockReset();
	mocks.alert.mockReset();
	prefer.reset({
		'voiceCall.inputDeviceId': null,
		'voiceCall.outputDeviceId': null,
		'voiceCall.echoCancellation': true,
		'voiceCall.noiseSuppression': true,
		'voiceCall.autoGainControl': true,
		'voiceCall.participantVolumes': {},
		'voiceCall.screenShareVolumes': {},
		'voiceCall.screenShareQuality': 'sharp',
		'voiceCall.screenShareAudio': true,
	});
});

afterEach(async () => {
	await leaveVoiceCall();
});

describe('voice call controller', () => {
	test('joins a room call with the token from the server and turns the mic on', async () => {
		await joinVoiceCall(room1);

		expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/join', { roomId: 'r1' });
		expect(lastRoom().connect).toHaveBeenCalledWith('https://local.test/livekit', 't', { autoSubscribe: false });
		expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.objectContaining({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }));
		expect(voiceCall).toMatchObject({ status: 'connected', micEnabled: true, room: room1 });
	});

	test('connects through the TURN servers the server hands out', async () => {
		const iceServers = [
			{ urls: ['stun:stun.cloudflare.com:3478'] },
			{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
		];
		mocks.misskeyApi.mockResolvedValue({ url: 'https://local.test/livekit', token: 't', iceServers });

		await joinVoiceCall(room1);

		expect(lastRoom().connect).toHaveBeenCalledWith('https://local.test/livekit', 't', { autoSubscribe: false, rtcConfig: { iceServers } });
		expect(voiceCall).toMatchObject({ status: 'connected' });
	});

	test.each([
		['null', null],
		['nothing (an older server)', undefined],
	])('leaves the ICE servers to LiveKit when the server hands out %s', async (_label, iceServers) => {
		mocks.misskeyApi.mockResolvedValue({ url: 'https://local.test/livekit', token: 't', iceServers });

		await joinVoiceCall(room1);

		const options = lastRoom().connect.mock.calls[0][2];
		expect(options).toEqual({ autoSubscribe: false });
		expect(options).not.toHaveProperty('rtcConfig');
	});

	// 他のサーバーの通話では、サーバーが確かめた ICE サーバーが無ければ空の一覧が届く。それをそのまま渡し、
	// 他のサーバーの LiveKit が渡す (確かめていない) ICE サーバーを LiveKit に使わせない
	test('passes an empty list of ICE servers through, so that LiveKit does not use the ones its own server sends', async () => {
		mocks.misskeyApi.mockResolvedValue({ url: 'https://remote.test/livekit', token: 't', iceServers: [] });

		await joinVoiceCall(room1);

		expect(lastRoom().connect).toHaveBeenCalledWith('https://remote.test/livekit', 't', { autoSubscribe: false, rtcConfig: { iceServers: [] } });
	});

	test('stays in the call as a listener when the microphone is unavailable', async () => {
		lk.FakeRoom.setup = room => room.localParticipant.setMicrophoneEnabled.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
		await joinVoiceCall(room1);

		expect(voiceCall).toMatchObject({ status: 'connected', micEnabled: false });
		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.micUnavailable);
	});

	test('returns to idle when the call server cannot be reached', async () => {
		lk.FakeRoom.setup = room => room.connect.mockRejectedValue(new Error('could not establish signal connection'));
		await joinVoiceCall(room1);

		expect(voiceCall).toMatchObject({ status: 'idle', room: null });
		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.connectionFailed);
	});

	test('explains that the host does not support calls', async () => {
		mocks.misskeyApi.mockRejectedValue({ code: 'REMOTE_HOST_UNSUPPORTED' });
		await joinVoiceCall(room1);

		expect(voiceCall).toMatchObject({ status: 'idle', room: null });
		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.remoteHostUnsupported);
	});

	test('reports an unreachable host as a connection failure', async () => {
		mocks.misskeyApi.mockRejectedValue({ code: 'REMOTE_HOST_UNREACHABLE' });
		await joinVoiceCall(room1);

		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.connectionFailed);
	});

	test('shows an enable-audio prompt when the browser blocks playback', async () => {
		await joinVoiceCall(room1);
		lastRoom().canPlaybackAudio = false;
		lastRoom().emit(lk.RoomEvent.AudioPlaybackStatusChanged, false);
		expect(voiceCall.audioBlocked).toBe(true);

		await resumeAudio();

		expect(lastRoom().startAudio).toHaveBeenCalled();
		expect(voiceCall.audioBlocked).toBe(false);
	});

	test('leaves the previous call before joining another room', async () => {
		await joinVoiceCall(room1);
		const first = lastRoom();

		await joinVoiceCall(room2);

		expect(first.disconnect).toHaveBeenCalled();
		expect(voiceCall.room).toEqual(room2);
		expect(mocks.toast).not.toHaveBeenCalled();
	});

	test.each([
		['DUPLICATE_IDENTITY', 'joinedFromAnotherTab'],
		['PARTICIPANT_REMOVED', 'removedFromCall'],
		['ROOM_DELETED', 'callEnded'],
	] as const)('cleans up and explains a %s disconnect', async (reason, key) => {
		await joinVoiceCall(room1);

		lastRoom().emit(lk.RoomEvent.Disconnected, lk.DisconnectReason[reason]);

		expect(voiceCall).toMatchObject({ status: 'idle', room: null });
		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall[key]);
	});

	test('does not toast when the user leaves on purpose', async () => {
		await joinVoiceCall(room1);
		const room = lastRoom();

		await leaveVoiceCall();

		expect(room.disconnect).toHaveBeenCalled();
		expect(voiceCall.status).toBe('idle');
		expect(mocks.toast).not.toHaveBeenCalled();
	});

	test('deafening silences everyone and the mic, undeafening restores saved volumes', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 0.5 });
		prefer.commit('voiceCall.screenShareVolumes', { a: 0.3 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const b = remoteParticipant('b');

		setDeafened(true);
		await Promise.resolve();

		expect(a.setVolume).toHaveBeenLastCalledWith(0, lk.Track.Source.ScreenShareAudio);
		expect(a.setVolume).toHaveBeenCalledWith(0, lk.Track.Source.Microphone);
		expect(b.setVolume).toHaveBeenCalledWith(0, lk.Track.Source.Microphone);
		expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false, expect.anything());
		expect(voiceCall).toMatchObject({ deafened: true, micEnabled: false });

		setDeafened(false);

		expect(a.setVolume).toHaveBeenCalledWith(0.5, lk.Track.Source.Microphone);
		expect(a.setVolume).toHaveBeenCalledWith(0.3, lk.Track.Source.ScreenShareAudio);
		expect(b.setVolume).toHaveBeenCalledWith(1, lk.Track.Source.Microphone);
		expect(b.setVolume).toHaveBeenCalledWith(1, lk.Track.Source.ScreenShareAudio);
		expect(voiceCall).toMatchObject({ deafened: false, micEnabled: false });
	});

	test('keeps participant volume within what an audio element accepts', async () => {
		prefer.commit('voiceCall.participantVolumes', { b: 1.8 });
		prefer.commit('voiceCall.screenShareVolumes', { b: -0.5 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const b = remoteParticipant('b');

		setParticipantVolume('a', 'voice', 1.5);
		expect(prefer.s['voiceCall.participantVolumes']).toMatchObject({ a: 1 });
		expect(a.setVolume).toHaveBeenCalledWith(1, lk.Track.Source.Microphone);
		setParticipantVolume('a', 'screenShare', -1);
		expect(prefer.s['voiceCall.screenShareVolumes']).toMatchObject({ a: 0 });
		expect(a.setVolume).toHaveBeenLastCalledWith(0, lk.Track.Source.ScreenShareAudio);

		expect(participantVolume('b', 'voice')).toBe(1);
		expect(participantVolume('b', 'screenShare')).toBe(0);
		setDeafened(true);
		setDeafened(false);
		expect(b.setVolume).toHaveBeenCalledWith(1, lk.Track.Source.Microphone);
		expect(b.setVolume).toHaveBeenLastCalledWith(0, lk.Track.Source.ScreenShareAudio);
		expect(b.setVolume).not.toHaveBeenCalledWith(1.8, expect.anything());
		expect(b.setVolume).not.toHaveBeenCalledWith(-0.5, expect.anything());
	});

	test('keeps the voice and the shared screen audio of a participant at separate volumes', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');

		setParticipantVolume('a', 'voice', 0.4);
		expect(a.setVolume).toHaveBeenCalledWith(0.4, lk.Track.Source.Microphone);
		expect(a.setVolume).toHaveBeenLastCalledWith(1, lk.Track.Source.ScreenShareAudio);

		setParticipantVolume('a', 'screenShare', 0.2);
		expect(a.setVolume).toHaveBeenLastCalledWith(0.2, lk.Track.Source.ScreenShareAudio);
		expect(a.setVolume).not.toHaveBeenCalledWith(0.2, lk.Track.Source.Microphone);

		expect(prefer.s['voiceCall.participantVolumes']).toEqual({ a: 0.4 });
		expect(prefer.s['voiceCall.screenShareVolumes']).toEqual({ a: 0.2 });
		expect(participantVolume('a', 'voice')).toBe(0.4);
		expect(participantVolume('a', 'screenShare')).toBe(0.2);
		expect(participantVolume('unknown', 'screenShare')).toBe(1);
	});

	test('subscribes to remote audio as it is published and plays it', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const publication = { source: lk.Track.Source.Microphone, kind: lk.Track.Kind.Audio, setSubscribed: vi.fn() };
		lastRoom().emit(lk.RoomEvent.TrackPublished, publication, a);
		expect(publication.setSubscribed).toHaveBeenCalledWith(true);

		const element = document.createElement('audio');
		const track = { kind: lk.Track.Kind.Audio, attach: vi.fn(() => element), detach: vi.fn(() => [element]) };
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, publication, a);
		expect(document.body.contains(element)).toBe(true);

		lastRoom().emit(lk.RoomEvent.TrackUnsubscribed, track, publication, a);
		expect(document.body.contains(element)).toBe(false);
	});

	test('tracks who is speaking', async () => {
		await joinVoiceCall(room1);
		lastRoom().emit(lk.RoomEvent.ActiveSpeakersChanged, [{ identity: 'i1' }]);
		expect(voiceCall.speakingIdentities).toEqual(['i1']);
	});

	test('reports reconnecting while the connection recovers', async () => {
		await joinVoiceCall(room1);
		lastRoom().emit(lk.RoomEvent.Reconnecting);
		expect(voiceCall.status).toBe('reconnecting');
		lastRoom().emit(lk.RoomEvent.Reconnected);
		expect(voiceCall.status).toBe('connected');
	});

	test('reflects a mute forced by the room owner', async () => {
		await joinVoiceCall(room1);
		lastRoom().emit(lk.RoomEvent.TrackMuted, { source: lk.Track.Source.Microphone }, lastRoom().localParticipant);
		expect(voiceCall.micEnabled).toBe(false);
	});

	test('turning the mic back on uses the saved input device', async () => {
		prefer.commit('voiceCall.inputDeviceId', 'mic-2');
		await joinVoiceCall(room1);
		await setMicEnabled(false);
		await setMicEnabled(true);
		expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true, expect.objectContaining({ deviceId: 'mic-2' }));
		expect(voiceCall.micEnabled).toBe(true);
	});
});

describe('active audio device', () => {
	test('prefers the saved device', async () => {
		prefer.commit('voiceCall.outputDeviceId', 'spk-2');
		await joinVoiceCall(room1);
		lastRoom().getActiveDevice.mockReturnValue('spk-1');
		expect(activeAudioDeviceId('audiooutput')).toBe('spk-2');
	});

	test('falls back to the device the room is using', async () => {
		await joinVoiceCall(room1);
		lastRoom().getActiveDevice.mockImplementation(kind => (kind === 'audioinput' ? 'mic-9' : undefined));
		expect(activeAudioDeviceId('audioinput')).toBe('mic-9');
		expect(lastRoom().getActiveDevice).toHaveBeenCalledWith('audioinput');
	});

	// 設定メニューのチェック位置は computed で読むので、選び直したら追従しなければならない
	test('follows a newly picked device when read inside a computed', async () => {
		await joinVoiceCall(room1);
		lastRoom().getActiveDevice.mockReturnValue('mic-1');
		const active = computed(() => activeAudioDeviceId('audioinput'));
		expect(active.value).toBe('mic-1');

		await selectAudioDevice('audioinput', 'mic-2');
		await nextTick();

		expect(active.value).toBe('mic-2');
	});

	test('falls back to default outside a call or when the room does not know', async () => {
		expect(activeAudioDeviceId('audioinput')).toBe('default');
		await joinVoiceCall(room1);
		expect(activeAudioDeviceId('audiooutput')).toBe('default');
	});
});

// 本物の RemoteTrackPublication と同じく、受け取るかどうかの希望 (isDesired) を覚える。autoSubscribe: false なので最初は受け取らない。
// layers は送り手が送っている層の数 (Firefox は画面共有を simulcast しないので 1 つ)
function screenSharePublication(participant: InstanceType<typeof lk.FakeRemoteParticipant>, layers = 3) {
	const publication = {
		source: lk.Track.Source.ScreenShare,
		kind: lk.Track.Kind.Video,
		trackSid: `TR_${participant.identity}`,
		track: null as unknown,
		simulcasted: layers > 1,
		trackInfo: { layers: Array.from({ length: layers }, (_, quality) => ({ quality })), codecs: [] },
		isDesired: false,
		setSubscribed: vi.fn((subscribed: boolean) => {
			publication.isDesired = subscribed;
		}),
		setVideoQuality: vi.fn(),
	};
	participant.trackPublications.set(publication.trackSid, publication);
	return publication;
}

function sharing(identity: string, layers = 3) {
	const participant = remoteParticipant(identity);
	const publication = screenSharePublication(participant, layers);
	lastRoom().emit(lk.RoomEvent.TrackPublished, publication, participant);
	return { participant, publication };
}

const screenShareTrack = () => ({ kind: lk.Track.Kind.Video, source: lk.Track.Source.ScreenShare, attach: vi.fn(), detach: vi.fn(() => []) });

describe('screen sharing', () => {
	test('shares the screen with the preferred quality', async () => {
		await joinVoiceCall(room1);

		await startScreenShare();

		expect(lastRoom().localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(true,
			expect.objectContaining({ audio: true, contentHint: 'detail', resolution: lk.ScreenSharePresets.h1080fps15.resolution }),
			expect.objectContaining({ screenShareEncoding: lk.ScreenSharePresets.h1080fps15.encoding }));
		expect(voiceCall.screenSharing).toBe(true);
	});

	test('uses the smooth preset when chosen', async () => {
		prefer.commit('voiceCall.screenShareQuality', 'smooth');
		prefer.commit('voiceCall.screenShareAudio', false);
		await joinVoiceCall(room1);

		await startScreenShare();

		expect(lastRoom().localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(true,
			expect.objectContaining({ audio: false, contentHint: 'motion', resolution: lk.ScreenSharePresets.h720fps30.resolution }),
			expect.objectContaining({ screenShareEncoding: lk.ScreenSharePresets.h720fps30.encoding }));
	});

	test('stays not sharing without an error when the picker is cancelled', async () => {
		lk.FakeRoom.setup = room => room.localParticipant.setScreenShareEnabled.mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));
		await joinVoiceCall(room1);

		await startScreenShare();

		expect(voiceCall.screenSharing).toBe(false);
		expect(mocks.alert).not.toHaveBeenCalled();
		expect(mocks.toast).not.toHaveBeenCalled();
	});

	test('tells the user when sharing fails for another reason', async () => {
		lk.FakeRoom.setup = room => room.localParticipant.setScreenShareEnabled.mockRejectedValue(new Error('track publish failed'));
		await joinVoiceCall(room1);

		await startScreenShare();

		expect(voiceCall.screenSharing).toBe(false);
		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.screenShareFailed);
	});

	test('stopping the share turns it off', async () => {
		await joinVoiceCall(room1);
		await startScreenShare();

		await stopScreenShare();

		expect(lastRoom().localParticipant.setScreenShareEnabled).toHaveBeenLastCalledWith(false);
		expect(voiceCall.screenSharing).toBe(false);
	});

	test('notices when the browser ends the share', async () => {
		await joinVoiceCall(room1);
		await startScreenShare();

		lastRoom().emit(lk.RoomEvent.LocalTrackUnpublished, { source: lk.Track.Source.ScreenShare }, lastRoom().localParticipant);

		expect(voiceCall.screenSharing).toBe(false);
	});

	test('publishes a small, slow layer for previews below the shared quality', async () => {
		await joinVoiceCall(room1);

		await startScreenShare();

		const publishOptions = lastRoom().localParticipant.setScreenShareEnabled.mock.calls[0][2] as { screenShareSimulcastLayers: InstanceType<typeof lk.VideoPreset>[] };
		const [preview, ...rest] = publishOptions.screenShareSimulcastLayers;
		expect(preview).toMatchObject({ width: 320, height: 180 });
		expect(preview.encoding.maxFramerate).toBeLessThanOrEqual(5);
		// Chromium は一番低い層の priority だけを送信の優先度に使うので、プレビューの層にも付ける
		expect(preview.encoding.priority).toBe('medium');
		// 層は低いものから並べる
		for (const layer of rest) expect(layer.encoding.maxBitrate).toBeGreaterThan(preview.encoding.maxBitrate);
	});

	test('subscribes to nothing until a share is watched', async () => {
		await joinVoiceCall(room1);
		const a = sharing('a');
		const b = sharing('b');

		expect(a.publication.setSubscribed).not.toHaveBeenCalledWith(true);
		expect(b.publication.setSubscribed).not.toHaveBeenCalledWith(true);
		expect(voiceCall.screenShareIdentities).toEqual(['a', 'b']);
		expect(voiceCall.watchingIdentities).toEqual([]);
	});

	test('watches several screen shares at once, each at high quality', async () => {
		await joinVoiceCall(room1);
		const a = sharing('a');
		const b = sharing('b');

		watchScreenShare('a');
		watchScreenShare('b');

		expect(voiceCall.watchingIdentities).toEqual(['a', 'b']);
		for (const { publication } of [a, b]) {
			expect(publication.setSubscribed).toHaveBeenLastCalledWith(true);
			expect(publication.setVideoQuality).toHaveBeenLastCalledWith(lk.VideoQuality.HIGH);
		}
	});

	test('stops watching only the share that is un-watched', async () => {
		await joinVoiceCall(room1);
		const a = sharing('a');
		const b = sharing('b');
		watchScreenShare('a');
		watchScreenShare('b');

		unwatchScreenShare('a');

		expect(voiceCall.watchingIdentities).toEqual(['b']);
		expect(a.publication.setSubscribed).toHaveBeenLastCalledWith(false);
		expect(b.publication.setSubscribed).not.toHaveBeenCalledWith(false);
		expect(b.publication.setVideoQuality).toHaveBeenLastCalledWith(lk.VideoQuality.HIGH);
	});

	test('toggles watching a share', async () => {
		await joinVoiceCall(room1);
		const a = sharing('a');

		toggleScreenShareWatch('a');
		expect(voiceCall.watchingIdentities).toEqual(['a']);
		expect(a.publication.setSubscribed).toHaveBeenLastCalledWith(true);

		toggleScreenShareWatch('a');
		expect(voiceCall.watchingIdentities).toEqual([]);
		expect(a.publication.setSubscribed).toHaveBeenLastCalledWith(false);
	});

	test('watching the same share twice keeps it once', async () => {
		await joinVoiceCall(room1);
		sharing('a');

		watchScreenShare('a');
		watchScreenShare('a');

		expect(voiceCall.watchingIdentities).toEqual(['a']);
	});

	test('subscribes a share watched before it is published once it arrives', async () => {
		await joinVoiceCall(room1);
		watchScreenShare('a');

		const a = sharing('a');

		expect(a.publication.setSubscribed).toHaveBeenLastCalledWith(true);
		expect(a.publication.setVideoQuality).toHaveBeenLastCalledWith(lk.VideoQuality.HIGH);
	});

	test('previews pull only the low layer of a share nobody watches', async () => {
		await joinVoiceCall(room1);
		const a = sharing('a');
		const b = sharing('b');

		const detach = attachScreenShare('a', document.createElement('video'), { preview: true });

		expect(a.publication.setSubscribed).toHaveBeenLastCalledWith(true);
		expect(a.publication.setVideoQuality).toHaveBeenLastCalledWith(lk.VideoQuality.LOW);
		expect(a.publication.setVideoQuality).not.toHaveBeenCalledWith(lk.VideoQuality.HIGH);
		expect(b.publication.setSubscribed).not.toHaveBeenCalledWith(true);

		// プレビューを閉じれば受け取るのもやめる
		detach();
		expect(a.publication.setSubscribed).toHaveBeenLastCalledWith(false);
	});

	test('does not preview a share sent as a single full-quality layer, but still lets it be watched', async () => {
		await joinVoiceCall(room1);
		// Firefox の送り手は simulcast しないので、低い層を頼んでも元の画質のまま届いてしまう
		const a = sharing('a', 1);

		attachScreenShare('a', document.createElement('video'), { preview: true });
		expect(a.publication.setSubscribed).not.toHaveBeenCalledWith(true);

		watchScreenShare('a');
		expect(a.publication.setSubscribed).toHaveBeenLastCalledWith(true);
		expect(a.publication.setVideoQuality).toHaveBeenLastCalledWith(lk.VideoQuality.HIGH);

		unwatchScreenShare('a');
		expect(a.publication.setSubscribed).toHaveBeenLastCalledWith(false);
		expect(a.publication.setVideoQuality).not.toHaveBeenCalledWith(lk.VideoQuality.LOW);
	});

	test('reads the layers from the per-codec layer list too', async () => {
		await joinVoiceCall(room1);
		const participant = remoteParticipant('a');
		const publication = screenSharePublication(participant, 1);
		publication.trackInfo = { layers: [], codecs: [{ layers: [{ quality: 0 }, { quality: 2 }] }] } as any;
		lastRoom().emit(lk.RoomEvent.TrackPublished, publication, participant);

		attachScreenShare('a', document.createElement('video'), { preview: true });

		expect(publication.setSubscribed).toHaveBeenLastCalledWith(true);
		expect(publication.setVideoQuality).toHaveBeenLastCalledWith(lk.VideoQuality.LOW);
	});

	test('a previewed share switches to high quality while watched and back to low after', async () => {
		await joinVoiceCall(room1);
		const a = sharing('a');
		attachScreenShare('a', document.createElement('video'), { preview: true });

		watchScreenShare('a');
		expect(a.publication.setVideoQuality).toHaveBeenLastCalledWith(lk.VideoQuality.HIGH);

		unwatchScreenShare('a');
		expect(a.publication.setSubscribed).not.toHaveBeenCalledWith(false);
		expect(a.publication.setVideoQuality).toHaveBeenLastCalledWith(lk.VideoQuality.LOW);
	});

	test('a sharer who stops sharing leaves the watched shares', async () => {
		await joinVoiceCall(room1);
		const a = sharing('a');
		sharing('b');
		watchScreenShare('a');
		watchScreenShare('b');

		a.participant.trackPublications.delete(a.publication.trackSid);
		lastRoom().emit(lk.RoomEvent.TrackUnpublished, a.publication, a.participant);

		expect(voiceCall.watchingIdentities).toEqual(['b']);
		expect(voiceCall.screenShareIdentities).toEqual(['b']);
	});

	test('a sharer who leaves the call leaves the watched shares', async () => {
		await joinVoiceCall(room1);
		const a = sharing('a');
		watchScreenShare('a');

		lastRoom().emit(lk.RoomEvent.ParticipantDisconnected, a.participant);

		expect(voiceCall.watchingIdentities).toEqual([]);
	});

	test('attaches the watched screen share to a video element once it arrives', async () => {
		await joinVoiceCall(room1);
		const a = sharing('a');
		watchScreenShare('a');
		const video = document.createElement('video');
		const detach = attachScreenShare('a', video);

		const track = screenShareTrack();
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, a.publication, a.participant);
		expect(track.attach).toHaveBeenCalledWith(video);

		detach();
		expect(track.detach).toHaveBeenCalledWith(video);
	});

	test('shows one share in its preview and its viewer at the same time', async () => {
		await joinVoiceCall(room1);
		const a = sharing('a');
		// 中身の同じ要素は toHaveBeenCalledWith で区別できないので、印を付けておく
		const preview = Object.assign(document.createElement('video'), { id: 'preview' });
		const viewer = Object.assign(document.createElement('video'), { id: 'viewer' });
		attachScreenShare('a', preview, { preview: true });
		watchScreenShare('a');
		attachScreenShare('a', viewer);

		const track = screenShareTrack();
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, a.publication, a.participant);
		expect(track.attach).toHaveBeenCalledWith(preview);
		expect(track.attach).toHaveBeenCalledWith(viewer);

		lastRoom().emit(lk.RoomEvent.TrackUnsubscribed, track, a.publication, a.participant);
		expect(track.detach).toHaveBeenCalledWith(preview);
		expect(track.detach).toHaveBeenCalledWith(viewer);
	});

	test('leaving the call does not take the share\'s video elements out of the page', async () => {
		await joinVoiceCall(room1);
		const a = sharing('a');
		const container = document.createElement('div');
		const viewer = document.createElement('video');
		container.appendChild(viewer);
		watchScreenShare('a');
		attachScreenShare('a', viewer);
		const track = { ...screenShareTrack(), detach: vi.fn(() => [viewer]) };
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, a.publication, a.participant);
		a.publication.track = track;

		await leaveVoiceCall();

		// video 要素は画面の部品のものなので、外すのは部品に任せる
		expect(viewer.parentElement).toBe(container);
		expect(voiceCall.watchingIdentities).toEqual([]);
	});
});

// 本物の LocalParticipant と同じく、画面共有を始めると映像と音声のトラックを LocalTrackPublished で、やめると LocalTrackUnpublished で知らせる。
// 映像を送り始めてから音声を送り始めるまでのあいだに起きることは whilePublishing で差し込む
function localScreenShare(options: { whilePublishing?: () => unknown } = {}) {
	const tracks = {
		video: { kind: lk.Track.Kind.Video, source: lk.Track.Source.ScreenShare, attach: vi.fn(), detach: vi.fn(() => []) },
		audio: { kind: lk.Track.Kind.Audio, source: lk.Track.Source.ScreenShareAudio, attach: vi.fn(() => document.createElement('audio')), detach: vi.fn(() => []) },
	};
	type Publication = { source: string; kind: string; trackSid: string; track: typeof tracks.video | typeof tracks.audio };
	const publications: Record<'video' | 'audio', Publication> = {
		video: { source: tracks.video.source, kind: tracks.video.kind, trackSid: 'TR_my_screen', track: tracks.video },
		audio: { source: tracks.audio.source, kind: tracks.audio.kind, trackSid: 'TR_my_screen_audio', track: tracks.audio },
	};

	// isScreenShareEnabled も本物と同じく、映像の公開が残っているあいだ true にする
	function publish(publication: Publication) {
		const room = lastRoom();
		if (publication === publications.video) room.localParticipant.isScreenShareEnabled = true;
		room.emit(lk.RoomEvent.LocalTrackPublished, publication, room.localParticipant);
	}

	function unpublish(publication: Publication) {
		const room = lastRoom();
		if (publication === publications.video) room.localParticipant.isScreenShareEnabled = false;
		room.emit(lk.RoomEvent.LocalTrackUnpublished, publication, room.localParticipant);
	}

	lk.FakeRoom.setup = room => room.localParticipant.setScreenShareEnabled.mockImplementation(async (enabled: boolean) => {
		if (!enabled) {
			for (const publication of Object.values(publications)) unpublish(publication);
			return;
		}
		publish(publications.video);
		await options.whilePublishing?.();
		publish(publications.audio);
	});
	return { tracks, publications, publish, unpublish };
}

describe('my own screen share', () => {
	// FakeRoom の localParticipant の identity
	const me = 'https://local.test/users/me';

	// 映す要素は画面の部品のもの。部品と同じく、テストの終わりに外す (外さないと次のテストにプレビューが残る)
	const detachers: (() => void)[] = [];
	afterEach(() => {
		for (const detach of detachers.splice(0)) detach();
	});

	// 中身の同じ要素は toHaveBeenCalledWith で区別できないので、印を付けておく
	function showMine(id: string, options: { preview?: boolean } = {}) {
		const element = Object.assign(document.createElement('video'), { id });
		detachers.push(attachScreenShare(me, element, options));
		return element;
	}

	test('shows my share in its previews and viewers straight from the local track, subscribing to nothing', async () => {
		const { tracks } = localScreenShare();
		await joinVoiceCall(room1);
		const other = sharing('someone');
		// 共有を始める前から出ていたプレビューにも映す
		const preview = showMine('preview', { preview: true });

		await startScreenShare();
		expect(tracks.video.attach).toHaveBeenCalledWith(preview);

		watchScreenShare(me);
		const viewer = showMine('viewer');
		expect(tracks.video.attach).toHaveBeenCalledWith(viewer);
		expect(voiceCall.watchingIdentities).toEqual([me]);
		// 自分の共有は受け取るものではないので、ほかの人の共有を受け取るかどうかは変わらない
		expect(other.publication.setSubscribed).not.toHaveBeenCalled();
		expect(voiceCall.screenShareIdentities).toEqual(['someone']);
	});

	test('never plays the audio of my own share back to me', async () => {
		const { tracks } = localScreenShare();
		await joinVoiceCall(room1);
		showMine('preview', { preview: true });
		const audioElements = document.body.querySelectorAll('audio').length;

		await startScreenShare();
		watchScreenShare(me);
		showMine('viewer');

		expect(tracks.video.attach).toHaveBeenCalledTimes(2);
		expect(tracks.audio.attach).not.toHaveBeenCalled();
		expect(document.body.querySelectorAll('audio').length).toBe(audioElements);
	});

	test.each<[string, (share: ReturnType<typeof localScreenShare>) => unknown]>([
		['the stop button', async () => {
			await stopScreenShare();
		}],
		// ブラウザの「共有を停止」やトラックが終わったときは、映像のトラックだけが外れることもある
		['the browser ending the share', ({ publications, unpublish }) => {
			unpublish(publications.video);
		}],
	])('stopping my share by %s takes it out of every preview and viewer and stops watching it', async (_label, stop) => {
		const share = localScreenShare();
		const { tracks } = share;
		await joinVoiceCall(room1);
		sharing('someone');
		watchScreenShare('someone');
		await startScreenShare();
		const preview = showMine('preview', { preview: true });
		watchScreenShare(me);
		const viewer = showMine('viewer');

		await stop(share);

		expect(tracks.video.detach).toHaveBeenCalledWith(preview);
		expect(tracks.video.detach).toHaveBeenCalledWith(viewer);
		expect(voiceCall.watchingIdentities).toEqual(['someone']);
		expect(voiceCall.screenSharing).toBe(false);
		// 止めたトラックは覚えていないので、あとから出た要素には映さない
		const later = showMine('later', { preview: true });
		expect(tracks.video.attach).not.toHaveBeenCalledWith(later);
	});

	test.each([
		['leaving the call', async () => {
			await leaveVoiceCall();
		}],
		['being disconnected', () => {
			lastRoom().emit(lk.RoomEvent.Disconnected, lk.DisconnectReason.SERVER_SHUTDOWN);
		}],
	])('%s while sharing takes my share out of its preview', async (_label, end) => {
		const { tracks } = localScreenShare();
		await joinVoiceCall(room1);
		await startScreenShare();
		const preview = showMine('preview', { preview: true });

		await end();

		expect(tracks.video.detach).toHaveBeenCalledWith(preview);
		const later = showMine('later', { preview: true });
		expect(tracks.video.attach).not.toHaveBeenCalledWith(later);
	});

	// 接続をやり直すとき、LiveKit は共有中のトラックをいったん外して送り直す
	test('keeps showing my share when LiveKit publishes it again after reconnecting', async () => {
		const { tracks, publications, publish, unpublish } = localScreenShare();
		await joinVoiceCall(room1);
		await startScreenShare();
		const preview = showMine('preview', { preview: true });
		tracks.video.attach.mockClear();

		unpublish(publications.video);
		publish(publications.video);

		expect(tracks.video.attach).toHaveBeenCalledWith(preview);
		expect(voiceCall.screenSharing).toBe(true);
	});

	// 映像を送り始めてから共有の準備が終わるまでのあいだに共有が終わっても、終わったあとで共有中に戻さない
	test('does not go back to sharing when the share ends while it is still being set up', async () => {
		// ブラウザの「共有を停止」は、音声を送り始める前の映像も止める
		const share = localScreenShare({
			whilePublishing: () => {
				share.unpublish(share.publications.video);
			},
		});
		await joinVoiceCall(room1);
		const preview = showMine('preview', { preview: true });

		await startScreenShare();

		expect(voiceCall.screenSharing).toBe(false);
		expect(share.tracks.video.detach).toHaveBeenCalledWith(preview);
	});

	test('does not mark a call left while the share was being set up as sharing', async () => {
		localScreenShare({
			whilePublishing: async () => {
				await leaveVoiceCall();
			},
		});
		await joinVoiceCall(room1);

		await startScreenShare();

		expect(voiceCall).toMatchObject({ status: 'idle', screenSharing: false });
	});
});

test('screen audio follows each watched identity while microphones remain independent', async () => {
	await joinVoiceCall(room1);
	const people = ['a', 'b'].map(identity => {
		const participant = remoteParticipant(identity);
		const audio = { source: lk.Track.Source.ScreenShareAudio, setSubscribed: vi.fn() };
		const mic = { source: lk.Track.Source.Microphone, setSubscribed: vi.fn() };
		participant.trackPublications.set('audio', audio);
		participant.trackPublications.set('mic', mic);
		lastRoom().emit(lk.RoomEvent.TrackPublished, audio, participant);
		lastRoom().emit(lk.RoomEvent.TrackPublished, mic, participant);
		return { participant, audio, mic };
	});
	for (const p of people) expect(p.audio.setSubscribed).toHaveBeenLastCalledWith(false);
	const detach = attachScreenShare('a', document.createElement('video'), { preview: true });
	expect(people[0].audio.setSubscribed).toHaveBeenLastCalledWith(false);
	watchScreenShare('a');
	watchScreenShare('b');
	for (const p of people) expect(p.audio.setSubscribed).toHaveBeenLastCalledWith(true);
	unwatchScreenShare('a');
	expect(people[0].audio.setSubscribed).toHaveBeenLastCalledWith(false);
	expect(people[1].audio.setSubscribed).toHaveBeenLastCalledWith(true);
	for (const p of people) expect(p.mic.setSubscribed).toHaveBeenLastCalledWith(true);
	lastRoom().emit(lk.RoomEvent.TrackPublished, people[0].audio, people[0].participant);
	expect(people[0].audio.setSubscribed).toHaveBeenLastCalledWith(false);
	detach();
});

test('initial screen audio is silent, late audio follows watch, and video removal also stops audio', async () => {
	const participant = new lk.FakeRemoteParticipant('a');
	const audio = { source: lk.Track.Source.ScreenShareAudio, setSubscribed: vi.fn() };
	participant.trackPublications.set('audio', audio);
	lk.FakeRoom.setup = room => room.remoteParticipants.set('a', participant);
	await joinVoiceCall(room1);
	expect(audio.setSubscribed).toHaveBeenLastCalledWith(false);
	watchScreenShare('a');
	const late = { source: lk.Track.Source.ScreenShareAudio, setSubscribed: vi.fn() };
	participant.trackPublications.set('late', late);
	lastRoom().emit(lk.RoomEvent.TrackPublished, late, participant);
	expect(late.setSubscribed).toHaveBeenLastCalledWith(true);
	lastRoom().emit(lk.RoomEvent.TrackUnpublished, { source: lk.Track.Source.ScreenShare }, participant);
	expect(audio.setSubscribed).toHaveBeenLastCalledWith(false);
	expect(late.setSubscribed).toHaveBeenLastCalledWith(false);
});
