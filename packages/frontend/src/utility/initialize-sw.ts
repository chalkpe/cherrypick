/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { lang } from '@@/js/config.js';
import { watch } from 'vue';
import { get, set } from 'idb-keyval';
import { chatIconPreferencesKey } from '@@/js/chat-icon.js';
import { prefer } from '@/preferences.js';
import { $i } from '@/i.js';

export async function initializeSw() {
	if (!('serviceWorker' in navigator)) return;
	if ($i) {
		const userId = $i.id;

		async function syncIconPreferences() {
			const accounts = await get<{ id: string }[]>('accounts').catch(() => undefined);
			for (const id of new Set([userId, ...accounts?.map(account => account.id) ?? []])) {
				await set(chatIconPreferencesKey(id), {
					showAvatarDecorations: prefer.getMatchedRecordOf('showAvatarDecorations', { id })[1],
					showRemoteAvatarDecorations: prefer.getMatchedRecordOf('showRemoteAvatarDecorations', { id })[1],
					squareAvatars: prefer.getMatchedRecordOf('squareAvatars', { id })[1],
				}).catch(() => {});
			}
		}

		watch(() => [prefer.r.showAvatarDecorations.value, prefer.r.showRemoteAvatarDecorations.value, prefer.r.squareAvatars.value], () => {
			void syncIconPreferences();
		}, { immediate: true });
		prefer.on('committed', () => { void syncIconPreferences(); });
	}

	navigator.serviceWorker.register('/sw.js', { scope: '/', type: 'classic' });
	navigator.serviceWorker.ready.then(registration => {
		registration.active?.postMessage({
			msg: 'initialize',
			lang,
		});
	});
}
