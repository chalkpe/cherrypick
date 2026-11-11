/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function checkHttps(url: string, allowHttpInDevelopment = true): boolean {
	return url.startsWith('https://') ||
		(allowHttpInDevelopment && url.startsWith('http://') && process.env.NODE_ENV !== 'production');
}
