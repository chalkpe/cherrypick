/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { getBrowser } from 'livekit-client';
import { HANDOVER_DELAY_MS, MAX_VOLUME, SETTLE_DELAY_MS, WAKE_GRACE_MS, VoiceBoost, detectPlatform } from '@/utility/voice-boost.js';

type FakeNode = { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
type FakeGain = FakeNode & { gain: { value: number; setTargetAtTime: ReturnType<typeof vi.fn> } };

// stateDelayMs를 주면 Firefox·WebKit처럼 suspend()·resume()이 끝난 뒤에야 state가 바뀐다 (fake timer 필요)
function createFakeContext(options: { stateDelayMs?: number } = {}) {
	// 실제 브라우저처럼 상태가 바뀐 뒤에 약속이 풀린다
	const changeState = (state: AudioContextState): Promise<void> => {
		if (options.stateDelayMs == null) {
			context.setState(state);
			return Promise.resolve();
		}
		return new Promise(resolve => {
			setTimeout(() => {
				context.setState(state);
				resolve();
			}, options.stateDelayMs);
		});
	};
	const listeners = new Set<() => void>();
	const nodes = { gains: [] as FakeGain[], sources: [] as FakeNode[], destinations: [] as Array<FakeNode & { stream: object }> };
	const node = (): FakeNode => ({ connect: vi.fn(), disconnect: vi.fn() });
	const context = {
		state: 'running' as AudioContextState,
		destination: { id: 'context-destination' },
		createMediaStreamSource: vi.fn(() => { const n = node(); nodes.sources.push(n); return n; }),
		createGain: vi.fn(() => { const n = { ...node(), gain: { value: 1, setTargetAtTime: vi.fn() } }; nodes.gains.push(n); return n; }),
		createMediaStreamDestination: vi.fn(() => { const n = { ...node(), stream: {} }; nodes.destinations.push(n); return n; }),
		addEventListener: vi.fn((_: string, listener: () => void) => { listeners.add(listener); }),
		removeEventListener: vi.fn((_: string, listener: () => void) => { listeners.delete(listener); }),
		resume: vi.fn(() => changeState('running')),
		suspend: vi.fn(() => changeState('suspended')),
		close: vi.fn(async () => { context.state = 'closed'; }),
		setState(state: AudioContextState) { context.state = state; for (const l of listeners) l(); },
	};
	return { context, nodes };
}

function createFakeElement() {
	const listeners = new Map<string, Set<() => void>>();
	const element = {
		srcObject: null as unknown,
		sinkId: '',
		muted: false,
		addEventListener: vi.fn((type: string, listener: () => void, options?: { signal?: AbortSignal }) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(listener);
			options?.signal?.addEventListener('abort', () => listeners.get(type)?.delete(listener));
		}),
		emit(type: string) { for (const listener of [...listeners.get(type) ?? []]) listener(); },
		listenerCount(type: string) { return listeners.get(type)?.size ?? 0; },
		play: vi.fn().mockResolvedValue(undefined),
		pause: vi.fn(),
		setSinkId: vi.fn(async (id: string) => { element.sinkId = id; }),
	};
	return element;
}

const track = () => ({ mediaStreamTrack: {} as MediaStreamTrack });

type FakeElement = ReturnType<typeof createFakeElement>;

function createBoost(options: { useElement?: boolean; keepMediaCategory?: boolean; settleDelayMs?: number; stateDelayMs?: number; element?: (element: FakeElement) => void; createContext?: () => AudioContext } = {}) {
	const fake = createFakeContext({ stateDelayMs: options.stateDelayMs });
	const elements: FakeElement[] = [];
	const onBlockedChange = vi.fn<(blocked: boolean) => void>();
	const onReady = vi.fn<() => void>();
	const boost = new VoiceBoost({
		onBlockedChange,
		onReadyChange: onReady,
		useElement: options.useElement ?? true,
		keepMediaCategory: options.keepMediaCategory,
		settleDelayMs: options.settleDelayMs ?? SETTLE_DELAY_MS,
		createContext: options.createContext ?? (() => fake.context as unknown as AudioContext),
		createElement: () => {
			const element = createFakeElement();
			options.element?.(element);
			elements.push(element);
			return element as unknown as HTMLAudioElement;
		},
	});
	return { boost, fake, elements, onBlockedChange, onReady };
}

describe('VoiceBoost', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
	});

	test('does nothing at 100% and for a muted track', () => {
		const { boost, fake } = createBoost();
		const t = track();

		expect(boost.set(t, 1)).toBe(true);
		expect(boost.set(t, 0)).toBe(true);

		expect(fake.context.createGain).not.toHaveBeenCalled();
		expect(boost.active).toBe(false);
	});

	test('plays a track below 100% through the gain as well', () => {
		const { boost, fake } = createBoost({ useElement: false });
		const t = track();

		expect(boost.set(t, 0.5)).toBe(true);

		expect(boost.active).toBe(true);
		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.5, 0, 0.005);

		boost.set(t, 0);

		expect(boost.active).toBe(false);
	});

	test('plays a track above 100% through one gain, and the gain follows the volume', async () => {
		const { boost, fake, elements } = createBoost({ settleDelayMs: 0 });
		const t = track();

		expect(boost.set(t, 1.5)).toBe(true);
		await vi.waitFor(() => expect(boost.isReady(t)).toBe(true));

		expect(boost.active).toBe(true);
		expect(fake.nodes.gains[0].gain.value).toBe(1.5);
		expect(elements).toHaveLength(1);
		expect(elements[0].srcObject).toBe(fake.nodes.destinations[0].stream);
		expect(elements[0].play).toHaveBeenCalled();

		boost.set(t, 1.8);

		expect(fake.context.createGain).toHaveBeenCalledOnce();
		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1.8, 0, 0.1);
		expect(elements).toHaveLength(1);
	});

	test('never exceeds 200%', () => {
		const { boost, fake } = createBoost({ useElement: false });
		const t = track();

		boost.set(t, 9);
		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(MAX_VOLUME, 0, 0.005);

		boost.set(t, 7);
		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenCalledOnce();
	});

	test('tears the track down when the volume goes back to 100%', () => {
		const { boost, fake, elements } = createBoost();
		const t = track();
		boost.set(t, 2);

		boost.set(t, 1);

		expect(boost.active).toBe(false);
		expect(elements[0].pause).toHaveBeenCalled();
		expect(elements[0].srcObject).toBeNull();
		expect(fake.nodes.sources[0].disconnect).toHaveBeenCalled();
		expect(fake.nodes.gains[0].disconnect).toHaveBeenCalled();
	});

	test('sends the sound to the chosen output device, also to tracks amplified before and after', async () => {
		const { boost, elements } = createBoost();
		boost.set(track(), 1.5);

		await boost.setSinkId('device-b');
		boost.set(track(), 2);

		expect(elements[0].setSinkId).toHaveBeenLastCalledWith('device-b');
		expect(elements[1].setSinkId).toHaveBeenCalledWith('device-b');
	});

	test('survives an output device the browser refuses, and tries the same device again', async () => {
		const { boost, elements } = createBoost();
		boost.set(track(), 1.5);
		elements[0].setSinkId.mockRejectedValueOnce(new Error('NotFoundError'));

		await expect(boost.setSinkId('gone')).resolves.toBeUndefined();
		await boost.setSinkId('gone');

		// 재생 시작 때의 기본 장치, 거절된 'gone', 다시 시도한 'gone'
		expect(elements[0].setSinkId).toHaveBeenCalledTimes(3);
		expect(elements[0].sinkId).toBe('gone');
	});

	test('reports being blocked while the context is suspended and recovers on resume', async () => {
		const { boost, fake, onBlockedChange } = createBoost();
		boost.set(track(), 1.5);

		fake.context.setState('suspended');
		expect(boost.blocked).toBe(true);
		expect(onBlockedChange).toHaveBeenLastCalledWith(true);

		await boost.resume();
		expect(fake.context.resume).toHaveBeenCalled();
		expect(boost.blocked).toBe(false);
		expect(onBlockedChange).toHaveBeenLastCalledWith(false);
	});

	test('reports being blocked when the element is not allowed to play, and plays on resume', async () => {
		const { boost, elements } = createBoost({ element: element => element.play.mockRejectedValueOnce(new Error('NotAllowedError')) });
		boost.set(track(), 1.5);
		await vi.waitFor(() => expect(boost.blocked).toBe(true));

		await boost.resume();

		expect(elements[0].play).toHaveBeenCalledTimes(2);
		expect(boost.blocked).toBe(false);
	});

	test('connects to the context output without an element where the output device cannot be chosen', () => {
		const { boost, fake } = createBoost({ useElement: false });
		const t = track();

		boost.set(t, 1.5);

		expect(fake.context.createMediaStreamDestination).not.toHaveBeenCalled();
		expect(fake.nodes.gains[0].connect).toHaveBeenCalledWith(fake.context.destination);
		fake.context.setState('suspended');
		expect(boost.blocked).toBe(true);
	});

	test('is not blocked when nothing is amplified', () => {
		const { boost, fake } = createBoost();
		fake.context.state = 'suspended';

		expect(boost.blocked).toBe(false);
	});

	test('reports a failure to create the context, and leaves nothing behind', () => {
		const { boost } = createBoost({ createContext: () => { throw new Error('no AudioContext'); } });

		expect(boost.set(track(), 1.5)).toBe(false);

		expect(boost.active).toBe(false);
		expect(boost.blocked).toBe(false);
	});

	test.each(['createMediaStreamSource', 'createGain', 'createMediaStreamDestination'] as const)('reports a failure of %s and cleans up what it made', method => {
		const { boost, fake, elements } = createBoost();
		fake.context[method].mockImplementationOnce(() => { throw new Error('boom'); });

		expect(boost.set(track(), 1.5)).toBe(false);

		expect(boost.active).toBe(false);
		expect(elements).toHaveLength(0);
		for (const node of [...fake.nodes.sources, ...fake.nodes.gains, ...fake.nodes.destinations]) expect(node.disconnect).toHaveBeenCalled();
	});

	test('reports a failure to create the element', () => {
		const { boost, fake } = createBoost({ element: () => { throw new Error('no Audio'); } });

		expect(boost.set(track(), 1.5)).toBe(false);

		expect(boost.active).toBe(false);
		expect(fake.nodes.gains[0].disconnect).toHaveBeenCalled();
	});

	test('dispose removes everything, closes the context and ignores later requests', () => {
		const { boost, fake, elements } = createBoost();
		boost.set(track(), 1.5);
		boost.set(track(), 2);

		boost.dispose();

		expect(boost.active).toBe(false);
		expect(elements.every(e => e.pause.mock.calls.length > 0 && e.srcObject === null)).toBe(true);
		expect(fake.context.close).toHaveBeenCalledOnce();
		expect(boost.set(track(), 2)).toBe(false);
		expect(boost.active).toBe(false);
	});
});

describe('VoiceBoost readiness', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('is ready on the direct output path once the sound has had time to reach the output', async () => {
		const { boost, onReady } = createBoost({ useElement: false, settleDelayMs: SETTLE_DELAY_MS });
		const t = track();

		boost.set(t, 0.5);
		expect(boost.isReady(t)).toBe(false);

		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

		expect(boost.isReady(t)).toBe(true);
		expect(onReady).toHaveBeenCalled();
	});

	test('is ready on the element path only after the element started playing', async () => {
		let startPlaying!: () => void;
		const { boost, onReady } = createBoost({ settleDelayMs: SETTLE_DELAY_MS, element: element => { element.play.mockImplementation(() => new Promise<void>(resolve => { startPlaying = resolve; })); } });
		const t = track();

		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS * 2);
		expect(boost.isReady(t)).toBe(false);
		expect(onReady).not.toHaveBeenCalled();

		startPlaying();
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

		expect(boost.isReady(t)).toBe(true);
		expect(onReady).toHaveBeenCalledOnce();
	});

	test('is not ready while the context is suspended, and becomes ready when it runs', async () => {
		const { boost, fake, onReady } = createBoost({ useElement: false });
		fake.context.state = 'suspended';
		fake.context.resume.mockImplementation(async () => {});
		const t = track();

		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);
		expect(boost.isReady(t)).toBe(false);

		fake.context.setState('running');
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

		expect(boost.isReady(t)).toBe(true);
		expect(onReady).toHaveBeenCalled();
	});

	test('is not ready when the element is not allowed to play', async () => {
		const { boost } = createBoost({ element: element => { element.play.mockRejectedValue(new Error('NotAllowedError')); } });
		const t = track();

		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(0);

		expect(boost.isReady(t)).toBe(false);
	});

	test('stops being ready for a track that is released', () => {
		const { boost } = createBoost({ useElement: false });
		const t = track();
		boost.set(t, 1.5);

		boost.release(t);

		expect(boost.isReady(t)).toBe(false);
	});

	test('plays straight to the context output when not told to use an element', () => {
		const fake = createFakeContext();
		const boost = new VoiceBoost({ createContext: () => fake.context as unknown as AudioContext });

		boost.set(track(), 1.5);

		expect(fake.context.createMediaStreamDestination).not.toHaveBeenCalled();
	});

	test('creates and resumes the context synchronously when prepared, and suspends it again if nothing was amplified', async () => {
		const { boost, fake } = createBoost({ useElement: false });
		fake.context.state = 'suspended';

		boost.prepare();

		expect(fake.context.resume).toHaveBeenCalledOnce();
		expect(fake.context.state).toBe('running');

		await vi.advanceTimersByTimeAsync(5000);

		expect(fake.context.suspend).toHaveBeenCalled();
	});

	test('keeps the prepared context running when a track is amplified in the meantime', async () => {
		const { boost, fake } = createBoost({ useElement: false });
		boost.prepare();
		boost.set(track(), 0.5);

		await vi.advanceTimersByTimeAsync(5000);

		expect(fake.context.suspend).not.toHaveBeenCalled();
		expect(fake.context.state).toBe('running');
	});

	test('does not prepare after being disposed', () => {
		const { boost, fake } = createBoost({ useElement: false });
		boost.dispose();

		boost.prepare();

		expect(fake.context.resume).not.toHaveBeenCalled();
	});
});

describe('VoiceBoost with a context that changes state after suspend and resume finish', () => {
	const IDLE = 3000;
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('does not suspend the context right after the last track is released', async () => {
		const { boost, fake } = createBoost({ useElement: false, stateDelayMs: 1 });
		const t = track();
		boost.set(t, 1.5);

		boost.release(t);
		await vi.advanceTimersByTimeAsync(IDLE - 1);

		expect(fake.context.suspend).not.toHaveBeenCalled();
	});

	test('suspends the context once nothing has been amplified for a while, and keeps it for the next amplification', async () => {
		const { boost, fake } = createBoost({ useElement: false, stateDelayMs: 1 });
		const t = track();
		boost.set(t, 1.5);

		boost.release(t);
		await vi.advanceTimersByTimeAsync(IDLE + 10);

		expect(fake.context.suspend).toHaveBeenCalledOnce();
		expect(fake.context.state).toBe('suspended');
		expect(fake.context.close).not.toHaveBeenCalled();
		expect(boost.blocked).toBe(false);
	});

	test('is not blocked while suspended with nothing amplified', async () => {
		const { boost, onBlockedChange } = createBoost({ useElement: false, stateDelayMs: 1 });
		const t = track();
		boost.set(t, 1.5);

		boost.release(t);
		await vi.advanceTimersByTimeAsync(IDLE + 10);

		expect(boost.blocked).toBe(false);
		expect(onBlockedChange).not.toHaveBeenCalledWith(true);
	});

	test('keeps running when a track is amplified again in the same task as the release', async () => {
		const { boost, fake } = createBoost({ useElement: false, stateDelayMs: 1 });
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(10);

		boost.release(t);
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(500);

		expect(fake.context.state).toBe('running');
		expect(boost.blocked).toBe(false);
	});

	test('resumes the context when a track is amplified while the idle suspend is still finishing', async () => {
		const { boost, fake } = createBoost({ useElement: false, stateDelayMs: 1 });
		boost.prepare();
		await vi.advanceTimersByTimeAsync(IDLE);
		expect(fake.context.suspend).toHaveBeenCalledOnce();
		expect(fake.context.state).toBe('running');

		boost.set(track(), 1.5);
		await vi.advanceTimersByTimeAsync(500);

		expect(fake.context.state).toBe('running');
		expect(boost.blocked).toBe(false);
	});

	test('resumes the context when prepared while the idle suspend is still finishing', async () => {
		const { boost, fake } = createBoost({ useElement: false, stateDelayMs: 1 });
		boost.prepare();
		await vi.advanceTimersByTimeAsync(IDLE);
		expect(fake.context.state).toBe('running');

		boost.prepare();
		await vi.advanceTimersByTimeAsync(500);

		expect(fake.context.state).toBe('running');
	});
});

describe('VoiceBoost fade-in', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('starts silent and raises the gain to the target when the element starts playing', async () => {
		let startPlaying!: () => void;
		const { boost, fake } = createBoost({ element: element => { element.play.mockImplementation(() => new Promise<void>(resolve => { startPlaying = resolve; })); } });
		boost.set(track(), 1.5);

		expect(fake.nodes.gains[0].gain.value).toBe(0);
		expect(fake.nodes.gains[0].gain.setTargetAtTime).not.toHaveBeenCalled();

		startPlaying();
		await vi.advanceTimersByTimeAsync(0);

		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenCalledWith(1.5, 0, 0.005);
	});

	test('raises the gain before telling the caller that the track is ready', async () => {
		const fake = createFakeContext();
		let rampedWhenReported = false;
		const boost = new VoiceBoost({
			settleDelayMs: SETTLE_DELAY_MS,
			createContext: () => fake.context as unknown as AudioContext,
			onReadyChange: () => { rampedWhenReported = fake.nodes.gains[0].gain.setTargetAtTime.mock.calls.length > 0; },
		});

		boost.set(track(), 1.5);
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

		expect(rampedWhenReported).toBe(true);
	});

	test('keeps the gain at zero while the context cannot run, and raises it when it runs', () => {
		const { boost, fake } = createBoost({ useElement: false });
		fake.context.state = 'suspended';
		fake.context.resume.mockImplementation(async () => {});

		boost.set(track(), 1.5);
		expect(fake.nodes.gains[0].gain.setTargetAtTime).not.toHaveBeenCalled();

		fake.context.setState('running');

		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenCalledWith(1.5, 0, 0.005);
	});

	test('follows a volume change made before the track became ready', async () => {
		let startPlaying!: () => void;
		const { boost, fake } = createBoost({ element: element => { element.play.mockImplementation(() => new Promise<void>(resolve => { startPlaying = resolve; })); } });
		const t = track();
		boost.set(t, 1.5);

		boost.set(t, 1.8);
		startPlaying();
		await vi.advanceTimersByTimeAsync(0);

		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1.8, 0, 0.005);
	});

	test('follows a volume change made before the track became ready when the browser does not wait', async () => {
		let startPlaying!: () => void;
		const { boost, fake } = createBoost({ settleDelayMs: 0, element: element => { element.play.mockImplementation(() => new Promise<void>(resolve => { startPlaying = resolve; })); } });
		const t = track();
		boost.set(t, 1.5);

		boost.set(t, 1.8);
		expect(fake.nodes.gains[0].gain.setTargetAtTime).not.toHaveBeenCalled();
		startPlaying();
		await vi.advanceTimersByTimeAsync(0);

		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenCalledOnce();
		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenCalledWith(1.8, 0, 0.1);
	});

	test('keeps the short ramp for volume changes while the original playback is still audible', async () => {
		const { boost, fake } = createBoost({ settleDelayMs: SETTLE_DELAY_MS });
		const t = track();
		boost.set(t, 1.2);
		await vi.advanceTimersByTimeAsync(0);

		boost.set(t, 1.5);
		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1.5, 0, 0.005);

		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);
		boost.set(t, 1.8);

		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1.8, 0, 0.1);
	});
});

describe('VoiceBoost element playback state', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('stops being ready when the element is paused by the browser, and is ready again when it plays', async () => {
		const { boost, elements, onReady } = createBoost();
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);
		expect(boost.isReady(t)).toBe(true);
		onReady.mockClear();

		elements[0].emit('pause');

		expect(boost.isReady(t)).toBe(false);
		expect(onReady).toHaveBeenCalledOnce();

		elements[0].emit('playing');
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

		expect(boost.isReady(t)).toBe(true);
		expect(onReady).toHaveBeenCalledTimes(2);
	});

	test('is not blocked and is ready again when the browser plays the element on its own after a second pause', async () => {
		const { boost, elements } = createBoost();
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

		elements[0].emit('pause');
		await vi.advanceTimersByTimeAsync(0);
		elements[0].emit('pause');
		expect(boost.blocked).toBe(true);

		elements[0].emit('playing');
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

		expect(boost.blocked).toBe(false);
		expect(boost.isReady(t)).toBe(true);
	});

	test('ignores the pause of an element that was torn down', async () => {
		const { boost, elements, onReady } = createBoost();
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(0);
		boost.release(t);
		onReady.mockClear();

		elements[0].emit('pause');

		expect(onReady).not.toHaveBeenCalled();
		expect(elements[0].listenerCount('pause')).toBe(0);
	});

	test('tries the same output device again after it failed for a newly created element', async () => {
		const { boost, elements } = createBoost({ element: element => element.setSinkId.mockRejectedValueOnce(new Error('NotFoundError')) });
		boost.set(track(), 1.5);
		await vi.advanceTimersByTimeAsync(0);

		await boost.setSinkId('');

		expect(elements[0].setSinkId).toHaveBeenCalledTimes(2);
	});
});

describe('VoiceBoost handover between the original element and the amplifier', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('reports a track as ready only after the sound has had time to reach the output', async () => {
		const { boost, onReady } = createBoost({ useElement: false, settleDelayMs: SETTLE_DELAY_MS });
		const t = track();

		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS - 1);
		expect(boost.isReady(t)).toBe(false);
		expect(onReady).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		expect(boost.isReady(t)).toBe(true);
		expect(onReady).toHaveBeenCalledOnce();
	});

	test('starts raising the gain before the track is reported as ready', () => {
		const { boost, fake } = createBoost({ useElement: false, settleDelayMs: SETTLE_DELAY_MS });
		const t = track();

		boost.set(t, 1.5);

		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenCalledWith(1.5, 0, expect.any(Number));
		expect(boost.isReady(t)).toBe(false);
	});

	test('waits again after the element was paused and plays again', async () => {
		const { boost, elements } = createBoost({ settleDelayMs: SETTLE_DELAY_MS });
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);
		elements[0].emit('pause');

		elements[0].emit('playing');

		expect(boost.isReady(t)).toBe(false);

		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

		expect(boost.isReady(t)).toBe(true);
	});

	test('keeps the amplifier for a short while after a delayed release, without reporting the track as ready', async () => {
		const { boost, fake, onReady } = createBoost({ useElement: false, settleDelayMs: SETTLE_DELAY_MS });
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);
		onReady.mockClear();

		boost.release(t, HANDOVER_DELAY_MS);

		expect(boost.active).toBe(true);
		expect(boost.isReady(t)).toBe(false);
		expect(onReady).toHaveBeenCalledOnce();
		expect(fake.nodes.gains[0].disconnect).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(HANDOVER_DELAY_MS);

		expect(boost.active).toBe(false);
		expect(fake.nodes.gains[0].disconnect).toHaveBeenCalled();
	});

	test('keeps the track amplified when it is set again during a delayed release', async () => {
		const { boost, fake } = createBoost({ useElement: false, settleDelayMs: SETTLE_DELAY_MS });
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);
		boost.release(t, HANDOVER_DELAY_MS);

		boost.set(t, 1.8);
		await vi.advanceTimersByTimeAsync(HANDOVER_DELAY_MS * 2);

		expect(boost.active).toBe(true);
		expect(fake.nodes.gains[0].disconnect).not.toHaveBeenCalled();
		expect(fake.context.createGain).toHaveBeenCalledOnce();
	});

	test('releases immediately without a delay', () => {
		const { boost } = createBoost({ useElement: false, settleDelayMs: SETTLE_DELAY_MS });
		const t = track();
		boost.set(t, 1.5);

		boost.release(t);

		expect(boost.active).toBe(false);
	});

	test('tears down a track whose delayed release is pending when disposed', async () => {
		const { boost, fake } = createBoost({ useElement: false, settleDelayMs: SETTLE_DELAY_MS });
		const t = track();
		boost.set(t, 1.5);
		boost.release(t, HANDOVER_DELAY_MS);

		boost.dispose();
		await vi.advanceTimersByTimeAsync(HANDOVER_DELAY_MS);

		expect(fake.nodes.gains[0].disconnect).toHaveBeenCalledOnce();
	});

	test('does not wait when no delay is given', () => {
		const { boost } = createBoost({ useElement: false, settleDelayMs: 0 });
		const t = track();

		boost.set(t, 1.5);

		expect(boost.isReady(t)).toBe(true);
	});
});

describe('VoiceBoost media playback category', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('plays a silent stream through an unmuted element while a track is amplified', async () => {
		const { boost, fake, elements } = createBoost({ useElement: false, keepMediaCategory: true });

		boost.set(track(), 0.5);

		expect(elements).toHaveLength(1);
		expect(elements[0].play).toHaveBeenCalled();
		expect(elements[0].muted).toBe(false);
		expect(elements[0].srcObject).toBe(fake.nodes.destinations[0].stream);
		expect(fake.nodes.gains[0].connect).not.toHaveBeenCalledWith(fake.nodes.destinations[0]);
	});

	test('does not create the element on other platforms', () => {
		const { boost, elements } = createBoost({ useElement: false });

		boost.set(track(), 0.5);
		boost.prepare();

		expect(elements).toHaveLength(0);
	});

	test('starts the element when prepared in a user gesture, and only pauses it when nothing was amplified', async () => {
		const { boost, elements } = createBoost({ useElement: false, keepMediaCategory: true });

		boost.prepare();

		expect(elements).toHaveLength(1);
		expect(elements[0].play).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(5000);

		expect(elements[0].pause).toHaveBeenCalled();
		expect(elements[0].srcObject).not.toBeNull();
	});

	test('keeps the element while another track is still amplified, and pauses it after the last one', async () => {
		const { boost, elements } = createBoost({ useElement: false, keepMediaCategory: true });
		const a = track();
		const b = track();
		boost.set(a, 0.5);
		boost.set(b, 1.5);

		boost.release(a);
		await vi.advanceTimersByTimeAsync(5000);
		expect(elements[0].pause).not.toHaveBeenCalled();

		boost.release(b);
		await vi.advanceTimersByTimeAsync(5000);

		expect(elements[0].pause).toHaveBeenCalled();
	});

	test('plays the same element again after it was paused for being idle', async () => {
		const { boost, elements } = createBoost({ useElement: false, keepMediaCategory: true });
		boost.prepare();
		await vi.advanceTimersByTimeAsync(5000);

		boost.set(track(), 0.5);

		expect(elements).toHaveLength(1);
		expect(elements[0].play).toHaveBeenCalledTimes(2);
	});

	test('starts the element again in the same synchronous stretch as the sound-on action', async () => {
		const { boost, fake, elements } = createBoost({ useElement: false, keepMediaCategory: true });
		boost.prepare();
		await vi.advanceTimersByTimeAsync(5000);
		fake.context.resume.mockImplementation(() => new Promise<void>(() => {}));

		void boost.resume();

		expect(elements[0].play).toHaveBeenCalledTimes(2);
	});

	test('starts the element again by the sound-on action when the browser refused it outside a gesture', async () => {
		const { boost, elements } = createBoost({ useElement: false, keepMediaCategory: true, element: element => element.play.mockRejectedValueOnce(new Error('NotAllowedError')) });
		boost.set(track(), 0.5);
		await vi.advanceTimersByTimeAsync(0);
		expect(boost.blocked).toBe(false);

		await boost.resume();

		expect(elements[0].play).toHaveBeenCalledTimes(2);
	});

	test('removes the element when disposed', () => {
		const { boost, elements } = createBoost({ useElement: false, keepMediaCategory: true });
		boost.set(track(), 0.5);

		boost.dispose();

		expect(elements[0].pause).toHaveBeenCalled();
		expect(elements[0].srcObject).toBeNull();
	});
});

describe('detectPlatform', () => {
	const platformOf = (userAgent: string, maxTouchPoints = 0) => detectPlatform(getBrowser(userAgent), maxTouchPoints);
	const CHROMIUM = { appleMobile: false, needsGestureToStartAudio: false, settleDelayMs: SETTLE_DELAY_MS, handoverDelayMs: HANDOVER_DELAY_MS };
	const OTHER = { appleMobile: false, needsGestureToStartAudio: false, settleDelayMs: 0, handoverDelayMs: 0 };
	const APPLE_MOBILE = { appleMobile: true, needsGestureToStartAudio: true, settleDelayMs: 0, handoverDelayMs: 0 };
	const SAFARI = { appleMobile: false, needsGestureToStartAudio: true, settleDelayMs: 0, handoverDelayMs: 0 };

	test.each([
		['Chrome on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 0],
		['Chrome on Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 0],
		['Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0', 0],
		['Opera', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0', 0],
		['Samsung Internet', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36', 5],
		['Android Chrome', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36', 5],
		['Android WebView', 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36', 5],
	])('waits for the output path and needs no gesture in %s', (_name, userAgent, touchPoints) => {
		expect(platformOf(userAgent, touchPoints)).toEqual(CHROMIUM);
	});

	test.each([
		['Firefox on desktop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0', 0],
		['Firefox on Android', 'Mozilla/5.0 (Android 15; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0', 5],
	])('neither waits nor needs a gesture in %s', (_name, userAgent, touchPoints) => {
		expect(platformOf(userAgent, touchPoints)).toEqual(OTHER);
	});

	test.each([
		['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1', 5],
		['iPhone Chrome', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1', 5],
		['iPhone Firefox', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/145.0 Mobile/15E148 Safari/605.1.15', 5],
		['iPhone Edge', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 EdgiOS/142.0.0.0 Mobile/15E148 Safari/605.1.15', 5],
		['iPad with the mobile user agent', 'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1', 5],
		['iPadOS Safari with the desktop user agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15', 5],
	])('treats %s as an Apple mobile device that needs a gesture and does not wait', (_name, userAgent, touchPoints) => {
		expect(platformOf(userAgent, touchPoints)).toEqual(APPLE_MOBILE);
	});

	test.each([
		['macOS Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15'],
		['Linux WebKitGTK', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'],
		['WKWebView without a Safari token', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'],
	])('needs a gesture but is not an Apple mobile device in %s', (_name, userAgent) => {
		expect(platformOf(userAgent, 0)).toEqual(SAFARI);
	});

	test('does not treat a Mac user agent with touch points as an Apple mobile device unless it is Safari', () => {
		expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 5).appleMobile).toBe(false);
	});

	test('is the most cautious when the browser is unknown', () => {
		expect(detectPlatform(undefined, 5)).toEqual(OTHER);
	});
});

describe('VoiceBoost gain ramps', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('keeps the short ramp when the caller sets the same volume again as soon as the track is ready', async () => {
		const fake = createFakeContext();
		const t = track();
		const boost: VoiceBoost = new VoiceBoost({
			settleDelayMs: SETTLE_DELAY_MS,
			useElement: true,
			createContext: () => fake.context as unknown as AudioContext,
			createElement: () => createFakeElement() as unknown as HTMLAudioElement,
			onReadyChange: () => { boost.set(t, 1.5); },
		});

		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS * 2);

		expect(boost.isReady(t)).toBe(true);
		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1.5, 0, 0.005);
	});

	test('starts a new playback at the target gain and does not raise it again when the browser does not wait', async () => {
		const { boost, fake, onReady } = createBoost({ settleDelayMs: 0 });
		const t = track();

		boost.set(t, 1.5);
		expect(fake.nodes.gains[0].gain.value).toBe(1.5);

		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS * 2);

		expect(boost.isReady(t)).toBe(true);
		expect(onReady).toHaveBeenCalled();
		expect(fake.nodes.gains[0].gain.value).toBe(1.5);
		expect(fake.nodes.gains[0].gain.setTargetAtTime).not.toHaveBeenCalled();
	});

	test('still follows a volume change after a playback that started at the target gain', async () => {
		const { boost, fake } = createBoost({ settleDelayMs: 0 });
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(0);

		boost.set(t, 1.8);

		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1.8, 0, 0.1);
	});

	test('does not raise the gain of a track that started while its release was pending', async () => {
		let startPlaying!: () => void;
		const { boost, fake } = createBoost({ settleDelayMs: SETTLE_DELAY_MS, element: element => { element.play.mockImplementation(() => new Promise<void>(resolve => { startPlaying = resolve; })); } });
		const t = track();
		boost.set(t, 1.5);
		boost.release(t, HANDOVER_DELAY_MS);

		startPlaying();
		await vi.advanceTimersByTimeAsync(0);

		expect(fake.nodes.gains[0].gain.setTargetAtTime).not.toHaveBeenCalled();
	});

	test('raises the gain when a pending release is cancelled after the track started', async () => {
		let startPlaying!: () => void;
		const { boost, fake } = createBoost({ settleDelayMs: SETTLE_DELAY_MS, element: element => { element.play.mockImplementation(() => new Promise<void>(resolve => { startPlaying = resolve; })); } });
		const t = track();
		boost.set(t, 1.5);
		boost.release(t, HANDOVER_DELAY_MS);
		startPlaying();
		await vi.advanceTimersByTimeAsync(0);

		boost.set(t, 1.5);

		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1.5, 0, 0.005);
	});

	test('cancels the wait when the context stops, and waits again from the start when it runs', async () => {
		const { boost, fake } = createBoost({ useElement: false, settleDelayMs: SETTLE_DELAY_MS });
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS / 2);
		fake.context.setState('suspended');
		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS * 2);

		fake.context.setState('running');

		expect(boost.isReady(t)).toBe(false);

		await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

		expect(boost.isReady(t)).toBe(true);
	});
});

describe('VoiceBoost idle suspend after the sound-on action', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('suspends the context again when it was woken with nothing to amplify', async () => {
		const { boost, fake } = createBoost({ useElement: false });
		const t = track();
		boost.set(t, 1.5);
		boost.release(t);
		await vi.advanceTimersByTimeAsync(5000);
		expect(fake.context.suspend).toHaveBeenCalledOnce();

		await boost.resume();
		await vi.advanceTimersByTimeAsync(5000);

		expect(fake.context.suspend).toHaveBeenCalledTimes(2);
	});

	test('does not suspend the context while a track is amplified', async () => {
		const { boost, fake } = createBoost({ useElement: false });
		boost.set(track(), 1.5);

		await boost.resume();
		await vi.advanceTimersByTimeAsync(5000);

		expect(fake.context.suspend).not.toHaveBeenCalled();
	});
});

describe('VoiceBoost while a new context is waking up', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const createSuspended = () => {
		const created = createBoost();
		created.fake.context.state = 'suspended';
		created.fake.context.resume.mockImplementation(() => new Promise<void>(() => {}));
		return created;
	};

	test('is not blocked right after the context was created suspended, but the track is not ready yet', async () => {
		const { boost, onBlockedChange } = createSuspended();
		const t = track();

		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS - 1);

		expect(boost.blocked).toBe(false);
		expect(boost.isReady(t)).toBe(false);
		expect(onBlockedChange).not.toHaveBeenCalledWith(true);
	});

	test('is blocked when the context did not run within the grace time', async () => {
		const { boost, onBlockedChange } = createSuspended();
		boost.set(track(), 1.5);

		await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);

		expect(boost.blocked).toBe(true);
		expect(onBlockedChange).toHaveBeenLastCalledWith(true);
	});

	test('is blocked at once when the browser refuses to resume the context', async () => {
		const { boost, fake, onBlockedChange } = createSuspended();
		fake.context.resume.mockRejectedValue(new Error('NotAllowedError'));

		boost.set(track(), 1.5);
		await vi.advanceTimersByTimeAsync(0);

		expect(boost.blocked).toBe(true);
		expect(onBlockedChange).toHaveBeenLastCalledWith(true);
	});

	test('never reports blocked when the context runs within the grace time', async () => {
		const { boost, fake, onBlockedChange } = createSuspended();
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS / 2);

		fake.context.setState('running');
		await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS * 2);

		expect(boost.blocked).toBe(false);
		expect(boost.isReady(t)).toBe(true);
		expect(onBlockedChange).not.toHaveBeenCalledWith(true);
	});

	test('is blocked at once when a running context is suspended by the browser', async () => {
		const { boost, fake } = createBoost();
		boost.set(track(), 1.5);

		fake.context.setState('suspended');

		expect(boost.blocked).toBe(true);
	});
});

describe('VoiceBoost when the browser pauses the amplified element', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('plays the element again once', async () => {
		const { boost, elements } = createBoost();
		boost.set(track(), 1.5);
		await vi.advanceTimersByTimeAsync(0);

		elements[0].emit('pause');
		await vi.advanceTimersByTimeAsync(0);
		elements[0].emit('pause');
		await vi.advanceTimersByTimeAsync(0);

		expect(elements[0].play).toHaveBeenCalledTimes(2);
	});

	test('is blocked when the element stops again after it was played again, and plays it on the sound-on action', async () => {
		const { boost, elements } = createBoost({ settleDelayMs: 0 });
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(0);
		elements[0].emit('pause');
		await vi.advanceTimersByTimeAsync(0);
		elements[0].emit('playing');
		expect(boost.blocked).toBe(false);
		expect(boost.isReady(t)).toBe(true);

		elements[0].emit('pause');
		await vi.advanceTimersByTimeAsync(0);

		expect(boost.blocked).toBe(true);
		expect(boost.isReady(t)).toBe(false);

		await boost.resume();

		expect(boost.blocked).toBe(false);
	});

	test('is blocked when the browser refuses to play it again, and plays it on the sound-on action', async () => {
		const { boost, elements } = createBoost({ settleDelayMs: 0 });
		const t = track();
		boost.set(t, 1.5);
		await vi.advanceTimersByTimeAsync(0);
		elements[0].play.mockRejectedValueOnce(new Error('NotAllowedError'));

		elements[0].emit('pause');
		await vi.advanceTimersByTimeAsync(0);

		expect(boost.blocked).toBe(true);
		expect(boost.isReady(t)).toBe(false);

		await boost.resume();

		expect(boost.blocked).toBe(false);
		expect(boost.isReady(t)).toBe(true);
	});

	test('plays it again after a later pause once the sound-on action was used', async () => {
		const { boost, elements } = createBoost();
		boost.set(track(), 1.5);
		await vi.advanceTimersByTimeAsync(0);
		elements[0].emit('pause');
		await vi.advanceTimersByTimeAsync(0);
		elements[0].emit('pause');
		await vi.advanceTimersByTimeAsync(0);
		await boost.resume();
		const before = elements[0].play.mock.calls.length;

		elements[0].emit('pause');
		await vi.advanceTimersByTimeAsync(0);

		expect(elements[0].play).toHaveBeenCalledTimes(before + 1);
	});
});

describe('VoiceBoost output device failures', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
	});

	test('keeps the failure of a new element recorded while an earlier device change is finishing', async () => {
		const { boost, elements } = createBoost({ element: element => { if (elements.length === 1) element.setSinkId.mockRejectedValueOnce(new Error('NotFoundError')); } });
		boost.set(track(), 1.5);

		const changing = boost.setSinkId('device-b');
		boost.set(track(), 2);
		await changing;
		await boost.setSinkId('device-b');

		expect(elements[1].setSinkId).toHaveBeenCalledTimes(2);
	});
});
