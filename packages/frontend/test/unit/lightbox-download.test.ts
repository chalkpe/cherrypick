/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import MkLightboxItem from '@/components/MkLightbox.item.vue';
import type { Content } from '@/components/MkLightbox.item.vue';
import * as os from '@/os.js';

vi.mock('@/os.js', () => ({ popupMenu: vi.fn() }));
vi.mock('@/utility/get-file-menu.js', () => ({ getFileMenu: () => [] }));
vi.mock('@/utility/touch.js', () => ({ isTouchUsing: false }));
vi.mock('@/components/MkBlurhash.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MkLightbox.item.controls.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MkLightbox.item.fileinfo.vue', () => ({ default: { template: '<div />' } }));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

test.each(['image', 'video', 'audio'] as const)('offers a direct download from the %s viewer without drive ownership', async (type) => {
	const content: Content = {
		id: 'attachment',
		type,
		url: 'https://media.example.org/original',
		thumbnailUrl: 'https://media.example.org/thumbnail',
		filename: '사진.jpg',
	};
	const { container } = render(MkLightboxItem, { props: { content, activated: false, pixelatedZoom: false } });
	await fireEvent.click(container.querySelector('button')!);
	const menu = vi.mocked(os.popupMenu).mock.calls[0][0];
	expect(menu).toContainEqual(expect.objectContaining({
		type: 'a',
		text: 'Download',
		href: content.url,
		download: content.filename,
		target: '_blank',
	}));
});

test('allows downloading a preview that has no filename or drive file', async () => {
	const content: Content = { id: 'preview', type: 'image', url: 'blob:https://example.org/preview' };
	const { container } = render(MkLightboxItem, { props: { content, activated: false, pixelatedZoom: false } });
	await fireEvent.click(container.querySelector('button')!);
	expect(vi.mocked(os.popupMenu).mock.calls[0][0]).toContainEqual(expect.objectContaining({
		type: 'a', href: content.url, download: '',
	}));
});

test('keeps the image hook used by PSKey to offer its native download dialog', () => {
	const content: Content = { id: 'image', type: 'image', url: 'https://example.org/image.jpg', thumbnailUrl: 'https://example.org/thumbnail.jpg' };
	const { container } = render(MkLightboxItem, { props: { content, activated: true, pixelatedZoom: false } });
	expect(container.querySelector('img.pswp__img')?.getAttribute('src')).toBe(content.url);
	expect(container.querySelector('img.pswp__img')?.getAttribute('src')).not.toBe(content.thumbnailUrl);
});
