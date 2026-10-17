/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/vue';
import { nextTick, ref } from 'vue';
import type * as Misskey from 'cherrypick-js';
import { preferState } from '../setup.unit.js';
import XFiles from '@/pages/user/index.timeline.files.files.vue';
import XFilesList from '@/pages/user/index.timeline.files.vue';

vi.mock('@/utility/media-proxy.js', () => ({ getStaticImageUrl: (url: string) => `${url}?static` }));
vi.mock('@/components/MkImgWithBlurhash.vue', () => ({
	default: { props: ['src'], template: '<img :src="src" />' },
}));

// Uncached remote videos have no thumbnail unless videoThumbnailGenerator is configured.
const remoteVideo = {
	id: 'video', name: 'video.mp4', type: 'video/mp4', isSensitive: false,
	url: 'https://example.com/video.mp4',
	thumbnailUrl: null,
} as Misskey.entities.DriveFile;

const video = { ...remoteVideo, thumbnailUrl: 'https://example.com/thumbnail.webp' } as Misskey.entities.DriveFile;

function renderFiles(file = remoteVideo) {
	const note = {
		id: 'note', createdAt: '2026-10-17T00:00:00.000Z', files: [file],
	} as Misskey.entities.Note;
	return render(XFiles, {
		props: { user: {} as Misskey.entities.User, note },
		global: { stubs: { MkA: { template: '<a><slot /></a>' }, MkTime: true } },
	});
}

const defaultPreferences = {
	loadRawImages: false, disableShowingAnimatedImages: false,
	showingAnimatedImages: 'always', dataSaver: { media: false },
	nsfw: 'respect', nsfwOpenBehavior: 'click', enableHighQualityImagePlaceholders: true,
};

beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(preferState, defaultPreferences);
});

afterEach(() => {
	cleanup();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test.each([true, false])('video tiles keep their thumbnail across image preferences (blurhash: %s)', async (enableHighQualityImagePlaceholders) => {
	const settings = [
		{},
		{ loadRawImages: true },
		{ disableShowingAnimatedImages: true },
		{ dataSaver: { media: true } },
		{ showingAnimatedImages: 'interaction' },
		{ showingAnimatedImages: 'inactive' },
	];
	for (const setting of settings) {
		Object.assign(preferState, defaultPreferences, { enableHighQualityImagePlaceholders }, setting);
		const { container, queryByText, unmount } = renderFiles(video);
		// Data saver hides the tile until it is clicked.
		const reveal = queryByText('Click to show');
		if (reveal) await fireEvent.click(reveal);
		expect(queryByText('Click to show')).toBeNull();
		expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/thumbnail.webp');
		await vi.advanceTimersByTimeAsync(5000);
		expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/thumbnail.webp');
		unmount();
	}
});

test('image tiles still use the original when requested', () => {
	Object.assign(preferState, { enableHighQualityImagePlaceholders: false, loadRawImages: true });
	const { container } = renderFiles({ ...video, type: 'image/gif', url: 'https://example.com/image.gif' });
	expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/image.gif');
});

test.each(['always', 'interaction', 'inactive'])('videos without a thumbnail preview the original video (showingAnimatedImages: %s)', (showingAnimatedImages) => {
	preferState.showingAnimatedImages = showingAnimatedImages;
	const { container } = renderFiles();
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
	const { rerender } = renderFiles();
	await nextTick();
	for (const callback of callbacks) callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
	expect(seek).toHaveBeenCalledExactlyOnceWith(0);
	// The tile can be reused for another note (e.g. after refreshing the list); prepare the new video too.
	callbacks.length = 0;
	const file = { ...remoteVideo, id: 'video2', url: 'https://example.com/video2.mp4' };
	await rerender({ note: { id: 'note2', createdAt: '2026-10-17T00:00:00.000Z', files: [file] } });
	await nextTick();
	for (const callback of callbacks) callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
	expect(seek).toHaveBeenCalledTimes(2);
});

test('videos without a thumbnail wait for a click to load the original with data saver', async () => {
	preferState.dataSaver = { media: true };
	const { container, getByText } = renderFiles();
	expect(container.querySelector('video')).toBeNull();
	await fireEvent.click(getByText('Click to show'));
	expect(container.querySelector('video')?.getAttribute('src')).toBe('https://example.com/video.mp4');
});

// All notes on a profile share the same author, so tiles must be keyed by note.
test('tiles keep their revealed state when a note is inserted before them', async () => {
	preferState.dataSaver = { media: true };
	const note = (id: string) => ({
		id, createdAt: '2026-10-17T00:00:00.000Z', user: { id: 'alice' },
		files: [{ id: `${id}-file`, name: `${id}.png`, type: 'image/png', isSensitive: false, url: `https://example.com/${id}.png`, thumbnailUrl: `https://example.com/${id}.webp` }],
	}) as Misskey.entities.Note;
	const items = ref([note('a'), note('b')]);
	const { getByTitle } = render(XFilesList, {
		props: { paginator: {} as never },
		global: { stubs: {
			MkPagination: { setup: () => ({ items }), template: '<div><slot :items="items" /></div>' },
			MkA: { template: '<a><slot /></a>' }, MkTime: true,
		} },
	});
	const tile = (name: string) => getByTitle(name).parentElement!.parentElement!;
	await fireEvent.click(within(tile('a.png')).getByText('Click to show'));
	expect(within(tile('a.png')).queryByText('Click to show')).toBeNull();
	items.value = [note('new'), ...items.value];
	await nextTick();
	expect(within(tile('a.png')).queryByText('Click to show')).toBeNull();
	expect(within(tile('new.png')).queryByText('Click to show')).not.toBeNull();
});
