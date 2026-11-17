/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createRecordingSegments, recordingSegmentBytes } from '@/utility/recording-recorder.js';

// recorder 예외 경계와 트랙 소유권을 검사한다. 파일 재생은 실제 브라우저에서 별도로 검사한다.
class Track {
	readyState = 'live';
	clones: Track[] = [];
	clone(): Track {
		const track = new Track();
		this.clones.push(track);
		return track;
	}
	stop(): void { this.readyState = 'ended'; }
}

class Stream {
	constructor(private tracks: Track[]) {}
	getTracks(): Track[] { return this.tracks; }
}

class Recorder {
	static instances: Recorder[] = [];
	static failStart = false;
	static failStop = false;
	state: RecordingState = 'inactive';
	timeslice = 0;
	finalChunk: Blob | null = null;
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	constructor() { Recorder.instances.push(this); }
	start(timeslice: number): void {
		if (Recorder.failStart) throw new Error('recorder start failed');
		this.timeslice = timeslice;
		this.state = 'recording';
	}
	emit(data: Blob): void { this.ondataavailable?.({ data }); }
	stop(): void {
		if (Recorder.failStop) throw new Error('recorder stop failed');
		this.state = 'inactive';
		queueMicrotask(() => {
			if (this.finalChunk) this.emit(this.finalChunk);
			this.onstop?.();
		});
	}
}

beforeEach(() => {
	Recorder.instances = [];
	Recorder.failStart = false;
	Recorder.failStop = false;
	vi.stubGlobal('MediaStream', Stream);
	vi.stubGlobal('MediaRecorder', Recorder);
});

test('limits ordinary segments and keeps every chunk', async () => {
	const segments: Blob[] = [];
	let finish!: () => void;
	const stopped = new Promise<void>(resolve => { finish = resolve; });
	const controller = createRecordingSegments(new Stream([]) as unknown as MediaStream, {}, 100 * 1024 * 1024, {
		onSegment: blob => { segments.push(blob); },
		onStop: finish,
		onError: error => { throw error; },
	});
	const chunk = new Blob([new Uint8Array(42_000_000).fill(7)]);
	for (let i = 0; i < 3; i++) Recorder.instances.at(-1)!.emit(chunk);
	controller.stop();
	await stopped;

	expect(segments.every(segment => segment.size <= 100 * 1024 * 1024)).toBe(true);
	expect(segments.reduce((sum, segment) => sum + segment.size, 0)).toBe(126_000_000);
	for (const segment of segments) expect(new Uint8Array(await segment.slice(0, 1).arrayBuffer())[0]).toBe(7);
});

test('keeps a single oversized chunk for the failure flow', async () => {
	const segments: Blob[] = [];
	let finish!: () => void;
	const stopped = new Promise<void>(resolve => { finish = resolve; });
	const controller = createRecordingSegments(new Stream([]) as unknown as MediaStream, {}, 5, {
		onSegment: blob => { segments.push(blob); }, onStop: finish, onError: error => { throw error; },
	});
	Recorder.instances[0].emit(new Blob(['too large']));
	controller.stop();
	await stopped;
	expect(await Promise.all(segments.map(segment => segment.text()))).toEqual(['too large']);
});

test('keeps a final chunk emitted after stop', async () => {
	const segments: Blob[] = [];
	let finish!: () => void;
	const stopped = new Promise<void>(resolve => { finish = resolve; });
	const controller = createRecordingSegments(new Stream([]) as unknown as MediaStream, {}, 5, {
		onSegment: blob => { segments.push(blob); }, onStop: finish, onError: error => { throw error; },
	});
	Recorder.instances[0].emit(new Blob(['ab']));
	Recorder.instances[0].finalChunk = new Blob(['over the limit']);
	controller.stop();
	await stopped;
	expect(await Promise.all(segments.map(segment => segment.text()))).toEqual(['abover the limit']);
});

test.each([
	[30, 262_144_000, 31_457_280],
	[200, 262_144_000, 104_857_600],
	[300, 52_428_800, 52_428_800],
])('uses the smallest recording, role and server limit', (role, server, expected) => {
	expect(recordingSegmentBytes(role, server)).toBe(expected);
});

afterEach(() => { vi.unstubAllGlobals(); });

test('requests one-second recording chunks', () => {
	const controller = createRecordingSegments(new Stream([]) as unknown as MediaStream, {}, 100, {
		onSegment: () => {}, onStop: () => {}, onError: error => { throw error; },
	});
	expect(Recorder.instances[0].timeslice).toBe(1000);
	controller.stop();
});

test('keeps caller tracks separate and releases recorder tracks after its final event', async () => {
	const original = new Track();
	let finished!: () => void;
	const stopped = new Promise<void>(resolve => { finished = resolve; });
	const controller = createRecordingSegments(new Stream([original]) as unknown as MediaStream, {}, 100, {
		onSegment: () => {},
		onStop: finished,
		onError: error => { throw error; },
	});

	controller.stop();
	controller.stop();
	expect(original.clones[0].readyState).toBe('live');
	await stopped;

	expect(original.readyState).toBe('live');
	expect(original.clones[0].readyState).toBe('ended');
});

test('a failed stop releases recorder tracks without recursing through the error handler', () => {
	const original = new Track();
	const errors: unknown[] = [];
	const controller = createRecordingSegments(new Stream([original]) as unknown as MediaStream, {}, 100, {
		onSegment: () => {},
		onStop: () => {},
		onError: error => { errors.push(error); controller.stop(); },
	});
	Recorder.failStop = true;

	expect(() => controller.stop()).not.toThrow();

	expect(original.readyState).toBe('live');
	expect(original.clones[0].readyState).toBe('ended');
	expect(errors.map(error => (error as Error).message)).toEqual(['recorder stop failed']);
});

test('a failed start releases the clones and leaves caller tracks to the caller', () => {
	const original = new Track();
	Recorder.failStart = true;

	expect(() => createRecordingSegments(new Stream([original]) as unknown as MediaStream, {}, 100, {
		onSegment: () => {},
		onStop: () => {},
		onError: error => { throw error; },
	})).toThrow('recorder start failed');

	expect(original.readyState).toBe('live');
	expect(original.clones[0].readyState).toBe('ended');
});
