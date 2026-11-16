/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { chatNotificationIcon } from '../../../sw/src/scripts/chat-icon.js';

vi.mock('idb-keyval', () => ({ get: async () => ({ showAvatarDecorations: true, showRemoteAvatarDecorations: true, squareAvatars: true }) }));

afterEach(() => { vi.unstubAllGlobals(); });

test('a group known to have no decorations keeps its icon without another API request', async () => {
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	vi.stubGlobal('OffscreenCanvas', class {});

	const icon = await chatNotificationIcon({ id: 'room', name: 'Shapes', iconUrl: 'https://local.test/square.png', iconDecorations: [] }, 'viewer');

	expect(icon).toBe('https://local.test/square.png');
	expect(fetch).not.toHaveBeenCalled();
});

test('a wide decoration uses its own image centre and vertical offset, like MkAvatar CSS', async () => {
	const translated: number[][] = [];
	const drawn: unknown[][] = [];
	const context = {
		save() {}, restore() {}, beginPath() {}, roundRect() {}, clip() {}, rotate() {}, scale() {},
		translate: (...args: number[]) => translated.push(args),
		drawImage: (...args: unknown[]) => drawn.push(args),
	};
	vi.stubGlobal('OffscreenCanvas', class {
		getContext() { return context; }
		async convertToBlob() { return new Blob([]); }
	});
	let image = 0;
	vi.stubGlobal('createImageBitmap', async () => ({ width: 128, height: image++ === 0 ? 128 : 64, close() {} }));
	vi.stubGlobal('fetch', async () => ({ ok: true, blob: async () => new Blob([]) }));

	await chatNotificationIcon({ id: 'room', name: 'Shapes', iconUrl: 'https://local.test/square.png', iconDecorations: [{ id: 'frame', url: 'https://local.test/wide.png', offsetX: 0.1, offsetY: 0.25 }] }, 'viewer');

	// At 2x the 128px avatar, the 2:1 image is 256x128 at (0, 0).
	// CSS rotates it around (128, 64); translateY(25%) adds 32px.
	expect(translated).toEqual([[153.6, 96]]);
	expect(drawn[1]?.slice(1)).toEqual([-128, -64, 256, 128]);
});
