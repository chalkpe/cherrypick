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
	const preset = (width: number, height: number, fps: number) => ({ resolution: { width, height, frameRate: fps }, encoding: { maxBitrate: width * fps, maxFramerate: fps } });
	const ScreenSharePresets = {
		h720fps15: preset(1280, 720, 15),
		h720fps30: preset(1280, 720, 30),
		h1080fps15: preset(1920, 1080, 15),
		h1080fps30: preset(1920, 1080, 30),
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
			setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
			setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
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

	return { Emitter, RoomEvent, DisconnectReason, Track, ScreenSharePresets, FakeRoom, FakeRemoteParticipant };
});

vi.mock('livekit-client', () => ({
	Room: lk.FakeRoom,
	RoomEvent: lk.RoomEvent,
	DisconnectReason: lk.DisconnectReason,
	Track: lk.Track,
	ScreenSharePresets: lk.ScreenSharePresets,
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
import { activeAudioDeviceId, attachScreenShare, joinVoiceCall, leaveVoiceCall, resumeAudio, selectAudioDevice, setDeafened, setMicEnabled, setParticipantVolume, startScreenShare, stopScreenShare, voiceCall, watchScreenShare } from '@/utility/voice-call.js';

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
		expect(b.setVolume).toHaveBeenCalledWith(1, lk.Track.Source.Microphone);
		expect(voiceCall).toMatchObject({ deafened: false, micEnabled: false });
	});

	test('keeps participant volume within what an audio element accepts', async () => {
		prefer.commit('voiceCall.participantVolumes', { b: 1.8 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const b = remoteParticipant('b');

		setParticipantVolume('a', 1.5);
		expect(prefer.s['voiceCall.participantVolumes']).toMatchObject({ a: 1 });
		expect(a.setVolume).toHaveBeenLastCalledWith(1, lk.Track.Source.ScreenShareAudio);

		setDeafened(true);
		setDeafened(false);
		expect(b.setVolume).toHaveBeenCalledWith(1, lk.Track.Source.Microphone);
		expect(b.setVolume).not.toHaveBeenCalledWith(1.8, expect.anything());
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

function screenSharePublication(participant: InstanceType<typeof lk.FakeRemoteParticipant>) {
	const publication = { source: lk.Track.Source.ScreenShare, kind: lk.Track.Kind.Video, trackSid: `TR_${participant.identity}`, setSubscribed: vi.fn(), track: null as unknown };
	participant.trackPublications.set(publication.trackSid, publication);
	return publication;
}

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

	test('subscribes only to the screen share being watched', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const b = remoteParticipant('b');
		const aShare = screenSharePublication(a);
		const bShare = screenSharePublication(b);
		lastRoom().emit(lk.RoomEvent.TrackPublished, aShare, a);
		lastRoom().emit(lk.RoomEvent.TrackPublished, bShare, b);

		expect(aShare.setSubscribed).not.toHaveBeenCalledWith(true);
		expect(bShare.setSubscribed).not.toHaveBeenCalledWith(true);
		expect(voiceCall.screenShareIdentities).toEqual(['a', 'b']);

		watchScreenShare('a');
		expect(aShare.setSubscribed).toHaveBeenLastCalledWith(true);
		expect(bShare.setSubscribed).not.toHaveBeenCalledWith(true);
		expect(voiceCall.watchingIdentity).toBe('a');

		watchScreenShare(null);
		expect(aShare.setSubscribed).toHaveBeenLastCalledWith(false);
		expect(voiceCall.watchingIdentity).toBeNull();
	});

	test('stops watching when the sharer stops', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const aShare = screenSharePublication(a);
		lastRoom().emit(lk.RoomEvent.TrackPublished, aShare, a);
		watchScreenShare('a');

		a.trackPublications.delete(aShare.trackSid);
		lastRoom().emit(lk.RoomEvent.TrackUnpublished, aShare, a);

		expect(voiceCall.watchingIdentity).toBeNull();
		expect(voiceCall.screenShareIdentities).toEqual([]);
	});

	test('attaches the watched screen share to a video element once it arrives', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		const aShare = screenSharePublication(a);
		lastRoom().emit(lk.RoomEvent.TrackPublished, aShare, a);
		watchScreenShare('a');
		const video = document.createElement('video');
		const detach = attachScreenShare('a', video);

		const track = { kind: lk.Track.Kind.Video, source: lk.Track.Source.ScreenShare, attach: vi.fn(), detach: vi.fn(() => []) };
		lastRoom().emit(lk.RoomEvent.TrackSubscribed, track, aShare, a);
		expect(track.attach).toHaveBeenCalledWith(video);

		detach();
		expect(track.detach).toHaveBeenCalledWith(video);
	});
});
