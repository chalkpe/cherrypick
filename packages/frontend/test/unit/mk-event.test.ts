/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import type * as Misskey from 'cherrypick-js';
import MkEvent from '@/components/MkEvent.vue';

afterEach(() => {
	cleanup();
});

function renderEvent(metadata: Record<string, unknown>) {
	const note = {
		event: {
			title: 'Test event',
			start: new Date('2026-10-27T00:00:00.000Z'),
			end: null,
			metadata,
		},
	} as unknown as Misskey.entities.Note;

	return render(MkEvent, {
		props: { note },
		global: {
			components: {
				MkTime: { template: '<span />' },
			},
		},
	});
}

describe('MkEvent', () => {
	test('does not render a link for a javascript: metadata URL', () => {
		const { container } = renderEvent({ url: 'javascript:alert(1)' });

		expect(container.querySelector('a')).toBeNull();
		expect(container.textContent).not.toContain('javascript:alert(1)');
	});

	test('does not render a link for a data: offers URL', () => {
		const { container } = renderEvent({ offers: { url: 'data:text/html,<script>alert(1)</script>' } });

		expect(container.querySelector('a')).toBeNull();
	});

	test('does not render a link for a relative metadata URL', () => {
		const { container } = renderEvent({ url: '/relative' });

		expect(container.querySelector('a')).toBeNull();
	});

	test('renders a safe metadata URL as an external link', () => {
		const { container } = renderEvent({ url: 'https://example.com/a' });

		const link = container.querySelector('a');
		expect(link?.getAttribute('href')).toBe('https://example.com/a');
		expect(link?.getAttribute('target')).toBe('_blank');
		expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
	});

	test('renders a safe offers URL as an external link', () => {
		const { container } = renderEvent({ offers: { url: 'https://tickets.example.com/buy' } });

		const link = container.querySelector('a');
		expect(link?.getAttribute('href')).toBe('https://tickets.example.com/buy');
		expect(link?.getAttribute('target')).toBe('_blank');
		expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
	});

	test.each([
		'JaVaScRiPt:alert(1)',
		'\njavascript:alert(1)',
		'java\tscript:alert(1)',
		'vbscript:msgbox(1)',
		'blob:https://example.com/1234',
		'//evil.example/path',
	])('does not render a link for an obfuscated metadata URL: %j', (url) => {
		const { container } = renderEvent({ url });

		expect(container.querySelector('a')).toBeNull();
	});

	test.each([
		'JaVaScRiPt:alert(1)',
		'//evil.example/path',
	])('does not render a link for an obfuscated offers URL: %j', (url) => {
		const { container } = renderEvent({ offers: { url } });

		expect(container.querySelector('a')).toBeNull();
	});

	test.each([
		{ toString: () => 'javascript:alert(1)' },
		['https://example.com'],
		123,
		true,
	])('does not render a link for a non-string metadata URL: %s', (url) => {
		const { container } = renderEvent({ url });

		expect(container.querySelector('a')).toBeNull();
	});

	test.each([
		'https://tickets.example.com/buy',
		[{ url: 'javascript:alert(1)' }],
		null,
	])('does not render a link for a malformed offers value: %j', (offers) => {
		const { container } = renderEvent({ offers });

		expect(container.querySelector('a')).toBeNull();
	});

	test('renders an http metadata URL as an external link', () => {
		const { container } = renderEvent({ url: 'http://example.com/a' });

		const link = container.querySelector('a');
		expect(link?.getAttribute('href')).toBe('http://example.com/a');
		expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
	});

	test('renders only the safe link when metadata and offers URLs are mixed', () => {
		const { container } = renderEvent({
			url: 'javascript:alert(1)',
			offers: { url: 'https://tickets.example.com/buy' },
		});

		const links = container.querySelectorAll('a');
		expect(links).toHaveLength(1);
		expect(links[0].getAttribute('href')).toBe('https://tickets.example.com/buy');
	});

	test('does not inject markup from a safe URL containing HTML', () => {
		const { container } = renderEvent({ url: 'https://example.com/"><img src=x onerror=alert(1)>' });

		expect(container.querySelector('img')).toBeNull();
		const link = container.querySelector('a');
		expect(link?.getAttribute('href')).toBe('https://example.com/%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E');
	});
});
