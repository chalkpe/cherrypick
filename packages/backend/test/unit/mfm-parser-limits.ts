/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as assert from 'assert';
import { describe, test } from 'vitest';

import { parse } from 'mfc-js';
import { extractMentions } from '@/misc/extract-mentions.js';
import { extractHashtags } from '@/misc/extract-hashtags.js';
import { extractCustomEmojisFromMfm } from '@/misc/extract-custom-emojis-from-mfm.js';

function elapsedMs(fn: () => void): number {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

describe('MFM parser limits', () => {
	test('unclosed link labels are parsed in bounded time', () => {
		const input = '['.repeat(3000);
		assert.ok(elapsedMs(() => parse(input)) < 1000);
	});

	test('repeated unclosed link labels with emphasis are parsed in bounded time', () => {
		const input = '[*a*'.repeat(2048);
		assert.ok(elapsedMs(() => parse(input)) < 1000);
	});

	test('search keyword at the end of a line without brackets is not a search node', () => {
		for (const keyword of ['検索', '검색', 'search']) {
			const nodes = parse(`foo bar ${keyword}`);
			assert.deepStrictEqual(nodes, [{ type: 'text', props: { text: `foo bar ${keyword}` } }]);
		}
	});

	test('search syntax is parsed as a search node', () => {
		for (const keyword of ['検索', '검색', 'search']) {
			const nodes = parse(`foo bar [${keyword}]`);
			assert.deepStrictEqual(nodes.map(n => n.type), ['search']);
			assert.deepStrictEqual(nodes[0].props, { query: 'foo bar', content: `foo bar [${keyword}]` });
		}
	});
});

describe('Extraction from parsed MFM', () => {
	const text = [
		'hello @alice @bob@example.com #tag1 #태그 :custom_emoji: :other_emoji: 😀',
		'**bold @carol** $[spin #inner :nested_emoji:]',
		'`@code #notag :notemoji:` [link @label](https://example.com/#frag) https://example.com/@dave',
	].join('\n');

	test('mentions', () => {
		assert.deepStrictEqual(extractMentions(parse(text)), [
			{ username: 'alice', acct: '@alice', host: null },
			{ username: 'bob', acct: '@bob@example.com', host: 'example.com' },
			{ username: 'carol', acct: '@carol', host: null },
		]);
	});

	test('hashtags', () => {
		assert.deepStrictEqual(extractHashtags(parse(text)), ['tag1', '태그', 'inner']);
	});

	test('custom emojis', () => {
		assert.deepStrictEqual(extractCustomEmojisFromMfm(parse(text)), ['custom_emoji', 'other_emoji', 'nested_emoji']);
	});
});
