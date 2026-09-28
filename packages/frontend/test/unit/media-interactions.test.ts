/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import type * as Misskey from 'cherrypick-js';
import { preferState } from '../setup.unit.js';
import MkLightbox from '@/components/MkLightbox.vue';
import MkMediaImage from '@/components/MkMediaImage.vue';
import * as os from '@/os.js';

vi.mock('@/os.js', () => ({ claimZIndex: vi.fn(() => 100), confirm: vi.fn(), popup: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('@/components/MkLightbox.item.vue', () => ({ default: { template: '<img />' } }));
vi.mock('@/utility/focus-trap.js', () => ({ focusTrap: () => ({ release: vi.fn() }) }));
vi.mock('@/utility/touch.js', () => ({ isTouchUsing: false }));
vi.mock('@/utility/get-file-menu.js', () => ({ getFileMenu: vi.fn(() => []) }));
vi.mock('@/utility/media-proxy.js', () => ({ getStaticImageUrl: (url: string) => `${url}?static` }));
vi.mock('@/components/MkImgWithBlurhash.vue', () => ({ default: { template: '<img />' } }));
vi.mock('@/components/MkRippleEffect.vue', () => ({ default: { template: '<div />' } }));

const image = { id: 'image', name: 'image.gif', url: 'https://example.com/image.gif', thumbnailUrl: 'https://example.com/thumbnail.gif', isSensitive: true, type: 'image/gif', properties: {} } as Misskey.entities.DriveFile;

beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(preferState, { nsfw: 'respect', nsfwOpenBehavior: 'doubleClick', confirmWhenRevealingSensitiveMedia: true, showingAnimatedImages: 'always', enableHighQualityImagePlaceholders: false });
	vi.mocked(os.confirm).mockResolvedValue({ canceled: false });
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe('media interaction preferences', () => {
	test('double click requires confirmation and a single click keeps the image hidden', async () => {
		const { container } = render(MkMediaImage, { props: { image } });
		const root = container.firstElementChild!;
		await fireEvent.click(root);
		expect(os.confirm).not.toHaveBeenCalled();
		expect(container.querySelector('a')).toBeNull();
		vi.mocked(os.confirm).mockResolvedValueOnce({ canceled: true });
		await fireEvent.dblClick(root);
		expect(container.querySelector('a')).toBeNull();
		await fireEvent.dblClick(root);
		expect(os.confirm).toHaveBeenCalledTimes(2);
		await nextTick();
		expect(container.querySelector('a')).not.toBeNull();
	});

	test('keyboard activation reveals a hidden image in double click mode', async () => {
		const { container } = render(MkMediaImage, { props: { image } });
		const root = container.firstElementChild!;
		expect(root.getAttribute('role')).toBe('button');
		await fireEvent.keyDown(root, { key: 'Enter' });
		await nextTick();
		expect(os.confirm).toHaveBeenCalledOnce();
		expect(container.querySelector('a')).not.toBeNull();
	});

	test.each([true, false])('lightbox right click prevention follows its option (%s)', (disableRightClick) => {
		const { container } = render(MkLightbox, { props: { contents: [], disableRightClick }, global: { directives: { hotkey: {} } } });
		const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		container.querySelector('div')!.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(disableRightClick);
	});

	test('single click mode reveals after confirmation', async () => {
		preferState.nsfwOpenBehavior = 'click';
		const { container } = render(MkMediaImage, { props: { image } });
		await fireEvent.click(container.firstElementChild!);
		expect(os.confirm).toHaveBeenCalledOnce();
		await nextTick();
		expect(container.querySelector('a')).not.toBeNull();
	});

	test('interaction mode plays while hovered or touched, including after five seconds', async () => {
		preferState.showingAnimatedImages = 'interaction';
		const { container } = render(MkMediaImage, { props: { image: { ...image, isSensitive: false } } });
		const root = container.firstElementChild!;
		const src = () => container.querySelector('img')?.getAttribute('src');
		expect(src()).toContain('?static');
		await fireEvent.mouseEnter(root);
		expect(src()).toBe(image.thumbnailUrl);
		await vi.advanceTimersByTimeAsync(6000);
		expect(src()).toBe(image.thumbnailUrl);
		await fireEvent.mouseLeave(root);
		expect(src()).toContain('?static');
		await fireEvent.touchStart(root);
		expect(src()).toBe(image.thumbnailUrl);
		await fireEvent.touchEnd(root);
		expect(src()).toContain('?static');
	});

	test('inactive mode resumes on activity and removes timers on unmount', async () => {
		preferState.showingAnimatedImages = 'inactive';
		const { container, unmount } = render(MkMediaImage, { props: { image: { ...image, isSensitive: false } } });
		await vi.advanceTimersByTimeAsync(5000);
		expect(container.querySelector('img')?.getAttribute('src')).toContain('?static');
		window.dispatchEvent(new MouseEvent('mousemove'));
		await nextTick();
		expect(container.querySelector('img')?.getAttribute('src')).toBe(image.thumbnailUrl);
		unmount();
		window.dispatchEvent(new MouseEvent('mousemove'));
		expect(vi.getTimerCount()).toBe(0);
	});
});
