/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { effectScope, nextTick, reactive, ref } from 'vue';
import type { EffectScope } from 'vue';

const mocks = vi.hoisted(() => {
	class Channel {
		handlers = new Map<string, Set<(payload?: any) => void>>();
		on(event: string, handler: (payload?: any) => void) {
			if (!this.handlers.has(event)) this.handlers.set(event, new Set());
			this.handlers.get(event)!.add(handler);
		}
		off(event: string, handler: (payload?: any) => void) { this.handlers.get(event)?.delete(handler); }
		emit(event: string, payload?: unknown) { for (const handler of this.handlers.get(event) ?? []) handler(payload); }
		dispose = vi.fn();
	}
	return { Channel, stream: new Channel(), channel: new Channel(), main: new Channel(), toast: vi.fn(), sound: vi.fn(), api: vi.fn(), setRecordingAllowed: vi.fn(), voiceStates: null as any };
});

vi.mock('@/stream.js', () => ({ useStream: () => Object.assign(mocks.stream, { useChannel: (name: string) => name === 'main' ? mocks.main : mocks.channel }) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/utility/voice-call.js', () => ({ voiceCall: reactive({ status: 'connected', room: { id: 'r1' }, recording: false }), setRecordingAllowed: mocks.setRecordingAllowed, localIdentityOf: (id: string) => id }));
vi.mock('@/composables/use-chat-room-voice-states.js', () => {
	const states = ref(new Map());
	mocks.voiceStates = states;
	return { useChatRoomVoiceStates: () => states };
});
vi.mock('@/os.js', () => ({ toast: mocks.toast }));
vi.mock('@/utility/sound.js', () => ({ playMisskeySfxFile: mocks.sound }));
vi.mock('@/filters/user.js', () => ({ userName: () => 'participant' }));
vi.mock('@/i.js', () => ({ $i: { id: 'me' } }));

import { voiceCall } from '@/utility/voice-call.js';
import { i18n } from '@/i18n.js';
import { useVoiceCallRecordingWatch } from '@/composables/use-voice-call-recording-watch.js';

let scope: EffectScope;

async function flush() { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick(); } }

function start() { scope = effectScope(); scope.run(useVoiceCallRecordingWatch); }

function setParticipants(roomId: string, participants: { identity: string; recording?: boolean; user?: { id: string } }[]) {
	mocks.voiceStates.value = new Map([[roomId, { participants }]]);
}

beforeEach(() => {
	vi.useFakeTimers();
	mocks.stream = new mocks.Channel();
	mocks.channel = new mocks.Channel();
	mocks.main = new mocks.Channel();
	mocks.toast.mockReset();
	mocks.sound.mockReset();
	mocks.api.mockReset().mockResolvedValue({ id: 'r1', allowRecording: true });
	mocks.setRecordingAllowed.mockReset();
	mocks.voiceStates.value = new Map();
	Object.assign(voiceCall, { status: 'connected', room: { id: 'r1' }, recording: false });
});

afterEach(() => { scope?.stop(); vi.useRealTimers(); });

test('recovers a revocation missed while the WebSocket was disconnected, outside the room page', async () => {
	start();
	await flush();
	mocks.api.mockResolvedValue({ id: 'r1', allowRecording: false });

	mocks.stream.emit('_connected_');
	await flush();

	expect(mocks.api).toHaveBeenLastCalledWith('chat/rooms/show', { roomId: 'r1' });
	expect(mocks.setRecordingAllowed).toHaveBeenLastCalledWith('r1', false);
});

test('loads the latest setting after channel subscription even when the tab is hidden', async () => {
	start();
	await flush();
	mocks.api.mockResolvedValue({ id: 'r1', allowRecording: false });

	mocks.channel.emit('_subscribed_');
	await flush();

	expect(mocks.setRecordingAllowed).toHaveBeenLastCalledWith('r1', false);
});

test('a stale settings response cannot undo a newer revocation event', async () => {
	let resolve!: (room: unknown) => void;
	mocks.api.mockReturnValueOnce(new Promise(done => { resolve = done; }));
	start();
	await flush();

	mocks.channel.emit('roomUpdated', { roomId: 'r1', allowRecording: false });
	resolve({ id: 'r1', allowRecording: true });
	await flush();

	expect(mocks.setRecordingAllowed.mock.calls).toEqual([['r1', false]]);
});

test('retries a failed resync and cancels retry work after leaving the call', async () => {
	mocks.api.mockRejectedValueOnce(new Error('connection not ready')).mockResolvedValue({ id: 'r1', allowRecording: false });
	start();
	await flush();

	await vi.advanceTimersByTimeAsync(1000);
	await flush();
	expect(mocks.setRecordingAllowed).toHaveBeenLastCalledWith('r1', false);

	scope.stop();
	const calls = mocks.api.mock.calls.length;
	mocks.stream.emit('_connected_');
	await vi.advanceTimersByTimeAsync(60_000);
	expect(mocks.api).toHaveBeenCalledTimes(calls);
});

test('does not apply a response belonging to the previous room', async () => {
	let resolve!: (room: unknown) => void;
	mocks.api.mockReturnValueOnce(new Promise(done => { resolve = done; }));
	start();
	await flush();

	Object.assign(voiceCall, { room: { id: 'r2' } });
	mocks.api.mockResolvedValue({ id: 'r2', allowRecording: false });
	await flush();
	resolve({ id: 'r1', allowRecording: true });
	await flush();

	expect(mocks.setRecordingAllowed).not.toHaveBeenCalledWith('r1', true);
	expect(mocks.setRecordingAllowed).toHaveBeenLastCalledWith('r2', false);
});

test('announces another participant starting and stopping recording from the participant list', async () => {
	start();
	await flush();
	// 별도의 녹화 이벤트 구독 없이 참가자 목록의 recording 변화만으로 알린다
	expect(mocks.main.handlers.size).toBe(0);
	const other = { identity: 'another-user', user: { id: 'another-user' } };

	setParticipants('r1', [{ ...other, recording: true }]);
	await flush();
	expect(mocks.toast).toHaveBeenCalledTimes(1);
	expect(mocks.sound).toHaveBeenCalledTimes(1);
	expect(mocks.sound).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'syuilo/up' }));

	setParticipants('r1', [{ ...other, recording: false }]);
	await flush();
	expect(mocks.toast).toHaveBeenCalledTimes(2);
	expect(mocks.sound).toHaveBeenCalledTimes(2);
	expect(mocks.sound).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'syuilo/down' }));
});

test('announces only the net recording change within one tick', async () => {
	scope = effectScope();
	const watch = scope.run(useVoiceCallRecordingWatch)!;
	await flush();
	const other = { identity: 'another-user', user: { id: 'another-user' } };

	setParticipants('r1', [{ ...other, recording: true }]);
	setParticipants('r1', [{ ...other, recording: false }]);
	setParticipants('r1', [{ ...other, recording: true }]);
	await nextTick();

	expect(mocks.toast).toHaveBeenCalledTimes(1);
	expect(mocks.sound).toHaveBeenCalledTimes(1);
	expect(watch.someoneRecording.value).toBe(true);
});

test('announces both the stop and the start when one update replaces the recorder', async () => {
	start();
	await flush();
	const a = { identity: 'user-a', user: { id: 'user-a' } };
	const b = { identity: 'user-b', user: { id: 'user-b' } };

	setParticipants('r1', [{ ...a, recording: true }]);
	await flush();
	mocks.toast.mockClear();
	mocks.sound.mockClear();

	setParticipants('r1', [{ ...b, recording: true }]);
	await flush();

	expect(mocks.toast.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
		i18n.tsx._voiceCall.recordingStartedBy({ name: 'participant' }),
		i18n.ts._voiceCall.recordingStopped,
	]));
	expect(mocks.sound.mock.calls.map(call => call[0].type)).toEqual(expect.arrayContaining(['syuilo/up', 'syuilo/down']));
});

test('announces another participant stopping when my own recording starts in the same update', async () => {
	start();
	await flush();
	const a = { identity: 'user-a', user: { id: 'user-a' } };

	setParticipants('r1', [{ ...a, recording: true }]);
	await flush();
	mocks.toast.mockClear();
	mocks.sound.mockClear();

	setParticipants('r1', []);
	Object.assign(voiceCall, { recording: true });
	await flush();

	expect(mocks.toast).toHaveBeenCalledTimes(1);
	expect(mocks.toast).toHaveBeenCalledWith(i18n.ts._voiceCall.recordingStopped);
	expect(mocks.sound.mock.calls.map(call => call[0].type)).toEqual(expect.arrayContaining(['syuilo/up', 'syuilo/down']));
});

test('does not announce the previous call recording state after switching calls', async () => {
	start();
	await flush();
	setParticipants('r1', [{ identity: 'another-user', recording: true, user: { id: 'another-user' } }]);
	await flush();
	expect(mocks.toast).toHaveBeenCalledTimes(1);

	Object.assign(voiceCall, { room: { id: 'r2' } });
	setParticipants('r2', []);
	await flush();

	expect(mocks.toast).toHaveBeenCalledTimes(1);
	expect(mocks.sound).toHaveBeenCalledTimes(1);
});

test('does not toast for my own recording but keeps the badge', async () => {
	scope = effectScope();
	const watch = scope.run(useVoiceCallRecordingWatch)!;
	await flush();

	Object.assign(voiceCall, { recording: true });
	await flush();

	expect(mocks.toast).not.toHaveBeenCalled();
	expect(watch.someoneRecording.value).toBe(true);
	expect(watch.recordingIdentities.value).toEqual(['me']);
});
