/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { reactive, readonly } from 'vue';
import * as Misskey from 'cherrypick-js';
import { url } from '@@/js/config.js';
import type { AudioCaptureOptions, DisconnectReason, LocalTrackPublication, Participant, RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, TrackPublication, VideoPreset } from 'livekit-client';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';

export type VoiceCallStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

type LiveKit = typeof import('livekit-client');

const state = reactive({
	status: 'idle' as VoiceCallStatus,
	room: null as Misskey.entities.ChatRoom | null,
	micEnabled: false,
	deafened: false,
	audioBlocked: false,
	speakingIdentities: [] as string[],
	screenSharing: false,
	screenShareIdentities: [] as string[],
	watchingIdentity: null as string | null,
});

/** 現在の通話の状態。書き換えは下の関数経由で行う */
export const voiceCall = readonly(state);

let livekit: LiveKit | null = null;
let current: Room | null = null;
let joinAttempt = 0;

// 画面共有の映像トラックと、それを映す video 要素 (どちらも identity ごと)
const screenShareTracks = new Map<string, RemoteTrack>();
const screenShareElements = new Map<string, HTMLVideoElement>();

async function loadLiveKit(): Promise<LiveKit> {
	// 通話しない人にライブラリを読ませないよう、参加時に読み込む
	livekit ??= await import('livekit-client');
	return livekit;
}

export function localIdentityOf(userId: string): string {
	return `${url}/users/${userId}`;
}

export async function joinVoiceCall(room: Misskey.entities.ChatRoom): Promise<void> {
	if (current != null) await leaveVoiceCall();

	const attempt = ++joinAttempt;
	resetState();
	state.status = 'connecting';
	state.room = room;

	let credentials: { url: string; token: string };
	let lk: LiveKit;
	try {
		[credentials, lk] = await Promise.all([
			misskeyApi('chat/rooms/voice/join', { roomId: room.id }),
			loadLiveKit(),
		]);
	} catch {
		if (attempt === joinAttempt) failToConnect();
		return;
	}
	if (attempt !== joinAttempt) return;

	const lkRoom = new lk.Room({ adaptiveStream: true, dynacast: true });
	current = lkRoom;
	bindRoomEvents(lk, lkRoom);

	try {
		await lkRoom.connect(credentials.url, credentials.token, { autoSubscribe: false });
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

	await enableMicrophone(lkRoom);
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
	if (current == null) return;
	if (enabled) {
		await enableMicrophone(current);
	} else {
		await current.localParticipant.setMicrophoneEnabled(false, captureOptions());
		state.micEnabled = false;
	}
}

export function setDeafened(deafened: boolean): void {
	state.deafened = deafened;
	if (current == null) return;
	for (const participant of current.remoteParticipants.values()) {
		applyVolume(participant);
	}
	if (deafened && state.micEnabled) {
		setMicEnabled(false).catch(() => {});
	}
}

export async function resumeAudio(): Promise<void> {
	if (current == null) return;
	await current.startAudio();
	state.audioBlocked = !current.canPlaybackAudio;
}

export function setParticipantVolume(identity: string, volume: number): void {
	prefer.commit('voiceCall.participantVolumes', { ...prefer.s['voiceCall.participantVolumes'], [identity]: volume });
	const participant = current?.remoteParticipants.get(identity);
	if (participant != null) applyVolume(participant);
}

export async function selectAudioDevice(kind: 'audioinput' | 'audiooutput', deviceId: string): Promise<void> {
	prefer.commit(kind === 'audioinput' ? 'voiceCall.inputDeviceId' : 'voiceCall.outputDeviceId', deviceId);
	if (current == null) return;
	await current.switchActiveDevice(kind, deviceId);
}

export function canShareScreen(): boolean {
	return typeof window.navigator.mediaDevices?.getDisplayMedia === 'function';
}

export async function startScreenShare(): Promise<void> {
	if (current == null || livekit == null) return;
	const { preset, contentHint } = screenSharePreset(livekit, prefer.s['voiceCall.screenShareQuality']);
	try {
		await current.localParticipant.setScreenShareEnabled(true, {
			audio: prefer.s['voiceCall.screenShareAudio'],
			resolution: preset.resolution,
			contentHint,
		}, {
			screenShareEncoding: preset.encoding,
			screenShareSimulcastLayers: [livekit.ScreenSharePresets.h720fps15],
		});
		state.screenSharing = true;
	} catch (err) {
		state.screenSharing = false;
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

export function watchScreenShare(identity: string | null): void {
	const previous = state.watchingIdentity;
	state.watchingIdentity = identity;
	if (current == null) return;
	if (previous != null && previous !== identity) {
		screenSharePublicationOf(current, previous)?.setSubscribed(false);
	}
	if (identity != null) {
		screenSharePublicationOf(current, identity)?.setSubscribed(true);
	}
}

export function attachScreenShare(identity: string, element: HTMLVideoElement): () => void {
	screenShareElements.set(identity, element);
	screenShareTracks.get(identity)?.attach(element);
	return () => {
		if (screenShareElements.get(identity) === element) screenShareElements.delete(identity);
		screenShareTracks.get(identity)?.detach(element);
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

function forgetScreenShare(identity: string): void {
	state.screenShareIdentities = state.screenShareIdentities.filter(x => x !== identity);
	screenShareTracks.delete(identity);
	if (state.watchingIdentity === identity) state.watchingIdentity = null;
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
		state.micEnabled = true;
	} catch {
		// マイクが無い・許可されない場合でも、聞くだけの参加者として通話に残る
		state.micEnabled = false;
		os.toast(i18n.ts._voiceCall.micUnavailable);
	}
}

function volumeOf(identity: string): number {
	if (state.deafened) return 0;
	return prefer.s['voiceCall.participantVolumes'][identity] ?? 1;
}

function applyVolume(participant: RemoteParticipant): void {
	const volume = volumeOf(participant.identity);
	const { Track } = livekit!;
	participant.setVolume(volume, Track.Source.Microphone);
	participant.setVolume(volume, Track.Source.ScreenShareAudio);
}

function applySubscription(lk: LiveKit, publication: TrackPublication, participant: RemoteParticipant): void {
	const remote = publication as RemoteTrackPublication;
	switch (publication.source) {
		case lk.Track.Source.Microphone:
		case lk.Track.Source.ScreenShareAudio:
			remote.setSubscribed(true);
			break;
		case lk.Track.Source.ScreenShare:
			if (!state.screenShareIdentities.includes(participant.identity)) {
				state.screenShareIdentities = [...state.screenShareIdentities, participant.identity];
			}
			remote.setSubscribed(participant.identity === state.watchingIdentity);
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
			const element = screenShareElements.get(participant.identity);
			if (element != null) track.attach(element);
		}
	});

	room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
		if (track.kind === Track.Kind.Audio) {
			for (const element of track.detach()) element.remove();
		} else if (publication.source === Track.Source.ScreenShare) {
			const element = screenShareElements.get(participant.identity);
			if (element != null) track.detach(element);
			screenShareTracks.delete(participant.identity);
		}
	});

	room.on(RoomEvent.TrackUnpublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
		if (isCurrent() && publication.source === Track.Source.ScreenShare) forgetScreenShare(participant.identity);
	});

	room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
		if (isCurrent()) forgetScreenShare(participant.identity);
	});

	room.on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
		// ブラウザの「共有を停止」で終わった場合もここに来る
		if (isCurrent() && publication.source === Track.Source.ScreenShare) state.screenSharing = false;
	});

	room.on(RoomEvent.TrackMuted, (publication: TrackPublication, participant: Participant) => {
		if (!isCurrent()) return;
		// オーナーによる強制ミュート
		if (participant === room.localParticipant && publication.source === Track.Source.Microphone) {
			state.micEnabled = false;
		}
	});

	room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
		if (isCurrent()) state.speakingIdentities = speakers.map(speaker => speaker.identity);
	});

	room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
		if (isCurrent()) state.audioBlocked = !room.canPlaybackAudio;
	});

	room.on(RoomEvent.Reconnecting, () => {
		if (isCurrent()) state.status = 'reconnecting';
	});

	room.on(RoomEvent.Reconnected, () => {
		if (isCurrent()) state.status = 'connected';
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

function detachAll(room: Room): void {
	for (const participant of room.remoteParticipants.values()) {
		for (const publication of participant.trackPublications.values()) {
			const track = publication.track;
			if (track == null) continue;
			for (const element of track.detach()) element.remove();
		}
	}
}

function failToConnect(): void {
	resetState();
	os.toast(i18n.ts._voiceCall.connectionFailed);
}

function resetState(): void {
	screenShareTracks.clear();
	state.status = 'idle';
	state.room = null;
	state.micEnabled = false;
	state.deafened = false;
	state.audioBlocked = false;
	state.speakingIdentities = [];
	state.screenSharing = false;
	state.screenShareIdentities = [];
	state.watchingIdentity = null;
}
