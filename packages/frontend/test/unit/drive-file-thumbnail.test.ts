/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import type * as Misskey from 'cherrypick-js';
import { preferState } from '../setup.unit.js';
import MkDriveFileThumbnail from '@/components/MkDriveFileThumbnail.vue';

vi.mock('@/utility/media-proxy.js', () => ({ getStaticImageUrl: (url: string) => `${url}?static` }));
vi.mock('@/components/MkImgWithBlurhash.vue', () => ({
	default: { props: ['src'], template: '<img :src="src" />' },
}));

const video = {
	id: 'video', name: 'video.mp4', type: 'video/mp4',
	url: 'https://example.com/video.mp4',
	thumbnailUrl: 'https://example.com/thumbnail.webp',
} as Misskey.entities.DriveFile;

beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(preferState, {
		loadRawImages: false, disableShowingAnimatedImages: false,
		showingAnimatedImages: 'always', dataSaver: { media: false },
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test.each([true, false])('video previews keep their thumbnail across image preferences (blurhash: %s)', async (enableHighQualityImagePlaceholders) => {
	preferState.enableHighQualityImagePlaceholders = enableHighQualityImagePlaceholders;
	const settings = [
		{},
		{ loadRawImages: true },
		{ disableShowingAnimatedImages: true },
		{ dataSaver: { media: true } },
		{ showingAnimatedImages: 'interaction' },
		{ showingAnimatedImages: 'inactive' },
	];
	for (const setting of settings) {
		Object.assign(preferState, {
			loadRawImages: false, disableShowingAnimatedImages: false,
			showingAnimatedImages: 'always', dataSaver: { media: false },
		}, setting);
		const { container, unmount } = render(MkDriveFileThumbnail, {
			props: { file: video, fit: 'cover' }, global: { directives: { panel: {} } },
		});
		expect(container.querySelector('img')?.getAttribute('src')).toBe(video.thumbnailUrl);
		await vi.advanceTimersByTimeAsync(5000);
		expect(container.querySelector('img')?.getAttribute('src')).toBe(video.thumbnailUrl);
		unmount();
	}
});

test('image previews still use the original when requested', () => {
	preferState.enableHighQualityImagePlaceholders = false;
	preferState.loadRawImages = true;
	const file = { ...video, type: 'image/gif', url: 'https://example.com/image.gif' };
	const { container } = render(MkDriveFileThumbnail, {
		props: { file, fit: 'contain' }, global: { directives: { panel: {} } },
	});
	expect(container.querySelector('img')?.getAttribute('src')).toBe(file.url);
});

// Uncached remote videos have no thumbnail unless videoThumbnailGenerator is configured.
const remoteVideo = { ...video, thumbnailUrl: null } as Misskey.entities.DriveFile;

test.each([true, false])('videos without a thumbnail preview the original video (blurhash: %s)', (enableHighQualityImagePlaceholders) => {
	preferState.enableHighQualityImagePlaceholders = enableHighQualityImagePlaceholders;
	const { container } = render(MkDriveFileThumbnail, {
		props: { file: remoteVideo, fit: 'cover' }, global: { directives: { panel: {} } },
	});
	expect(container.querySelector('video')?.getAttribute('src')).toBe('https://example.com/video.mp4');
	expect(container.querySelector('img')).toBeNull();
});

// Some WebViews (e.g. PSKey) paint a blank default poster until the video is seeked.
test('videos without a thumbnail request their first frame once visible', async () => {
	const callbacks: IntersectionObserverCallback[] = [];
	vi.stubGlobal('IntersectionObserver', class {
		constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
		observe() {}
		disconnect() {}
	});
	vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
	vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(3);
	const seek = vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set');
	const { rerender } = render(MkDriveFileThumbnail, {
		props: { file: remoteVideo, fit: 'cover' }, global: { directives: { panel: {} } },
	});
	await nextTick();
	for (const callback of callbacks) callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
	expect(seek).toHaveBeenCalledExactlyOnceWith(0);
	// Switching to another file must prepare the new video too.
	callbacks.length = 0;
	await rerender({ file: { ...remoteVideo, id: 'video2', url: 'https://example.com/video2.mp4' } });
	await nextTick();
	for (const callback of callbacks) callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
	expect(seek).toHaveBeenCalledTimes(2);
});

test.each([
	['data saver', { dataSaver: { media: true } }, {}],
	['forced blurhash', {}, { forceBlurhash: true }],
])('videos without a thumbnail do not load the original with %s', (_, setting, props) => {
	Object.assign(preferState, setting);
	const { container } = render(MkDriveFileThumbnail, {
		props: { file: remoteVideo, fit: 'cover', ...props }, global: { directives: { panel: {} } },
	});
	expect(container.querySelector('video')).toBeNull();
	expect(container.querySelector('.ti-video')).not.toBeNull();
});
