/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { FastifyReply, FastifyRequest } from 'fastify';

interface AnyEntity {
	readonly id: string;
}

/**
 * Attaches Mastodon's pagination headers to a response that is paginated by min_id / max_id parameters.
 * Results must be sorted, but can be in ascending or descending order.
 * Attached headers will always be in descending order.
 *
 * @param request Fastify request object
 * @param reply Fastify reply object
 * @param results Results array, ordered in ascending or descending order.
 *   IDs can be passed instead, for lists paginated by records other than the returned entities (see megalodon's PagedResponse).
 * @param baseUrl Public base URL of this server. The request's own protocol and host may be those behind a reverse proxy.
 */
export function attachMinMaxPagination(request: FastifyRequest, reply: FastifyReply, results: readonly AnyEntity[] | readonly string[], baseUrl: string): void {
	const ids = results.map((r: AnyEntity | string) => typeof r === 'string' ? r : r.id);

	// No results, nothing to do
	if (!hasItems(ids)) return;

	// "next" link - older results
	const oldest = findOldest(ids);
	const nextUrl = createPaginationUrl(request, baseUrl, { max_id: oldest }); // Next page (older) has IDs less than the oldest of this page
	const next = `<${nextUrl}>; rel="next"`;

	// "prev" link - newer results
	const newest = findNewest(ids);
	const prevUrl = createPaginationUrl(request, baseUrl, { min_id: newest }); // Previous page (newer) has IDs greater than the newest of this page
	const prev = `<${prevUrl}>; rel="prev"`;

	// https://docs.joinmastodon.org/api/guidelines/#pagination
	const link = `${next}, ${prev}`;
	reply.header('link', link);
}

/**
 * Attaches Mastodon's pagination headers to a response that is paginated by limit / offset parameters.
 * Results must be sorted, but can be in ascending or descending order.
 * Attached headers will always be in descending order.
 *
 * @param request Fastify request object
 * @param reply Fastify reply object
 * @param results Results array, ordered in ascending or descending order
 * @param baseUrl Public base URL of this server. The request's own protocol and host may be those behind a reverse proxy.
 */
export function attachOffsetPagination(request: FastifyRequest, reply: FastifyReply, results: unknown[], baseUrl: string): void {
	const links: string[] = [];

	// Find initial offset
	const offset = findOffset(request);
	const limit = findLimit(request);

	// "next" link - older results
	if (hasItems(results)) {
		const oldest = offset + results.length;
		const nextUrl = createPaginationUrl(request, baseUrl, { offset: oldest }); // Next page (older) has entries less than the oldest of this page
		links.push(`<${nextUrl}>; rel="next"`);
	}

	// "prev" link - newer results
	// We can only paginate backwards if a limit is specified
	if (limit) {
		// Make sure we don't cross below 0, as that will produce an API error
		if (limit <= offset) {
			const newest = offset - limit;
			const prevUrl = createPaginationUrl(request, baseUrl, { offset: newest }); // Previous page (newer) has entries greater than the newest of this page
			links.push(`<${prevUrl}>; rel="prev"`);
		} else {
			const prevUrl = createPaginationUrl(request, baseUrl, { offset: 0, limit: offset }); // Previous page (newer) has entries greater than the newest of this page
			links.push(`<${prevUrl}>; rel="prev"`);
		}
	}

	// https://docs.joinmastodon.org/api/guidelines/#pagination
	if (links.length > 0) {
		const link = links.join(', ');
		reply.header('link', link);
	}
}

/**
 * Sorts a page newest first, in place.
 * Misskey returns a page oldest first when only sinceId is given (Mastodon's min_id and since_id),
 * but Mastodon clients expect every page newest first.
 */
export function sortNewestFirst<T extends AnyEntity>(items: T[]): T[] {
	return items.sort((a, b) => isOlder(a.id, b.id) ? 1 : isOlder(b.id, a.id) ? -1 : 0);
}

function hasItems<T>(items: readonly T[]): items is [T, ...T[]] {
	return items.length > 0;
}

function findOffset(request: FastifyRequest): number {
	if (typeof(request.query) !== 'object') return 0;

	const query = request.query as Record<string, string | string[] | undefined>;
	if (!query.offset) return 0;

	if (Array.isArray(query.offset)) {
		const offsets = query.offset
			.map(o => parseInt(o))
			.filter(o => !isNaN(o));
		const offset = Math.max(...offsets);
		return isNaN(offset) ? 0 : offset;
	}

	const offset = parseInt(query.offset);
	return isNaN(offset) ? 0 : offset;
}

function findLimit(request: FastifyRequest): number | null {
	if (typeof(request.query) !== 'object') return null;

	const query = request.query as Record<string, string | string[] | undefined>;
	if (!query.limit) return null;

	if (Array.isArray(query.limit)) {
		const limits = query.limit
			.map(l => parseInt(l))
			.filter(l => !isNaN(l));
		const limit = Math.max(...limits);
		return isNaN(limit) ? null : limit;
	}

	const limit = parseInt(query.limit);
	return isNaN(limit) ? null : limit;
}

function findOldest(ids: [string, ...string[]]): string {
	const first = ids[0];
	const last = ids[ids.length - 1];

	return isOlder(first, last) ? first : last;
}

function findNewest(ids: [string, ...string[]]): string {
	const first = ids[0];
	const last = ids[ids.length - 1];

	return isOlder(first, last) ? last : first;
}

function isOlder(a: string, b: string): boolean {
	if (a === b) return false;

	if (a.length !== b.length) {
		return a.length < b.length;
	}

	return a < b;
}

function createPaginationUrl(request: FastifyRequest, baseUrl: string, data: {
	min_id?: string;
	max_id?: string;
	offset?: number;
	limit?: number;
}): string {
	const requestUrl = new URL(request.url, baseUrl);

	// Remove any existing pagination
	requestUrl.searchParams.delete('min_id');
	requestUrl.searchParams.delete('max_id');
	requestUrl.searchParams.delete('since_id');
	requestUrl.searchParams.delete('offset');

	if (data.min_id) requestUrl.searchParams.set('min_id', data.min_id);
	if (data.max_id) requestUrl.searchParams.set('max_id', data.max_id);
	if (data.offset) requestUrl.searchParams.set('offset', String(data.offset));
	if (data.limit) requestUrl.searchParams.set('limit', String(data.limit));

	return requestUrl.href;
}
