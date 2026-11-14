/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { reactive, readonly } from 'vue';
import * as Misskey from 'cherrypick-js';
import { apiUrl, url } from '@@/js/config.js';
import { $i } from '@/i.js';
import { instance } from '@/instance.js';
import type { AudioCaptureOptions, DisconnectReason, LocalAudioTrack, LocalParticipant, LocalTrack, LocalTrackPublication, Participant, RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, RoomConnectOptions, TrackPublication, VideoPreset } from 'livekit-client';
import { misskeyApi } from '@/utility/misskey-api.js';
import { isApiError } from '@/utility/api-error.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { userNameForLabel } from '@/filters/user.js';
import { createRecordingSegments, recordingSegmentBytes } from '@/utility/recording-recorder.js';

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
	// 通話の録画 (声と画面)。録画中は参加者に知らせる
	recording: false,
	recordingStarting: false,
	recordingStartedAt: null as number | null,
	// ルームの持ち主が録画を許しているか (既定では許さない)
	recordingAllowed: false,
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
	// 녹음 시작 승인을 기다리는 쪽. 녹음 보고가 수락되거나 영구 거절되면 알려 준다
	approval: { resolve: () => void; reject: (err: unknown) => void } | null;
};
let statusDelivery: StatusDelivery | null = null;
// スピーカーを切り替えた回数。マイクを入れるのを待つあいだに切り替えられたかを見分ける
let deafenRevision = 0;

// record the whole call as one file: a single recorder mixes every voice and, when present, the shared screens
type RecordingUploadReason = 'noFreeSpace' | 'tooLarge' | 'network' | null;
// a failed part keeps its blob only when the upload itself failed; once the original reached the drive the blob is
// released and a device download fetches it back from `url`
type FailedRecording = { blob: Blob | null; name: string; ext: string; reason: RecordingUploadReason; fileId?: string; url?: string | null };

class RecordingUploadError extends Error {
	constructor(public reason: RecordingUploadReason, public fileId?: string, public url?: string | null) {
		super('Failed to save or convert the recording');
	}
}
/**
 * 一回の録画。通話の状態 (state.room) とは別に持ち、通話が終わって状態が片付いた後に届く最後の部分も同じ録画として保存する
 */
type RecordingSession = {
	roomId: string;
	uploads: Promise<boolean>[];
	failed: FailedRecording[];
	stopping: boolean;
	micRevision: number;
	// uploaded originals held back until we know whether the call ever has video
	pending: { fileId: string; name: string; url: string | null }[];
	hasVideo: boolean;
	folderId: string | null;
	folderName: string | null;
	name: string;
	ext: string;
};
type RecordingPart = {
	stop: () => void;
	name: string;
};
let recordingPart: RecordingPart | null = null;
let recordingSession: RecordingSession | null = null;
// サーバーが録画を受け付けるのを待っているあいだ。二重に始めない
let recordingStarting: object | null = null;
let recordingContext: AudioContext | null = null;
let recordingMicBus: GainNode | null = null;
let recordingMixedDest: MediaStreamAudioDestinationNode | null = null;
let recordingConversions: Promise<void> = Promise.resolve();
let recordingRawMicStream: MediaStream | null = null;
const recordingSources = new Map<MediaStreamTrack, { source: MediaStreamAudioSourceNode; kind: 'mic' | 'others' }>();
let recordingCanvas: HTMLCanvasElement | null = null;
let recordingCanvasStream: MediaStream | null = null;
let recordingDrawTimer: number | null = null;
const recordingVideos = new Map<MediaStreamTrack, { element: HTMLVideoElement; screen: boolean }>();

function recordingMimeType(): string | undefined {
	if (typeof MediaRecorder === 'undefined') return undefined;
	return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
}

function recordingVideoMimeType(): string | undefined {
	if (typeof MediaRecorder === 'undefined') return undefined;
	return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
}

function addRecordingVideo(track: MediaStreamTrack, screen: boolean): void {
	// this runs on every share, not only while recording
	if (recordingSession?.stopping !== false || recordingContext == null || recordingVideos.has(track)) return;
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
	markRecordingVideo();
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

/** capture the compositing canvas from the start so a share that appears mid-recording lands in the same file */
function createRecordingCanvas(): MediaStream | null {
	try {
		const canvas = window.document.createElement('canvas');
		canvas.width = 1920;
		canvas.height = 1080;
		const stream = canvas.captureStream(30);
		recordingCanvas = canvas;
		if (typeof HTMLVideoElement.prototype.requestVideoFrameCallback !== 'function') {
			recordingDrawTimer = window.setInterval(drawRecordingFrame, 33);
		}
		drawRecordingFrame();
		return stream;
	} catch (err) {
		// without a canvas we cannot add video later; this stays an audio-only recording
		console.warn('[recording] could not capture the canvas; recording audio only', err);
		recordingCanvas = null;
		return null;
	}
}

/** note that the call now has video; held originals are converted as video from here on */
function markRecordingVideo(): void {
	const session = recordingSession;
	if (session == null || session.stopping || session.hasVideo || recordingCanvasStream == null) return;
	session.hasVideo = true;
	flushPendingRecordings(session, true);
	drawRecordingFrame();
}

function removeRecordingVideo(track: MediaStreamTrack): void {
	const entry = recordingVideos.get(track);
	if (entry == null) return;
	entry.element.pause();
	entry.element.srcObject = null;
	recordingVideos.delete(track);
	drawRecordingFrame();
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
	if (recordingSession?.stopping !== false || recordingContext == null) return;
	// the microphone passes through a gain bus so muting stays in sync; other voices feed the mix directly
	const dest = kind === 'mic' ? recordingMicBus : recordingMixedDest;
	if (dest == null || recordingSources.has(track)) return;
	try {
		const source = recordingContext.createMediaStreamSource(new MediaStream([track]));
		source.connect(dest);
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

// ドライブのファイル名規則 (200 文字以内、\ / .. は使えない) に合わせ、絵文字のshortcodeと零幅文字も落とす。
// 末尾の -NNN と拡張子を入れても 200 に収まるよう、名前の部分は 175 文字までに切る
const RECORDING_NAME_MAX = 175;

function sanitizeRecordingName(name: string): string {
	let cleaned = name
		.replace(/:[\w+-]+(?:@[\w.-]+)?:/g, ' ')
		.replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
		.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
		.replace(/\.\./g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length > RECORDING_NAME_MAX) {
		cleaned = cleaned.slice(0, RECORDING_NAME_MAX);
		// 代理pairの途中で切らない
		const last = cleaned.charCodeAt(cleaned.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) cleaned = cleaned.slice(0, -1);
		cleaned = cleaned.trim();
	}
	return cleaned;
}

/** 1:1 なら相手の名前、それ以外ならルーム名で録画ファイルを名付ける */
async function recordingFileLabel(room: Room, roomId: string): Promise<string> {
	const fallback = sanitizeRecordingName(state.room?.name ?? '') || 'voice';
	if (room.remoteParticipants.size !== 1) return fallback;
	const otherIdentity = [...room.remoteParticipants.keys()][0];
	try {
		const states = await misskeyApi('chat/rooms/voice/states', { roomIds: [roomId] });
		const voiceState = Array.isArray(states) ? states.find(candidate => candidate.roomId === roomId) : null;
		const other = voiceState?.participants.find(participant => participant.identity === otherIdentity);
		if (other != null) return sanitizeRecordingName(userNameForLabel(other.user)) || fallback;
	} catch {
		// 参加者一覧が取れなければルーム名で保存する
	}
	return fallback;
}

/** 利用者の言語の録画フォルダを探す。無ければ作り、どちらも駄目ならルートに保存する */
async function findRecordingFolder(): Promise<{ id: string; name: string } | null> {
	const name = i18n.ts._voiceCall.recordingFolderName;
	try {
		const found = await misskeyApi('drive/folders/find', { name, parentId: null });
		if (Array.isArray(found)) {
			const match = found.find(folder => folder.name === name);
			if (match?.id != null) return { id: match.id, name };
		}
		const created = await misskeyApi('drive/folders/create', { name });
		if (created?.id != null) return { id: created.id, name };
		return null;
	} catch (err) {
		console.warn('[recording] could not prepare the recordings folder; saving to the drive root', err);
		return null;
	}
}

/** 녹화 원본을 드라이브에 올린다. 변환은 따로 처리하며, 이미 올라간 원본은 다시 올리지 않는다. */
async function uploadRecordingOriginal(session: RecordingSession, blob: Blob, name: string): Promise<{ fileId: string; url: string | null }> {
	const form = new FormData();
	form.append('file', new File([blob], `${name}${session.ext}`, { type: blob.type }));
	// 변환 후 정리할 원본이 기존 첨부와 공유되지 않도록 독립 파일로 저장한다.
	form.append('force', 'true');
	if (session.folderId != null) form.append('folderId', session.folderId);
	if ($i != null) form.append('i', $i.token);
	let res: Response;
	try {
		res = await window.fetch(apiUrl + '/drive/files/create', { method: 'POST', body: form, credentials: 'omit' });
	} catch {
		throw new RecordingUploadError('network');
	}
	if (!res.ok) {
		const body = await res.json().catch(() => null) as { error?: { id?: string } } | null;
		const id = body?.error?.id;
		const reason = id === 'd08dbc37-a6a9-463a-8c47-96c32ab5f064' ? 'noFreeSpace'
			: res.status === 413 || id === 'b9d8c348-33f0-4673-b9a9-5d4da058977a' ? 'tooLarge' : null;
		throw new RecordingUploadError(reason);
	}
	const file = await res.json() as Misskey.entities.DriveFile;
	return { fileId: file.id, url: file.url ?? null };
}

/** 올라간 원본을 변환한다. 폴더가 사라졌으면 루트로 한 번만 다시 시도한다. */
async function convertRecordingOriginal(session: RecordingSession, fileId: string, url: string | null, video: boolean): Promise<void> {
	// the server converts one recording per user at a time, so convert the parts one after another
	const conversion = recordingConversions.then(async () => {
		let converted: Misskey.entities.DriveFile | null;
		try {
			converted = await misskeyApi('chat/rooms/voice/convert-recording', { fileId, video, folderId: session.folderId });
		} catch (error) {
			if (isApiError(error) && error.code === 'NO_SUCH_FOLDER') {
				session.folderId = null;
				converted = await misskeyApi('chat/rooms/voice/convert-recording', { fileId, video, folderId: null });
			} else {
				throw error;
			}
		}
		if (converted?.id == null || converted.id === fileId) return;
		await misskeyApi('drive/files/delete', { fileId }).catch(error => {
			console.warn('[recording] could not delete the converted original', error);
		});
	});
	recordingConversions = conversion.then(() => {}, () => {});
	try {
		await conversion;
	} catch (error) {
		const code = isApiError(error) ? error.code : null;
		const reason = code === 'OUTPUT_TOO_LARGE' ? 'tooLarge' : code === 'NO_FREE_SPACE' ? 'noFreeSpace' : null;
		throw new RecordingUploadError(reason, fileId, url);
	}
}

/** 変換結果を録画ごとに数える。失敗した部分は捨てずに残し、録画が終わった後で再試行できるようにする */
function convertAndTrack(session: RecordingSession, entry: { fileId: string; name: string; url: string | null }, video: boolean): void {
	session.uploads.push(convertRecordingOriginal(session, entry.fileId, entry.url, video).then(() => true, err => {
		console.error(err);
		session.failed.push({ blob: null, name: entry.name, ext: session.ext, reason: err instanceof RecordingUploadError ? err.reason : null, fileId: err instanceof RecordingUploadError ? (err.fileId ?? entry.fileId) : entry.fileId, url: entry.url });
		return false;
	}));
}

/** 아직 영상이 나오지 않는 동안 올려 둔 원본을, 영상 유무가 정해진 시점에 변환한다 */
function flushPendingRecordings(session: RecordingSession, video: boolean): void {
	const pending = session.pending;
	session.pending = [];
	for (const entry of pending) convertAndTrack(session, entry, video);
}

/** 올린 결과를 녹화ごとに 센다. 아직 영상이 없으면 변환을 미루고, 녹화가 끝나거나 영상이 나오면 변환한다 */
function trackRecordingUpload(session: RecordingSession, blob: Blob, name: string): void {
	if (blob.size === 0) return;
	session.uploads.push((async () => {
		try {
			const { fileId, url } = await uploadRecordingOriginal(session, blob, name);
			if (session.hasVideo) {
				await convertRecordingOriginal(session, fileId, url, true);
			} else if (session.stopping) {
				await convertRecordingOriginal(session, fileId, url, false);
			} else {
				session.pending.push({ fileId, name, url });
			}
			return true;
		} catch (err) {
			console.error(err);
			const fileId = err instanceof RecordingUploadError ? err.fileId : undefined;
			// 변환 실패는 원본이 이미 드라이브에 있으므로 blob을 해제하고, 업로드 실패는 blob을 유지한다
			session.failed.push({ blob: fileId != null ? null : blob, name, ext: session.ext, reason: err instanceof RecordingUploadError ? err.reason : null, fileId, url: err instanceof RecordingUploadError ? err.url : undefined });
			return false;
		}
	})());
}

/** 재시도: 올라간 원본은 다시変換만 하고, 업로드 실패는 처음부터 다시 올린다 */
async function retryRecording(session: RecordingSession, recording: FailedRecording): Promise<void> {
	let fileId = recording.fileId;
	let url = recording.url ?? null;
	if (fileId == null) {
		const uploaded = await uploadRecordingOriginal(session, recording.blob!, recording.name);
		fileId = uploaded.fileId;
		url = uploaded.url;
	}
	await convertRecordingOriginal(session, fileId, url, session.hasVideo);
}

function createRecordingPart(session: RecordingSession, stream: MediaStream, mime: string | undefined, video: boolean): void {
	const options: MediaRecorderOptions = { ...(mime != null ? { mimeType: mime } : {}), audioBitsPerSecond: 256_000 };
	if (video) options.videoBitsPerSecond = 12_000_000;
	if ($i == null) throw new Error('Recording requires an authenticated user');
	const recorder = createRecordingSegments(stream, options, recordingSegmentBytes($i.policies.maxFileSizeMb, instance.maxFileSize), {
		onSegment: (blob, index) => trackRecordingUpload(session, blob, index === 1 ? session.name : `${session.name}-${String(index).padStart(3, '0')}`),
		onStop: () => {
			recordingPart = null;
			teardownRecording();
		},
		onError: error => {
			console.error(error);
			stopRecording();
			os.toast(i18n.ts._voiceCall.recordingStopped);
		},
	});
	recordingPart = { stop: recorder.stop, name: session.name };
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
	const session = recordingSession;
	recordingSession = null;
	if (session != null) void finishRecordingSession(session);
	recordingMicBus = null;
	recordingMixedDest = null;
	recordingRawMicStream?.getTracks().forEach(track => track.stop());
	recordingRawMicStream = null;
	recordingContext?.close().catch(() => {});
	recordingContext = null;
	recordingSources.clear();
}

/** 録画のすべての部分を上げ終えてから知らせる。保存できたと言うのは、本当に全部保存できたときだけ */
async function finishRecordingSession(session: RecordingSession): Promise<void> {
	// 通常は停止時に片付いているが、取りこぼした保留分もここで変換する
	flushPendingRecordings(session, session.hasVideo);
	if (session.uploads.length === 0) return;
	await Promise.all(session.uploads);
	if (session.failed.length === 0) {
		toastRecordingSaved(session);
		return;
	}
	await offerFailedRecordings(session);
}

function toastRecordingSaved(session: RecordingSession): void {
	os.toast(session.folderName != null
		? i18n.tsx._voiceCall.recordingSavedToFolder({ folder: session.folderName })
		: i18n.ts._voiceCall.recordingSaved);
}

async function downloadRecording(recording: FailedRecording): Promise<void> {
	let blob = recording.blob;
	// 변환 실패로 blob을 놓아준 원본은 드라이브에서 다시 받아온다
	if (blob == null) {
		if (recording.url == null) {
			os.toast(i18n.ts._voiceCall.recordingDownloadFailed);
			return;
		}
		try {
			const res = await window.fetch(recording.url, { credentials: 'omit' });
			if (!res.ok) throw new Error(`download failed: ${res.status}`);
			blob = await res.blob();
		} catch (err) {
			console.warn('[recording] could not download the original from the drive', err);
			os.toast(i18n.ts._voiceCall.recordingDownloadFailed);
			return;
		}
	}
	const objectUrl = URL.createObjectURL(blob);
	const a = window.document.createElement('a');
	a.href = objectUrl;
	a.download = `${recording.name}${recording.ext}`;
	a.click();
	window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/** 버리기를 확정하면 이미 드라이브에 올라간 원본도 지운다. 저장에 성공한 부분의 변환 결과는 버리기 대상이 아니다. 삭제에 실패한 원본은 목록에 남도록 돌려준다. */
async function discardUploadedOriginals(failed: FailedRecording[]): Promise<FailedRecording[]> {
	const undeleted: FailedRecording[] = [];
	await Promise.all(failed.map(async recording => {
		if (recording.fileId == null) return;
		try {
			await misskeyApi('drive/files/delete', { fileId: recording.fileId });
		} catch (error) {
			// 이미 지워진 파일은 성공으로 취급한다. 그 밖의 실패는 원본을 남겨 다시 버릴 수 있게 한다
			if (isApiError(error) && error.code === 'NO_SUCH_FILE') return;
			console.warn('[recording] could not delete a discarded original', error);
			undeleted.push(recording);
		}
	}));
	return undeleted;
}

/** 保存できなかった部分は、利用者が選ぶまで手元に残す (もう一度上げる・この機器に保存する・捨てる) */
async function offerFailedRecordings(session: RecordingSession): Promise<void> {
	let failed = session.failed;
	while (failed.length > 0) {
		const reason = (['noFreeSpace', 'tooLarge', 'network'] as const).find(candidate => failed.some(recording => recording.reason === candidate));
		const failedPart = failed.find(recording => recording.reason === reason);
		const hasOriginal = failed.some(recording => recording.fileId != null);
		const hasUploadFailure = failed.some(recording => recording.fileId == null);
		const caption = reason === 'noFreeSpace' ? (failedPart?.fileId != null ? i18n.ts._voiceCall.recordingConversionNoFreeSpace : i18n.ts.cannotUploadBecauseNoFreeSpace)
			: reason === 'tooLarge' ? (failedPart?.fileId != null ? i18n.ts._voiceCall.recordingConversionTooLarge : i18n.ts.cannotUploadBecauseExceedsFileSizeLimit)
				: reason === 'network' ? i18n.ts.cannotUploadBecauseNetworkError : undefined;
		const text = hasOriginal
			? hasUploadFailure ? i18n.ts._voiceCall.recordingMixedFailure : i18n.tsx._voiceCall.recordingConversionFailed({ n: failed.length })
			: i18n.tsx._voiceCall.recordingSaveFailed({ n: failed.length });
		const { canceled, result } = await os.actions({
			type: 'error',
			text,
			caption,
			actions: [
				{ value: 'retry', text: i18n.ts.retry, primary: true },
				{ value: 'download', text: i18n.ts._voiceCall.recordingSaveToDevice },
				{ value: 'discard', text: i18n.ts._voiceCall.recordingDiscard, danger: true },
			],
		});
		// 閉じただけでは捨てない。選ぶまでもう一度聞く
		if (canceled) continue;
		if (result === 'download') {
			for (const recording of failed) await downloadRecording(recording);
			return;
		}
		if (result === 'discard') {
			const confirmed = await os.confirm({ type: 'warning', text: hasOriginal ? i18n.ts._voiceCall.recordingDiscardConfirmUploaded : i18n.ts._voiceCall.recordingDiscardConfirm });
			if (!confirmed.canceled) {
				const undeleted = await discardUploadedOriginals(failed);
				if (undeleted.length === 0) return;
				// 삭제에 실패한 원본은 드라이브에 남는다. 오류로 알리고 다시 버릴 수 있게 목록을 유지한다.
				// 알림이 닫힌 뒤에 목록을 다시 띄운다. 바로 띄우면 알림이 목록 뒤에 가려져 보이지 않는다
				failed = undeleted;
				await os.alert({ type: 'error', text: i18n.tsx._voiceCall.recordingDiscardDeleteFailed({ n: undeleted.length }) });
			}
			continue;
		}
		const retrying = failed;
		failed = [];
		const results = await os.promiseDialog(Promise.all(retrying.map(recording => retryRecording(session, recording).then(() => true, err => {
			console.error(err);
			const fileId = err instanceof RecordingUploadError ? (err.fileId ?? recording.fileId) : recording.fileId;
			failed.push({ blob: fileId != null ? null : recording.blob, name: recording.name, ext: recording.ext, reason: err instanceof RecordingUploadError ? err.reason : null, fileId, url: err instanceof RecordingUploadError ? (err.url ?? recording.url) : recording.url });
			return false;
		}))), null, null);
		if (results.every(ok => ok)) toastRecordingSaved(session);
	}
}

function resetStatusDelivery(): void {
	if (statusDelivery?.timer != null) window.clearTimeout(statusDelivery.timer);
	statusDelivery?.approval?.reject(new Error('Recording approval canceled'));
	statusDelivery = null;
}

// Keep only the newest settings. A failed report must not leave the server stale for the rest of the call.
// 録音中かどうかもいまの値一つだけを実って送り、終わった録音の痕跡は残さない
function reportStatus(room: Room, force = false): void {
	const roomId = state.room?.id;
	if (current !== room || roomId == null || state.status === 'connecting') return;
	const recording = state.recording || recordingStarting != null;
	const sessionId = room.localParticipant.sid;
	const prev = statusDelivery != null && statusDelivery.room === room && statusDelivery.latest.sessionId === sessionId ? statusDelivery : null;
	const status = { roomId, sessionId, micMuted: !state.micEnabled, deafened: state.deafened, recording };
	let delivery: StatusDelivery;
	if (prev == null) {
		resetStatusDelivery();
		delivery = { room, latest: status, pending: status, sending: false, retryDelay: 1000, timer: null, stopped: false, approval: null };
		statusDelivery = delivery;
	} else {
		if (!force && prev.latest.micMuted === status.micMuted && prev.latest.deafened === status.deafened && prev.latest.recording === status.recording) return;
		// 止めたのは失敗した報告の再送だけ。設定が変わったら、新しい設定はもう一度だけ送ってみる
		// (セッションを確かめる一時的な失敗も ACCESS_DENIED になるので、一度の失敗で通話の残りずっと黙らない)
		prev.stopped = false;
		prev.latest = status;
		prev.pending = status;
		delivery = prev;
	}
	void deliverStatus(delivery);
}

async function deliverStatus(delivery: StatusDelivery): Promise<void> {
	if (statusDelivery !== delivery || current !== delivery.room || delivery.sending || delivery.timer != null || delivery.stopped || delivery.pending == null) return;
	const status = delivery.pending;
	delivery.pending = null;
	delivery.sending = true;
	try {
		await misskeyApi('chat/rooms/voice/status', status);
		delivery.retryDelay = 1000;
		// 録音報告が受け付けられたら、開始を待っている側に知らせる
		if (status.recording === true && delivery.approval != null) {
			delivery.approval.resolve();
			delivery.approval = null;
		}
	} catch (err) {
		if (statusDelivery !== delivery || current !== delivery.room) return;
		const code = isApiError(err) ? err.code : null;
		const permanent = code != null && code !== 'RATE_LIMIT_EXCEEDED' && code !== 'INTERNAL_ERROR' && code !== 'REMOTE_HOST_UNREACHABLE';
		if (code === 'RECORDING_NOT_ALLOWED') state.recordingAllowed = false;
		if (permanent && status.recording === true) {
			if (delivery.approval != null) {
				// まだ開始を待っているあいだの拒否は、開始側が後片付けして知らせる
				delivery.approval.reject(err);
				delivery.approval = null;
			} else if (recordingStarting != null || recordingSession != null) {
				// 録画していると伝えるのを断られたら (持ち主が許さなくなった・通話の資格を確かめられないなど)、理由によらず録画を止め、止めたことを伝える
				stopRecording();
				os.toast(i18n.ts._voiceCall.recordingRejected);
			}
		}
		if (permanent) {
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
	const onRestarted = () => {
		if (current !== room) return;
		startLocalMeter(room);
		if (recordingSession != null) void captureRecordingMicrophone(recordingSession, room);
	};
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
	stopRecording();
	current = null;
	stopIceRefresh();
	if (room != null) {
		await room.disconnect();
		detachAll(room);
	}
}

/** start recording the whole call as one file (every voice, plus the shared screens when present) */
export async function startRecording(): Promise<void> {
	const room = current;
	const roomId = state.room?.id;
	if (room == null || roomId == null || recordingStarting || recordingPart != null || state.status !== 'connected' || !state.recordingAllowed) return;
	const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (Context == null || typeof MediaRecorder === 'undefined') return;

	// 시작 전체에 소유권을 두어, 취소한 대기의 continuation이 다음 통화의 자원을 덮어쓰지 못하게 한다.
	const attempt = {};
	recordingStarting = attempt;
	state.recordingStarting = true;
	const active = () => recordingStarting === attempt && current === room && state.room?.id === roomId && state.status === 'connected' && state.recordingAllowed;
	let approved = false;
	try {
		// 서버가 녹음을 받아들이는지 먼저 보고한다. 수락과 일시 오류 재시도는 상태 보고의 배달 경로가 맡는다
		reportStatus(room, true);
		const delivery = statusDelivery;
		if (delivery == null || delivery.room !== room) return;
		await new Promise<void>((resolve, reject) => { delivery.approval = { resolve, reject }; });
		approved = true;
		if (!active()) {
			if (current === room && recordingStarting == null && recordingSession == null) reportStatus(room, true);
			return;
		}
		const session: RecordingSession = { roomId, uploads: [], failed: [], stopping: false, micRevision: 0, pending: [], hasVideo: false, folderId: null, folderName: null, name: 'voice', ext: '.webm' };
		recordingSession = session;

		const context = new Context();
		// resume을 기다리는 동안에도 stopRecording이 이 context를 닫을 수 있다.
		recordingContext = context;
		await context.resume();
		if (!active()) return;

		const mixedDest = context.createMediaStreamDestination();
		mixedDest.channelCount = 2;
		mixedDest.channelCountMode = 'explicit';
		const micBus = context.createGain();
		micBus.connect(mixedDest);
		recordingMixedDest = mixedDest;
		recordingMicBus = micBus;
		recordingSources.clear();

		syncRecordingMicrophone();

		// 저장 폴더와 파일 이름을 미리 준비한다. 폴더가 없으면 루트에 저장한다
		const [folder, label] = await Promise.all([findRecordingFolder(), recordingFileLabel(room, roomId)]);
		if (!active()) return;
		session.folderId = folder?.id ?? null;
		session.folderName = folder?.name ?? null;
		const startedAt = new Date();
		session.name = `${label}-${recordingStamp(startedAt)}`;

		// 처음부터 캔버스를 capture해 두면, 녹음 중간에 나타난 화면도 같은 파일에 담긴다
		recordingCanvasStream = createRecordingCanvas();

		await captureRecordingMicrophone(session, room);
		if (!active()) return;
		const lk = livekit;
		if (lk != null) {
			// my own tab audio is not played to my speakers, so it only reaches the recording here
			const shareAudio = room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShareAudio)?.track;
			if (shareAudio?.mediaStreamTrack != null) addRecordingTrack(shareAudio.mediaStreamTrack, 'others');
			const shareVideo = room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShare)?.track;
			if (shareVideo?.mediaStreamTrack != null) addRecordingVideo(shareVideo.mediaStreamTrack, true);
			for (const participant of room.remoteParticipants.values()) {
				for (const publication of participant.trackPublications.values()) {
					const track = publication.track?.mediaStreamTrack;
					if (track == null) continue;
					if (publication.kind === lk.Track.Kind.Audio) {
						addRecordingTrack(track, 'others');
					} else if (publication.kind === lk.Track.Kind.Video) {
						addRecordingVideo(track, publication.source === lk.Track.Source.ScreenShare);
					}
				}
			}
			for (const track of screenShareTracks.values()) {
				if (track.mediaStreamTrack != null) addRecordingVideo(track.mediaStreamTrack, true);
			}
		}

		// 하나의 recorder가 섞인 음성과 (캔버스가 있으면) 화면을 함께 녹음한다. 화면이 없으면 검은 화면이고, 서버가 음성만 뽑아 mp3로 만든다
		const video = recordingCanvasStream != null;
		const stream = new MediaStream([
			...mixedDest.stream.getAudioTracks(),
			...(recordingCanvasStream?.getVideoTracks() ?? []),
		]);
		const mime = video ? recordingVideoMimeType() : recordingMimeType();
		session.ext = mime != null && (mime.startsWith('video/mp4') || mime.startsWith('audio/mp4')) ? '.mp4' : '.webm';
		createRecordingPart(session, stream, mime, video);

		state.recording = true;
		state.recordingStartedAt = startedAt.getTime();
		reportStatus(room, true);
	} catch (err) {
		if (recordingStarting === attempt) {
			if (isApiError(err) && err.code === 'RECORDING_NOT_ALLOWED') state.recordingAllowed = false;
			stopRecording();
			os.toast(i18n.ts._voiceCall.recordingStartRejected);
		}
	} finally {
		if (recordingStarting === attempt) {
			if (!state.recording) stopRecording();
			recordingStarting = null;
			state.recordingStarting = false;
		}
		// 승인 뒤 실패하거나 취소됐으면 서버에 남은 녹화 표시도 되돌린다.
		if (approved && !state.recording && current === room && recordingStarting == null && recordingSession == null) reportStatus(room, true);
	}
}

/** stop recording and upload what is left */
export function stopRecording(): void {
	const session = recordingSession;
	const hadRecording = recordingStarting != null || session?.stopping === false || state.recording;
	recordingStarting = null;
	state.recordingStarting = false;
	// 시작 승인을 기다리는 중이었으면 더 기다리지 않게 한다. 취소는 거절 토스트 없이 끝난다
	if (statusDelivery?.approval != null) {
		statusDelivery.approval.reject(new Error('Recording approval canceled'));
		statusDelivery.approval = null;
	}
	if (session != null) {
		session.stopping = true;
		// 보류 중인 원본을 먼저 변환해, 마지막 조각보다 앞선 순서를 지키게 한다
		flushPendingRecordings(session, session.hasVideo);
	}
	state.recording = false;
	state.recordingStartedAt = null;
	if (hadRecording && current != null) reportStatus(current, true);
	try {
		recordingPart?.stop();
	} finally {
		// 종료 요청 뒤 원본 마이크 점유는 바로 해제한다. 녹음 destination과 복제 트랙은 최종 이벤트까지 별도로 유지한다.
		recordingRawMicStream?.getTracks().forEach(track => track.stop());
		recordingRawMicStream = null;
	}
	if (recordingPart == null) teardownRecording();
}

function clearRecordingMicrophone(): void {
	for (const [track, source] of recordingSources) if (source.kind === 'mic') removeRecordingTrack(track);
	recordingRawMicStream?.getTracks().forEach(track => track.stop());
	recordingRawMicStream = null;
}

async function captureRecordingMicrophone(session: RecordingSession, room: Room): Promise<void> {
	const active = () => recordingSession === session && !session.stopping && current === room;
	if (!active()) return;
	const revision = ++session.micRevision;
	clearRecordingMicrophone();
	try {
		const raw = await navigator.mediaDevices.getUserMedia({
			audio: { deviceId: prefer.s['voiceCall.inputDeviceId'] ?? undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
		});
		if (!active() || session.micRevision !== revision) {
			raw.getTracks().forEach(track => track.stop());
			return;
		}
		// 장치를 얻는 동안 LiveKit이 발행한 대체 입력도 제거해 같은 마이크를 두 번 섞지 않는다.
		clearRecordingMicrophone();
		recordingRawMicStream = raw;
		syncRecordingMicrophone();
		const track = raw.getAudioTracks()[0];
		if (track != null) addRecordingTrack(track, 'mic');
	} catch {
		if (!active() || session.micRevision !== revision || livekit == null) return;
		const mic = room.localParticipant.getTrackPublication(livekit.Track.Source.Microphone)?.track;
		if (mic?.mediaStreamTrack != null) addRecordingTrack(mic.mediaStreamTrack, 'mic');
	}
}

function syncRecordingMicrophone(): void {
	const enabled = state.micEnabled && !state.deafened;
	for (const track of recordingRawMicStream?.getAudioTracks() ?? []) track.enabled = enabled;
	if (recordingMicBus != null) recordingMicBus.gain.value = enabled ? 1 : 0;
}

/** follow the room owner's recording setting while in the call; recording stops when it is turned off */
export function setRecordingAllowed(roomId: string, allowed: boolean): void {
	if (state.room?.id !== roomId) return;
	state.recordingAllowed = allowed;
	if (!allowed) stopRecording();
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
	state.recordingAllowed = room.allowRecording === true;

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
	syncRecordingMicrophone();
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
	const room = current;
	if (room == null) return;
	await room.switchActiveDevice(kind, deviceId);
	if (kind === 'audioinput' && current != null) {
		startLocalMeter(current);
		if (current === room && recordingSession != null) await captureRecordingMicrophone(recordingSession, room);
	}
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
		syncRecordingMicrophone();
		startLocalMeter(room);
		reportStatus(room);
	} catch {
		// マイクが無い・許可されない場合でも、聞くだけの参加者として通話に残る
		if (current !== room) return;
		state.micEnabled = false;
		syncRecordingMicrophone();
		stopLocalMeter?.();
		reportStatus(room);
		os.toast(i18n.ts._voiceCall.micUnavailable);
	}
}

async function disableMicrophone(room: Room): Promise<void> {
	await room.localParticipant.setMicrophoneEnabled(false, captureOptions());
	if (current !== room) return;
	state.micEnabled = false;
	syncRecordingMicrophone();
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
			if (track != null && recordingRawMicStream == null) {
				for (const [input, source] of recordingSources) if (source.kind === 'mic') removeRecordingTrack(input);
				addRecordingTrack(track.mediaStreamTrack, 'mic');
			}
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
			syncRecordingMicrophone();
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
	state.recordingAllowed = false;
	stopLocalMeter?.();
	unwatchMicrophoneTrack?.();
	screenShareTracks.clear();
	state.status = 'idle';
	state.room = null;
	state.mediaProvider = null;
	screenShareLimits = undefined;
	state.micEnabled = false;
	syncRecordingMicrophone();
	state.deafened = false;
	state.audioBlocked = false;
	state.speakingIdentities = [];
	state.localSpeaking = false;
	state.screenSharing = false;
	state.screenShareIdentities = [];
	state.watchingIdentities = [];
}
