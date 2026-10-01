/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers';
import { Redis } from 'ioredis';
import { describe, expect, test } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import { GlobalModule } from '@/GlobalModule.js';
import { loadConfig } from '@/config.js';

describe('GlobalModule shutdown', () => {
	test('finishes pending Redis commands before closing connections', async () => {
		const config = loadConfig();
		const clients = Array.from({ length: 6 }, () => new Redis({ ...config.redis, disconnectTimeout: 10 }));
		const db = mock<DataSource>();
		db.destroy.mockResolvedValue(undefined);
		const module = new GlobalModule(db, clients[0], clients[1], clients[2], clients[3], clients[4], clients[5]);

		try {
			await Promise.all(clients.map(client => client.ping()));
			// Delay replies to reproduce shutdown while Redis commands are in flight.
			for (const client of clients) client.stream.pause();
			const pending = Promise.allSettled(clients.map(client => client.ping()));
			const resume = setTimeout(() => {
				for (const client of clients) client.stream.resume();
			}, 50);

			try {
				await module.dispose();
				expect(await pending).toEqual(Array.from({ length: 6 }, () => ({ status: 'fulfilled', value: 'PONG' })));
			} finally {
				clearTimeout(resume);
			}
		} finally {
			for (const client of clients) client.disconnect();
		}
	});
});
