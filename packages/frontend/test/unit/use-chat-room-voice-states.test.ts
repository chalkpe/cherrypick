/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { defineComponent, effectScope, h, KeepAlive, nextTick, ref } from 'vue';
import type { EffectScope } from 'vue';
import { cleanup, render } from '@testing-library/vue';

const mocks = vi.hoisted(() => {
	class FakeChannel {
		handlers = new Map<string, (payload: unknown) => void>();
		on(event: string, handler: (payload: unknown) => void) {
			this.handlers.set(event, handler);
		}
		off() {}
		dispose = vi.fn();
		emit(event: string, payload: unknown) {
			this.handlers.get(event)?.(payload);
		}
	}
	return {
		FakeChannel,
		channel: new FakeChannel(),
		misskeyApi: vi.fn().mockResolvedValue([]),
		instance: { features: { voiceCall: true, remoteVoiceCall: false } },
	};
});

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.misskeyApi }));
vi.mock('@/stream.js', () => ({ useStream: () => ({ useChannel: () => mocks.channel }) }));
vi.mock('@/instance.js', () => ({ instance: mocks.instance }));

import { useChatRoomVoiceStates } from '@/composables/use-chat-room-voice-states.js';

const p = { identity: 'https://local.test/users/alice', user: { id: 'alice', username: 'alice' }, screenSharing: false };
let scope: EffectScope;

async function flush() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

function use(roomIds: string[]) {
	scope = effectScope();
	return scope.run(() => useChatRoomVoiceStates(ref(roomIds)))!;
}

beforeEach(() => {
	mocks.channel = new mocks.FakeChannel();
	mocks.instance.features.voiceCall = true;
	mocks.instance.features.remoteVoiceCall = false;
	mocks.misskeyApi.mockReset().mockResolvedValue([]);
});

afterEach(() => {
	scope?.stop();
	cleanup();
	vi.useRealTimers();
	// setVisibility で上書きした分を消し、本物 (Document.prototype) の値に戻す
	delete (document as { visibilityState?: unknown }).visibilityState;
});

function setVisibility(state: DocumentVisibilityState) {
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
	document.dispatchEvent(new Event('visibilitychange'));
}

describe('useChatRoomVoiceStates', () => {
	test('loads voice states for the given rooms', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [p] }]);
		const states = use(['r1', 'r2']);
		await flush();

		expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/states', { roomIds: ['r1', 'r2'] });
		expect(states.value.get('r1')?.participants).toEqual([p]);
		expect(states.value.has('r2')).toBe(false);
	});

	test('applies live updates and drops rooms whose call ended', async () => {
		const states = use(['r1', 'r2']);
		await flush();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r2', participants: [p] });
		expect(states.value.has('r2')).toBe(true);

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r2', participants: [] });
		expect(states.value.has('r2')).toBe(false);
	});

	test('ignores live updates for rooms that are not shown', async () => {
		const states = use(['r1']);
		await flush();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r9', participants: [p] });
		expect(states.value.has('r9')).toBe(false);
	});

	test('does not let a slow initial load overwrite a newer live update', async () => {
		let resolveLoad: (value: unknown) => void = () => {};
		mocks.misskeyApi.mockReturnValue(new Promise(resolve => {
			resolveLoad = resolve;
		}));
		const states = use(['r1']);
		await flush();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [] });
		resolveLoad([{ roomId: 'r1', participants: [p] }]);
		await flush();

		expect(states.value.has('r1')).toBe(false);
	});

	test('does not reload when the same rooms are passed again', async () => {
		scope = effectScope();
		const roomIds = ref(['r1', 'r2']);
		scope.run(() => useChatRoomVoiceStates(roomIds));
		await flush();

		roomIds.value = ['r1', 'r2'];
		await flush();
		expect(mocks.misskeyApi).toHaveBeenCalledTimes(1);

		roomIds.value = ['r1', 'r3'];
		await flush();
		expect(mocks.misskeyApi).toHaveBeenCalledTimes(2);
	});

	test('loads and follows the states on a server without its own LiveKit that joins calls on other servers', async () => {
		mocks.instance.features.voiceCall = false;
		mocks.instance.features.remoteVoiceCall = true;
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [p] }]);
		const states = use(['r1', 'r2']);
		await flush();

		expect(mocks.misskeyApi).toHaveBeenCalledWith('chat/rooms/voice/states', { roomIds: ['r1', 'r2'] });
		expect(states.value.get('r1')?.participants).toEqual([p]);

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r2', participants: [p] });
		expect(states.value.has('r2')).toBe(true);
	});

	test('does nothing when voice calls are disabled', async () => {
		mocks.instance.features.voiceCall = false;
		mocks.instance.features.remoteVoiceCall = false;
		const states = use(['r1']);
		await flush();

		expect(mocks.misskeyApi).not.toHaveBeenCalled();
		expect(states.value.size).toBe(0);
	});

	test('keeps an empty map when the request fails', async () => {
		mocks.misskeyApi.mockRejectedValue(new Error('network'));
		const states = use(['r1']);
		await flush();

		expect(states.value.size).toBe(0);
	});

	test('stops listening when the owner goes away', async () => {
		use(['r1']);
		await flush();

		scope.stop();

		expect(mocks.channel.dispose).toHaveBeenCalled();
	});
});

// サーバーは現況を保存した順に知らせるとは限らない (別々のワーカーが送る)。現況の時刻 (updatedAt) で新しいものを残す
describe('useChatRoomVoiceStates keeping the newest state of each room', () => {
	const T = 1_700_000_000_000;
	const q = { identity: 'https://local.test/users/bob', user: { id: 'bob', username: 'bob' }, screenSharing: true };

	function useRef(initial: string[]) {
		scope = effectScope();
		const roomIds = ref(initial);
		const states = scope.run(() => useChatRoomVoiceStates(roomIds))!;
		return { roomIds, states };
	}

	test('keeps a newer live update when an older one arrives late', async () => {
		const states = use(['r1']);
		await flush();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [p, q], updatedAt: T + 1 });
		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [p], updatedAt: T });

		expect(states.value.get('r1')).toEqual({ roomId: 'r1', participants: [p, q], updatedAt: T + 1 });
	});

	test('does not bring back an ended call when an older update arrives late', async () => {
		const states = use(['r1']);
		await flush();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [p], updatedAt: T });
		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [], updatedAt: T + 1 });
		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [p], updatedAt: T });

		expect(states.value.has('r1')).toBe(false);
	});

	test('applies an update with the same time', async () => {
		const states = use(['r1']);
		await flush();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [p], updatedAt: T });
		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [p, q], updatedAt: T });

		expect(states.value.get('r1')?.participants).toEqual([p, q]);
	});

	test('keeps a newer live update over an older fetched state', async () => {
		const { roomIds, states } = useRef(['r1']);
		await flush();
		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [p, q], updatedAt: T + 1 });

		mocks.misskeyApi.mockResolvedValueOnce([{ roomId: 'r1', participants: [p], updatedAt: T }, { roomId: 'r2', participants: [q], updatedAt: T }]);
		roomIds.value = ['r1', 'r2'];
		await flush();

		expect(states.value.get('r1')).toEqual({ roomId: 'r1', participants: [p, q], updatedAt: T + 1 });
		expect(states.value.get('r2')?.participants).toEqual([q]);
	});

	test('does not bring back an ended call from an older fetched state', async () => {
		const { roomIds, states } = useRef(['r1']);
		await flush();
		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [], updatedAt: T + 1 });

		mocks.misskeyApi.mockResolvedValueOnce([{ roomId: 'r1', participants: [p], updatedAt: T }]);
		roomIds.value = ['r1', 'r2'];
		await flush();

		expect(states.value.has('r1')).toBe(false);
	});

	test('ignores a live update older than a fetched state', async () => {
		mocks.misskeyApi.mockResolvedValueOnce([{ roomId: 'r1', participants: [p, q], updatedAt: T + 1 }]);
		const states = use(['r1']);
		await flush();

		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [], updatedAt: T });

		expect(states.value.get('r1')?.participants).toEqual([p, q]);
	});
});

// ホストのサーバーが落ちると通話の終わりは届かず、サーバー側の現況だけが寿命で消える
describe('useChatRoomVoiceStates reconciling with the server', () => {
	const statesCalls = () => mocks.misskeyApi.mock.calls.filter(([endpoint]) => endpoint === 'chat/rooms/voice/states');

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
	});

	async function advance(ms: number) {
		await vi.advanceTimersByTimeAsync(ms);
		await flush();
	}

	test('drops a silent host\'s call once the server stops reporting it', async () => {
		mocks.misskeyApi
			.mockResolvedValueOnce([{ roomId: 'r1', participants: [p] }])
			.mockResolvedValueOnce([{ roomId: 'r1', participants: [p] }])
			.mockResolvedValue([]);
		const states = use(['r1', 'r2']);
		await flush();
		expect(states.value.has('r1')).toBe(true);

		// サーバーがまだ通話を返す間は出したまま
		await advance(30_000);
		expect(statesCalls()).toHaveLength(2);
		expect(statesCalls()[1]).toEqual(['chat/rooms/voice/states', { roomIds: ['r1', 'r2'] }]);
		expect(states.value.has('r1')).toBe(true);

		// サーバー側の現況が寿命で消えたら、次の取り直しで消える
		await advance(30_000);
		expect(statesCalls()).toHaveLength(3);
		expect(states.value.has('r1')).toBe(false);

		// 何も出していなければもう取り直さない
		await advance(90_000);
		expect(statesCalls()).toHaveLength(3);
	});

	test('does not poll when no call is shown', async () => {
		use(['r1', 'r2']);
		await flush();

		await advance(90_000);
		expect(statesCalls()).toHaveLength(1);
	});

	test('does not poll while the page is hidden, and refreshes once when it is shown again', async () => {
		setVisibility('hidden');
		mocks.misskeyApi.mockResolvedValueOnce([{ roomId: 'r1', participants: [p] }]).mockResolvedValue([]);
		const states = use(['r1']);
		await flush();
		expect(states.value.has('r1')).toBe(true);

		await advance(90_000);
		expect(statesCalls()).toHaveLength(1);

		setVisibility('visible');
		await flush();
		expect(statesCalls()).toHaveLength(2);
		expect(states.value.has('r1')).toBe(false);
	});

	test('keeps showing the call when a refresh fails', async () => {
		mocks.misskeyApi.mockResolvedValueOnce([{ roomId: 'r1', participants: [p] }]).mockRejectedValue(new Error('network'));
		const states = use(['r1']);
		await flush();

		await advance(30_000);
		expect(statesCalls()).toHaveLength(2);
		expect(states.value.has('r1')).toBe(true);
	});

	test('does not let a refresh overwrite a newer live update', async () => {
		mocks.misskeyApi.mockResolvedValueOnce([{ roomId: 'r1', participants: [p] }]);
		const states = use(['r1']);
		await flush();

		let resolveRefresh: (value: unknown) => void = () => {};
		mocks.misskeyApi.mockReturnValue(new Promise(resolve => {
			resolveRefresh = resolve;
		}));
		await advance(30_000);
		mocks.channel.emit('chatRoomVoiceState', { roomId: 'r1', participants: [] });
		resolveRefresh([{ roomId: 'r1', participants: [p] }]);
		await flush();

		expect(states.value.has('r1')).toBe(false);
	});

	test('stops polling when the owner goes away', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [p] }]);
		use(['r1']);
		await flush();

		scope.stop();
		await advance(90_000);
		expect(statesCalls()).toHaveLength(1);
	});

	test('does not poll while the page waits in the background, and refreshes once when it comes back', async () => {
		mocks.misskeyApi.mockResolvedValue([{ roomId: 'r1', participants: [p] }]);
		const shown = ref(true);
		const Page = defineComponent({
			setup() {
				useChatRoomVoiceStates(ref(['r1']));
				return () => null;
			},
		});
		render(defineComponent({
			setup: () => () => h(KeepAlive, null, [shown.value ? h(Page, { key: 'page' }) : h('div', { key: 'other' })]),
		}));
		await flush();
		expect(statesCalls()).toHaveLength(1);

		shown.value = false;
		await flush();
		await advance(90_000);
		expect(statesCalls()).toHaveLength(1);

		shown.value = true;
		await flush();
		expect(statesCalls()).toHaveLength(2);
	});
});
