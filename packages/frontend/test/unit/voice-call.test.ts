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
			// 本物の EventEmitter と同じく、emit の途中で付け外しされたハンドラはその emit では呼ばない
			for (const handler of [...this.handlers.get(event) ?? []]) handler(...args);
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
	const TrackEvent = { Restarted: 'restarted', Ended: 'ended' };
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
		publisher = { getConfiguration: vi.fn(() => ({ iceTransportPolicy: 'relay' as RTCIceTransportPolicy, bundlePolicy: 'max-bundle' as RTCBundlePolicy })), setConfiguration: vi.fn() };
		subscriber = { getConfiguration: vi.fn(() => ({ iceTransportPolicy: 'relay' as RTCIceTransportPolicy })), setConfiguration: vi.fn() };
		engine = { token: '', rtcConfig: {} as RTCConfiguration, reconnect: vi.fn(), pcManager: { publisher: { _pc: this.publisher }, subscriber: { _pc: this.subscriber }, triggerIceRestart: vi.fn().mockResolvedValue(undefined) } };
		localParticipant = {
			identity: 'https://local.test/users/me',
			// 本物と同じく、画面共有の映像を送っているあいだ true になる
			sid: 'PA_local',
			isScreenShareEnabled: false,
			// 本物と同じく、マイクのトラックは livekit-client が作り直す (restarted) ことも終わる (ended) こともある
			microphoneTrack: Object.assign(new Emitter(), { kind: 'audio', mediaStreamTrack: {} }),
			getTrackPublication: vi.fn(() => ({ track: this.localParticipant.microphoneTrack })),
			setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
			screenVideo: { source: 'screen_share', mediaStreamTrack: { applyConstraints: vi.fn().mockResolvedValue(undefined), getSettings: vi.fn(() => ({ width: 1280, height: 720, frameRate: 10 })) }, stop: vi.fn() },
			createScreenTracks: vi.fn(async () => [this.localParticipant.screenVideo]),
			publishTrack: vi.fn(async () => { this.localParticipant.isScreenShareEnabled = true; }),
			unpublishTrack: vi.fn().mockResolvedValue(undefined),
			setScreenShareEnabled: vi.fn(async (enabled: boolean, ..._options: unknown[]) => {
				this.localParticipant.isScreenShareEnabled = enabled;
			}),
		};
		connect = vi.fn(async (_url: string, token: string, options?: { rtcConfig?: RTCConfiguration }) => { this.engine.token = token; this.engine.rtcConfig = options?.rtcConfig ?? {}; });
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

	const analyser = { analyser: { fftSize: 512, context: { state: 'running' as AudioContextState }, getFloatTimeDomainData: vi.fn((data: Float32Array) => data.fill(0)) }, cleanup: vi.fn().mockResolvedValue(undefined) };
	const createAudioAnalyser = vi.fn(() => analyser);
	return { analyser, createAudioAnalyser, Emitter, RoomEvent, TrackEvent, DisconnectReason, Track, ScreenSharePresets, VideoPreset, VideoQuality, FakeRoom, FakeRemoteParticipant };
});

vi.mock('livekit-client', () => ({
	Room: lk.FakeRoom,
	createAudioAnalyser: lk.createAudioAnalyser,
	RoomEvent: lk.RoomEvent,
	TrackEvent: lk.TrackEvent,
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
	confirm: vi.fn(),
	actions: vi.fn(),
	promiseDialog: vi.fn(promise => promise),
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/os.js', () => ({ toast: mocks.toast, alert: mocks.alert, confirm: mocks.confirm, actions: mocks.actions, promiseDialog: mocks.promiseDialog }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer() }));
vi.mock('@/i.js', async importOriginal => ({
	...await importOriginal<typeof import('@/i.js')>(),
	$i: { token: 'test-token', policies: { maxFileSizeMb: 30 } },
}));
vi.mock('@/instance.js', async importOriginal => {
	const original = await importOriginal<typeof import('@/instance.js')>();
	return { ...original, instance: { ...original.instance, maxFileSize: 262_144_000 } };
});

import { i18n } from '@/i18n.js';
import { prefer as mockedPrefer } from '@/preferences.js';
import { activeAudioDeviceId, attachScreenShare, joinVoiceCall, leaveVoiceCall, migrateParticipantVolumes, participantVolume, resumeAudio, restartMicrophone, selectAudioDevice, setDeafened, setMicEnabled, setParticipantVolume, setRecordingAllowed, startRecording, stopRecording, startScreenShare, stopScreenShare, toggleScreenShareWatch, unwatchScreenShare, voiceCall, watchScreenShare } from '@/utility/voice-call.js';

const prefer = mockedPrefer as unknown as FakePrefer;
const room1 = { id: 'r1', name: 'room 1' } as any;
const room2 = { id: 'r2', name: 'room 2' } as any;
const room3 = { id: 'r3', name: 'room 3' } as any;
const lastRoom = () => lk.FakeRoom.instances[lk.FakeRoom.instances.length - 1];

function remoteParticipant(identity: string) {
	const participant = new lk.FakeRemoteParticipant(identity);
	lastRoom().remoteParticipants.set(identity, participant);
	return participant;
}

beforeEach(() => {
	lk.FakeRoom.instances.length = 0;
	lk.analyser.analyser.getFloatTimeDomainData.mockImplementation((data: Float32Array) => data.fill(0));
	lk.analyser.analyser.context.state = 'running';
	lk.analyser.cleanup.mockClear();
	lk.createAudioAnalyser.mockClear();
	lk.FakeRoom.setup = null;
	mocks.misskeyApi.mockReset().mockResolvedValue({ url: 'https://local.test/livekit', token: 't' });
	mocks.toast.mockReset();
	mocks.alert.mockReset();
	mocks.confirm.mockReset().mockResolvedValue({ canceled: false });
	prefer.reset({
		'voiceCall.inputDeviceId': null,
		'voiceCall.outputDeviceId': null,
		'voiceCall.echoCancellation': true,
		'voiceCall.noiseSuppression': true,
		'voiceCall.autoGainControl': true,
		'voiceCall.micEnabled': true,
		'voiceCall.participantVolumes': {},
		'voiceCall.screenShareVolumes': {},
		'voiceCall.screenShareVolumesMigrated': false,
		'voiceCall.screenShareQuality': 'sharp',
		'voiceCall.screenShareAudio': true,
	});
});

afterEach(async () => {
	await leaveVoiceCall();
});

describe('TURN credential refresh', () => {
	const oldIce = [{ urls: ['turn:turn.example:3478'], username: 'old', credential: 'old' }];
	const freshIce = [{ urls: ['turn:turn.example:3478'], username: 'new', credential: 'new' }];
	const credentials = (iceServers: typeof oldIce, token = 't') => ({ url: 'https://local.test/livekit', token, iceServers });
	beforeEach(() => vi.useFakeTimers());
	afterEach(async () => { await leaveVoiceCall(); vi.useRealTimers(); });

	test('refreshes before expiry without interrupting the call or weakening relay policy', async () => {
		let joins = 0;
		mocks.misskeyApi.mockImplementation(async endpoint => endpoint === 'chat/rooms/voice/join' ? (joins++ === 0 ? credentials(oldIce, 'initial') : credentials(freshIce, 'renewed')) : {});
		await joinVoiceCall(room1, { micEnabled: false }); const room = lastRoom();
		room.engine.reconnect.mockImplementation(() => { expect(room.engine.token).toBe('renewed'); });
		await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
		expect(joins).toBe(2); expect(voiceCall.status).toBe('connected'); expect(room.disconnect).not.toHaveBeenCalled();
		expect(room.engine.rtcConfig.iceServers).toEqual(freshIce);
		expect(room.engine.reconnect).toHaveBeenCalledOnce();
		expect(room.publisher.setConfiguration).toHaveBeenCalledWith(expect.objectContaining({ iceServers: freshIce, iceTransportPolicy: 'relay', bundlePolicy: 'max-bundle' }));
		expect(room.subscriber.setConfiguration).toHaveBeenCalledWith(expect.objectContaining({ iceServers: freshIce, iceTransportPolicy: 'relay' }));
	});

	test('a reconnect event refreshes stale credentials without waiting for the periodic timer', async () => {
		let joins = 0;
		mocks.misskeyApi.mockImplementation(async endpoint => endpoint === 'chat/rooms/voice/join' ? credentials(joins++ === 0 ? oldIce : freshIce) : {});
		await joinVoiceCall(room1, { micEnabled: false }); const room = lastRoom();
		vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
		room.emit(lk.RoomEvent.Reconnecting);
		await vi.advanceTimersByTimeAsync(0);
		expect(joins).toBe(2); expect(room.engine.rtcConfig.iceServers).toEqual(freshIce); expect(voiceCall.status).toBe('reconnecting');
		expect(room.engine.pcManager.triggerIceRestart).toHaveBeenCalledOnce();
	});
	test('retries a failed ICE restart with the refreshed credentials', async () => {
		let joins = 0;
		mocks.misskeyApi.mockImplementation(async endpoint => endpoint === 'chat/rooms/voice/join' ? credentials(joins++ === 0 ? oldIce : freshIce) : {});
		await joinVoiceCall(room1, { micEnabled: false }); const room = lastRoom();
		room.engine.pcManager.triggerIceRestart.mockRejectedValueOnce(new Error('signaling not ready'));
		vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000); room.emit(lk.RoomEvent.Reconnecting);
		await vi.advanceTimersByTimeAsync(0); expect(room.engine.pcManager.triggerIceRestart).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60 * 1000);
		expect(room.engine.pcManager.triggerIceRestart).toHaveBeenCalledTimes(2); expect(room.disconnect).not.toHaveBeenCalled();
	});

	test('a failed refresh keeps the call and retries without discarding working credentials', async () => {
		let joins = 0;
		mocks.misskeyApi.mockImplementation(async endpoint => {
			if (endpoint !== 'chat/rooms/voice/join') return {};
			joins++; if (joins === 2) throw new Error('network'); return credentials(joins === 1 ? oldIce : freshIce);
		});
		await joinVoiceCall(room1, { micEnabled: false }); const room = lastRoom();
		await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
		expect(voiceCall.status).toBe('connected'); expect(room.engine.rtcConfig.iceServers).toEqual(oldIce); expect(room.disconnect).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60 * 1000);
		expect(joins).toBe(3); expect(room.engine.rtcConfig.iceServers).toEqual(freshIce);
	});

	test('does not reconnect or reconfigure when cached TURN credentials are unchanged', async () => {
		let joins = 0;
		mocks.misskeyApi.mockImplementation(async endpoint => endpoint === 'chat/rooms/voice/join' ? credentials(oldIce, joins++ === 0 ? 'initial' : 'renewed') : {});
		await joinVoiceCall(room1, { micEnabled: false }); const room = lastRoom();
		await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
		expect(joins).toBe(2); expect(room.engine.token).toBe('initial'); expect(room.publisher.setConfiguration).not.toHaveBeenCalled(); expect(room.engine.reconnect).not.toHaveBeenCalled(); expect(room.disconnect).not.toHaveBeenCalled();
	});
	test('a credential-driven LiveKit reconnect retains the room and follows reconnect events', async () => {
		let joins = 0;
		mocks.misskeyApi.mockImplementation(async endpoint => endpoint === 'chat/rooms/voice/join' ? credentials(joins++ === 0 ? oldIce : freshIce) : {});
		await joinVoiceCall(room1, { micEnabled: false }); const room = lastRoom();
		room.engine.reconnect.mockImplementation(() => room.emit(lk.RoomEvent.Reconnecting));
		await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
		expect(voiceCall.status).toBe('reconnecting'); expect(voiceCall.room?.id).toBe('r1');
		room.emit(lk.RoomEvent.Reconnected); expect(voiceCall.status).toBe('connected');
		expect(room.disconnect).not.toHaveBeenCalled();
	});

	test('does not silently apply credentials from a different media provider', async () => {
		let joins = 0;
		mocks.misskeyApi.mockImplementation(async endpoint => endpoint === 'chat/rooms/voice/join'
			? { ...credentials(joins++ === 0 ? oldIce : freshIce), mediaProvider: joins === 1 ? 'https://provider-one.test' : 'https://provider-two.test' } : {});
		await joinVoiceCall(room1, { micEnabled: false, approvedMediaProvider: 'https://provider-one.test' }); const room = lastRoom();
		await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
		expect(joins).toBe(2); expect(room.engine.rtcConfig.iceServers).toEqual(oldIce); expect(room.publisher.setConfiguration).not.toHaveBeenCalled(); expect(room.disconnect).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000); expect(joins).toBe(2);
	});

	test('a refresh response after leaving cannot modify the previous or next call', async () => {
		let joins = 0; let finish!: (value: ReturnType<typeof credentials>) => void;
		const pending = new Promise<ReturnType<typeof credentials>>(resolve => { finish = resolve; });
		mocks.misskeyApi.mockImplementation(async endpoint => {
			if (endpoint !== 'chat/rooms/voice/join') return {};
			joins++; return joins === 1 ? credentials(oldIce) : joins === 2 ? await pending : credentials(oldIce);
		});
		await joinVoiceCall(room1, { micEnabled: false }); const previous = lastRoom();
		await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); expect(joins).toBe(2);
		await leaveVoiceCall(); await joinVoiceCall(room2, { micEnabled: false }); const next = lastRoom();
		finish(credentials(freshIce)); await vi.advanceTimersByTimeAsync(0);
		expect(previous.publisher.setConfiguration).not.toHaveBeenCalled(); expect(next.publisher.setConfiguration).not.toHaveBeenCalled();
		expect(voiceCall.room?.id).toBe('r2'); expect(next.engine.rtcConfig.iceServers).toEqual(oldIce);
	});

	test('does not schedule credential refresh when the call has no TURN server', async () => {
		let joins = 0;
		mocks.misskeyApi.mockImplementation(async endpoint => endpoint === 'chat/rooms/voice/join' ? (joins++, { url: 'https://local.test/livekit', token: 't', iceServers: null }) : {});
		await joinVoiceCall(room1, { micEnabled: false }); await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
		expect(joins).toBe(1);
	});
	test('leaving cancels the scheduled refresh', async () => {
		let joins = 0;
		mocks.misskeyApi.mockImplementation(async endpoint => endpoint === 'chat/rooms/voice/join' ? (joins++, credentials(oldIce)) : {});
		await joinVoiceCall(room1, { micEnabled: false }); await leaveVoiceCall();
		await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000); expect(joins).toBe(1);
	});
});

describe('voice call controller', () => {
	test('joins with the microphone off without acquiring or publishing microphone audio', async () => {
		await joinVoiceCall(room1, { micEnabled: false });

		expect(lastRoom().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
		expect(voiceCall).toMatchObject({ status: 'connected', micEnabled: false, deafened: false });
		await setMicEnabled(true);
		expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.anything());
	});
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

	test('joining another room while the previous call is still disconnecting keeps the new call', async () => {
		await joinVoiceCall(room1);
		const first = lastRoom();
		let finishDisconnect!: () => void;
		first.disconnect.mockImplementationOnce(() => new Promise<void>(resolve => {
			finishDisconnect = resolve;
		}));

		const leaving = leaveVoiceCall();
		await joinVoiceCall(room2);
		finishDisconnect();
		await leaving;

		expect(voiceCall).toMatchObject({ status: 'connected', room: room2, micEnabled: true });
	});

	test('starting another join while the previous join is still disconnecting keeps the latest call', async () => {
		await joinVoiceCall(room1);
		const first = lastRoom();
		let finishDisconnect!: () => void;
		first.disconnect.mockImplementationOnce(() => new Promise<void>(resolve => {
			finishDisconnect = resolve;
		}));

		// room2 への参加は room1 の切断待ち。そのあいだに room3 へ参加する
		const joiningRoom2 = joinVoiceCall(room2);
		await joinVoiceCall(room3);
		const latest = lastRoom();
		finishDisconnect();
		await joiningRoom2;

		expect(voiceCall).toMatchObject({ status: 'connected', room: room3, micEnabled: true });
		// 古い参加が後から再開して room3 を追い出さないこと (room2 の Room も作られない)
		expect(lk.FakeRoom.instances).toHaveLength(2);
		expect(lk.FakeRoom.instances[1]).toBe(latest);
		expect(latest.disconnect).not.toHaveBeenCalled();
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

	// スピーカーを切ったままマイクだけ入れると、聞こえないまま話すことになる
	test('turning the mic on while deafened also turns the speakers back on', async () => {
		prefer.commit('voiceCall.participantVolumes', { a: 0.5 });
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		setDeafened(true);
		await Promise.resolve();
		expect(voiceCall).toMatchObject({ deafened: true, micEnabled: false });
		a.setVolume.mockClear();

		await setMicEnabled(true);

		expect(voiceCall).toMatchObject({ deafened: false, micEnabled: true });
		expect(a.setVolume).toHaveBeenCalledWith(0.5, lk.Track.Source.Microphone);
		expect(a.setVolume).not.toHaveBeenCalledWith(0, expect.anything());
	});

	// マイクを入れられなかったら、聞こえるようにだけなって話せない状態にはしない (スピーカーは切ったまま)
	test('keeps the speakers off when the mic cannot be turned on while deafened', async () => {
		await joinVoiceCall(room1);
		const a = remoteParticipant('a');
		setDeafened(true);
		await Promise.resolve();
		a.setVolume.mockClear();
		lastRoom().localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error('NotAllowedError'));

		await setMicEnabled(true);

		expect(voiceCall).toMatchObject({ deafened: true, micEnabled: false });
		expect(a.setVolume).not.toHaveBeenCalledWith(1, lk.Track.Source.Microphone);
	});

	// 許可を待つあいだにスピーカーを切り替えたら、その選択を優先する (マイクが入ってもスピーカーを勝手に戻さない)
	test('does not undeafen when the speakers were toggled while the mic waited for permission', async () => {
		await joinVoiceCall(room1);
		setDeafened(true);
		await Promise.resolve();
		let grant!: () => void;
		lastRoom().localParticipant.setMicrophoneEnabled.mockImplementationOnce(() => new Promise<void>(resolve => { grant = resolve; }));
		const enabling = setMicEnabled(true);
		setDeafened(false);
		setDeafened(true);
		grant();
		await enabling;
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(voiceCall).toMatchObject({ deafened: true, micEnabled: false });
	});

	test('deafening while the mic waits for permission leaves the mic off once it is granted', async () => {
		let grant!: () => void;
		lk.FakeRoom.setup = room => room.localParticipant.setMicrophoneEnabled.mockImplementationOnce(() => new Promise<void>(resolve => { grant = resolve; }));
		const joined = joinVoiceCall(room1);
		await vi.waitFor(() => expect(grant).toBeTypeOf('function'));

		setDeafened(true);
		grant();
		await joined;
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false, expect.anything());
		expect(voiceCall).toMatchObject({ deafened: true, micEnabled: false });
		expect(mocks.misskeyApi).toHaveBeenLastCalledWith('chat/rooms/voice/status', expect.objectContaining({ micMuted: true, deafened: true }));
	});

	test('deafening while connecting joins without turning the mic on', async () => {
		let connected!: () => void;
		lk.FakeRoom.setup = room => room.connect.mockImplementationOnce(() => new Promise<void>(resolve => { connected = resolve; }));
		const joined = joinVoiceCall(room1);
		await vi.waitFor(() => expect(connected).toBeTypeOf('function'));

		setDeafened(true);
		connected();
		await joined;

		expect(lastRoom().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
		expect(voiceCall).toMatchObject({ status: 'connected', deafened: true, micEnabled: false });
	});

	// 自分で選んだマイクの入/切だけを次の参加に引き継ぐ。スピーカーを切ったときに一緒に切れたマイクは、選んだものではない
	test('remembers only the mic choices I make for the next call', async () => {
		await joinVoiceCall(room1);
		await setMicEnabled(false);
		expect(prefer.commit).toHaveBeenLastCalledWith('voiceCall.micEnabled', false);
		await setMicEnabled(true);
		expect(prefer.commit).toHaveBeenLastCalledWith('voiceCall.micEnabled', true);

		prefer.commit.mockClear();
		setDeafened(true);
		await Promise.resolve();
		setDeafened(false);
		expect(prefer.commit).not.toHaveBeenCalledWith('voiceCall.micEnabled', expect.anything());

		await leaveVoiceCall();
		prefer.commit('voiceCall.micEnabled', false);
		await joinVoiceCall(room1);
		expect(lastRoom().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
		expect(voiceCall).toMatchObject({ status: 'connected', micEnabled: false });
	});

	test('reports mute and deafen settings without sharing personal volume changes', async () => {
		await joinVoiceCall(room1);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/status', {
			roomId: 'r1', sessionId: 'PA_local', micMuted: false, deafened: false,
		});
		await setMicEnabled(false);
		setDeafened(true);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(mocks.misskeyApi).toHaveBeenLastCalledWith('chat/rooms/voice/status', expect.objectContaining({ micMuted: true, deafened: true }));
		mocks.misskeyApi.mockClear();
		setParticipantVolume('someone', 'voice', 0);
		expect(mocks.misskeyApi).not.toHaveBeenCalled();
	});

	// スピーカーを切るときにマイクも切るが、マイクを切り終える前に知らせると「スピーカーだけ切ってマイクは入ったまま」の状態が一瞬伝わり、知らせも二度になる
	test('deafening with the microphone on reports the settings once, after the microphone is off', async () => {
		await joinVoiceCall(room1);
		await new Promise(resolve => setTimeout(resolve, 0));
		mocks.misskeyApi.mockClear();

		setDeafened(true);
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(mocks.misskeyApi.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/voice/status')).toEqual([
			['chat/rooms/voice/status', { roomId: 'r1', sessionId: 'PA_local', micMuted: true, deafened: true }],
		]);
	});

	describe('status delivery', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(async () => {
			await leaveVoiceCall();
			vi.useRealTimers();
		});
		const reports = () => mocks.misskeyApi.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/voice/status');

		async function joinMuted() {
			await joinVoiceCall(room1, { micEnabled: false });
			await vi.advanceTimersByTimeAsync(0);
			mocks.misskeyApi.mockClear();
		}

		test.each([new TypeError('Failed to fetch'), { code: 'INTERNAL_ERROR' }, { code: 'REMOTE_HOST_UNREACHABLE' }])('delivers the latest settings after a transient failure: %j', async error => {
			await joinMuted();
			mocks.misskeyApi.mockRejectedValueOnce(error);
			setDeafened(true);
			await vi.advanceTimersByTimeAsync(0);
			setDeafened(false);
			await vi.advanceTimersByTimeAsync(999);
			expect(reports()).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(reports()).toHaveLength(2);
			expect(reports()[1][1]).toMatchObject({ micMuted: true, deafened: false });
		});

		test('waits out rate limiting before sending the newest settings', async () => {
			await joinMuted();
			mocks.misskeyApi.mockRejectedValueOnce({ code: 'RATE_LIMIT_EXCEEDED' });
			setDeafened(true);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(59_999);
			expect(reports()).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(reports()).toHaveLength(2);
		});

		test('backs off repeated failures and resumes with the newest settings', async () => {
			await joinMuted();
			mocks.misskeyApi.mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(new TypeError('offline'));
			setDeafened(true);
			await vi.advanceTimersByTimeAsync(1000);
			expect(reports()).toHaveLength(2);
			setDeafened(false);
			await vi.advanceTimersByTimeAsync(1999);
			expect(reports()).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(reports()).toHaveLength(3);
			expect(reports()[2][1]).toMatchObject({ deafened: false });
		});

		test('keeps only the newest update while a report is in flight', async () => {
			await joinMuted();
			let finish!: () => void;
			mocks.misskeyApi.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
			setDeafened(true);
			setDeafened(false);
			setDeafened(true);
			setDeafened(false);
			expect(reports()).toHaveLength(1);
			finish();
			await vi.advanceTimersByTimeAsync(0);
			expect(reports()).toHaveLength(2);
			expect(reports()[1][1]).toMatchObject({ deafened: false });
		});

		test('serializes reconnect reports behind an in-flight request in the same session', async () => {
			await joinMuted();
			let finish!: () => void;
			mocks.misskeyApi.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
			setDeafened(true);
			setDeafened(false);
			lastRoom().emit(lk.RoomEvent.Reconnected);
			await vi.advanceTimersByTimeAsync(0);
			expect(reports()).toHaveLength(1);
			finish();
			await vi.advanceTimersByTimeAsync(0);
			expect(reports()).toHaveLength(2);
			expect(reports()[1][1]).toMatchObject({ deafened: false });
		});

		test('an old in-flight failure cannot schedule a retry in a new call', async () => {
			await joinMuted();
			let fail!: (error: unknown) => void;
			mocks.misskeyApi.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
			setDeafened(true);
			await leaveVoiceCall();
			await joinVoiceCall(room2, { micEnabled: false });
			fail(new TypeError('offline'));
			await vi.advanceTimersByTimeAsync(120_000);
			expect(reports().map(([, status]) => status.roomId)).toEqual(['r1', 'r2']);
		});

		test.each(['ACCESS_DENIED', 'REMOTE_HOST_UNSUPPORTED', 'UNKNOWN_API_ENDPOINT'])('does not retry a permanent API error: %s', async code => {
			await joinMuted();
			mocks.misskeyApi.mockRejectedValueOnce({ code });
			setDeafened(true);
			await vi.advanceTimersByTimeAsync(120_000);
			expect(reports()).toHaveLength(1);
		});

		// セッションを確かめる一時的な失敗も ACCESS_DENIED になる。一度の失敗で、その後の切り替えまで送らなくなってはいけない
		test('tries once more when the settings change after a permanent API error', async () => {
			await joinMuted();
			mocks.misskeyApi.mockRejectedValueOnce({ code: 'ACCESS_DENIED' }).mockRejectedValueOnce({ code: 'ACCESS_DENIED' });
			setDeafened(true);
			await vi.advanceTimersByTimeAsync(0);
			setDeafened(false);
			await vi.advanceTimersByTimeAsync(120_000);
			expect(reports()).toHaveLength(2);
			expect(reports()[1][1]).toMatchObject({ deafened: false });
			setDeafened(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(reports()).toHaveLength(3);
		});

		test('still sends settings changed while a report was in flight when that report fails permanently', async () => {
			await joinMuted();
			let fail!: (error: unknown) => void;
			mocks.misskeyApi.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
			setDeafened(true);
			setDeafened(false);
			expect(reports()).toHaveLength(1);
			fail({ code: 'ACCESS_DENIED' });
			await vi.advanceTimersByTimeAsync(0);
			expect(reports()).toHaveLength(2);
			expect(reports()[1][1]).toMatchObject({ deafened: false });
			await vi.advanceTimersByTimeAsync(120_000);
			expect(reports()).toHaveLength(2);
		});

		test('cancels retries when leaving and does not send an old session into the next call', async () => {
			await joinMuted();
			mocks.misskeyApi.mockRejectedValueOnce(new TypeError('Failed to fetch'));
			setDeafened(true);
			await vi.advanceTimersByTimeAsync(0);
			await leaveVoiceCall();
			await joinVoiceCall(room2, { micEnabled: false });
			await vi.advanceTimersByTimeAsync(120_000);
			expect(reports().map(([, status]) => status.roomId)).toEqual(['r1', 'r2']);
		});

		test('coalesces the SDK mute event and the UI mute operation into one report', async () => {
			await joinVoiceCall(room1);
			await vi.advanceTimersByTimeAsync(0);
			mocks.misskeyApi.mockClear();
			lastRoom().localParticipant.setMicrophoneEnabled.mockImplementationOnce(async () => {
				lastRoom().emit(lk.RoomEvent.TrackMuted, { source: lk.Track.Source.Microphone }, lastRoom().localParticipant);
			});
			await setMicEnabled(false);
			await vi.advanceTimersByTimeAsync(0);
			expect(reports()).toHaveLength(1);
			expect(reports()[0][1]).toMatchObject({ micMuted: true, deafened: false });
		});
	});

	// livekit-client は入力装置が抜けたり既定の装置が変わったりするとマイクのトラックを自分で作り直す。測る相手もその新しいトラックに付け替える
	test('re-binds the local meter when livekit restarts the microphone track by itself', async () => {
		await joinVoiceCall(room1);
		expect(lk.createAudioAnalyser).toHaveBeenCalledTimes(1);

		lastRoom().localParticipant.microphoneTrack.emit(lk.TrackEvent.Restarted);

		expect(lk.analyser.cleanup).toHaveBeenCalledTimes(1);
		expect(lk.createAudioAnalyser).toHaveBeenCalledTimes(2);
	});

	// トラックが終わっているあいだは測れないので、サーバーの知らせに従う。作り直されたらまた手元で測る
	test('follows the server about my speaking while the microphone track has ended, and meters again once it restarts', async () => {
		vi.useFakeTimers();
		try {
			await joinVoiceCall(room1);
			const identity = lastRoom().localParticipant.identity;
			const track = lastRoom().localParticipant.microphoneTrack;

			track.emit(lk.TrackEvent.Ended);
			lastRoom().emit(lk.RoomEvent.ActiveSpeakersChanged, [{ identity }]);
			expect(voiceCall.localSpeaking).toBe(true);

			track.emit(lk.TrackEvent.Restarted);
			await vi.advanceTimersByTimeAsync(50);
			expect(voiceCall.localSpeaking).toBe(false);
			lastRoom().emit(lk.RoomEvent.ActiveSpeakersChanged, [{ identity }]);
			expect(voiceCall.localSpeaking).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	// 手元でマイクの音を測れない (AudioContext が無いなど) ときは、サーバーの知らせで自分の発話を示す
	test('lights the local speaker from the server when the microphone cannot be metered', async () => {
		lk.createAudioAnalyser.mockImplementationOnce(() => { throw new Error('no AudioContext'); });
		await joinVoiceCall(room1);
		const identity = lastRoom().localParticipant.identity;

		lastRoom().emit(lk.RoomEvent.ActiveSpeakersChanged, [{ identity }, { identity: 'remote' }]);
		expect(voiceCall.speakingIdentities).toEqual(['remote', identity]);
		expect(voiceCall.localSpeaking).toBe(true);

		lastRoom().emit(lk.RoomEvent.ActiveSpeakersChanged, [{ identity: 'remote' }]);
		expect(voiceCall.speakingIdentities).toEqual(['remote']);
		expect(voiceCall.localSpeaking).toBe(false);
	});

	// 自動再生の制限で AudioContext が止まっていると無音しか返らない。そのあいだはサーバーの知らせに従う
	test('lights the local speaker from the server while the meter audio context is suspended', async () => {
		vi.useFakeTimers();
		try {
			lk.analyser.analyser.context.state = 'suspended';
			await joinVoiceCall(room1);
			const identity = lastRoom().localParticipant.identity;
			lastRoom().emit(lk.RoomEvent.ActiveSpeakersChanged, [{ identity }]);
			await vi.advanceTimersByTimeAsync(200);
			expect(voiceCall.localSpeaking).toBe(true);
			expect(voiceCall.speakingIdentities).toEqual([identity]);
		} finally {
			vi.useRealTimers();
		}
	});

	// 途中で失敗した createAudioAnalyser は AudioContext を閉じないので、同じトラックを切り替えのたびに測り直さない
	test('does not retry metering a microphone track that could not be metered', async () => {
		lk.createAudioAnalyser.mockImplementationOnce(() => { throw new Error('createMediaStreamSource failed'); });
		await joinVoiceCall(room1);
		await setMicEnabled(false);
		await setMicEnabled(true);
		expect(lk.createAudioAnalyser).toHaveBeenCalledTimes(1);
	});

	test('lights the local speaker from microphone samples and keeps remote server speakers', async () => {
		vi.useFakeTimers();
		try {
			await joinVoiceCall(room1);
			const identity = lastRoom().localParticipant.identity;
			lastRoom().emit(lk.RoomEvent.ActiveSpeakersChanged, [{ identity }, { identity: 'remote' }]);
			expect(voiceCall.speakingIdentities).toEqual(['remote']);
			lk.analyser.analyser.getFloatTimeDomainData.mockImplementation((data: Float32Array) => data.fill(0.1));
			await vi.advanceTimersByTimeAsync(50);
			expect(voiceCall.speakingIdentities).toContain(identity);
			expect(voiceCall.speakingIdentities).toContain('remote');
			lk.analyser.analyser.getFloatTimeDomainData.mockImplementation((data: Float32Array) => data.fill(0));
			await vi.advanceTimersByTimeAsync(250);
			expect(voiceCall.speakingIdentities).toEqual(['remote']);
			await setMicEnabled(false);
			expect(lk.analyser.cleanup).toHaveBeenCalled();
			await leaveVoiceCall();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
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

	test('migrates the legacy voice volume into screen share once', () => {
		prefer.commit('voiceCall.participantVolumes', { muted: 0, quiet: 0.25 });
		prefer.commit('voiceCall.screenShareVolumes', {});

		migrateParticipantVolumes();

		expect(prefer.s['voiceCall.screenShareVolumes']).toEqual({ muted: 0, quiet: 0.25 });
		expect(prefer.s['voiceCall.screenShareVolumesMigrated']).toBe(true);
		expect(participantVolume('muted', 'screenShare')).toBe(0);
		expect(participantVolume('quiet', 'screenShare')).toBe(0.25);

		setParticipantVolume('quiet', 'screenShare', 0.4);
		migrateParticipantVolumes();

		expect(participantVolume('quiet', 'screenShare')).toBe(0.4);
		expect(prefer.s['voiceCall.participantVolumes']).toEqual({ muted: 0, quiet: 0.25 });
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
	test('applies delegated limits when sharing the screen', async () => {
		const limits = { maxWidth: 1280, maxHeight: 720, maxFrameRate: 10, maxBitrate: 500000 };
		mocks.misskeyApi.mockResolvedValue({ url: 'https://local.test/livekit', token: 't', mediaProvider: 'https://relay.test', screenShareLimits: limits });
		await joinVoiceCall(room1, { approvedMediaProvider: 'https://relay.test' });

		await startScreenShare();

		const participant = lastRoom().localParticipant;
		expect(participant.createScreenTracks).toHaveBeenCalledWith(expect.objectContaining({ resolution: { width: 1280, height: 720, frameRate: 10 } }));
		expect(participant.screenVideo.mediaStreamTrack.applyConstraints).toHaveBeenCalledWith({ width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 10 } });
		expect(participant.publishTrack).toHaveBeenCalledWith(participant.screenVideo, expect.objectContaining({ screenShareEncoding: { maxBitrate: 500000, maxFramerate: 10 }, simulcast: false, backupCodec: false, videoCodec: 'vp8' }));
	});

	test('keeps the existing screen share options when a relay has no policy', async () => {
		mocks.misskeyApi.mockResolvedValue({ url: 'https://local.test/livekit', token: 't', mediaProvider: 'https://relay.test' });
		await joinVoiceCall(room1, { approvedMediaProvider: 'https://relay.test' });

		await startScreenShare();

		expect(lastRoom().localParticipant.createScreenTracks).not.toHaveBeenCalled();
		expect(lastRoom().localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(true,
			expect.objectContaining({ resolution: lk.ScreenSharePresets.h1080fps15.resolution }),
			expect.objectContaining({ screenShareEncoding: lk.ScreenSharePresets.h1080fps15.encoding }));
	});

	test('accepts a relay policy above 1080p60 while retaining the selected preset', async () => {
		const limits = { maxWidth: 3840, maxHeight: 2160, maxFrameRate: 120, maxBitrate: 16000000 };
		mocks.misskeyApi.mockResolvedValue({ url: 'https://local.test/livekit', token: 't', mediaProvider: 'https://relay.test', screenShareLimits: limits });
		await joinVoiceCall(room1, { approvedMediaProvider: 'https://relay.test' });

		await startScreenShare();

		const participant = lastRoom().localParticipant;
		expect(participant.screenVideo.mediaStreamTrack.applyConstraints).toHaveBeenCalledWith({ width: { max: 3840 }, height: { max: 2160 }, frameRate: { max: 120 } });
		expect(participant.publishTrack).toHaveBeenCalledWith(participant.screenVideo, expect.objectContaining({ screenShareEncoding: lk.ScreenSharePresets.h1080fps15.encoding, simulcast: false, backupCodec: false }));
	});

	test('keeps delegated limits after stopping, reconnecting, and sharing again', async () => {
		const limits = { maxWidth: 1280, maxHeight: 720, maxFrameRate: 10, maxBitrate: 500000 };
		mocks.misskeyApi.mockResolvedValue({ url: 'https://local.test/livekit', token: 't', mediaProvider: 'https://relay.test', screenShareLimits: limits });
		await joinVoiceCall(room1, { approvedMediaProvider: 'https://relay.test' });
		const room = lastRoom();

		await startScreenShare();
		await stopScreenShare();
		room.emit(lk.RoomEvent.Reconnecting);
		room.emit(lk.RoomEvent.Reconnected);
		await startScreenShare();

		expect(room.localParticipant.screenVideo.mediaStreamTrack.applyConstraints).toHaveBeenCalledTimes(2);
		expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);
		expect(room.localParticipant.publishTrack).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ simulcast: false, backupCodec: false, screenShareEncoding: { maxBitrate: 500000, maxFramerate: 10 } }));
	});

	test('does not publish a capture that fails to meet delegated limits', async () => {
		const limits = { maxWidth: 1280, maxHeight: 720, maxFrameRate: 10, maxBitrate: 500000 };
		mocks.misskeyApi.mockResolvedValue({ url: 'https://local.test/livekit', token: 't', mediaProvider: 'https://relay.test', screenShareLimits: limits });
		await joinVoiceCall(room1, { approvedMediaProvider: 'https://relay.test' });
		const participant = lastRoom().localParticipant;
		participant.screenVideo.mediaStreamTrack.getSettings.mockReturnValue({ width: 1920, height: 1080, frameRate: 30 });

		await startScreenShare();

		expect(participant.publishTrack).not.toHaveBeenCalled();
		expect(participant.screenVideo.stop).toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.screenShareFailed);
	});

	test('reports screen capture permission denial on the delegated path', async () => {
		mocks.misskeyApi.mockResolvedValue({ url: 'https://local.test/livekit', token: 't', mediaProvider: 'https://relay.test', screenShareLimits: { maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrate: 8000000 } });
		await joinVoiceCall(room1, { approvedMediaProvider: 'https://relay.test' });
		const participant = lastRoom().localParticipant;
		participant.createScreenTracks.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));

		await startScreenShare();

		expect(participant.publishTrack).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.screenSharePermissionDenied);
	});

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
		vi.useFakeTimers();
		try {
			// 共有する画面を選ぶ画面が出てから、人がやめるまでには時間がかかる
			lk.FakeRoom.setup = room => room.localParticipant.setScreenShareEnabled.mockImplementation(() => new Promise((_, reject) => { setTimeout(() => reject(new DOMException('cancelled', 'NotAllowedError')), 2000); }));
			await joinVoiceCall(room1);

			const sharing = startScreenShare();
			await vi.advanceTimersByTimeAsync(2000);
			await sharing;

			expect(voiceCall.screenSharing).toBe(false);
			expect(mocks.alert).not.toHaveBeenCalled();
			expect(mocks.toast).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// 画面を選ぶ前にブラウザや OS が拒んだ (すぐに NotAllowedError が返る) ときは、選択をやめたのとは違うので理由を知らせる
	test('explains a screen share the browser refuses outright, instead of staying silent as for a cancelled picker', async () => {
		lk.FakeRoom.setup = room => room.localParticipant.setScreenShareEnabled.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
		await joinVoiceCall(room1);

		await startScreenShare();

		expect(voiceCall.screenSharing).toBe(false);
		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.screenSharePermissionDenied);
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

 test('declining the delegated media provider prevents any media connection', async () => {
  mocks.misskeyApi.mockResolvedValue({ url: 'https://local.test/livekit', token: 't', mediaProvider: 'https://delegated.test' });
  mocks.confirm.mockResolvedValue({ canceled: true });
  await joinVoiceCall(room1);
  expect(lk.FakeRoom.instances).toHaveLength(0);
  expect(voiceCall.status).toBe('idle');
 });

 test.each([
  ['VOICE_RELAY_CAPACITY_EXCEEDED', 'full'], ['VOICE_RELAY_UNREACHABLE', 'unreachable'], ['VOICE_RELAY_REVOKED', 'revoked'],
 ] as const)('shows a specific delegated failure: %s', async (code, message) => {
  mocks.misskeyApi.mockRejectedValue({ code }); await joinVoiceCall(room1); expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceRelay[message]);
 });

// 이 시험은 실제 통화/녹화 수명 코드를 실행하고 브라우저와 미디어 장치 경계만 대체한다.
describe('call recording lifecycle', () => {
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>(done => { resolve = done; });
		return { promise, resolve };
	}

	class RecordingStream {
		constructor(private tracks: { kind: string; enabled: boolean; stop: () => void }[] = []) {}
		getTracks() { return this.tracks; }
		getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
		getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
	}

	class RecordingContext {
		static instances: RecordingContext[] = [];
		static resume = () => Promise.resolve();
		state = 'running';
		close = vi.fn(async () => { this.state = 'closed'; });
		resume = () => RecordingContext.resume();
		createMediaStreamDestination = () => ({ stream: new RecordingStream(), channelCount: 2, channelCountMode: 'explicit' });
		createGain = () => ({ connect: vi.fn(), gain: { value: 1 } });
		createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
		constructor() { RecordingContext.instances.push(this); }
	}

	class Recorder {
		static instances: Recorder[] = [];
		static isTypeSupported = () => true;
		static failStartAt: number | null = null;
		state = 'inactive';
		mimeType = 'audio/webm';
		onstop: (() => void) | null = null;
		ondataavailable: ((event: { data: Blob }) => void) | null = null;
		constructor(_stream: unknown, _options: unknown) { Recorder.instances.push(this); }
		start() {
			if (Recorder.instances.length === Recorder.failStartAt) throw new Error('recorder unavailable');
			this.state = 'recording';
		}
		requestData() { if (this.state === 'inactive') throw new DOMException('inactive', 'InvalidStateError'); }
		stop() {
			if (this.state === 'inactive') throw new DOMException('inactive', 'InvalidStateError');
			this.state = 'inactive';
			queueMicrotask(() => {
				this.ondataavailable?.({ data: new Blob(['last chunk'], { type: this.mimeType }) });
				this.onstop?.();
			});
		}
	}

	let rawTrack: { kind: string; enabled: boolean; stop: ReturnType<typeof vi.fn<() => void>> };
	let raw: RecordingStream;
	let getUserMedia: ReturnType<typeof vi.fn>;

	async function flushRecording() {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	}

	async function joinRecordingCall(micEnabled = true) {
		await joinVoiceCall({ ...room1, allowRecording: true }, { micEnabled });
		// 화면 공유가 없는 통화의 실제 publication 분기를 따른다.
		lastRoom().localParticipant.getTrackPublication.mockImplementation((source?: string) => source === lk.Track.Source.Microphone
			? { track: lastRoom().localParticipant.microphoneTrack }
			: undefined as any);
		await flushRecording();
	}

	beforeEach(() => {
		RecordingContext.instances = [];
		RecordingContext.resume = () => Promise.resolve();
		Recorder.instances = [];
		Recorder.failStartAt = null;
		rawTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
		raw = new RecordingStream([rawTrack]);
		getUserMedia = vi.fn().mockResolvedValue(raw);
		vi.stubGlobal('MediaStream', RecordingStream);
		vi.stubGlobal('MediaRecorder', Recorder);
		vi.stubGlobal('AudioContext', RecordingContext);
		Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
		vi.spyOn(window, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ id: 'recording-file' }) } as Response);
		mocks.misskeyApi.mockImplementation(async endpoint => endpoint === 'chat/rooms/voice/join' ? { url: 'https://local.test/livekit', token: 't' } : {});
		mocks.actions.mockReset().mockResolvedValue({ canceled: false, result: 'retry' });
	});

	afterEach(async () => {
		await leaveVoiceCall();
		await flushRecording();
		vi.restoreAllMocks();
	});

	test('exposes a cancelable pending state through server approval and device acquisition', async () => {
		await joinRecordingCall();
		const media = deferred<RecordingStream>();
		getUserMedia.mockReturnValueOnce(media.promise);
		const starting = startRecording();
		await flushRecording();

		expect(voiceCall.recordingStarting).toBe(true);
		stopRecording();
		expect(voiceCall.recordingStarting).toBe(false);
		media.resolve(raw);
		await starting;
		expect(voiceCall.recordingStarting).toBe(false);
	});

	test.each(['stop', 'revoke', 'leave', 'switch'] as const)('cancels a pending server approval on %s', async action => {
		await joinRecordingCall();
		const approval = deferred<unknown>();
		mocks.misskeyApi.mockReturnValueOnce(approval.promise);
		const starting = startRecording();

		if (action === 'stop') stopRecording();
		if (action === 'revoke') setRecordingAllowed('r1', false);
		if (action === 'leave') await leaveVoiceCall();
		if (action === 'switch') await joinVoiceCall({ ...room2, allowRecording: true }, { micEnabled: false });
		approval.resolve({});
		await starting;

		expect(voiceCall.recording).toBe(false);
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(RecordingContext.instances.every(context => context.state === 'closed')).toBe(true);
	});

	test.each(['stop', 'revoke', 'leave', 'switch'] as const)('closes a pending AudioContext on %s without reviving the recording', async action => {
		await joinRecordingCall();
		const resume = deferred<void>();
		RecordingContext.resume = () => resume.promise;
		const starting = startRecording();
		await flushRecording();

		if (action === 'stop') stopRecording();
		if (action === 'revoke') setRecordingAllowed('r1', false);
		if (action === 'leave') await leaveVoiceCall();
		if (action === 'switch') await joinVoiceCall({ ...room2, allowRecording: true }, { micEnabled: false });
		resume.resolve();
		await starting;

		expect(voiceCall.recording).toBe(false);
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(RecordingContext.instances.every(context => context.state === 'closed')).toBe(true);
	});

	test.each(['stop', 'revoke', 'leave', 'switch'] as const)('stops a microphone acquired after %s without reviving the recording', async action => {
		await joinRecordingCall();
		const media = deferred<RecordingStream>();
		getUserMedia.mockReturnValueOnce(media.promise);
		const starting = startRecording();
		await flushRecording();
		expect(getUserMedia).toHaveBeenCalledOnce();

		if (action === 'stop') stopRecording();
		if (action === 'revoke') setRecordingAllowed('r1', false);
		if (action === 'leave') await leaveVoiceCall();
		if (action === 'switch') await joinVoiceCall({ ...room2, allowRecording: true }, { micEnabled: false });
		await flushRecording();
		media.resolve(raw);
		await starting;

		expect(voiceCall.recording).toBe(false);
		expect(rawTrack.stop).toHaveBeenCalledOnce();
		expect(RecordingContext.instances.every(context => context.state === 'closed')).toBe(true);
	});

	test('cancels recording setup as soon as a room switch starts, even if disconnect is pending', async () => {
		await joinRecordingCall();
		const resumed = deferred<void>();
		const disconnected = deferred<void>();
		RecordingContext.resume = () => resumed.promise;
		const starting = startRecording();
		await flushRecording();
		lastRoom().disconnect.mockImplementationOnce(() => disconnected.promise);

		const switching = joinVoiceCall({ ...room2, allowRecording: true }, { micEnabled: false });
		await flushRecording();
		const closedBeforeDisconnect = RecordingContext.instances.every(context => context.state === 'closed');
		disconnected.resolve();
		resumed.resolve();
		await Promise.all([starting, switching]);

		expect(closedBeforeDisconnect).toBe(true);
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(voiceCall.room?.id).toBe('r2');
	});

	test('a second start cannot overtake device acquisition', async () => {
		await joinRecordingCall();
		const media = deferred<RecordingStream>();
		getUserMedia.mockReturnValueOnce(media.promise);
		const starting = startRecording();
		await flushRecording();

		await startRecording();
		media.resolve(raw);
		await starting;

		expect(getUserMedia).toHaveBeenCalledOnce();
		expect(voiceCall.recording).toBe(true);
	});

	test('stop is idempotent while final recorder events are queued and uploads both final chunks', async () => {
		await joinRecordingCall();
		await startRecording();

		stopRecording();
		expect(() => stopRecording()).not.toThrow();
		await leaveVoiceCall();
		await flushRecording();

		expect(voiceCall.status).toBe('idle');
		expect(rawTrack.stop).toHaveBeenCalledOnce();
		expect(window.fetch).toHaveBeenCalledTimes(2);
		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.recordingSaved);
	});

	test.each(['deafen', 'forced mute', 'restart', 'failed enable'] as const)('silences the raw recording microphone on %s', async action => {
		await joinRecordingCall();
		await startRecording();
		expect(rawTrack.enabled).toBe(true);

		if (action === 'deafen') setDeafened(true);
		if (action === 'forced mute') lastRoom().emit(lk.RoomEvent.TrackMuted, { source: lk.Track.Source.Microphone }, lastRoom().localParticipant);
		if (action === 'restart') {
			const enable = deferred<void>();
			lastRoom().localParticipant.setMicrophoneEnabled.mockImplementationOnce(async () => {}).mockImplementationOnce(() => enable.promise);
			const restarting = restartMicrophone();
			await flushRecording();
			expect(rawTrack.enabled).toBe(false);
			enable.resolve();
			await restarting;
			expect(rawTrack.enabled).toBe(true);
			return;
		}
		if (action === 'failed enable') {
			await setMicEnabled(false);
			lastRoom().localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error('device unavailable'));
			await setMicEnabled(true);
		}
		await flushRecording();

		expect(voiceCall.micEnabled).toBe(false);
		expect(rawTrack.enabled).toBe(false);
	});

	test('replaces the raw input when the call switches microphones', async () => {
		await joinRecordingCall();
		await startRecording();
		const switchedTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
		getUserMedia.mockResolvedValueOnce(new RecordingStream([switchedTrack]));

		await selectAudioDevice('audioinput', 'second-input');

		expect(rawTrack.stop).toHaveBeenCalledOnce();
		expect(getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: 'second-input' }) });
		expect(switchedTrack.enabled).toBe(true);
	});

	test('stops an input acquired after a device switch was canceled by stopping the recording', async () => {
		await joinRecordingCall();
		await startRecording();
		const switchedTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
		const media = deferred<RecordingStream>();
		getUserMedia.mockReturnValueOnce(media.promise);
		const switching = selectAudioDevice('audioinput', 'second-input');
		await flushRecording();

		stopRecording();
		media.resolve(new RecordingStream([switchedTrack]));
		await switching;

		expect(switchedTrack.stop).toHaveBeenCalledOnce();
		expect(voiceCall.recording).toBe(false);
	});

	test('does not mix the processed call microphone on top of the raw input when LiveKit republishes it', async () => {
		await joinRecordingCall();
		await startRecording();
		const room = lastRoom();
		const context = RecordingContext.instances[0];
		expect(context.createMediaStreamSource).toHaveBeenCalledOnce();

		room.emit(lk.RoomEvent.LocalTrackPublished, { source: lk.Track.Source.Microphone, track: room.localParticipant.microphoneTrack }, room.localParticipant);

		expect(context.createMediaStreamSource).toHaveBeenCalledOnce();
	});

	test('closes the recording context when starting the second recorder fails', async () => {
		await joinRecordingCall();
		Recorder.failStartAt = 2;

		await startRecording();
		await flushRecording();

		expect(voiceCall.recording).toBe(false);
		expect(RecordingContext.instances.every(context => context.state === 'closed')).toBe(true);
	});

	test('records the selected microphone instead of reopening the system default', async () => {
		prefer.commit('voiceCall.inputDeviceId', 'selected-input');
		await joinRecordingCall();

		await startRecording();

		expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ deviceId: 'selected-input' }) });
	});

	test('uses one recording ID for the approval and the rollback when device setup fails', async () => {
		await joinRecordingCall();
		RecordingContext.resume = () => Promise.reject(new Error('audio context failed'));

		await startRecording();
		await flushRecording();

		const reports = mocks.misskeyApi.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/voice/status').map(([, report]) => report);
		const approval = reports.find(report => report.recording === true);
		expect(approval.recordingId).toMatch(/^[0-9a-f-]{36}$/);
		expect(reports.some(report => report.recording !== true && report.recordingId === approval.recordingId)).toBe(true);
		expect(voiceCall.recording).toBe(false);
	});

	test('preserves both failed final chunks and reports success only after their retries finish after leaving', async () => {
		await joinRecordingCall();
		await startRecording();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const firstRetry = deferred<Response>();
		const secondRetry = deferred<Response>();
		vi.mocked(window.fetch).mockReset()
			.mockRejectedValueOnce(new Error('upload unavailable'))
			.mockRejectedValueOnce(new Error('upload unavailable'))
			.mockReturnValueOnce(firstRetry.promise)
			.mockReturnValueOnce(secondRetry.promise);

		await leaveVoiceCall();
		await flushRecording();

		expect(voiceCall.status).toBe('idle');
		expect(window.fetch).toHaveBeenCalledTimes(4);
		expect(mocks.actions).toHaveBeenCalledWith(expect.objectContaining({ caption: i18n.ts.cannotUploadBecauseNetworkError }));
		expect(mocks.toast).not.toHaveBeenCalledWith(i18n.ts._voiceCall.recordingSaved);
		const uploadedParts = vi.mocked(window.fetch).mock.calls.map(([, options]) => (options!.body as FormData).get('file') as File);
		expect(await uploadedParts[2].text()).toBe(await uploadedParts[0].text());
		expect(await uploadedParts[3].text()).toBe(await uploadedParts[1].text());

		firstRetry.resolve({ ok: true, json: async () => ({ id: 'mic-file' }) } as Response);
		secondRetry.resolve({ ok: true, json: async () => ({ id: 'call-file' }) } as Response);
		await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.recordingSaved));
	});

	test.each(['OUTPUT_TOO_LARGE', 'NO_FREE_SPACE', 'CONVERSION_FAILED'] as const)('reports %s and retries conversion without uploading the originals again', async code => {
		await joinRecordingCall();
		await startRecording();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const choice = deferred<{ canceled: boolean; result: string }>();
		mocks.actions.mockReturnValueOnce(choice.promise);
		vi.mocked(window.fetch).mockReset()
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'mic-file' }) } as Response)
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'call-file' }) } as Response);
		let attempts = 0;
		mocks.misskeyApi.mockImplementation(async (endpoint, params) => {
			if (endpoint !== 'chat/rooms/voice/convert-recording') return {};
			if (++attempts <= 2) throw Object.assign(new Error(code), { code });
			return { id: `${params.fileId}-converted` };
		});

		stopRecording();
		await vi.waitFor(() => expect(mocks.actions).toHaveBeenCalledOnce());
		expect(mocks.toast).not.toHaveBeenCalledWith(i18n.ts._voiceCall.recordingSaved);
		expect(window.fetch).toHaveBeenCalledTimes(2);

		choice.resolve({ canceled: false, result: 'retry' });
		await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.recordingSaved));
		expect(window.fetch).toHaveBeenCalledTimes(2);
		expect(mocks.misskeyApi).toHaveBeenCalledWith('drive/files/delete', { fileId: 'mic-file' });
		expect(mocks.misskeyApi).toHaveBeenCalledWith('drive/files/delete', { fileId: 'call-file' });
	});

	test('discarding failed recordings deletes the originals already uploaded to the drive', async () => {
		await joinRecordingCall();
		await startRecording();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const choice = deferred<{ canceled: boolean; result: string }>();
		mocks.actions.mockReturnValueOnce(choice.promise);
		vi.mocked(window.fetch).mockReset()
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'mic-file' }) } as Response)
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'call-file' }) } as Response);
		mocks.misskeyApi.mockImplementation(async endpoint => {
			if (endpoint === 'chat/rooms/voice/convert-recording') throw Object.assign(new Error('NO_FREE_SPACE'), { code: 'NO_FREE_SPACE' });
			return {};
		});

		stopRecording();
		await vi.waitFor(() => expect(mocks.actions).toHaveBeenCalledOnce());
		choice.resolve({ canceled: false, result: 'discard' });
		await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());

		await vi.waitFor(() => expect(mocks.misskeyApi).toHaveBeenCalledWith('drive/files/delete', { fileId: 'mic-file' }));
		expect(mocks.misskeyApi).toHaveBeenCalledWith('drive/files/delete', { fileId: 'call-file' });
	});

	test('canceling the discard confirmation keeps the uploaded originals and asks again', async () => {
		await joinRecordingCall();
		await startRecording();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const choice = deferred<{ canceled: boolean; result: string }>();
		const secondChoice = deferred<{ canceled: boolean; result: string }>();
		const confirmation = deferred<{ canceled: boolean }>();
		mocks.actions.mockReturnValueOnce(choice.promise).mockReturnValueOnce(secondChoice.promise);
		mocks.confirm.mockReturnValueOnce(confirmation.promise);
		vi.mocked(window.fetch).mockReset()
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'mic-file' }) } as Response)
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'call-file' }) } as Response);
		mocks.misskeyApi.mockImplementation(async endpoint => {
			if (endpoint === 'chat/rooms/voice/convert-recording') throw Object.assign(new Error('NO_FREE_SPACE'), { code: 'NO_FREE_SPACE' });
			return {};
		});

		stopRecording();
		await vi.waitFor(() => expect(mocks.actions).toHaveBeenCalledOnce());
		choice.resolve({ canceled: false, result: 'discard' });
		await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
		confirmation.resolve({ canceled: true });

		await vi.waitFor(() => expect(mocks.actions).toHaveBeenCalledTimes(2));
		expect(mocks.misskeyApi).not.toHaveBeenCalledWith('drive/files/delete', expect.anything());
		secondChoice.resolve({ canceled: false, result: 'discard' });
		await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(mocks.misskeyApi).toHaveBeenCalledWith('drive/files/delete', { fileId: 'mic-file' }));
		expect(mocks.misskeyApi).toHaveBeenCalledWith('drive/files/delete', { fileId: 'call-file' });
	});

	test('discarding deletes only the originals that reached the drive', async () => {
		await joinRecordingCall();
		await startRecording();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const choice = deferred<{ canceled: boolean; result: string }>();
		mocks.actions.mockReturnValueOnce(choice.promise);
		vi.mocked(window.fetch).mockReset()
			.mockRejectedValueOnce(new Error('upload unavailable'))
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'call-file' }) } as Response);
		mocks.misskeyApi.mockImplementation(async endpoint => {
			if (endpoint === 'chat/rooms/voice/convert-recording') throw Object.assign(new Error('NO_FREE_SPACE'), { code: 'NO_FREE_SPACE' });
			return {};
		});

		stopRecording();
		await vi.waitFor(() => expect(mocks.actions).toHaveBeenCalledOnce());
		choice.resolve({ canceled: false, result: 'discard' });
		await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());

		await vi.waitFor(() => expect(mocks.misskeyApi).toHaveBeenCalledWith('drive/files/delete', { fileId: 'call-file' }));
		expect(mocks.misskeyApi.mock.calls.filter(([endpoint]) => endpoint === 'drive/files/delete')).toHaveLength(1);
	});

	test('discarding failed parts keeps the converted results of saved parts', async () => {
		await joinRecordingCall();
		await startRecording();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const choice = deferred<{ canceled: boolean; result: string }>();
		mocks.actions.mockReturnValueOnce(choice.promise);
		vi.mocked(window.fetch).mockReset()
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'mic-file' }) } as Response)
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'call-file' }) } as Response);
		mocks.misskeyApi.mockImplementation(async (endpoint, params) => {
			if (endpoint !== 'chat/rooms/voice/convert-recording') return {};
			if (params.fileId === 'mic-file') return { id: 'mic-converted' };
			throw Object.assign(new Error('NO_FREE_SPACE'), { code: 'NO_FREE_SPACE' });
		});

		stopRecording();
		await vi.waitFor(() => expect(mocks.actions).toHaveBeenCalledOnce());
		choice.resolve({ canceled: false, result: 'discard' });
		await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());

		await vi.waitFor(() => expect(mocks.misskeyApi).toHaveBeenCalledWith('drive/files/delete', { fileId: 'call-file' }));
		expect(mocks.misskeyApi).toHaveBeenCalledWith('drive/files/delete', { fileId: 'mic-file' });
		expect(mocks.misskeyApi).not.toHaveBeenCalledWith('drive/files/delete', { fileId: 'mic-converted' });
	});

	test('the discard confirmation tells that uploaded originals will also be deleted', async () => {
		await joinRecordingCall();
		await startRecording();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const choice = deferred<{ canceled: boolean; result: string }>();
		mocks.actions.mockReturnValueOnce(choice.promise);
		vi.mocked(window.fetch).mockReset()
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'mic-file' }) } as Response)
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'call-file' }) } as Response);
		mocks.misskeyApi.mockImplementation(async endpoint => {
			if (endpoint === 'chat/rooms/voice/convert-recording') throw Object.assign(new Error('NO_FREE_SPACE'), { code: 'NO_FREE_SPACE' });
			return {};
		});

		stopRecording();
		await vi.waitFor(() => expect(mocks.actions).toHaveBeenCalledOnce());
		choice.resolve({ canceled: false, result: 'discard' });

		await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith({ type: 'warning', text: i18n.ts._voiceCall.recordingDiscardConfirmUploaded }));
	});

	test('the discard confirmation stays unchanged when nothing reached the drive', async () => {
		await joinRecordingCall();
		await startRecording();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const choice = deferred<{ canceled: boolean; result: string }>();
		mocks.actions.mockReturnValueOnce(choice.promise);
		vi.mocked(window.fetch).mockReset().mockRejectedValue(new Error('upload unavailable'));

		stopRecording();
		await vi.waitFor(() => expect(mocks.actions).toHaveBeenCalledOnce());
		choice.resolve({ canceled: false, result: 'discard' });

		await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith({ type: 'warning', text: i18n.ts._voiceCall.recordingDiscardConfirm }));
		expect(mocks.misskeyApi).not.toHaveBeenCalledWith('drive/files/delete', expect.anything());
	});

	test('uploads independent recordings and deletes only their converted originals', async () => {
		await joinRecordingCall();
		await startRecording();
		vi.mocked(window.fetch).mockReset()
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'mic-file' }) } as Response)
			.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'call-file' }) } as Response);
		mocks.misskeyApi.mockImplementation(async endpoint => endpoint === 'chat/rooms/voice/convert-recording' ? { id: 'converted-file' } : {});

		await leaveVoiceCall();
		await vi.waitFor(() => expect(mocks.misskeyApi.mock.calls.filter(([endpoint]) => endpoint === 'drive/files/delete')).toHaveLength(2));

		for (const [, options] of vi.mocked(window.fetch).mock.calls) {
			expect((options!.body as FormData).get('force')).toBe('true');
		}
		expect(mocks.misskeyApi).toHaveBeenCalledWith('drive/files/delete', { fileId: 'mic-file' });
		expect(mocks.misskeyApi).toHaveBeenCalledWith('drive/files/delete', { fileId: 'call-file' });
	});

	test.each([
		[413, 'b9d8c348-33f0-4673-b9a9-5d4da058977a', 'cannotUploadBecauseExceedsFileSizeLimit'],
		[400, 'd08dbc37-a6a9-463a-8c47-96c32ab5f064', 'cannotUploadBecauseNoFreeSpace'],
	] as const)('explains an upload rejection and retries the preserved chunks', async (status, id, message) => {
		await joinRecordingCall();
		await startRecording();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const rejected = { ok: false, status, json: async () => ({ error: { id } }) } as Response;
		vi.mocked(window.fetch).mockReset()
			.mockResolvedValueOnce(rejected)
			.mockResolvedValueOnce(rejected)
			.mockResolvedValue({ ok: true, json: async () => ({ id: 'retry-file' }) } as Response);

		await leaveVoiceCall();
		await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.recordingSaved));

		expect(mocks.actions).toHaveBeenCalledWith(expect.objectContaining({ caption: i18n.ts[message] }));
		expect(window.fetch).toHaveBeenCalledTimes(4);
	});

	test('a permanent status refusal closes a pending AudioContext before any recorder exists', async () => {
		await joinRecordingCall();
		const resumed = deferred<void>();
		RecordingContext.resume = () => resumed.promise;
		const starting = startRecording();
		await flushRecording();
		mocks.misskeyApi.mockRejectedValueOnce({ code: 'ACCESS_DENIED' });

		await setMicEnabled(false);
		await flushRecording();

		expect(RecordingContext.instances.every(context => context.state === 'closed')).toBe(true);
		expect(voiceCall.recordingStarting).toBe(false);
		resumed.resolve();
		await starting;
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.recordingRejected);
	});

	test('a server recording refusal stops capture and keeps the final uploads', async () => {
		await joinRecordingCall();
		await startRecording();
		mocks.misskeyApi.mockRejectedValueOnce({ code: 'ACCESS_DENIED' });

		await setMicEnabled(false);
		await flushRecording();

		expect(voiceCall.recording).toBe(false);
		expect(rawTrack.stop).toHaveBeenCalledOnce();
		expect(window.fetch).toHaveBeenCalledTimes(2);
		expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.recordingRejected);
	});
});
