/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
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
