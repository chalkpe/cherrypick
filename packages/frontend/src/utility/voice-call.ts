/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { reactive, readonly } from 'vue';
import * as Misskey from 'cherrypick-js';
import { url } from '@@/js/config.js';
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
	micEnabled: false,
	deafened: false,
	audioBlocked: false,
	speakingIdentities: [] as string[],
	localSpeaking: false,
	screenSharing: false,
	screenShareIdentities: [] as string[],
	// 見ている共有画面 (見始めた順)。いくつでも同時に見られる
	watchingIdentities: [] as string[],
});

/** 現在の通話の状態。書き換えは下の関数経由で行う */
export const voiceCall = readonly(state);

let livekit: LiveKit | null = null;
let current: Room | null = null;
let joinAttempt = 0;
let stopLocalMeter: (() => void) | null = null;
let statusReports = Promise.resolve();

// Report UI settings, not per-participant playback volume. Keep updates ordered.
function reportStatus(room: Room): void {
	const roomId = state.room?.id;
	if (current !== room || roomId == null || state.status === 'connecting') return;
	const status = { roomId, sessionId: room.localParticipant.sid, micMuted: !state.micEnabled, deafened: state.deafened };
	statusReports = statusReports.then(async () => {
		if (current === room) await misskeyApi('chat/rooms/voice/status', status);
	}).catch(() => {
		// Older hosts may not support reports. Audio controls must still work.
	});
}

function setLocalSpeaking(room: Room, speaking: boolean): void {
	state.localSpeaking = speaking;
	const identity = room.localParticipant.identity;
	if (state.speakingIdentities.includes(identity) === speaking) return;
	state.speakingIdentities = speaking
		? [...state.speakingIdentities, identity]
		: state.speakingIdentities.filter(id => id !== identity);
}

function startLocalMeter(room: Room): void {
	stopLocalMeter?.();
	if (livekit == null || current !== room || !state.micEnabled) return;
	const track = room.localParticipant.getTrackPublication(livekit.Track.Source.Microphone)?.track;
	if (track == null || track.kind !== livekit.Track.Kind.Audio) return;
	try {
		const meter = livekit.createAudioAnalyser(track as LocalAudioTrack, { fftSize: 512 });
		const samples = new Float32Array(meter.analyser.fftSize);
		let lastLoudAt = -Infinity;
		const timer = window.setInterval(() => {
			if (current !== room || !state.micEnabled) return;
			meter.analyser.getFloatTimeDomainData(samples);
			const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
			if (rms >= 0.02) lastLoudAt = Date.now();
			setLocalSpeaking(room, Date.now() - lastLoudAt < 150);
		}, 50);
		stopLocalMeter = () => {
			window.clearInterval(timer);
			void meter.cleanup().catch(() => {});
			setLocalSpeaking(room, false);
			stopLocalMeter = null;
		};
	} catch {
		// Audio metering is optional; failure must not stop the microphone.
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

export async function joinVoiceCall(room: Misskey.entities.ChatRoom, options: { micEnabled?: boolean } = {}): Promise<void> {
	migrateParticipantVolumes();
	if (current != null) await leaveVoiceCall();

	const attempt = ++joinAttempt;
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

	if (options.micEnabled !== false) await enableMicrophone(lkRoom);
	else reportStatus(lkRoom);
}

export async function leaveVoiceCall(): Promise<void> {
	joinAttempt++;
	const room = current;
	current = null;
	if (room != null) {
		await room.disconnect();
		detachAll(room);
	}
	resetState();
}

export async function setMicEnabled(enabled: boolean): Promise<void> {
	const room = current;
	if (room == null) return;
	if (enabled) {
		await enableMicrophone(room);
	} else {
		await room.localParticipant.setMicrophoneEnabled(false, captureOptions());
		if (current !== room) return;
		state.micEnabled = false;
		stopLocalMeter?.();
		reportStatus(room);
	}
}

export function setDeafened(deafened: boolean): void {
	state.deafened = deafened;
	if (current == null) return;
	const room = current;
	for (const participant of room.remoteParticipants.values()) {
		applyVolume(participant);
	}
	if (deafened && state.micEnabled) {
		// マイクを切り終えてから一度だけ知らせる (setMicEnabled が知らせる)。切る前に知らせると、スピーカーだけ切ってマイクは入ったままの状態が
		// 一瞬伝わり、知らせも二度になる。切れなかったときは、そのままの状態 (マイクは入ったまま) を知らせる
		setMicEnabled(false).catch(() => reportStatus(room));
		return;
	}
	reportStatus(room);
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

export async function startScreenShare(): Promise<void> {
	const room = current;
	if (room == null || livekit == null) return;
	const { preset, contentHint } = screenSharePreset(livekit, prefer.s['voiceCall.screenShareQuality']);
	try {
		await room.localParticipant.setScreenShareEnabled(true, {
			audio: prefer.s['voiceCall.screenShareAudio'],
			resolution: preset.resolution,
			contentHint,
		}, {
			screenShareEncoding: preset.encoding,
			// 層は低いものから並べる。一番低い層はプレビュー用
			screenShareSimulcastLayers: [
				new livekit.VideoPreset(SCREEN_SHARE_PREVIEW_LAYER.width, SCREEN_SHARE_PREVIEW_LAYER.height, SCREEN_SHARE_PREVIEW_LAYER.maxBitrate, SCREEN_SHARE_PREVIEW_LAYER.maxFramerate, SCREEN_SHARE_PREVIEW_LAYER.priority),
				livekit.ScreenSharePresets.h720fps15,
			],
		});
		// 待っているあいだに通話を離れていれば何もしない。共有が終わっていれば (ブラウザの「共有を停止」など) 共有中にはしない
		if (current === room) state.screenSharing = room.localParticipant.isScreenShareEnabled;
	} catch (err) {
		if (current === room) state.screenSharing = false;
		// 共有する画面の選択をキャンセルしただけなら何も言わない
		if (err instanceof DOMException && err.name === 'NotAllowedError') return;
		os.toast(i18n.ts._voiceCall.screenShareFailed);
	}
}

export async function stopScreenShare(): Promise<void> {
	if (current == null) return;
	await current.localParticipant.setScreenShareEnabled(false);
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

async function enableMicrophone(room: Room): Promise<void> {
	try {
		await room.localParticipant.setMicrophoneEnabled(true, captureOptions());
		if (current !== room) return;
		state.micEnabled = true;
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
			window.document.body.appendChild(track.attach());
			applyVolume(participant);
		} else if (publication.source === Track.Source.ScreenShare) {
			screenShareTracks.set(participant.identity, track);
			for (const view of screenShareViews.get(participant.identity) ?? []) track.attach(view.element);
		}
	});

	room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
		if (track.kind === Track.Kind.Audio) {
			for (const element of track.detach()) element.remove();
		} else if (publication.source === Track.Source.ScreenShare) {
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
			return;
		}
		if (publication.source !== Track.Source.ScreenShare || track == null) return;
		state.screenSharing = true;
		screenShareTracks.set(participant.identity, track);
		for (const view of screenShareViews.get(participant.identity) ?? []) track.attach(view.element);
	});

	room.on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication, participant: LocalParticipant) => {
		// ブラウザの「共有を停止」で終わった場合もここに来る
		if (!isCurrent() || publication.source !== Track.Source.ScreenShare) return;
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
		// 測れていない (AudioContext が無いなど) ときはサーバーの知らせに従う
		const metered = stopLocalMeter != null;
		const localSpeaking = metered ? state.speakingIdentities.includes(localIdentity) : speakers.some(speaker => speaker.identity === localIdentity);
		state.speakingIdentities = localSpeaking ? [...others, localIdentity] : others;
		if (!metered) state.localSpeaking = localSpeaking;
	});

	room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
		if (isCurrent()) state.audioBlocked = !room.canPlaybackAudio;
	});

	room.on(RoomEvent.Reconnecting, () => {
		if (isCurrent()) state.status = 'reconnecting';
	});

	room.on(RoomEvent.Reconnected, () => {
		if (isCurrent()) {
			state.status = 'connected';
			reportStatus(room);
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

function failToConnect(err?: unknown): void {
	resetState();
	// 相手のサーバーが通話に対応していないときだけ、原因が分かる文言にする
	const code = isApiError(err) ? err.code : undefined;
	os.toast(code === 'REMOTE_HOST_UNSUPPORTED' ? i18n.ts._voiceCall.remoteHostUnsupported : i18n.ts._voiceCall.connectionFailed);
}

function resetState(): void {
	stopLocalMeter?.();
	screenShareTracks.clear();
	state.status = 'idle';
	state.room = null;
	state.micEnabled = false;
	state.deafened = false;
	state.audioBlocked = false;
	state.speakingIdentities = [];
	state.localSpeaking = false;
	state.screenSharing = false;
	state.screenShareIdentities = [];
	state.watchingIdentities = [];
}
