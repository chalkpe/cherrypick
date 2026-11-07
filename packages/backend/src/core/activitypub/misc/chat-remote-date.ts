/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const MAX_REMOTE_CLOCK_LEAD = 5 * 60 * 1000;

/**
 * A date another server stated, for ordering what it sends. A date far ahead would freeze whatever it is compared
 * with until then, and JavaScript accepts years PostgreSQL refuses, which would only use up the inbox queue's retries.
 * Such dates count as not stated.
 */
export function parseRemoteChatDate(value: unknown, now = Date.now()): Date | null {
	if (typeof value !== 'string') return null;
	const date = new Date(value);
	const time = date.getTime();
	if (Number.isNaN(time) || time > now + MAX_REMOTE_CLOCK_LEAD) return null;
	const year = date.getUTCFullYear();
	return year >= 0 && year <= 9999 ? date : null;
}
