/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { reactive, readonly } from 'vue';
import * as Misskey from 'cherrypick-js';
import { apiUrl, url } from '@@/js/config.js';
import { $i } from '@/i.js';
import type { AudioCaptureOptions, DisconnectReason, LocalAudioTrack, LocalParticipant, LocalTrack, LocalTrackPublication, Participant, RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, RoomConnectOptions, TrackPublication, VideoPreset } from 'livekit-client';
import { misskeyApi } from '@/utility/misskey-api.js';
import { isApiError } from '@/utility/api-error.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';

export type VoiceCallStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

// 参加者の声と共有画面の音声は、音量を別々に持つ
const VOLUME_PREFERENCES = {
	voice: 'voiceCall.participantVolumes',
	screenShare: 'voiceCall.screenShareVolumes',
} as const;

export type ParticipantAudio = keyof typeof VOLUME_PREFERENCES;

type LiveKit = typeof import('livekit-client');

const state = reactive({
	status: 'idle' as VoiceCallStatus,
	room: null as Misskey.entities.ChatRoom | null,
	mediaProvider: null as string | null,
	micEnabled: false,
	deafened: false,
	audioBlocked: false,
	speakingIdentities: [] as string[],
	localSpeaking: false,
	screenSharing: false,
	screenShareIdentities: [] as string[],
	// 見ている共有画面 (見始めた順)。いくつでも同時に見られる
	watchingIdentities: [] as string[],
	// 通話の録音 (声だけ)。録音中は参加者に知らせる
	recording: false,
	recordingStartedAt: null as number | null,
});

/** 現在の通話の状態。書き換えは下の関数経由で行う */
export const voiceCall = readonly(state);

let livekit: LiveKit | null = null;
let current: Room | null = null;
let screenShareLimits: Misskey.entities.ChatRoomsVoiceJoinResponse['screenShareLimits'] = undefined;
let pendingScreenShare: { room: Room; promise: Promise<void> } | null = null;
let joinAttempt = 0;
const ICE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ICE_REFRESH_STALE_MS = 60 * 60 * 1000;
const ICE_REFRESH_RETRY_MS = 60 * 1000;
type IceRefresh = { room: Room; roomId: string; url: string; mediaProvider: string; lastSuccess: number; retryDelay: number; timer: number | null; inFlight: boolean; iceServers: RTCIceServer[] };
let iceRefresh: IceRefresh | null = null;

function stopIceRefresh(): void {
	if (iceRefresh?.timer != null) window.clearTimeout(iceRefresh.timer);
	iceRefresh = null;
}

function scheduleIceRefresh(refresh: IceRefresh, delay: number): void {
	if (iceRefresh !== refresh || current !== refresh.room) return;
	if (refresh.timer != null) window.clearTimeout(refresh.timer);
	refresh.timer = window.setTimeout(() => { refresh.timer = null; void refreshIceServers(refresh); }, delay);
}

async function refreshIceServers(refresh: IceRefresh): Promise<void> {
	if (iceRefresh !== refresh || current !== refresh.room || refresh.inFlight) return;
	refresh.inFlight = true;
	let nextDelay = refresh.retryDelay;
	try {
		const credentials = await misskeyApi('chat/rooms/voice/join', { roomId: refresh.roomId });
		if (iceRefresh !== refresh || current !== refresh.room) return;
		if (credentials.url !== refresh.url || (credentials.mediaProvider ?? new URL(credentials.url).origin) !== refresh.mediaProvider) { stopIceRefresh(); return; }
		if (credentials.iceServers == null || !credentials.token) throw new Error('ICE refresh unavailable');
		const iceServers = credentials.iceServers;
		const engine = refresh.room.engine;
		const changed = JSON.stringify(iceServers) !== JSON.stringify(refresh.iceServers);
		if (changed) {
			// livekit-client 2.23 has no public RTC configuration updater. Preserve each
			// peer's current policy (including server-forced relay) while changing only ICE.
			const manager = engine.pcManager;
			for (const transport of [manager?.publisher, manager?.subscriber]) {
				const pc = (transport as unknown as { _pc?: RTCPeerConnection } | undefined)?._pc;
				if (pc && pc.connectionState !== 'closed') pc.setConfiguration({ ...pc.getConfiguration(), iceServers });
			}
			engine.rtcConfig.iceServers = iceServers;
		}
		// LiveKit normally refreshes its own token. Use the freshly authorized token
		// only when a reconnect is needed, so a short token does not replace its longer one.
		if (changed || state.status === 'reconnecting') (engine as unknown as { token: string }).token = credentials.token;
		if (changed) {
			const manager = engine.pcManager;
			// A live relay allocation can outlast its credentials. Refresh both publisher
			// and subscriber through LiveKit's reconnect path before those credentials expire.
			if (state.status === 'reconnecting' && manager) await manager.triggerIceRestart();
			else if (state.status === 'connected') engine.reconnect();
			refresh.iceServers = iceServers;
		}
		refresh.lastSuccess = Date.now(); refresh.retryDelay = ICE_REFRESH_RETRY_MS; nextDelay = ICE_REFRESH_INTERVAL_MS;
	} catch {
		refresh.retryDelay = Math.min(refresh.retryDelay * 2, 60 * 60 * 1000);
	} finally {
		refresh.inFlight = false;
		scheduleIceRefresh(refresh, nextDelay);
	}
}

function startIceRefresh(room: Room, roomId: string, credentials: Misskey.entities.ChatRoomsVoiceJoinResponse): void {
	stopIceRefresh();
	const iceServers = credentials.iceServers;
	if (!iceServers?.some(server => server.urls.some(value => /^turns?:/i.test(value)))) return;
	iceRefresh = { room, roomId, url: credentials.url, mediaProvider: credentials.mediaProvider ?? new URL(credentials.url).origin, lastSuccess: Date.now(), retryDelay: ICE_REFRESH_RETRY_MS, timer: null, inFlight: false, iceServers };
	scheduleIceRefresh(iceRefresh, ICE_REFRESH_INTERVAL_MS);
}

let stopLocalMeter: (() => void) | null = null;
let localMeterContext: BaseAudioContext | null = null;
// 測れなかったトラックは測り直さない。createAudioAnalyser は途中で失敗すると作った AudioContext を閉じずに投げるので、
// 切り替えのたびに測り直すと閉じられない AudioContext が溜まっていく。作り直されたトラックは別のものなので、また測ってみる
const unmeterableTracks = new WeakSet<MediaStreamTrack>();
let watchedMicrophoneTrack: LocalAudioTrack | null = null;
let unwatchMicrophoneTrack: (() => void) | null = null;
type VoiceStatusReport = Misskey.Endpoints['chat/rooms/voice/status']['req'];
type StatusDelivery = {
	room: Room;
	latest: VoiceStatusReport;
	pending: VoiceStatusReport | null;
	sending: boolean;
	retryDelay: number;
	timer: number | null;
	stopped: boolean;
};
let statusDelivery: StatusDelivery | null = null;
// スピーカーを切り替えた回数。マイクを入れるのを待つあいだに切り替えられたかを見分ける
let deafenRevision = 0;

// record the call in separate tracks (my microphone, the other side, video when present)
const RECORDING_CHUNK_BYTES = 100 * 1024 * 1024;
type RecordingPartKind = 'mic' | 'others' | 'video';
type RecordingPart = {
	recorder: MediaRecorder;
	chunks: Blob[];
	bytes: number;
	uploads: Promise<void>[];
	name: string;
};
const recordingParts = new Map<RecordingPartKind, RecordingPart>();
let recordingContext: AudioContext | null = null;
let recordingMicBus: GainNode | null = null;
let recordingOthersBus: GainNode | null = null;
let recordingMixedDest: MediaStreamAudioDestinationNode | null = null;
let pendingRecordingUploads: Promise<void>[] = [];
let recordingConversions: Promise<void> = Promise.resolve();
let recordingRawMicStream: MediaStream | null = null;
const recordingSources = new Map<MediaStreamTrack, { source: MediaStreamAudioSourceNode; kind: 'mic' | 'others' }>();
let recordingCanvas: HTMLCanvasElement | null = null;
let recordingCanvasStream: MediaStream | null = null;
let recordingDrawTimer: number | null = null;
const recordingVideos = new Map<MediaStreamTrack, { element: HTMLVideoElement; screen: boolean }>();

function recordingMimeType(): string | undefined {
	if (typeof MediaRecorder === 'undefined') return undefined;
	return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
}

function recordingVideoMimeType(): string | undefined {
	if (typeof MediaRecorder === 'undefined') return undefined;
	return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
}

function addRecordingVideo(track: MediaStreamTrack, screen: boolean): void {
	// this runs on every share, not only while recording
	if (recordingContext == null || recordingVideos.has(track)) return;
	if (screen) {
		try { track.contentHint = 'detail'; } catch { /* not supported */ }
	}
	const element = window.document.createElement('video');
	element.muted = true;
	element.playsInline = true;
	element.srcObject = new MediaStream([track]);
	void element.play().catch(() => {});
	recordingVideos.set(track, { element, screen });
	watchRecordingVideo(track, element);
	ensureRecordingVideoPart();
}

/** redraw whenever the source produces a frame; background tabs throttle timers */
function watchRecordingVideo(track: MediaStreamTrack, video: HTMLVideoElement): void {
	const step = () => {
		const entry = recordingVideos.get(track);
		if (entry == null || entry.element !== video) return;
		drawRecordingFrame();
		schedule();
	};
	const schedule = () => {
		if (typeof video.requestVideoFrameCallback === 'function') {
			video.requestVideoFrameCallback(step);
		} else {
			window.setTimeout(step, 33);
		}
	};
	schedule();
}

/** start the video part when the first video track appears, even after recording began */
function ensureRecordingVideoPart(): void {
	if (recordingParts.has('video') || recordingMixedDest == null || recordingContext == null) return;
	if (recordingCanvas == null) {
		const canvas = window.document.createElement('canvas');
		canvas.width = 1920;
		canvas.height = 1080;
		recordingCanvas = canvas;
		recordingCanvasStream = canvas.captureStream(30);
		if (typeof HTMLVideoElement.prototype.requestVideoFrameCallback !== 'function') {
			recordingDrawTimer = window.setInterval(drawRecordingFrame, 33);
		}
		drawRecordingFrame();
	}
	const base = recordingParts.get('mic')?.name ?? `voice-${recordingStamp(new Date())}`;
	createRecordingPart('video', new MediaStream([
		...recordingMixedDest.stream.getAudioTracks(),
		...recordingCanvasStream!.getVideoTracks(),
	]), recordingVideoMimeType(), 12_000_000, `${base.replace(/-mic$/, '')}-video-${recordingStamp(new Date())}`);
}

function removeRecordingVideo(track: MediaStreamTrack): void {
	const entry = recordingVideos.get(track);
	if (entry == null) return;
	entry.element.pause();
	entry.element.srcObject = null;
	recordingVideos.delete(track);
}

function drawRecordingFrame(): void {
	const canvas = recordingCanvas;
	const ctx = canvas?.getContext('2d');
	if (canvas == null || ctx == null) return;
	ctx.fillStyle = '#111';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	const ready = [...recordingVideos.values()].filter(v => v.element.readyState >= 2);
	if (ready.length === 0) return;

	const drawFit = (video: HTMLVideoElement, x: number, y: number, w: number, h: number) => {
		const vw = video.videoWidth || 16;
		const vh = video.videoHeight || 9;
		const scale = Math.min(w / vw, h / vh);
		const dw = vw * scale;
		const dh = vh * scale;
		ctx.drawImage(video, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
	};

	// a shared screen gets the whole frame; otherwise lay the cameras out in a grid
	const screen = ready.find(v => v.screen);
	if (screen != null) {
		drawFit(screen.element, 0, 0, canvas.width, canvas.height);
		return;
	}
	const cols = ready.length <= 1 ? 1 : ready.length <= 4 ? 2 : 3;
	const rows = Math.ceil(ready.length / cols);
	const cw = canvas.width / cols;
	const ch = canvas.height / rows;
	ready.forEach((entry, i) => drawFit(entry.element, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch));
}

function addRecordingTrack(track: MediaStreamTrack, kind: 'mic' | 'others'): void {
	if (recordingContext == null) return;
	const bus = kind === 'mic' ? recordingMicBus : recordingOthersBus;
	if (bus == null || recordingSources.has(track)) return;
	try {
		const source = recordingContext.createMediaStreamSource(new MediaStream([track]));
		source.connect(bus);
		recordingSources.set(track, { source, kind });
	} catch (err) {
		console.warn('[recording] could not connect a track', err);
	}
}

function removeRecordingTrack(track: MediaStreamTrack): void {
	const entry = recordingSources.get(track);
	if (entry == null) return;
	entry.source.disconnect();
	recordingSources.delete(track);
}

function recordingStamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function uploadRecording(blob: Blob, name: string): Promise<void> {
	const roomId = state.room?.id;
	if (roomId == null || blob.size === 0) return;
	const form = new FormData();
	form.append('file', blob, `${name}.webm`);
	// Misskey authenticates API calls with the token in the form, not with cookies
	if ($i != null) form.append('i', $i.token);
	const res = await window.fetch(apiUrl + '/drive/files/create', { method: 'POST', body: form, credentials: 'omit' });
	if (!res.ok) throw new Error(`failed to upload the recording: ${res.status}`);
	let file = await res.json() as Misskey.entities.DriveFile;
	// the server converts one recording per user at a time, so convert the parts one after another
	const fileId = file.id;
	const conversion = recordingConversions.then(() => misskeyApi('chat/rooms/voice/convert-recording', { fileId }));
	recordingConversions = conversion.then(() => {}, () => {});
	try {
		const converted = await conversion;
		if (converted != null) file = converted;
	} catch { /* keep the WebM when ffmpeg fails */ }
	// the recording stays in the drive; it is not posted to the room
}

function flushRecordingChunk(kind: RecordingPartKind, force: boolean): void {
	const part = recordingParts.get(kind);
	if (part == null || part.chunks.length === 0) return;
	if (!force && part.bytes < RECORDING_CHUNK_BYTES) return;
	const blob = new Blob(part.chunks, { type: part.recorder.mimeType || 'audio/webm' });
	part.chunks = [];
	part.bytes = 0;
	const upload = uploadRecording(blob, part.name).catch(err => {
		console.error(err);
	});
	part.uploads.push(upload);
	pendingRecordingUploads.push(upload);
}

function createRecordingPart(kind: RecordingPartKind, stream: MediaStream, mime: string | undefined, bits: number, name: string): void {
	const options: MediaRecorderOptions = { ...(mime != null ? { mimeType: mime } : {}) };
	if (kind === 'video') {
		options.videoBitsPerSecond = bits;
		options.audioBitsPerSecond = 192_000;
	} else {
		options.audioBitsPerSecond = bits;
	}
	const rec = new MediaRecorder(stream, options);
	const part: RecordingPart = { recorder: rec, chunks: [], bytes: 0, uploads: [], name };
	recordingParts.set(kind, part);
	rec.ondataavailable = (ev) => {
		if (ev.data.size === 0) return;
		part.chunks.push(ev.data);
		part.bytes += ev.data.size;
		flushRecordingChunk(kind, false);
	};
	rec.onstop = () => {
		flushRecordingChunk(kind, true);
		void Promise.allSettled(part.uploads);
		if (kind === 'video') stopRecordingVideo();
		recordingParts.delete(kind);
		if (recordingParts.size === 0) teardownRecording();
	};
	rec.start(10_000);
}

function stopRecordingVideo(): void {
	if (recordingDrawTimer != null) {
		window.clearInterval(recordingDrawTimer);
		recordingDrawTimer = null;
	}
	for (const track of [...recordingVideos.keys()]) removeRecordingVideo(track);
	recordingCanvas = null;
	recordingCanvasStream?.getTracks().forEach(track => track.stop());
	recordingCanvasStream = null;
}

function teardownRecording(): void {
	stopRecordingVideo();
	const uploads = pendingRecordingUploads;
	pendingRecordingUploads = [];
	if (uploads.length > 0) {
		void Promise.allSettled(uploads).then(() => {
			os.toast(i18n.ts._voiceCall.recordingSaved);
		});
	}
	recordingMicBus = null;
	recordingOthersBus = null;
	recordingMixedDest = null;
	recordingRawMicStream?.getTracks().forEach(track => track.stop());
	recordingRawMicStream = null;
	recordingContext?.close().catch(() => {});
	recordingContext = null;
	recordingSources.clear();
}

function resetStatusDelivery(): void {
	if (statusDelivery?.timer != null) window.clearTimeout(statusDelivery.timer);
	statusDelivery = null;
}

// Keep only the newest settings. A failed report must not leave the server stale for the rest of the call.
function reportStatus(room: Room, force = false): void {
	const roomId = state.room?.id;
	if (current !== room || roomId == null || state.status === 'connecting') return;
	const status = { roomId, sessionId: room.localParticipant.sid, micMuted: !state.micEnabled, deafened: state.deafened, ...(state.recording ? { recording: true } : {}) };
	if (statusDelivery?.room !== room || statusDelivery.latest.sessionId !== status.sessionId) {
		resetStatusDelivery();
		statusDelivery = { room, latest: status, pending: status, sending: false, retryDelay: 1000, timer: null, stopped: false };
	} else {
		if (!force && statusDelivery.latest.micMuted === status.micMuted && statusDelivery.latest.deafened === status.deafened && statusDelivery.latest.recording === status.recording) return;
		// 止めたのは失敗した報告の再送だけ。設定が変わったら、新しい設定はもう一度だけ送ってみる
		// (セッションを確かめる一時的な失敗も ACCESS_DENIED になるので、一度の失敗で通話の残りずっと黙らない)
		statusDelivery.stopped = false;
		statusDelivery.latest = status;
		statusDelivery.pending = status;
	}
	void deliverStatus(statusDelivery);
}

async function deliverStatus(delivery: StatusDelivery): Promise<void> {
	if (statusDelivery !== delivery || current !== delivery.room || delivery.sending || delivery.timer != null || delivery.stopped || delivery.pending == null) return;
	const status = delivery.pending;
	delivery.pending = null;
	delivery.sending = true;
	try {
		await misskeyApi('chat/rooms/voice/status', status);
		delivery.retryDelay = 1000;
	} catch (err) {
		if (statusDelivery !== delivery || current !== delivery.room) return;
		const code = isApiError(err) ? err.code : null;
		if (code != null && code !== 'RATE_LIMIT_EXCEEDED' && code !== 'INTERNAL_ERROR' && code !== 'REMOTE_HOST_UNREACHABLE') {
			// Unsupported hosts and permanent API errors must not generate a retry loop.
			// 送り直さないのは失敗した設定だけ。送っているあいだに変わった新しい設定は、下でもう一度だけ送ってみる
			if (delivery.pending == null) {
				delivery.stopped = true;
				return;
			}
		} else {
			delivery.pending ??= status;
			const delay = code === 'RATE_LIMIT_EXCEEDED' ? 60_000 : delivery.retryDelay;
			delivery.retryDelay = Math.min(delivery.retryDelay * 2, 30_000);
			delivery.timer = window.setTimeout(() => {
				delivery.timer = null;
				void deliverStatus(delivery);
			}, delay);
		}
	} finally {
		delivery.sending = false;
	}
	if (statusDelivery === delivery) void deliverStatus(delivery);
}

function setLocalSpeaking(room: Room, speaking: boolean): void {
	state.localSpeaking = speaking;
	const identity = room.localParticipant.identity;
	if (state.speakingIdentities.includes(identity) === speaking) return;
	state.speakingIdentities = speaking
		? [...state.speakingIdentities, identity]
		: state.speakingIdentities.filter(id => id !== identity);
}

// livekit-client は入力装置が抜けたり既定の装置が変わったりすると、マイクのトラックを自分で作り直す (restartTrack)。
// 測っていた MediaStreamTrack はそのとき終わっているので、終わったら測るのをやめてサーバーの知らせに戻り、作り直されたら新しいトラックで測り直す
function watchMicrophoneTrack(room: Room, track: LocalAudioTrack): void {
	// 作り直されても LocalAudioTrack は同じものなので、付け替えるのは別のトラックになったときだけ (restarted の中で付け直すと、その emit にまた呼ばれる)
	if (livekit == null || watchedMicrophoneTrack === track) return;
	unwatchMicrophoneTrack?.();
	const events = livekit.TrackEvent;
	const onRestarted = () => { if (current === room) startLocalMeter(room); };
	const onEnded = () => { stopLocalMeter?.(); };
	track.on(events.Restarted, onRestarted);
	track.on(events.Ended, onEnded);
	watchedMicrophoneTrack = track;
	unwatchMicrophoneTrack = () => {
		track.off(events.Restarted, onRestarted);
		track.off(events.Ended, onEnded);
		watchedMicrophoneTrack = null;
		unwatchMicrophoneTrack = null;
	};
}

function startLocalMeter(room: Room): void {
	stopLocalMeter?.();
	if (livekit == null || current !== room || !state.micEnabled) return;
	const track = room.localParticipant.getTrackPublication(livekit.Track.Source.Microphone)?.track;
	if (track == null || track.kind !== livekit.Track.Kind.Audio) return;
	watchMicrophoneTrack(room, track as LocalAudioTrack);
	if (unmeterableTracks.has(track.mediaStreamTrack)) return;
	try {
		const meter = livekit.createAudioAnalyser(track as LocalAudioTrack, { fftSize: 512 });
		const context = meter.analyser.context;
		const samples = new Float32Array(meter.analyser.fftSize);
		let lastLoudAt = -Infinity;
		const timer = window.setInterval(() => {
			if (current !== room || !state.micEnabled || context.state === 'suspended') return;
			meter.analyser.getFloatTimeDomainData(samples);
			const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
			if (rms >= 0.02) lastLoudAt = Date.now();
			setLocalSpeaking(room, Date.now() - lastLoudAt < 150);
		}, 50);
		localMeterContext = context;
		stopLocalMeter = () => {
			window.clearInterval(timer);
			void meter.cleanup().catch(() => {});
			setLocalSpeaking(room, false);
			stopLocalMeter = null;
			localMeterContext = null;
		};
	} catch {
		// Audio metering is optional; failure must not stop the microphone.
		unmeterableTracks.add(track.mediaStreamTrack);
	}
}

// 画面共有の映像トラックと、それを映す video 要素 (どちらも identity ごと)。
// 一つの共有画面を、参加者のチップやタイルの小さなプレビューと、見ている画面の両方に同時に映すことがある。
// 自分の共有画面は受け取るものではないので、送っている手元のトラックをそのまま映す
type ScreenShareView = { element: HTMLVideoElement; preview: boolean };
const screenShareTracks = new Map<string, RemoteTrack | LocalTrack>();
const screenShareViews = new Map<string, Set<ScreenShareView>>();

// 小さなプレビュー用に、共有画面とは別に送る低い層 (320×180、数 fps)。
// 誰もプレビューを出していないあいだは、dynacast が送るのを止める。
// Chromium は一番低い層 (encodings[0]) の priority だけを送信の優先度に使うので、ほかの画面共有の層と同じ medium を付ける
const SCREEN_SHARE_PREVIEW_LAYER = { width: 320, height: 180, maxBitrate: 100_000, maxFramerate: 5, priority: 'medium' } as const;

async function loadLiveKit(): Promise<LiveKit> {
	// 通話しない人にライブラリを読ませないよう、参加時に読み込む
	livekit ??= await import('livekit-client');
	return livekit;
}

export function localIdentityOf(userId: string): string {
	return `${url}/users/${userId}`;
}

async function disconnectCurrentRoom(): Promise<void> {
	const room = current;
	current = null;
	stopIceRefresh();
	if (room != null) {
		await room.disconnect();
		detachAll(room);
	}
}

/** start recording the call in separate tracks (microphone, the other side, video when present) */
export async function startRecording(): Promise<void> {
	const room = current;
	if (room == null || recordingParts.size > 0 || state.status !== 'connected') return;
	const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (Context == null || typeof MediaRecorder === 'undefined') return;

	const context = new Context();
	// a suspended context feeds no samples to the recorder
	await context.resume().catch(() => {});
	recordingContext = context;

	const micDest = context.createMediaStreamDestination();
	const othersDest = context.createMediaStreamDestination();
	const mixedDest = context.createMediaStreamDestination();
	for (const dest of [micDest, othersDest, mixedDest]) {
		dest.channelCount = 2;
		dest.channelCountMode = 'explicit';
	}
	const micBus = context.createGain();
	const othersBus = context.createGain();
	micBus.connect(micDest);
	micBus.connect(mixedDest);
	othersBus.connect(othersDest);
	othersBus.connect(mixedDest);
	recordingMixedDest = mixedDest;
	recordingMicBus = micBus;
	recordingOthersBus = othersBus;
	recordingSources.clear();

	const base = recordingStamp(new Date());
	createRecordingPart('mic', micDest.stream, recordingMimeType(), 192_000, `voice-${base}-mic`);
	createRecordingPart('others', othersDest.stream, recordingMimeType(), 256_000, `voice-${base}-call`);

	const lk = livekit;
	let hasVideo = false;
	// capture the microphone without the call's voice processing (echo cancellation, noise
	// suppression, auto gain), which makes music and quiet voices sound thin
	try {
		const raw = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
		});
		recordingRawMicStream = raw;
		const track = raw.getAudioTracks()[0];
		if (track != null) {
			track.enabled = state.micEnabled;
			addRecordingTrack(track, 'mic');
		}
	} catch {
		// fall back to the microphone of the call
		if (lk != null) {
			const mic = room.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.track;
			if (mic?.mediaStreamTrack != null) addRecordingTrack(mic.mediaStreamTrack, 'mic');
		}
	}
	if (lk != null) {
		// my own tab audio is not played to my speakers, so it only reaches the recording here
		const shareAudio = room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShareAudio)?.track;
		if (shareAudio?.mediaStreamTrack != null) addRecordingTrack(shareAudio.mediaStreamTrack, 'others');
		const shareVideo = room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShare)?.track;
		if (shareVideo?.mediaStreamTrack != null) {
			addRecordingVideo(shareVideo.mediaStreamTrack, true);
			hasVideo = true;
		}
		for (const participant of room.remoteParticipants.values()) {
			for (const publication of participant.trackPublications.values()) {
				const track = publication.track?.mediaStreamTrack;
				if (track == null) continue;
				if (publication.kind === lk.Track.Kind.Audio) {
					addRecordingTrack(track, 'others');
				} else if (publication.kind === lk.Track.Kind.Video) {
					addRecordingVideo(track, publication.source === lk.Track.Source.ScreenShare);
					hasVideo = true;
				}
			}
		}
		for (const track of screenShareTracks.values()) {
			if (track.mediaStreamTrack != null) {
				addRecordingVideo(track.mediaStreamTrack, true);
				hasVideo = true;
			}
		}
	}

	// only composite video when there is something to show; otherwise this stays an audio recording
	if (hasVideo) ensureRecordingVideoPart();

	state.recording = true;
	state.recordingStartedAt = Date.now();
	reportStatus(room, true);
}

/** stop recording and upload what is left */
export function stopRecording(): void {
	if (recordingParts.size === 0) return;
	state.recording = false;
	state.recordingStartedAt = null;
	if (current != null) reportStatus(current, true);
	for (const part of [...recordingParts.values()]) {
		try { part.recorder.requestData(); } catch { /* not recording yet */ }
		part.recorder.stop();
	}
}

export async function joinVoiceCall(room: Misskey.entities.ChatRoom, options: { micEnabled?: boolean; approvedMediaProvider?: string } = {}): Promise<void> {
	migrateParticipantVolumes();
	// 前の通話の切断を待つあいだに別の参加が始まったら、この参加は捨てる。
	// leaveVoiceCall は joinAttempt を進めるので、ここでは切断だけを行う
	const attempt = ++joinAttempt;
	if (current != null) {
		await disconnectCurrentRoom();
		if (attempt !== joinAttempt) return;
	}

	resetState();
	state.status = 'connecting';
	state.room = room;

	let credentials: Misskey.entities.ChatRoomsVoiceJoinResponse;
	let lk: LiveKit;
	try {
		[credentials, lk] = await Promise.all([
			misskeyApi('chat/rooms/voice/join', { roomId: room.id }),
			loadLiveKit(),
		]);
	} catch (err) {
		if (attempt === joinAttempt) failToConnect(err);
		return;
	}
	if (attempt !== joinAttempt) return;

	if (credentials.mediaProvider && credentials.mediaProvider !== url && credentials.mediaProvider !== options.approvedMediaProvider) {
		const { canceled } = await os.confirm({ type: 'info', text: i18n.tsx._voiceRelay.mediaNotice({ host: new URL(credentials.mediaProvider).host }) });
		if (attempt !== joinAttempt) return;
		if (canceled) { resetState(); return; }
	}
	state.mediaProvider = credentials.mediaProvider ?? new URL(credentials.url).origin;
	screenShareLimits = credentials.screenShareLimits;
	const lkRoom = new lk.Room({ adaptiveStream: true, dynacast: true });
	current = lkRoom;
	bindRoomEvents(lk, lkRoom);

	// サーバーが ICE サーバーの一覧を渡したら、空でも、LiveKit が渡す ICE サーバーの代わりにそれを使う。
	// このサーバーの TURN なら LiveKit が NAT の内側にあってもつながる。他のサーバーの通話では、サーバーが確かめたものだけが届き
	// (使えるものが無ければ空の一覧)、他のサーバーの LiveKit が渡す確かめていない ICE サーバーは使わない。
	// LiveKit は rtcConfig.iceServers があればそれを、再接続のときも使い続ける
	const iceServers = credentials.iceServers;
	const connectOptions: RoomConnectOptions = iceServers != null
		? { autoSubscribe: false, rtcConfig: { iceServers } }
		: { autoSubscribe: false };

	try {
		await lkRoom.connect(credentials.url, credentials.token, connectOptions);
	} catch {
		if (current === lkRoom) {
			current = null;
			failToConnect();
		}
		return;
	}
	if (current !== lkRoom) return;

	state.status = 'connected';
	startIceRefresh(lkRoom, room.id, credentials);
	state.audioBlocked = !lkRoom.canPlaybackAudio;

	for (const participant of lkRoom.remoteParticipants.values()) {
		for (const publication of participant.trackPublications.values()) {
			applySubscription(lk, publication, participant);
		}
	}

	const outputDeviceId = prefer.s['voiceCall.outputDeviceId'];
	if (outputDeviceId != null) {
		lkRoom.switchActiveDevice('audiooutput', outputDeviceId).catch(() => {});
	}

	// つながるまでのあいだにスピーカーを切っていたら、マイクは入れない (スピーカーを切っているあいだはマイクも切っておく)
	if ((options.micEnabled ?? prefer.s['voiceCall.micEnabled']) && !state.deafened) await enableMicrophone(lkRoom);
	else reportStatus(lkRoom);
}

export async function leaveVoiceCall(): Promise<void> {
	const attempt = ++joinAttempt;
	stopRecording();
	await disconnectCurrentRoom();
	// 切れるのを待つあいだに次の通話に入り始めていたら、その通話の表示を消さない
	if (attempt === joinAttempt) resetState();
}

/** 自分でマイクを切り替える。選んだ入/切は、次に通話に入るときにも使う */
export async function setMicEnabled(enabled: boolean): Promise<void> {
	const room = current;
	if (room == null) return;
	if (recordingRawMicStream != null) {
		for (const track of recordingRawMicStream.getAudioTracks()) track.enabled = enabled;
	}
	prefer.commit('voiceCall.micEnabled', enabled);
	if (enabled) {
		// スピーカーを切ったままマイクだけを入れると、聞こえないまま話すことになる。マイクが入ったらスピーカーも戻す。
		// マイクを入れられなかったときは、スピーカーは切ったままにする
		await enableMicrophone(room, state.deafened ? deafenRevision : null);
	} else {
		await disableMicrophone(room);
	}
}

/** 音声処理の設定を反映するために、マイクを入れ直す。自分で選んだ入/切は変えない */
export async function restartMicrophone(): Promise<void> {
	const room = current;
	if (room == null || !state.micEnabled) return;
	await disableMicrophone(room);
	if (current === room && !state.deafened) await enableMicrophone(room);
}

/** スピーカーを切るとマイクも切る。スピーカーを戻してもマイクは切ったまま (自分で入れ直す) */
export function setDeafened(deafened: boolean): void {
	deafenRevision++;
	state.deafened = deafened;
	if (current == null) return;
	const room = current;
	applyVolumes(room);
	if (deafened && state.micEnabled) {
		// マイクを切り終えてから一度だけ知らせる (disableMicrophone が知らせる)。切る前に知らせると、スピーカーだけ切ってマイクは入ったままの状態が
		// 一瞬伝わり、知らせも二度になる。切れなかったときは、そのままの状態 (マイクは入ったまま) を知らせる
		disableMicrophone(room).catch(() => reportStatus(room));
		return;
	}
	reportStatus(room);
}

function applyVolumes(room: Room): void {
	for (const participant of room.remoteParticipants.values()) {
		applyVolume(participant);
	}
}

export async function resumeAudio(): Promise<void> {
	if (current == null) return;
	await current.startAudio();
	state.audioBlocked = !current.canPlaybackAudio;
}

/** 保存してある参加者の音量。スピーカーをオフにしていても、その前の音量を返す */
export function participantVolume(identity: string, audio: ParticipantAudio): number {
	return clampVolume(prefer.s[VOLUME_PREFERENCES[audio]][identity] ?? 1);
}

/**
 * 声と画面共有の音量を分ける前の設定を、画面共有側へ一度だけ引き継ぐ。
 * 移行前にミュート/音量調整した参加者が、画面共有を始めた途端に既定の 1 で
 * 再生されないようにする。明示的に設定済みの画面共有音量は上書きしない。
 */
export function migrateParticipantVolumes(): void {
	if (prefer.s['voiceCall.screenShareVolumesMigrated']) return;

	const voiceVolumes = prefer.s['voiceCall.participantVolumes'];
	const screenShareVolumes = { ...prefer.s['voiceCall.screenShareVolumes'] };
	let changed = false;
	for (const [identity, volume] of Object.entries(voiceVolumes)) {
		if (screenShareVolumes[identity] == null) {
			screenShareVolumes[identity] = volume;
			changed = true;
		}
	}

	if (changed) prefer.commit('voiceCall.screenShareVolumes', screenShareVolumes);
	prefer.commit('voiceCall.screenShareVolumesMigrated', true);
}

export function setParticipantVolume(identity: string, audio: ParticipantAudio, volume: number): void {
	const key = VOLUME_PREFERENCES[audio];
	prefer.commit(key, { ...prefer.s[key], [identity]: clampVolume(volume) });
	const participant = current?.remoteParticipants.get(identity);
	if (participant != null) applyVolume(participant);
}

// メニューのチェック位置に使う。保存済みの選択を優先し、未選択なら通話が実際に使っているデバイスを返す
// computed の中で読まれるので、変更を追える prefer.r から読む (prefer.s はリアクティブではない)
export function activeAudioDeviceId(kind: 'audioinput' | 'audiooutput'): string {
	return prefer.r[kind === 'audioinput' ? 'voiceCall.inputDeviceId' : 'voiceCall.outputDeviceId'].value ?? current?.getActiveDevice(kind) ?? 'default';
}

export async function selectAudioDevice(kind: 'audioinput' | 'audiooutput', deviceId: string): Promise<void> {
	prefer.commit(kind === 'audioinput' ? 'voiceCall.inputDeviceId' : 'voiceCall.outputDeviceId', deviceId);
	if (current == null) return;
	await current.switchActiveDevice(kind, deviceId);
	if (kind === 'audioinput' && current != null) startLocalMeter(current);
}

export function canShareScreen(): boolean {
	return typeof window.navigator.mediaDevices?.getDisplayMedia === 'function';
}

// 共有する画面を選ぶ画面が出れば、人がやめるまでに少なくともこのくらいはかかる。
// それより早く NotAllowedError が返るのは、選ぶ前にブラウザや OS が拒んだとき (権限が無い、ポリシーで止められているなど)
const SCREEN_SHARE_PICKER_MIN_MS = 250;

export async function startScreenShare(): Promise<void> {
	const room = current;
	if (room == null || livekit == null) return;
	if (pendingScreenShare?.room === room) return pendingScreenShare.promise;
	const { preset, contentHint } = screenSharePreset(livekit, prefer.s['voiceCall.screenShareQuality']);
	const startedAt = Date.now();
	try {
		const captureOptions = {
			audio: prefer.s['voiceCall.screenShareAudio'],
			resolution: preset.resolution,
			contentHint,
		};
		const publishOptions = {
			screenShareEncoding: preset.encoding,
			// 層は低いものから並べる。一番低い層はプレビュー用
			screenShareSimulcastLayers: [
				new livekit.VideoPreset(SCREEN_SHARE_PREVIEW_LAYER.width, SCREEN_SHARE_PREVIEW_LAYER.height, SCREEN_SHARE_PREVIEW_LAYER.maxBitrate, SCREEN_SHARE_PREVIEW_LAYER.maxFramerate, SCREEN_SHARE_PREVIEW_LAYER.priority),
				livekit.ScreenSharePresets.h720fps15,
			],
		};
		if (screenShareLimits) {
			const limits = screenShareLimits;
			const resolution = {
				width: Math.min(preset.resolution.width, limits.maxWidth),
				height: Math.min(preset.resolution.height, limits.maxHeight),
				frameRate: Math.min(preset.resolution.frameRate ?? limits.maxFrameRate, limits.maxFrameRate),
			};
			const promise = publishLimitedScreenShare(room, { ...captureOptions, resolution }, {
				videoCodec: 'vp8', simulcast: false, backupCodec: false,
				screenShareEncoding: { maxBitrate: Math.min(preset.encoding.maxBitrate, limits.maxBitrate), maxFramerate: Math.min(preset.encoding.maxFramerate ?? limits.maxFrameRate, limits.maxFrameRate) },
			}, limits);
			pendingScreenShare = { room, promise };
			try { await promise; } finally { if (pendingScreenShare?.promise === promise) pendingScreenShare = null; }
		} else {
			await room.localParticipant.setScreenShareEnabled(true, captureOptions, publishOptions);
		}
		// 待っているあいだに通話を離れていれば何もしない。共有が終わっていれば (ブラウザの「共有を停止」など) 共有中にはしない
		if (current === room) state.screenSharing = room.localParticipant.isScreenShareEnabled;
	} catch (err) {
		if (current === room) state.screenSharing = false;
		if (err instanceof DOMException && err.name === 'NotAllowedError') {
			// 共有する画面の選択をキャンセルしただけなら何も言わない。選ぶ前に拒まれたなら、許可が要ることを知らせる
			if (Date.now() - startedAt >= SCREEN_SHARE_PICKER_MIN_MS) return;
			os.toast(i18n.ts._voiceCall.screenSharePermissionDenied);
			return;
		}
		os.toast(i18n.ts._voiceCall.screenShareFailed);
	}
}

async function publishLimitedScreenShare(room: Room, capture: import('livekit-client').ScreenShareCaptureOptions, publish: import('livekit-client').TrackPublishOptions, limits: NonNullable<typeof screenShareLimits>): Promise<void> {
	if (room.localParticipant.isScreenShareEnabled) return;
	const tracks = await room.localParticipant.createScreenTracks(capture);
	const published: LocalTrack[] = [];
	try {
		const video = tracks.find(track => track.source === livekit?.Track.Source.ScreenShare);
		if (!video) throw new Error('Screen video track missing');
		await video.mediaStreamTrack.applyConstraints({ width: { max: limits.maxWidth }, height: { max: limits.maxHeight }, frameRate: { max: limits.maxFrameRate } });
		const settings = video.mediaStreamTrack.getSettings();
		if (settings.width == null || settings.height == null || settings.frameRate == null || settings.width > limits.maxWidth || settings.height > limits.maxHeight || settings.frameRate > limits.maxFrameRate) throw new Error('Screen capture exceeds relay limits');
		if (current !== room) return;
		for (const track of tracks) {
			await room.localParticipant.publishTrack(track, publish);
			published.push(track);
			if (current !== room) throw new Error('Voice call ended');
		}
	} catch (error) {
		await Promise.allSettled(published.map(track => room.localParticipant.unpublishTrack(track)));
		throw error;
	} finally {
		if (published.length !== tracks.length || current !== room) tracks.forEach(track => track.stop());
	}
}

export async function stopScreenShare(): Promise<void> {
	if (current == null) return;
	const room = current;
	if (pendingScreenShare?.room === room) await pendingScreenShare.promise.catch(() => {});
	await room.localParticipant.setScreenShareEnabled(false);
	state.screenSharing = false;
}

export function watchScreenShare(identity: string): void {
	if (state.watchingIdentities.includes(identity)) return;
	state.watchingIdentities = [...state.watchingIdentities, identity];
	syncScreenShareSubscription(identity);
}

export function unwatchScreenShare(identity: string): void {
	if (!state.watchingIdentities.includes(identity)) return;
	state.watchingIdentities = state.watchingIdentities.filter(x => x !== identity);
	syncScreenShareSubscription(identity);
}

export function toggleScreenShareWatch(identity: string): void {
	if (state.watchingIdentities.includes(identity)) {
		unwatchScreenShare(identity);
	} else {
		watchScreenShare(identity);
	}
}

/**
 * 共有画面を video 要素に映す。返り値の関数で外す。
 * preview を付けた要素 (チップやタイルの小さなプレビュー) があるあいだは、見ていない共有画面も低い層だけ受け取る
 */
export function attachScreenShare(identity: string, element: HTMLVideoElement, options: { preview?: boolean } = {}): () => void {
	const view: ScreenShareView = { element, preview: options.preview === true };
	let views = screenShareViews.get(identity);
	if (views == null) {
		views = new Set();
		screenShareViews.set(identity, views);
	}
	views.add(view);
	screenShareTracks.get(identity)?.attach(element);
	if (view.preview) syncScreenShareSubscription(identity);
	return () => {
		const registered = screenShareViews.get(identity);
		if (registered == null || !registered.delete(view)) return;
		if (registered.size === 0) screenShareViews.delete(identity);
		screenShareTracks.get(identity)?.detach(element);
		if (view.preview) syncScreenShareSubscription(identity);
	};
}

function screenSharePreset(lk: LiveKit, quality: 'sharp' | 'smooth' | 'high'): { preset: VideoPreset; contentHint: 'detail' | 'motion' } {
	switch (quality) {
		case 'smooth': return { preset: lk.ScreenSharePresets.h720fps30, contentHint: 'motion' };
		case 'high': return { preset: lk.ScreenSharePresets.h1080fps30, contentHint: 'motion' };
		default: return { preset: lk.ScreenSharePresets.h1080fps15, contentHint: 'detail' };
	}
}

function screenSharePublicationOf(room: Room, identity: string): RemoteTrackPublication | undefined {
	const participant = room.remoteParticipants.get(identity);
	if (participant == null || livekit == null) return undefined;
	for (const publication of participant.trackPublications.values()) {
		if (publication.source === livekit.Track.Source.ScreenShare) return publication;
	}
	return undefined;
}

function isScreenSharePreviewed(identity: string): boolean {
	for (const view of screenShareViews.get(identity) ?? []) {
		if (view.preview) return true;
	}
	return false;
}

// 送り手が低い層も送っているか。Firefox は画面共有を simulcast しないので層が 1 つしかなく、
// 低い画質を頼んでも元の画質のまま届く
function hasLowerLayer(publication: RemoteTrackPublication): boolean {
	const info = publication.trackInfo;
	const layerCount = Math.max(info?.layers.length ?? 0, ...(info?.codecs ?? []).map(codec => codec.layers.length));
	if (layerCount > 0) return layerCount >= 2;
	return publication.simulcasted === true;
}

// 見ている共有画面は高い画質で、プレビューだけを出している共有画面は低い層だけを受け取り、どちらでもなければ受け取らない。
// 低い層の無い共有画面はプレビューのためには受け取らない (プレビューは共有のアイコンのままになる)。
// adaptiveStream も効いているので、映している要素が小さければ、ここで決めた上限よりさらに低い層になる
function syncScreenShareSubscription(identity: string): void {
	if (current == null || livekit == null) return;
	const watched = state.watchingIdentities.includes(identity);
	for (const publication of current.remoteParticipants.get(identity)?.trackPublications.values() ?? []) {
		if (publication.source === livekit.Track.Source.ScreenShareAudio) publication.setSubscribed(watched);
	}
	const publication = screenSharePublicationOf(current, identity);
	if (publication == null) return;
	if (!watched && !(isScreenSharePreviewed(identity) && hasLowerLayer(publication))) {
		if (publication.isDesired) publication.setSubscribed(false);
		return;
	}
	// 画質の指定は受け取る希望を出してからでないと無視される
	if (!publication.isDesired) publication.setSubscribed(true);
	publication.setVideoQuality(watched ? livekit.VideoQuality.HIGH : livekit.VideoQuality.LOW);
}

function forgetScreenShare(identity: string): void {
	state.screenShareIdentities = state.screenShareIdentities.filter(x => x !== identity);
	screenShareTracks.delete(identity);
	state.watchingIdentities = state.watchingIdentities.filter(x => x !== identity);
	syncScreenShareSubscription(identity);
}

function captureOptions(): AudioCaptureOptions {
	return {
		deviceId: prefer.s['voiceCall.inputDeviceId'] ?? undefined,
		echoCancellation: prefer.s['voiceCall.echoCancellation'],
		noiseSuppression: prefer.s['voiceCall.noiseSuppression'],
		autoGainControl: prefer.s['voiceCall.autoGainControl'],
	};
}

// undeafenAt: マイクが入ったらスピーカーも戻すとき、そう決めたときの deafenRevision
async function enableMicrophone(room: Room, undeafenAt: number | null = null): Promise<void> {
	try {
		await room.localParticipant.setMicrophoneEnabled(true, captureOptions());
		if (current !== room) return;
		state.micEnabled = true;
		// 待っているあいだにスピーカーを切り替えていなければ、マイクと一緒にスピーカーも戻す
		if (undeafenAt != null && undeafenAt === deafenRevision && state.deafened) {
			state.deafened = false;
			applyVolumes(room);
		}
		// 許可を待つあいだなどにスピーカーが切られていたら、入ったマイクをすぐ切る (スピーカーを切っているあいだはマイクを入れない)
		if (state.deafened) {
			await disableMicrophone(room).catch(() => reportStatus(room));
			return;
		}
		startLocalMeter(room);
		reportStatus(room);
	} catch {
		// マイクが無い・許可されない場合でも、聞くだけの参加者として通話に残る
		if (current !== room) return;
		state.micEnabled = false;
		stopLocalMeter?.();
		reportStatus(room);
		os.toast(i18n.ts._voiceCall.micUnavailable);
	}
}

async function disableMicrophone(room: Room): Promise<void> {
	await room.localParticipant.setMicrophoneEnabled(false, captureOptions());
	if (current !== room) return;
	state.micEnabled = false;
	stopLocalMeter?.();
	unwatchMicrophoneTrack?.();
	reportStatus(room);
}

// audio 要素の volume は 0〜1 しか受け付けない (範囲外は IndexSizeError)
function clampVolume(volume: number): number {
	return Math.min(1, Math.max(0, volume));
}

function volumeOf(identity: string, audio: ParticipantAudio): number {
	if (state.deafened) return 0;
	return participantVolume(identity, audio);
}

function applyVolume(participant: RemoteParticipant): void {
	const { Track } = livekit!;
	participant.setVolume(volumeOf(participant.identity, 'voice'), Track.Source.Microphone);
	participant.setVolume(volumeOf(participant.identity, 'screenShare'), Track.Source.ScreenShareAudio);
}

function applySubscription(lk: LiveKit, publication: TrackPublication, participant: RemoteParticipant): void {
	const remote = publication as RemoteTrackPublication;
	switch (publication.source) {
		case lk.Track.Source.Microphone:
			remote.setSubscribed(true);
			break;
		case lk.Track.Source.ScreenShareAudio:
			remote.setSubscribed(state.watchingIdentities.includes(participant.identity));
			break;
		case lk.Track.Source.ScreenShare:
			if (!state.screenShareIdentities.includes(participant.identity)) {
				state.screenShareIdentities = [...state.screenShareIdentities, participant.identity];
			}
			syncScreenShareSubscription(participant.identity);
			break;
		default:
			remote.setSubscribed(false);
	}
}

function bindRoomEvents(lk: LiveKit, room: Room): void {
	const { RoomEvent, Track } = lk;
	const isCurrent = () => current === room;

	room.on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
		if (isCurrent()) applySubscription(lk, publication, participant);
	});

	room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
		if (!isCurrent()) return;
		if (track.kind === Track.Kind.Audio) {
			addRecordingTrack(track.mediaStreamTrack, 'others');
			window.document.body.appendChild(track.attach());
			applyVolume(participant);
			return;
		}
		if (track.kind === Track.Kind.Video) addRecordingVideo(track.mediaStreamTrack, publication.source === Track.Source.ScreenShare);
		if (publication.source === Track.Source.ScreenShare) {
			screenShareTracks.set(participant.identity, track);
			for (const view of screenShareViews.get(participant.identity) ?? []) track.attach(view.element);
		}
	});

	room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
		if (track.kind === Track.Kind.Audio) {
			removeRecordingTrack(track.mediaStreamTrack);
			for (const element of track.detach()) element.remove();
			return;
		}
		if (track.kind === Track.Kind.Video) removeRecordingVideo(track.mediaStreamTrack);
		if (publication.source === Track.Source.ScreenShare) {
			for (const view of screenShareViews.get(participant.identity) ?? []) track.detach(view.element);
			screenShareTracks.delete(participant.identity);
		}
	});

	room.on(RoomEvent.TrackUnpublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
		if (isCurrent() && publication.source === Track.Source.ScreenShare) forgetScreenShare(participant.identity);
	});

	room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
		if (isCurrent()) forgetScreenShare(participant.identity);
	});

	// 自分の共有画面も、送っているあいだはチップやタイルのプレビューと見ている画面に映し、何を共有しているか確かめられるようにする。
	// 映すのは映像だけで、共有している音声は手元では鳴らさない (鳴らすと二重に聞こえる)。
	// 接続をやり直すときは、LiveKit が共有中のトラックをいったん外して送り直すので、ここにもう一度来る
	room.on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication, participant: LocalParticipant) => {
		const track = publication.track;
		if (!isCurrent()) return;
		if (publication.source === Track.Source.Microphone) {
			startLocalMeter(room);
			if (track != null) addRecordingTrack(track.mediaStreamTrack, 'mic');
			return;
		}
		if (publication.source === Track.Source.ScreenShareAudio) {
			// my own tab audio is not played to my speakers, so it only reaches the recording here
			if (track != null) addRecordingTrack(track.mediaStreamTrack, 'others');
			return;
		}
		if (publication.source !== Track.Source.ScreenShare || track == null) return;
		addRecordingVideo(track.mediaStreamTrack, true);
		state.screenSharing = true;
		screenShareTracks.set(participant.identity, track);
		for (const view of screenShareViews.get(participant.identity) ?? []) track.attach(view.element);
	});

	room.on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication, participant: LocalParticipant) => {
		// ブラウザの「共有を停止」で終わった場合もここに来る
		if (!isCurrent()) return;
		if (publication.source === Track.Source.ScreenShareAudio) {
			const track = publication.track;
			if (track != null) removeRecordingTrack(track.mediaStreamTrack);
			return;
		}
		if (publication.source !== Track.Source.ScreenShare) return;
		const track = publication.track;
		if (track != null) removeRecordingVideo(track.mediaStreamTrack);
		state.screenSharing = false;
		detachLocalScreenShare(participant.identity);
		forgetScreenShare(participant.identity);
	});

	room.on(RoomEvent.TrackMuted, (publication: TrackPublication, participant: Participant) => {
		if (!isCurrent()) return;
		// オーナーによる強制ミュート
		if (participant === room.localParticipant && publication.source === Track.Source.Microphone) {
			state.micEnabled = false;
			stopLocalMeter?.();
			reportStatus(room);
		}
	});

	room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
		if (!isCurrent()) return;
		const localIdentity = room.localParticipant.identity;
		const others = speakers.filter(speaker => speaker.identity !== localIdentity).map(speaker => speaker.identity);
		// 自分の発話は、マイクの音を手元で測れているあいだはその結果 (サーバーの知らせより速い) で示し、
		// 測れていない (AudioContext が無い、自動再生の制限で止まっていて無音しか返らないなど) ときはサーバーの知らせに従う
		const metered = stopLocalMeter != null && localMeterContext?.state !== 'suspended';
		const localSpeaking = metered ? state.speakingIdentities.includes(localIdentity) : speakers.some(speaker => speaker.identity === localIdentity);
		state.speakingIdentities = localSpeaking ? [...others, localIdentity] : others;
		if (!metered) state.localSpeaking = localSpeaking;
	});

	room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
		if (isCurrent()) state.audioBlocked = !room.canPlaybackAudio;
	});

	room.on(RoomEvent.Reconnecting, () => {
		if (isCurrent()) {
			state.status = 'reconnecting';
			const refresh = iceRefresh;
			if (refresh?.room === room && Date.now() - refresh.lastSuccess >= ICE_REFRESH_STALE_MS) {
				if (refresh.timer != null) window.clearTimeout(refresh.timer);
				refresh.timer = null; void refreshIceServers(refresh);
			}
		}
	});

	room.on(RoomEvent.Reconnected, () => {
		if (isCurrent()) {
			state.status = 'connected';
			// Keep same-session reports serialized, including requests still in flight before reconnecting.
			reportStatus(room, true);
			startLocalMeter(room);
		}
	});

	room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
		// 自分で退出した場合は leaveVoiceCall が先に current を外しているので何もしない
		if (!isCurrent()) return;
		current = null;
		joinAttempt++;
		detachAll(room);
		resetState();
		const message = disconnectMessage(lk, reason);
		if (message != null) os.toast(message);
	});
}

function disconnectMessage(lk: LiveKit, reason: DisconnectReason | undefined): string | null {
	switch (reason) {
		case lk.DisconnectReason.CLIENT_INITIATED: return null;
		case lk.DisconnectReason.DUPLICATE_IDENTITY: return i18n.ts._voiceCall.joinedFromAnotherTab;
		case lk.DisconnectReason.PARTICIPANT_REMOVED: return i18n.ts._voiceCall.removedFromCall;
		case lk.DisconnectReason.ROOM_DELETED: return i18n.ts._voiceCall.callEnded;
		default: return i18n.ts._voiceCall.connectionFailed;
	}
}

// 止めた自分の共有画面を、映している要素から外す (止めたトラックの最後の画のまま残さない)
function detachLocalScreenShare(identity: string): void {
	const track = screenShareTracks.get(identity);
	if (track == null) return;
	for (const view of screenShareViews.get(identity) ?? []) track.detach(view.element);
}

function detachAll(room: Room): void {
	detachLocalScreenShare(room.localParticipant.identity);
	for (const participant of room.remoteParticipants.values()) {
		for (const publication of participant.trackPublications.values()) {
			const track = publication.track;
			if (track == null) continue;
			const elements = track.detach();
			// 音声の要素はここで作ったものなので消す。映像の要素は画面の部品のものなので、外すのは部品に任せる
			if (track.kind === livekit?.Track.Kind.Audio) {
				for (const element of elements) element.remove();
			}
		}
	}
}

export function notifyVoiceCallFailure(err?: unknown): void {
 const code = isApiError(err) ? err.code : undefined;
 const message = code === 'VOICE_RELAY_CAPACITY_EXCEEDED' ? i18n.ts._voiceRelay.full : code === 'VOICE_RELAY_UNREACHABLE' ? i18n.ts._voiceRelay.unreachable : code === 'VOICE_RELAY_REVOKED' ? i18n.ts._voiceRelay.revoked : code === 'REMOTE_HOST_UNSUPPORTED' ? i18n.ts._voiceCall.remoteHostUnsupported : i18n.ts._voiceCall.connectionFailed;
 os.toast(message);
}

function failToConnect(err?: unknown): void { resetState(); notifyVoiceCallFailure(err); }

function resetState(): void {
	stopIceRefresh();
	resetStatusDelivery();
	stopRecording();
	state.recording = false;
	state.recordingStartedAt = null;
	stopLocalMeter?.();
	unwatchMicrophoneTrack?.();
	screenShareTracks.clear();
	state.status = 'idle';
	state.room = null;
	state.mediaProvider = null;
	screenShareLimits = undefined;
	state.micEnabled = false;
	state.deafened = false;
	state.audioBlocked = false;
	state.speakingIdentities = [];
	state.localSpeaking = false;
	state.screenSharing = false;
	state.screenShareIdentities = [];
	state.watchingIdentities = [];
}
