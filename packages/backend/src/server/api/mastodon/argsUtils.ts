/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Keys taken from:
// - https://docs.joinmastodon.org/methods/accounts/#statuses
// - https://docs.joinmastodon.org/methods/timelines/#public
// - https://docs.joinmastodon.org/methods/timelines/#tag
export interface TimelineArgs {
	max_id?: string;
	min_id?: string;
	since_id?: string;
	limit?: string;
	offset?: string;
	local?: string;
	pinned?: string;
	exclude_reblogs?: string;
	exclude_replies?: string;
	only_media?: string;
}

// Values taken from https://docs.joinmastodon.org/client/intro/#boolean
export function toBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	return !['0', 'f', 'F', 'false', 'FALSE', 'off', 'OFF'].includes(value);
}

export function toInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	return parseInt(value);
}

// Keys that would reach Object.prototype when used as a path segment
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Turns the bracketed keys of a form body ("media_ids[]", "poll[options][]", "poll[expires_in]")
 * into the nested values JSON clients send. Keys without brackets are kept as they are.
 */
export function unflattenFormBody(body: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(body)) {
		const match = /^([^[\]]+)((?:\[[^[\]]*\])+)$/.exec(key);
		if (match == null) {
			result[key] = value;
			continue;
		}

		const path = [match[1], ...Array.from(match[2].matchAll(/\[([^[\]]*)\]/g), m => m[1])];
		if (path.some(segment => UNSAFE_KEYS.has(segment))) continue;

		// "key[]" is a list, even when only one value was sent
		const isList = path.at(-1) === '';
		if (isList) path.pop();
		const leaf = isList && !Array.isArray(value) ? [value] : value;

		let node = result;
		for (const segment of path.slice(0, -1)) {
			const next = Object.hasOwn(node, segment) ? node[segment] : undefined;
			if (next == null || typeof next !== 'object' || Array.isArray(next)) {
				node[segment] = {};
			}
			node = node[segment] as Record<string, unknown>;
		}
		node[path[path.length - 1]] = leaf;
	}

	return result;
}

export function parseTimelineArgs(q: TimelineArgs) {
	return {
		max_id: q.max_id,
		min_id: q.min_id,
		since_id: q.since_id,
		limit: typeof(q.limit) === 'string' ? parseInt(q.limit, 10) : undefined,
		offset: typeof(q.offset) === 'string' ? parseInt(q.offset, 10) : undefined,
		local: typeof(q.local) === 'string' ? toBoolean(q.local) : undefined,
		pinned: typeof(q.pinned) === 'string' ? toBoolean(q.pinned) : undefined,
		exclude_reblogs: typeof(q.exclude_reblogs) === 'string' ? toBoolean(q.exclude_reblogs) : undefined,
		exclude_replies: typeof(q.exclude_replies) === 'string' ? toBoolean(q.exclude_replies) : undefined,
		only_media: typeof(q.only_media) === 'string' ? toBoolean(q.only_media) : undefined,
	};
}
