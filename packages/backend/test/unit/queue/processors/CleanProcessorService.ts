/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { Test, TestingModule } from '@nestjs/testing';
import type { UserPendingsRepository } from '@/models/_.js';
import { CleanProcessorService } from '@/queue/processors/CleanProcessorService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { ReversiService } from '@/core/ReversiService.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { SIGNUP_PENDING_RETENTION } from '@/const.js';

describe('CleanProcessorService', () => {
	let app: TestingModule;
	let service: CleanProcessorService;
	let idService: IdService;
	let userPendingsRepository: UserPendingsRepository;

	async function createPending(ageMs: number) {
		const username = secureRndstr(12);
		return await userPendingsRepository.insertOne({
			id: idService.gen(Date.now() - ageMs),
			code: secureRndstr(16),
			email: `${username}@example.com`,
			username,
			password: 'hash',
			reason: '',
		});
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [CleanProcessorService, QueueLoggerService],
		})
			.overrideProvider(ReversiService).useValue(mockDeep<ReversiService>())
			.compile();

		service = app.get(CleanProcessorService);
		idService = app.get(IdService);
		userPendingsRepository = app.get(DI.userPendingsRepository);
	});

	afterAll(async () => {
		await app.close();
	});

	test('deletes signup requests kept past the retention period', async () => {
		const stale = await createPending(SIGNUP_PENDING_RETENTION + 1000 * 60 * 60);
		const recent = await createPending(SIGNUP_PENDING_RETENTION - 1000 * 60 * 60);

		await service.process();

		expect(await userPendingsRepository.existsBy({ id: stale.id })).toBe(false);
		expect(await userPendingsRepository.existsBy({ id: recent.id })).toBe(true);
	});
});
