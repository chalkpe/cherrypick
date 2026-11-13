/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { Test } from '@nestjs/testing';
import { expect, test, vi } from 'vitest';
import { CacheService } from '@/core/CacheService.js';
import { MastodonFilterService } from '@/server/api/mastodon/MastodonFilterService.js';

test.each([
	{
		name: 'CacheService',
		create: () => new CacheService(
			{} as never,
			new EventEmitter() as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
		),
	},
	{
		name: 'MastodonFilterService',
		create: () => new MastodonFilterService({} as never, {} as never, {} as never, {} as never, {} as never),
	},
])('$name releases its cache timers when the application closes', async ({ create }) => {
	vi.useFakeTimers();
	const app = await Test.createTestingModule({
		providers: [{ provide: 'cache-owner', useFactory: create }],
	}).compile();

	try {
		expect(vi.getTimerCount()).toBeGreaterThan(0);

		await app.close();

		expect(vi.getTimerCount()).toBe(0);
	} finally {
		await app.close();
		vi.clearAllTimers();
		vi.useRealTimers();
	}
});
