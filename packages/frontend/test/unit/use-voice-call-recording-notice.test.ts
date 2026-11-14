/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 같은 현況 갱신에서 녹음 시작과 종료가 겹칠 때의 알림을, 실제 sound.ts 의 25ms 재생 가드와
// 실제 os.toast → MkToast 표시 파이프라인으로 검증한다. 호출 수가 아니라 실제 재생·표시 결과를 본다.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { defineComponent, effectScope, h, nextTick, reactive, ref } from 'vue';
import type { EffectScope } from 'vue';
import { cleanup, render } from '@testing-library/vue';

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
	return { Channel, stream: new Channel(), channel: new Channel(), main: new Channel(), api: vi.fn(), setRecordingAllowed: vi.fn(), voiceStates: null as any };
});

vi.mock('@/stream.js', () => ({ useStream: () => Object.assign(mocks.stream, { useChannel: (name: string) => name === 'main' ? mocks.main : mocks.channel }) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.api }));
vi.mock('@/utility/voice-call.js', () => ({ voiceCall: reactive({ status: 'connected', room: { id: 'r1' }, recording: false }), setRecordingAllowed: mocks.setRecordingAllowed, localIdentityOf: (id: string) => id }));
vi.mock('@/composables/use-chat-room-voice-states.js', () => {
	const states = ref(new Map());
	mocks.voiceStates = states;
	return { useChatRoomVoiceStates: () => states };
});
vi.mock('@/i.js', () => ({ $i: { id: 'me' } }));
vi.mock('@/instance.js', () => ({ instance: { features: { voiceCall: true } } }));
vi.mock('@/filters/user.js', () => ({ userName: (user: { name?: string | null; username: string }) => user.name ?? user.username }));
vi.mock('@/preferences.js', async () => ({ prefer: (await import('./fake-prefer.js')).createFakePrefer({
	'sound.masterVolume': 1,
	'sound.notUseSound': false,
	'sound.useSoundOnlyWhenActive': false,
	animation: false,
	useBlurEffect: false,
	nicknameEnabled: false,
}) }));
// os.ts 가 끌어오는 다른 대화상자 부품은 이 시험과 무관하므로 비운다. MkToast 본체는 그대로 쓴다
vi.mock('@/components/MkPostFormDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('@/components/MkWaitingDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('@/components/MkPageWindow.vue', () => ({ default: { render: () => null } }));
vi.mock('@/components/MkDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('@/components/MkPopupMenu.vue', () => ({ default: { render: () => null } }));
vi.mock('@/components/MkContextMenu.vue', () => ({ default: { render: () => null } }));

import * as sound from '@/utility/sound.js';
import { popups } from '@/os.js';
import { i18n } from '@/i18n.js';
import { voiceCall } from '@/utility/voice-call.js';
import { useVoiceCallRecordingWatch } from '@/composables/use-voice-call-recording-watch.js';

const UP = '/client-assets/sounds/syuilo/up.mp3';
const DOWN = '/client-assets/sounds/syuilo/down.mp3';

// 실제 재생 결과: AudioBufferSourceNode.start 가 호출된 버퍼만 기록 (가드에 걸린 호출은 여기에 없다)
const played: { url: string | null }[] = [];
const abUrls = new WeakMap<ArrayBuffer, string>();

function installAudio() {
	played.length = 0;
	vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		if (!/\/client-assets\/sounds\/.+\.mp3$/.test(url)) throw new Error('unexpected fetch: ' + url);
		return {
			arrayBuffer: async () => {
				const ab = new ArrayBuffer(8);
				abUrls.set(ab, url);
				return ab;
			},
		};
	}));

	// new 로 불러야 하므로 화살표가 아닌 이름 있는 함수를 쓴다
	function FakeAudioContext() {
		return {
			destination: {},
			createStereoPanner: () => ({ pan: { value: 0 }, connect: (n: unknown) => n }),
			createGain: () => ({ gain: { value: 0 }, connect: (n: unknown) => n }),
			createBufferSource: () => {
				const node: any = {
					buffer: null,
					playbackRate: { value: 1 },
					connect: (n: unknown) => n,
					start: vi.fn(() => { played.push({ url: node.buffer?.url ?? null }); }),
				};
				return node;
			},
			decodeAudioData: async (ab: ArrayBuffer) => ({ url: abUrls.get(ab) ?? null }),
			close: vi.fn(),
		};
	}

	vi.stubGlobal('AudioContext', vi.fn(FakeAudioContext));
	try {
		Object.defineProperty(window.navigator, 'userActivation', { configurable: true, value: { hasBeenActive: true, isActive: true } });
	} catch { /* userActivation 이 없으면 sound.ts 가 검사를 건너뛴다 */ }
}

// common.vue 와 같은 방식으로 popups 를 그리는 호스트. MkToast 가 실제로 DOM 에 올린다
const Host = defineComponent({
	name: 'PopupHost',
	setup() {
		return () => h('div', popups.value.map(p => h(p.component as any, { ...p.props, key: p.id, onClosed: p.events.closed })));
	},
});

let ui: ReturnType<typeof render> | null = null;
let scope: EffectScope | null = null;
let sfxSpy: ReturnType<typeof vi.spyOn> | null = null;

function mountHost() {
	ui = render(Host, { global: { components: { MkAvatar: { render: () => null }, Mfm: { render: () => null } } } });
}

// MkToast 가 렌더한 메시지 문구 (메시지 상자는 잎 div 하나)
function renderedMessages(): string[] {
	return [...ui!.container.querySelectorAll('div')]
		.filter(el => el.childElementCount === 0 && (el.textContent ?? '').trim() !== '')
		.map(el => el.textContent!.trim());
}

async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick(); } }

// 반응 갱신 + 소리 재생 약속 + 25ms 가드 해제까지 진행한다
async function settle() {
	await flush();
	await vi.advanceTimersByTimeAsync(30);
	await flush();
}

// 이미 뜬 토스트를 수명(4초)+퇴장 전환 뒤까지 보내 화면에서 치운다 (다음 사건의 표시만 보려고)
async function expireToasts() {
	await vi.advanceTimersByTimeAsync(4600);
	await flush();
}

function start() { scope = effectScope(); scope.run(useVoiceCallRecordingWatch); }

const user = (id: string, name: string) => ({ id, name, username: id.toLowerCase() });

function setParticipants(participants: { identity: string; recording?: boolean; user?: ReturnType<typeof user> }[]) {
	mocks.voiceStates.value = new Map([['r1', { participants }]]);
}

function attemptedTypes(): string[] { return sfxSpy!.mock.calls.map((call: [{ type: string }]) => call[0].type); }

beforeEach(() => {
	vi.useFakeTimers();
	mocks.stream = new mocks.Channel();
	mocks.channel = new mocks.Channel();
	mocks.main = new mocks.Channel();
	mocks.api.mockReset().mockResolvedValue({ id: 'r1', allowRecording: true });
	mocks.setRecordingAllowed.mockReset();
	mocks.voiceStates.value = new Map();
	Object.assign(voiceCall, { status: 'connected', room: { id: 'r1' }, recording: false });
	popups.value = [];
	installAudio();
	sfxSpy = vi.spyOn(sound, 'playMisskeySfxFile');
	mountHost();
});

afterEach(async () => {
	scope?.stop();
	scope = null;
	await vi.runAllTimersAsync();
	cleanup();
	ui = null;
	popups.value = [];
	sfxSpy?.mockRestore();
	sfxSpy = null;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test('the real playback guard rejects an immediate second sound and recovers after 25ms', async () => {
	const first = sound.playMisskeySfxFile({ type: 'syuilo/up', volume: 1 });
	const second = sound.playMisskeySfxFile({ type: 'syuilo/down', volume: 1 });
	expect(await second).toBe(false);
	await vi.advanceTimersByTimeAsync(30);
	expect(await first).toBe(true);
	const third = sound.playMisskeySfxFile({ type: 'syuilo/down', volume: 1 });
	await vi.advanceTimersByTimeAsync(30);
	expect(await third).toBe(true);
	expect(played.map(p => p.url)).toEqual([UP, DOWN]);
});

test('a single start keeps its own toast and the up sound', async () => {
	start();
	await flush();
	setParticipants([{ identity: 'user-a', recording: true, user: user('user-a', 'Alice') }]);
	await settle();
	expect(renderedMessages()).toEqual([i18n.tsx._voiceCall.recordingStartedBy({ name: 'Alice' })]);
	expect(renderedMessages()).toHaveLength(1);
	expect(attemptedTypes()).toEqual(['syuilo/up']);
	expect(played.map(p => p.url)).toEqual([UP]);
});

test('a single stop keeps the generic toast and the down sound', async () => {
	start();
	await flush();
	setParticipants([{ identity: 'user-a', recording: true, user: user('user-a', 'Alice') }]);
	await settle();
	await expireToasts();
	sfxSpy!.mockClear();
	played.length = 0;
	setParticipants([{ identity: 'user-a', recording: false, user: user('user-a', 'Alice') }]);
	await settle();
	expect(renderedMessages()).toEqual([i18n.ts._voiceCall.recordingStopped]);
	expect(attemptedTypes()).toEqual(['syuilo/down']);
	expect(played.map(p => p.url)).toEqual([DOWN]);
});

test('one update replacing the recorder shows one combined toast and plays one up sound', async () => {
	start();
	await flush();
	setParticipants([{ identity: 'user-a', recording: true, user: user('user-a', 'Alice') }]);
	await settle();
	await expireToasts();
	sfxSpy!.mockClear();
	played.length = 0;

	setParticipants([{ identity: 'user-b', recording: true, user: user('user-b', 'Bob') }]);
	await settle();

	expect(renderedMessages()).toHaveLength(1);
	expect(renderedMessages()).toEqual([i18n.tsx._voiceCall.recordingStoppedAndStarted({ stopped: 'Alice', started: 'Bob' })]);
	expect(attemptedTypes()).toEqual(['syuilo/up']);
	expect(played.map(p => p.url)).toEqual([UP]);
});

test('my own start replacing another recorder keeps the stop toast and plays the up sound once', async () => {
	start();
	await flush();
	setParticipants([{ identity: 'user-a', recording: true, user: user('user-a', 'Alice') }]);
	await settle();
	await expireToasts();
	sfxSpy!.mockClear();
	played.length = 0;

	setParticipants([]);
	Object.assign(voiceCall, { recording: true });
	await settle();

	expect(renderedMessages()).toHaveLength(1);
	expect(renderedMessages()).toEqual([i18n.ts._voiceCall.recordingStopped]);
	// 녹음이 이어지므로 시작음 하나만 시도·재생되어야 한다 (종료음을 연달아 부르면 가드에 묻힌다)
	expect(attemptedTypes()).toEqual(['syuilo/up']);
	expect(played.map(p => p.url)).toEqual([UP]);
});

test('multiple stoppers and starters in one update share one combined toast and one sound', async () => {
	start();
	await flush();
	setParticipants([
		{ identity: 'user-a', recording: true, user: user('user-a', 'Alice') },
		{ identity: 'user-b', recording: true, user: user('user-b', 'Bob') },
	]);
	await settle();
	await expireToasts();
	sfxSpy!.mockClear();
	played.length = 0;

	setParticipants([
		{ identity: 'user-c', recording: true, user: user('user-c', 'Carol') },
		{ identity: 'user-d', recording: true, user: user('user-d', 'Dave') },
	]);
	await settle();

	expect(renderedMessages()).toHaveLength(1);
	expect(renderedMessages()).toEqual([i18n.tsx._voiceCall.recordingStoppedAndStarted({ stopped: 'Alice, Bob', started: 'Carol, Dave' })]);
	expect(attemptedTypes()).toEqual(['syuilo/up']);
	expect(played.map(p => p.url)).toEqual([UP]);
});

test('multiple starters in one update share one toast', async () => {
	start();
	await flush();
	setParticipants([
		{ identity: 'user-a', recording: true, user: user('user-a', 'Alice') },
		{ identity: 'user-b', recording: true, user: user('user-b', 'Bob') },
	]);
	await settle();

	expect(renderedMessages()).toHaveLength(1);
	expect(renderedMessages()).toEqual([i18n.tsx._voiceCall.recordingStartedBy({ name: 'Alice, Bob' })]);
	expect(attemptedTypes()).toEqual(['syuilo/up']);
	expect(played.map(p => p.url)).toEqual([UP]);
});

test('a stopper who left the participant list in the same update is still named', async () => {
	start();
	await flush();
	setParticipants([
		{ identity: 'user-a', recording: true, user: user('user-a', 'Alice') },
		{ identity: 'user-b', recording: false, user: user('user-b', 'Bob') },
	]);
	await settle();
	await expireToasts();
	sfxSpy!.mockClear();
	played.length = 0;

	// alice 는 목록에서 완전히 빠지고 bob 이 녹음을 시작한다
	setParticipants([{ identity: 'user-b', recording: true, user: user('user-b', 'Bob') }]);
	await settle();

	expect(renderedMessages()).toHaveLength(1);
	expect(renderedMessages()).toEqual([i18n.tsx._voiceCall.recordingStoppedAndStarted({ stopped: 'Alice', started: 'Bob' })]);
	expect(attemptedTypes()).toEqual(['syuilo/up']);
	expect(played.map(p => p.url)).toEqual([UP]);
});

test('my own start alone stays untoasted with the badge and the up sound', async () => {
	scope = effectScope();
	const watch = scope.run(useVoiceCallRecordingWatch)!;
	await flush();

	Object.assign(voiceCall, { recording: true });
	await settle();

	expect(renderedMessages()).toHaveLength(0);
	expect(renderedMessages()).toEqual([]);
	expect(watch.someoneRecording.value).toBe(true);
	expect(attemptedTypes()).toEqual(['syuilo/up']);
	expect(played.map(p => p.url)).toEqual([UP]);
});

test('the guard recovers between updates so a later stop still plays the down sound', async () => {
	start();
	await flush();
	setParticipants([{ identity: 'user-a', recording: true, user: user('user-a', 'Alice') }]);
	await settle();
	await expireToasts();
	sfxSpy!.mockClear();
	played.length = 0;

	setParticipants([{ identity: 'user-b', recording: true, user: user('user-b', 'Bob') }]);
	await settle();
	setParticipants([{ identity: 'user-b', recording: false, user: user('user-b', 'Bob') }]);
	await settle();

	expect(attemptedTypes()).toEqual(['syuilo/up', 'syuilo/down']);
	expect(played.map(p => p.url)).toEqual([UP, DOWN]);
	expect(renderedMessages()).toEqual([
		i18n.tsx._voiceCall.recordingStoppedAndStarted({ stopped: 'Alice', started: 'Bob' }),
		i18n.ts._voiceCall.recordingStopped,
	]);
});
