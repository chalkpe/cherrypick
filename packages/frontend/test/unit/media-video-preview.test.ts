/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import type * as Misskey from 'cherrypick-js';
import { preferState } from '../setup.unit.js';
import MkMediaVideo from '@/components/MkMediaVideo.vue';

vi.mock('@/os.js', () => ({ confirm: vi.fn(), popupMenu: vi.fn(), contextMenu: vi.fn() }));
vi.mock('@/utility/get-file-menu.js', () => ({ getFileMenu: vi.fn(() => []) }));

const file = { id: 'video', name: 'video.mp4', type: 'video/mp4', url: 'https://example.com/video.mp4', thumbnailUrl: null, isSensitive: false } as Misskey.entities.DriveFile;
const observers: Array<{ callback: IntersectionObserverCallback; target?: Element; disconnected: boolean }> = [];
let decodedFrames = 0;
let readyState = 4;
let seek: ReturnType<typeof vi.spyOn>;
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
const originalQuality = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'getVideoPlaybackQuality');

async function visible(isIntersecting = true) {
	await nextTick();
	for (const o of observers) {
		if (o.target && !o.disconnected) o.callback([{ target: o.target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
	}
	await nextTick();
}

beforeEach(() => {
	vi.clearAllMocks();
	decodedFrames = 0;
	readyState = 4;
	observers.length = 0;
	Object.assign(preferState, { nsfw: 'respect', dataSaver: { media: false }, confirmWhenRevealingSensitiveMedia: false });
	vi.stubGlobal('IntersectionObserver', class {
		record: typeof observers[number];
		constructor(callback: IntersectionObserverCallback) {
			this.record = { callback, disconnected: false };
			observers.push(this.record);
		}
		observe(target: Element) { this.record.target = target; }
		disconnect() { this.record.disconnected = true; }
	});
	vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockImplementation(() => readyState);
	vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(3);
	seek = vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set');
	play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
	pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
	// happy-dom does not implement the browser's decoded-frame counter.
	Object.defineProperty(HTMLVideoElement.prototype, 'getVideoPlaybackQuality', {
		configurable: true, value: () => ({ totalVideoFrames: decodedFrames }),
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (originalQuality) Object.defineProperty(HTMLVideoElement.prototype, 'getVideoPlaybackQuality', originalQuality);
	else Reflect.deleteProperty(HTMLVideoElement.prototype, 'getVideoPlaybackQuality');
});

test('requests the first frame by seeking without starting playback or changing audio settings', async () => {
	const { container } = render(MkMediaVideo, { props: { video: file } });
	const video = container.querySelector('video')!;
	await visible();
	expect(seek).toHaveBeenCalledExactlyOnceWith(0);
	expect(video.paused).toBe(true);
	expect(video.currentTime).toBe(0);
	expect(video.muted).toBe(false);
	expect(video.hasAttribute('playsinline')).toBe(false);
	expect(play).not.toHaveBeenCalled();
	expect(pause).not.toHaveBeenCalled();
	await visible();
	expect(seek).toHaveBeenCalledOnce();
});

test('keeps existing thumbnails as images without video preparation', async () => {
	const { container } = render(MkMediaVideo, { props: { video: { ...file, thumbnailUrl: 'https://example.com/thumbnail.webp' } } });
	await visible();
	expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/thumbnail.webp');
	expect(container.querySelector('video')).toBeNull();
	expect(seek).not.toHaveBeenCalled();
	expect(play).not.toHaveBeenCalled();
});

test('does not seek when the browser already decoded the preview', async () => {
	decodedFrames = 4;
	render(MkMediaVideo, { props: { video: file } });
	await visible();
	expect(seek).not.toHaveBeenCalled();
});

test('does not prepare offscreen or hidden sensitive media', async () => {
	render(MkMediaVideo, { props: { video: file } });
	await visible(false);
	expect(seek).not.toHaveBeenCalled();
	cleanup();
	const { container } = render(MkMediaVideo, { props: { video: { ...file, isSensitive: true } } });
	await visible();
	expect(container.querySelector('video')).toBeNull();
	expect(seek).not.toHaveBeenCalled();
});

test('respects data saver even after explicitly revealing a video', async () => {
	preferState.dataSaver = { media: true };
	const { container } = render(MkMediaVideo, { props: { video: file } });
	await fireEvent.click(container.querySelector('button')!);
	await visible();
	expect(seek).not.toHaveBeenCalled();
	expect(play).not.toHaveBeenCalled();
});

test('waits for metadata after becoming visible', async () => {
	readyState = 0;
	const { container } = render(MkMediaVideo, { props: { video: file } });
	await visible();
	expect(seek).not.toHaveBeenCalled();
	readyState = 1;
	await fireEvent(container.querySelector('video')!, new Event('loadedmetadata'));
	expect(seek).toHaveBeenCalledExactlyOnceWith(0);
});

test.each(['playing', 'seeking', 'advanced', 'live'])('does not interfere with a video that is %s', async (state) => {
	if (state === 'playing') vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(false);
	if (state === 'seeking') vi.spyOn(HTMLMediaElement.prototype, 'seeking', 'get').mockReturnValue(true);
	if (state === 'advanced') vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'get').mockReturnValue(1);
	if (state === 'live') vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(Infinity);
	render(MkMediaVideo, { props: { video: file } });
	await visible();
	expect(seek).not.toHaveBeenCalled();
	expect(play).not.toHaveBeenCalled();
	expect(pause).not.toHaveBeenCalled();
});

test('handles an unavailable seek without retrying or attempting playback', async () => {
	seek.mockImplementation(() => { throw new DOMException('Unavailable', 'InvalidStateError'); });
	render(MkMediaVideo, { props: { video: file } });
	await visible();
	await visible();
	expect(seek).toHaveBeenCalledOnce();
	expect(play).not.toHaveBeenCalled();
});

test('does not prepare a removed video after late metadata arrives', async () => {
	readyState = 0;
	const { container, unmount } = render(MkMediaVideo, { props: { video: file } });
	const video = container.querySelector('video')!;
	await visible();
	unmount();
	seek.mockClear();
	readyState = 1;
	await fireEvent(video, new Event('loadedmetadata'));
	expect(seek).not.toHaveBeenCalled();
	expect(observers.every(o => o.disconnected)).toBe(true);
});

test('waits until visible again if metadata arrives after scrolling away', async () => {
	readyState = 0;
	const { container } = render(MkMediaVideo, { props: { video: file } });
	await visible();
	await visible(false);
	readyState = 1;
	await fireEvent(container.querySelector('video')!, new Event('loadedmetadata'));
	expect(seek).not.toHaveBeenCalled();
	await visible();
	expect(seek).toHaveBeenCalledExactlyOnceWith(0);
});

test('does not require a browser-specific decoded-frame API', async () => {
	Reflect.deleteProperty(HTMLVideoElement.prototype, 'getVideoPlaybackQuality');
	render(MkMediaVideo, { props: { video: file } });
	await visible();
	expect(seek).toHaveBeenCalledExactlyOnceWith(0);
	expect(play).not.toHaveBeenCalled();
});

test('leaves unsupported visibility observers on the original metadata-only path', async () => {
	vi.stubGlobal('IntersectionObserver', undefined);
	const { container } = render(MkMediaVideo, { props: { video: file } });
	await fireEvent(container.querySelector('video')!, new Event('loadedmetadata'));
	expect(seek).not.toHaveBeenCalled();
	expect(play).not.toHaveBeenCalled();
});

test('removes pending metadata work when the user hides the video', async () => {
	readyState = 0;
	const { container } = render(MkMediaVideo, { props: { video: file } });
	const video = container.querySelector('video')!;
	await visible();
	await fireEvent.click(container.querySelectorAll('button')[1]);
	expect(container.querySelector('video')).toBeNull();
	seek.mockClear();
	readyState = 1;
	await fireEvent(video, new Event('loadedmetadata'));
	expect(seek).not.toHaveBeenCalled();
	expect(observers.every(o => o.disconnected)).toBe(true);
});
