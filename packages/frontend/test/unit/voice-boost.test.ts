/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { MAX_VOLUME, VoiceBoost } from '@/utility/voice-boost.js';

type FakeNode = { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
type FakeGain = FakeNode & { gain: { value: number; setTargetAtTime: ReturnType<typeof vi.fn> } };

function createFakeContext() {
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
		resume: vi.fn(async () => { context.setState('running'); }),
		suspend: vi.fn(async () => { context.setState('suspended'); }),
		close: vi.fn(async () => { context.state = 'closed'; }),
		setState(state: AudioContextState) { context.state = state; for (const l of listeners) l(); },
	};
	return { context, nodes };
}

function createFakeElement() {
	const element = {
		srcObject: null as unknown,
		sinkId: '',
		play: vi.fn().mockResolvedValue(undefined),
		pause: vi.fn(),
		setSinkId: vi.fn(async (id: string) => { element.sinkId = id; }),
	};
	return element;
}

const track = () => ({ mediaStreamTrack: {} as MediaStreamTrack });

type FakeElement = ReturnType<typeof createFakeElement>;

function createBoost(options: { useElement?: boolean; element?: (element: FakeElement) => void; createContext?: () => AudioContext } = {}) {
	const fake = createFakeContext();
	const elements: FakeElement[] = [];
	const onBlockedChange = vi.fn<(blocked: boolean) => void>();
	const boost = new VoiceBoost({
		onBlockedChange,
		useElement: options.useElement ?? true,
		createContext: options.createContext ?? (() => fake.context as unknown as AudioContext),
		createElement: () => {
			const element = createFakeElement();
			options.element?.(element);
			elements.push(element);
			return element as unknown as HTMLAudioElement;
		},
	});
	return { boost, fake, elements, onBlockedChange };
}

describe('VoiceBoost', () => {
	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
	});

	test('does nothing at 100% or below', () => {
		const { boost, fake } = createBoost();
		const t = track();

		expect(boost.set(t, 1)).toBe(true);
		expect(boost.set(t, 0.3)).toBe(true);

		expect(fake.context.createGain).not.toHaveBeenCalled();
		expect(boost.active).toBe(false);
	});

	test('plays a track above 100% through one gain, and the gain follows the volume', () => {
		const { boost, fake, elements } = createBoost();
		const t = track();

		expect(boost.set(t, 1.5)).toBe(true);

		expect(boost.active).toBe(true);
		expect(fake.nodes.gains[0].gain.value).toBe(1.5);
		expect(elements).toHaveLength(1);
		expect(elements[0].srcObject).toBe(fake.nodes.destinations[0].stream);
		expect(elements[0].play).toHaveBeenCalled();

		boost.set(t, 1.8);

		expect(fake.context.createGain).toHaveBeenCalledOnce();
		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenCalledWith(1.8, 0, 0.1);
		expect(elements).toHaveLength(1);
	});

	test('never exceeds 200%', () => {
		const { boost, fake } = createBoost();
		const t = track();

		boost.set(t, 9);
		expect(fake.nodes.gains[0].gain.value).toBe(MAX_VOLUME);

		boost.set(t, 7);
		expect(fake.nodes.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(MAX_VOLUME, 0, 0.1);
	});

	test('tears the track down when the volume goes back to 100% or below', () => {
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

	test('keeps one context for the whole call, suspending it while nothing is amplified', () => {
		const { boost, fake } = createBoost();
		const a = track();
		const b = track();
		boost.set(a, 1.5);
		boost.set(b, 2);

		boost.release(a);
		expect(fake.context.suspend).not.toHaveBeenCalled();
		boost.release(b);
		expect(fake.context.suspend).toHaveBeenCalledOnce();
		expect(fake.context.close).not.toHaveBeenCalled();

		boost.set(a, 1.5);
		expect(fake.context.createGain).toHaveBeenCalledTimes(3);
		expect(fake.context.resume).toHaveBeenCalled();
		expect(boost.blocked).toBe(false);
	});

	test('is not blocked while the context is suspended with nothing amplified', () => {
		const { boost, fake, onBlockedChange } = createBoost();
		const t = track();
		boost.set(t, 1.5);

		boost.release(t);

		expect(fake.context.state).toBe('suspended');
		expect(boost.blocked).toBe(false);
		expect(onBlockedChange).not.toHaveBeenCalledWith(true);
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
