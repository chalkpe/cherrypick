/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { url as local } from '@@/js/config.js';
import { instance } from '@/instance.js';
import { prefer } from '@/preferences.js';
import * as os from '@/os.js';
import MkUrlWarningDialog from '@/components/MkUrlWarningDialog.vue';

const isRegExp = /^\/(.+)\/(.*)$/;

function parseUrl(url: string): URL | null {
	try {
		// 相対パスはこのサーバーのURLとして解釈される
		return new URL(url, local);
	} catch {
		return null;
	}
}

export async function warningExternalWebsite(ev: MouseEvent, url: string) {
	const urlObj = parseUrl(url);
	const self = urlObj != null && urlObj.origin === local;
	const hostname = urlObj?.hostname.toLowerCase() ?? '';
	// www. を除いた形も候補にする
	const domains = hostname === '' ? [] : [...new Set([hostname, hostname.replace(/^www\./, '')])];
	const isTrustedByInstance = self || (urlObj != null && instance.trustedLinkUrlPatterns.some(expression => {
		const r = isRegExp.exec(expression);
		if (r) {
			try {
				return new RegExp(r[1], r[2]).test(url);
			} catch {
				return false;
			}
		} else if (expression.includes(' ')) return expression.split(' ').every(keyword => url.includes(keyword));
		else {
			// 先頭の . と大文字小文字の違いは無視する
			const pattern = expression.toLowerCase().replace(/^\.+/, '');
			if (pattern === '') return false;
			return domains.some(domain => domain === pattern || domain.endsWith('.' + pattern));
		}
	}));
	const isTrustedByUser = urlObj != null && hostname !== '' && prefer.r.trustedDomains.value.includes(hostname);

	if (!self && !isTrustedByInstance && !isTrustedByUser && prefer.s.externalNavigationWarning) {
		ev.preventDefault();
		ev.stopPropagation();

		const confirm = await new Promise<{ canceled: boolean }>(resolve => {
			const { dispose } = os.popup(MkUrlWarningDialog, {
				url,
			}, {
				done: result => {
					resolve(result ? result : { canceled: true });
				},
				closed: () => dispose(),
			});
		});

		if (confirm.canceled) return false;

		window.open(url, '_blank', 'noopener');
	}

	return true;
}
