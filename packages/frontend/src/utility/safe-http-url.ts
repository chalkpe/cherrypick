/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Returns a normalized absolute http(s) URL, or null when the value is not a safe absolute http(s) URL.
 *
 * Relative URLs and non-http(s) schemes (e.g. javascript:, data:, vbscript:, file:) are rejected.
 */
export function safeHttpUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null;

	try {
		const url = new URL(value);

		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

		return url.href;
	} catch {
		return null;
	}
}
