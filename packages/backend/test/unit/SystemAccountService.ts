/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import type { TestingModule } from '@nestjs/testing';
import { DI } from '@/di-symbols.js';
import { GlobalModule } from '@/GlobalModule.js';
import { IdService } from '@/core/IdService.js';
import { SystemAccountService } from '@/core/SystemAccountService.js';
import { MiSystemAccount, MiUsedUsername, MiUser } from '@/models/_.js';

// The race only exists between two PostgreSQL transactions, so this uses the real one.
describe('SystemAccountService', () => {
	let app: TestingModule;
	let db: DataSource;
	let idService: IdService;
	let service: SystemAccountService;

	const username = 'system.proxy';

	// The service caches accounts, so each case needs its own instance.
	beforeEach(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule],
			providers: [IdService, SystemAccountService],
		}).compile();
		await app.init();
		app.enableShutdownHooks();

		db = app.get<DataSource>(DI.db);
		idService = app.get(IdService);
		service = app.get(SystemAccountService);

		await db.getRepository(MiSystemAccount).delete({ type: 'proxy' });
		await db.getRepository(MiUser).delete({ usernameLower: username });
		await db.getRepository(MiUsedUsername).delete({ username });
	});

	afterEach(async () => {
		await app.close();
	});

	test('losing the race to create an account returns the one that won', async () => {
		const queryRunner = db.createQueryRunner();
		await queryRunner.startTransaction();
		try {
			// Another process is in the middle of creating the account, so its row is not visible yet.
			const winnerId = idService.gen();
			await queryRunner.manager.insert(MiUser, { id: winnerId, username, usernameLower: username, host: null, token: randomUUID().slice(0, 16) });
			await queryRunner.manager.insert(MiUsedUsername, { createdAt: new Date(), username });
			await queryRunner.manager.insert(MiSystemAccount, { id: idService.gen(), userId: winnerId, type: 'proxy' });

			const fetching = service.fetch('proxy');
			await vi.waitFor(async () => {
				const [{ count }] = await db.query(`SELECT count(*)::int AS "count" FROM "pg_stat_activity" WHERE "wait_event_type" = 'Lock' AND "query" LIKE 'INSERT INTO "used_username"%'`) as { count: number }[];
				expect(count).toBe(1);
			}, { timeout: 10000, interval: 20 });

			await queryRunner.commitTransaction();

			// The insert the race lost is rolled back, so only the winner's user remains.
			await expect(fetching).resolves.toMatchObject({ id: winnerId });
			expect(await db.getRepository(MiUser).countBy({ usernameLower: username })).toBe(1);
		} finally {
			if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
			await queryRunner.release();
		}
	});

	test('creates the account when nobody else is creating it', async () => {
		const created = await service.fetch('proxy');

		expect(created.username).toBe(username);
		expect(await db.getRepository(MiSystemAccount).findOneBy({ type: 'proxy' })).toMatchObject({ userId: created.id });
	});
});
