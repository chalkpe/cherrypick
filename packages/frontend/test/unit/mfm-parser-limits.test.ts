/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import * as mfm from 'mfc-js';

function elapsedMs(fn: () => void): number {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

describe('MFM parser limits', () => {
	test('unclosed link labels are parsed in bounded time', () => {
		const input = '['.repeat(3000);
		expect(elapsedMs(() => mfm.parse(input))).toBeLessThan(1000);
	});

	test('repeated unclosed link labels with emphasis are parsed in bounded time', () => {
		const input = '[*a*'.repeat(2048);
		expect(elapsedMs(() => mfm.parse(input))).toBeLessThan(1000);
	});

	test.each(['検索', '검색', 'search'])('search syntax [%s] is parsed as a search node', (keyword) => {
		const nodes = mfm.parse(`foo bar [${keyword}]`);
		expect(nodes.map(n => n.type)).toEqual(['search']);
		expect(nodes[0].props).toEqual({ query: 'foo bar', content: `foo bar [${keyword}]` });
	});

	test.each(['検索', '검색', 'search'])('search keyword %s at the end of a line without brackets is not a search node', (keyword) => {
		expect(mfm.parse(`foo bar ${keyword}`)).toEqual([{ type: 'text', props: { text: `foo bar ${keyword}` } }]);
	});

	test('mentions, hashtags and emojis are parsed', () => {
		const nodes = mfm.parse('@alice @bob@example.com #tag1 :custom_emoji: 😀');
		const types = nodes.map(n => n.type).filter(t => t !== 'text');
		expect(types).toEqual(['mention', 'mention', 'hashtag', 'emojiCode', 'unicodeEmoji']);
	});
});
