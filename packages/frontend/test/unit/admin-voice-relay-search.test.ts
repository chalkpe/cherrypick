/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { searchIndexes } from 'search-index:admin';
import { genSearchIndexes } from '@/utility/inapp-search.js';
import { compareStringIncludes } from '@/utility/intl-string.js';

const adminSearchIndex = genSearchIndexes(searchIndexes);

function matchesQuery(item: typeof adminSearchIndex[number], query: string): boolean {
	return compareStringIncludes(item.label, query)
		|| item.keywords.some(keyword => compareStringIncludes(keyword, query))
		|| item.texts.some(text => compareStringIncludes(text, query));
}

function voiceRelayMatches(query: string): boolean {
	return adminSearchIndex.some(item => item.path === '/admin/voice-relay' && matchesQuery(item, query));
}

test.each(['call', 'voice', 'LiveKit', 'TURN'])('admin search finds the call settings page for %s', (query) => {
	expect(voiceRelayMatches(query)).toBe(true);
});

test.each(['통화', '대여하기', '通話', 'レンタル'])('admin search finds the call infrastructure rental page for %s', (query) => {
	expect(voiceRelayMatches(query)).toBe(true);
});

test('the rental search result keeps its page, icon, and title', () => {
	const item = adminSearchIndex.find(entry => entry.path === '/admin/voice-relay');

	expect(item).toBeDefined();
	expect(item?.icon).toBe('ti ti-phone');
	expect(item?.label).toBe('Call settings');
});
