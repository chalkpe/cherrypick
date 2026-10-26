/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { ApEventService } from '@/core/activitypub/models/ApEventService.js';
import type { IObject } from '@/core/activitypub/type.js';

function createService(): ApEventService {
	return new ApEventService(
		{} as any,
		{ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any,
	);
}

function eventObject(overrides: Partial<IObject> = {}): IObject {
	return {
		type: 'Event',
		id: 'https://remote.example/events/1',
		name: 'Test event',
		startTime: '2026-10-27T00:00:00.000Z' as unknown as Date,
		...overrides,
	};
}

describe('ApEventService.extractEventFromNote', () => {
	test('does not copy a javascript: href into event metadata', async () => {
		const event = await createService().extractEventFromNote(eventObject({ href: 'javascript:alert(1)' }));

		expect(event.metadata).not.toHaveProperty('url');
	});

	test('does not copy a data: href into event metadata', async () => {
		const event = await createService().extractEventFromNote(eventObject({ href: 'data:text/html,<script>alert(1)</script>' }));

		expect(event.metadata).not.toHaveProperty('url');
	});

	test('does not copy a relative href into event metadata', async () => {
		const event = await createService().extractEventFromNote(eventObject({ href: '/events/1' }));

		expect(event.metadata).not.toHaveProperty('url');
	});

	test('copies an absolute https href into event metadata', async () => {
		const event = await createService().extractEventFromNote(eventObject({ href: 'https://remote.example/events/1' }));

		expect(event.metadata.url).toBe('https://remote.example/events/1');
	});

	test('copies an absolute http href into event metadata', async () => {
		const event = await createService().extractEventFromNote(eventObject({ href: 'http://remote.example/events/1' }));

		expect(event.metadata.url).toBe('http://remote.example/events/1');
	});

	test.each([
		'JaVaScRiPt:alert(1)',
		' javascript:alert(1)',
		'\njavascript:alert(1)',
		'java\tscript:alert(1)',
		'vbscript:msgbox(1)',
		'blob:https://remote.example/1234',
		'file:///etc/passwd',
		'//evil.example/events/1',
	])('does not copy an obfuscated or non-http href into event metadata: %j', async (href) => {
		const event = await createService().extractEventFromNote(eventObject({ href }));

		expect(event.metadata).not.toHaveProperty('url');
	});

	test.each([
		['https://remote.example/events/1'],
		{ type: 'Link', href: 'https://remote.example/events/1' },
		123,
	])('does not copy a non-string href into event metadata: %j', async (href) => {
		const event = await createService().extractEventFromNote(eventObject({ href: href as unknown as string }));

		expect(event.metadata).not.toHaveProperty('url');
	});
});
