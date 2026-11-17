/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import BubbleTimelineEndpoint from '@/server/api/endpoints/notes/bubble-timeline.js';
import EventsSearchEndpoint from '@/server/api/endpoints/notes/events/search.js';

function queryBuilder() {
	const query: any = new Proxy({}, {
		get: (_t, prop) => {
			if (prop === 'getMany') return async () => [];
			if (prop === 'then') return undefined;
			return () => query;
		},
	});
	return query;
}

function queryService() {
	return {
		makePaginationQuery: vi.fn((q: unknown) => q),
		generateBaseNoteFilteringQuery: vi.fn(),
		generateVisibilityQuery: vi.fn(),
		generateMutedUserRenotesQueryForNotes: vi.fn(),
		generateUgcVisibilityQueryForVisitor: vi.fn(),
	};
}

function bubbleFixture() {
	const qs = queryService();
	const endpoint = new BubbleTimelineEndpoint(
		{ bubbleInstances: ['bubble.example'] } as any,
		{ createQueryBuilder: () => queryBuilder() } as any,
		{ packMany: vi.fn().mockResolvedValue([]) } as any,
		qs as any,
		{ getUserPolicies: vi.fn().mockResolvedValue({ btlAvailable: true }) } as any,
		{ read: vi.fn() } as any,
		{ userFollowingsCache: { fetch: vi.fn().mockResolvedValue({}) } } as any,
	);
	return { endpoint, qs };
}

function searchFixture() {
	const qs = queryService();
	const endpoint = new EventsSearchEndpoint(
		{} as any,
		{ createQueryBuilder: () => queryBuilder(), queryRunner: undefined } as any,
		{ packMany: vi.fn().mockResolvedValue([]) } as any,
		qs as any,
		{ getUserPolicies: vi.fn().mockResolvedValue({ canSearchNotes: true }) } as any,
	);
	return { endpoint, qs };
}

describe('notes/bubble-timeline', () => {
	test('applies the visitor visibility restriction without a user', async () => {
		const { endpoint, qs } = bubbleFixture();
		await endpoint.exec({ limit: 10, withRenotes: true, withBots: true } as any, null, null, null);
		expect(qs.generateUgcVisibilityQueryForVisitor).toHaveBeenCalledOnce();
	});

	test('does not apply the visitor restriction for a signed-in user', async () => {
		const { endpoint, qs } = bubbleFixture();
		await endpoint.exec({ limit: 10, withRenotes: true, withBots: true } as any, { id: 'me' } as any, null, null);
		expect(qs.generateUgcVisibilityQueryForVisitor).not.toHaveBeenCalled();
	});
});

describe('notes/events/search', () => {
	test('applies the visitor visibility restriction without a user', async () => {
		const { endpoint, qs } = searchFixture();
		await endpoint.exec({ limit: 10, sortBy: 'createdAt' } as any, null, null, null);
		expect(qs.generateUgcVisibilityQueryForVisitor).toHaveBeenCalledOnce();
	});

	test('does not apply the visitor restriction for a signed-in user', async () => {
		const { endpoint, qs } = searchFixture();
		await endpoint.exec({ limit: 10, sortBy: 'createdAt' } as any, { id: 'me' } as any, null, null);
		expect(qs.generateUgcVisibilityQueryForVisitor).not.toHaveBeenCalled();
	});
});
