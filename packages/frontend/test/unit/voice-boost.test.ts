/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { MAX_VOLUME, VoiceBoost } from '@/utility/voice-boost.js';

type FakeNode = { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };

function createFakeContext() {
	const listeners = new Set<() => void>();
	const nodes = { gains: [] as Array<FakeNode & { gain: { value: number } }>, sources: [] as FakeNode[], destinations: [] as Array<FakeNode & { stream: object }> };
	const node = (): FakeNode => ({ connect: vi.fn(), disconnect: vi.fn() });
	const context = {
		state: 'running' as AudioContextState,
		destination: { id: 'context-destination' },
		createMediaStreamSource: vi.fn(() => { const n = node(); nodes.sources.push(n); return n; }),
		createGain: vi.fn(() => { const n = { ...node(), gain: { value: 1 } }; nodes.gains.push(n); return n; }),
		createMediaStreamDestination: vi.fn(() => { const n = { ...node(), stream: {} }; nodes.destinations.push(n); return n; }),
		addEventListener: vi.fn((_: string, listener: () => void) => { listeners.add(listener); }),
		removeEventListener: vi.fn((_: string, listener: () => void) => { listeners.delete(listener); }),
		resume: vi.fn(async () => { context.state = 'running'; for (const l of listeners) l(); }),
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

describe('VoiceBoost', () => {
	let fake: ReturnType<typeof createFakeContext>;
	let elements: Array<ReturnType<typeof createFakeElement>>;
	let onBlockedChange: Mock<(blocked: boolean) => void>;
	let boost: VoiceBoost;

	beforeEach(() => {
		vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
		fake = createFakeContext();
		elements = [];
		onBlockedChange = vi.fn();
		boost = new VoiceBoost({
			onBlockedChange,
			useElement: true,
			createContext: () => fake.context as unknown as AudioContext,
			createElement: () => { const e = createFakeElement(); elements.push(e); return e as unknown as HTMLAudioElement; },
		});
	});

	test('does nothing at 100% or below', () => {
		const t = track();
		boost.set(t, 1);
		boost.set(t, 0.3);
		expect(fake.context.createGain).not.toHaveBeenCalled();
		expect(boost.active).toBe(false);
	});

	test('plays a track above 100% through one gain, and the gain follows the volume', () => {
		const t = track();
		boost.set(t, 1.5);
		expect(boost.active).toBe(true);
		expect(fake.nodes.gains[0].gain.value).toBe(1.5);
		expect(elements).toHaveLength(1);
		expect(elements[0].srcObject).toBe(fake.nodes.destinations[0].stream);
		expect(elements[0].play).toHaveBeenCalled();

		boost.set(t, 1.8);
		expect(fake.context.createGain).toHaveBeenCalledOnce();
		expect(fake.nodes.gains[0].gain.value).toBe(1.8);
		expect(elements).toHaveLength(1);
	});

	test('never exceeds 200%', () => {
		boost.set(track(), 9);
		expect(fake.nodes.gains[0].gain.value).toBe(MAX_VOLUME);
	});

	test('tears everything down when the volume goes back to 100% or below', () => {
		const t = track();
		boost.set(t, 2);
		boost.set(t, 1);
		expect(boost.active).toBe(false);
		expect(elements[0].pause).toHaveBeenCalled();
		expect(elements[0].srcObject).toBeNull();
		expect(fake.nodes.sources[0].disconnect).toHaveBeenCalled();
		expect(fake.nodes.gains[0].disconnect).toHaveBeenCalled();
		expect(fake.context.close).toHaveBeenCalledOnce();
	});

	test('shares one context between tracks and closes it after the last one', () => {
		const a = track();
		const b = track();
		boost.set(a, 1.5);
		boost.set(b, 2);
		expect(fake.context.createGain).toHaveBeenCalledTimes(2);
		boost.release(a);
		expect(fake.context.close).not.toHaveBeenCalled();
		boost.release(b);
		expect(fake.context.close).toHaveBeenCalledOnce();
	});

	test('sends the sound to the chosen output device, also to tracks amplified before and after', async () => {
		boost.set(track(), 1.5);
		await boost.setSinkId('device-b');
		expect(elements[0].setSinkId).toHaveBeenLastCalledWith('device-b');
		boost.set(track(), 2);
		expect(elements[1].setSinkId).toHaveBeenCalledWith('device-b');
	});

	test('survives an output device the browser refuses', async () => {
		boost.set(track(), 1.5);
		elements[0].setSinkId.mockRejectedValueOnce(new Error('NotFoundError'));
		await expect(boost.setSinkId('gone')).resolves.toBeUndefined();
	});

	test('reports being blocked while the context is suspended and recovers on resume', async () => {
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
		elements.length = 0;
		const original = boost;
		const blockedBoost = new VoiceBoost({
			onBlockedChange,
			useElement: true,
			createContext: () => fake.context as unknown as AudioContext,
			createElement: () => { const e = createFakeElement(); e.play.mockRejectedValueOnce(new Error('NotAllowedError')); elements.push(e); return e as unknown as HTMLAudioElement; },
		});
		blockedBoost.set(track(), 1.5);
		await vi.waitFor(() => expect(blockedBoost.blocked).toBe(true));
		expect(original.blocked).toBe(false);

		await blockedBoost.resume();
		expect(elements[0].play).toHaveBeenCalledTimes(2);
		expect(blockedBoost.blocked).toBe(false);
	});

	test('connects to the context output without an element where the output device cannot be chosen', () => {
		const direct = new VoiceBoost({ onBlockedChange, useElement: false, createContext: () => fake.context as unknown as AudioContext, createElement: () => { throw new Error('no element expected'); } });
		const t = track();
		direct.set(t, 1.5);
		expect(fake.context.createMediaStreamDestination).not.toHaveBeenCalled();
		expect(fake.nodes.gains[0].connect).toHaveBeenCalledWith(fake.context.destination);
		fake.context.setState('suspended');
		expect(direct.blocked).toBe(true);
		direct.release(t);
		expect(fake.context.close).toHaveBeenCalledOnce();
	});

	test('is not blocked when nothing is amplified', () => {
		fake.context.state = 'suspended';
		expect(boost.blocked).toBe(false);
	});

	test('dispose removes everything and ignores later requests', () => {
		boost.set(track(), 1.5);
		boost.set(track(), 2);
		boost.dispose();
		expect(boost.active).toBe(false);
		expect(elements.every(e => e.pause.mock.calls.length > 0 && e.srcObject === null)).toBe(true);
		expect(fake.context.close).toHaveBeenCalledOnce();
		boost.set(track(), 2);
		expect(boost.active).toBe(false);
	});
});
