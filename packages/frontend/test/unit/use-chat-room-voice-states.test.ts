/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { EffectScope } from 'vue';

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
		instance: { features: { voiceCall: true } },
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
	mocks.misskeyApi.mockReset().mockResolvedValue([]);
});

afterEach(() => {
	scope?.stop();
});

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

	test('does nothing when voice calls are disabled', async () => {
		mocks.instance.features.voiceCall = false;
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
