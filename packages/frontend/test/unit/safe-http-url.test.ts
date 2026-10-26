/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { safeHttpUrl } from '@/utility/safe-http-url.js';

describe('safeHttpUrl', () => {
	test.each([
		'javascript:alert(1)',
		'JavaScript:alert(1)',
		' javascript:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'vbscript:msgbox(1)',
		'file:///etc/passwd',
		'blob:https://example.com/1234',
	])('rejects unsafe URL scheme: %s', (value) => {
		expect(safeHttpUrl(value)).toBeNull();
	});

	test('accepts an absolute https URL and normalizes it', () => {
		expect(safeHttpUrl('https://example.com/a')).toBe('https://example.com/a');
	});

	test('accepts an absolute http URL and normalizes it', () => {
		expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
	});

	test.each([
		'/relative',
		'relative/path',
		'//example.com/path',
		'',
	])('rejects relative URL: %s', (value) => {
		expect(safeHttpUrl(value)).toBeNull();
	});

	test.each([
		null,
		undefined,
		123,
		true,
		{},
		['https://example.com'],
	])('rejects non-string value: %s', (value) => {
		expect(safeHttpUrl(value)).toBeNull();
	});

	test.each([
		'JaVaScRiPt:alert(1)',
		'JAVASCRIPT:alert(1)',
		'\tjavascript:alert(1)',
		'\njavascript:alert(1)',
		'java\tscript:alert(1)',
		'java\nscript:alert(1)',
		'\u0000javascript:alert(1)',
		' \u0001javascript:alert(1)',
		'VBScript:msgbox(1)',
		'BLOB:https://example.com/1234',
		'Data:text/html,<script>alert(1)</script>',
		'ftp://example.com/file',
		'ws://example.com/socket',
		'about:blank',
	])('rejects obfuscated or non-http scheme: %j', (value) => {
		expect(safeHttpUrl(value)).toBeNull();
	});

	test.each([
		'\\\\evil.example\\path',
		'/\\evil.example',
		'?q=1',
		'#fragment',
	])('rejects scheme-less URL: %j', (value) => {
		expect(safeHttpUrl(value)).toBeNull();
	});

	test('normalizes scheme and host case of an allowed URL', () => {
		expect(safeHttpUrl('HTTPS://EXAMPLE.COM/A')).toBe('https://example.com/A');
	});

	test('strips surrounding whitespace from an allowed URL', () => {
		expect(safeHttpUrl('  https://example.com/a\n')).toBe('https://example.com/a');
	});

	test('percent-encodes markup characters in an allowed URL', () => {
		const result = safeHttpUrl('https://example.com/"><script>alert(1)</script>');

		expect(result).toBe('https://example.com/%22%3E%3Cscript%3Ealert(1)%3C/script%3E');
	});

	test.each([
		{ toString: () => 'https://example.com' },
		new String('https://example.com'),
		new URL('https://example.com'),
	])('does not coerce string-like objects: %s', (value) => {
		expect(safeHttpUrl(value)).toBeNull();
	});
});
