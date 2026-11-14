/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { get } from 'idb-keyval';
import { api } from 'cherrypick-js';
import type { entities } from 'cherrypick-js';
import { chatIconPreferencesKey } from '@@/js/chat-icon.js';
import type { ChatIconPreferences } from '@@/js/chat-icon.js';
import { getAccountFromId } from './get-account-from-id.js';

type PushChatRoom = Pick<entities.ChatRoom, 'id' | 'name'> & Partial<Pick<entities.ChatRoom, 'iconUrl' | 'iconDecorations'>> & { owner?: { host: string | null } };

export async function chatNotificationIcon(room: PushChatRoom, userId: string): Promise<string> {
	const preferences = await get<ChatIconPreferences>(chatIconPreferencesKey(userId)).catch(() => undefined);
	const baseUrl = room.iconUrl ?? `/identicon/${encodeURIComponent(room.id)}@${room.owner?.host ?? globalThis.location.host}`;
	if (preferences?.showAvatarDecorations === false || (room.owner?.host != null && preferences?.showRemoteAvatarDecorations === false)) return baseUrl;
	if (typeof OffscreenCanvas === 'undefined') return baseUrl;
	if (room.iconDecorations == null) {
		try {
			const account = await getAccountFromId(userId);
			if (account == null) return baseUrl;
			const client = new api.APIClient({ origin, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) });
			room = await client.request('chat/rooms/show', { roomId: room.id }, account.token);
		} catch {
			return baseUrl;
		}
	}
	const used = room.iconDecorations ?? [];
	if (used.length === 0 || (room.owner?.host != null && preferences?.showRemoteAvatarDecorations === false)) return room.iconUrl ?? baseUrl;
	const images: ImageBitmap[] = [];
	try {
		async function load(url: string) {
			const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
			if (!response.ok) throw new Error('Unable to load chat icon');
			const bitmap = await createImageBitmap(await response.blob());
			images.push(bitmap);
			return bitmap;
		}

		const base = await load(room.iconUrl ?? baseUrl);
		const decorations = await Promise.all(used.map(d => load(d.url).catch(() => null)));
		const canvas = new OffscreenCanvas(256, 256);
		const context = canvas.getContext('2d');
		if (context == null) return baseUrl;
		context.save();
		context.beginPath();
		context.roundRect(64, 64, 128, 128, preferences?.squareAvatars === false ? 64 : 25.6);
		context.clip();
		const size = Math.min(base.width, base.height);
		context.drawImage(base, (base.width - size) / 2, (base.height - size) / 2, size, size, 64, 64, 128, 128);
		context.restore();
		used.forEach((d, index) => {
			const image = decorations[index];
			if (image == null) return;
			const height = 256 * image.height / image.width;
			context.save();
			context.translate(128 + (d.offsetX ?? 0) * 256, height / 2 + (d.offsetY ?? 0) * height);
			context.rotate((d.angle ?? 0) * 2 * Math.PI);
			context.scale((d.flipH ? -1 : 1) * (d.scale ?? 1), d.scale ?? 1);
			context.globalAlpha = d.opacity ?? 1;
			context.drawImage(image, -128, -height / 2, 256, height);
			context.restore();
		});
		const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
		return `data:image/png;base64,${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}`;
	} catch {
		return baseUrl;
	} finally {
		for (const image of images) image.close();
	}
}
