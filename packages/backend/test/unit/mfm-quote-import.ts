/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { MfmService } from '@/core/MfmService.js';
import { ApMfmService } from '@/core/activitypub/ApMfmService.js';

const mfm = new MfmService({ url: 'https://local.test' } as never);
const apMfm = new ApMfmService(mfm);
const quoteHtml = '<p class="quote-inline">RE: <a href="https://remote.test/notes/quote">quoted note</a></p><p>Comment</p>';

describe('external quote import', () => {
	test('removes the inline quote link when the note has a separate quote', () => {
		expect(apMfm.htmlToMfm(quoteHtml, { hasQuote: true })).toBe('Comment');
	});

	test('keeps an inline link when no separate quote is present', () => {
		expect(apMfm.htmlToMfm(quoteHtml)).toContain('https://remote.test/notes/quote');
	});

	test('keeps hashtag metadata with the new options shape', () => {
		const html = '<p><a href="https://remote.test/tags/topic">#topic</a></p>';
		const tag = { type: 'Hashtag', name: '#topic', href: 'https://remote.test/tags/topic' };

		expect(apMfm.htmlToMfm(html, { tag })).toBe('#topic');
	});
});
