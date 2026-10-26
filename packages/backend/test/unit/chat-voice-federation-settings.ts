/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import UpdateMetaEndpoint from '@/server/api/endpoints/admin/update-meta.js';
import UpdateInstanceEndpoint from '@/server/api/endpoints/admin/federation/update-instance.js';
import { MetaEntityService } from '@/core/entities/MetaEntityService.js';
import { DI } from '@/di-symbols.js';
import { MiMeta } from '@/models/Meta.js';
import type { MiLocalUser } from '@/models/User.js';
import { MetaService } from '@/core/MetaService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { SystemAccountService } from '@/core/SystemAccountService.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { ApiLoggerService } from '@/server/api/ApiLoggerService.js';
import { ServerStatsService } from '@/daemons/ServerStatsService.js';

// 依存は DI のトークンで渡す (コンストラクタの引数の並びに頼らない)
const admin = { id: 'admin', host: null } as MiLocalUser;

function metaWith(fields: Partial<MiMeta>): MiMeta {
	return Object.assign(new MiMeta(), fields);
}

async function createMetaEntityService(meta: MiMeta) {
	// pack が引く広告は無い
	const adsQuery = {
		where() { return this; },
		andWhere() { return this; },
		getMany: async () => [],
	};
	const module = await Test.createTestingModule({
		providers: [
			MetaEntityService,
			{ provide: DI.config, useValue: { url: 'https://local.test' } },
			{ provide: DI.meta, useValue: meta },
			{ provide: DI.adsRepository, useValue: { createQueryBuilder: () => adsQuery } },
			{ provide: SystemAccountService, useValue: { fetch: async () => ({ username: 'proxy' }) } },
			{ provide: LiveKitService, useValue: { isEnabled: true } },
		],
	}).compile();
	return module.get(MetaEntityService);
}

describe('remote voice call setting', () => {
	test.each<[Pick<MiMeta, 'enableRemoteVoiceCall' | 'federation'>, boolean]>([
		[{ enableRemoteVoiceCall: true, federation: 'all' }, true],
		[{ enableRemoteVoiceCall: false, federation: 'all' }, false],
		[{ enableRemoteVoiceCall: true, federation: 'none' }, false],
	])('reports remote voice call availability for %j', async (fields, expected) => {
		const meta = metaWith({ rootUserId: 'root', policies: { ltlAvailable: true, gtlAvailable: true }, ...fields });
		const service = await createMetaEntityService(meta);

		const packed = await service.packDetailed(meta);

		expect(packed.features?.remoteVoiceCall).toBe(expected);
	});

	test('admin/update-meta stores enableRemoteVoiceCall', async () => {
		const metaService = {
			fetch: vi.fn(async () => metaWith({})),
			update: vi.fn(async () => metaWith({})),
		};
		const module = await Test.createTestingModule({
			providers: [
				UpdateMetaEndpoint,
				{ provide: DI.meta, useValue: metaWith({}) },
				{ provide: MetaService, useValue: metaService },
				{ provide: ModerationLogService, useValue: { log: vi.fn() } },
				{ provide: ServerStatsService, useValue: { start: vi.fn(), dispose: vi.fn() } },
			],
		}).compile();
		const endpoint = module.get(UpdateMetaEndpoint);

		await endpoint.exec({ enableRemoteVoiceCall: false }, admin, null, null);

		expect(metaService.update).toHaveBeenCalledWith(expect.objectContaining({ enableRemoteVoiceCall: false }));
	});
});

describe('suspending a server from the admin panel', () => {
	async function createFixture(suspensionState = 'none') {
		const instance = { id: 'i1', host: 'remote.test', suspensionState, moderationNote: '' };
		const federatedInstanceService = {
			update: vi.fn(async (_id: string, data: { suspensionState?: string }) => {
				if (data.suspensionState != null) instance.suspensionState = data.suspensionState;
			}),
		};
		const chatVoiceService = {
			removeRefusedRemoteParticipants: vi.fn(async () => {}),
		};
		const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
		const module = await Test.createTestingModule({
			providers: [
				UpdateInstanceEndpoint,
				{ provide: DI.instancesRepository, useValue: { findOneBy: async ({ host }: { host: string }) => (host === instance.host ? instance : null) } },
				{ provide: UtilityService, useValue: { toPuny: (host: string) => host } },
				{ provide: FederatedInstanceService, useValue: federatedInstanceService },
				{ provide: ModerationLogService, useValue: { log: vi.fn() } },
				{ provide: ChatVoiceService, useValue: chatVoiceService },
				{ provide: ApiLoggerService, useValue: { logger } },
			],
		}).compile();
		const endpoint = module.get(UpdateInstanceEndpoint);
		return { endpoint, instance, federatedInstanceService, chatVoiceService, logger };
	}

	test('admin/federation/update-instance removes the server\'s call participants after suspending it, without waiting', async () => {
		const f = await createFixture();
		let checked = false;
		f.chatVoiceService.removeRefusedRemoteParticipants.mockImplementation(async () => {
			// 停止が記録された後で判定する
			checked = f.instance.suspensionState === 'manuallySuspended';
			await new Promise(() => {});
		});

		await f.endpoint.exec({ host: 'remote.test', isSuspended: true }, admin, null, null);

		expect(f.chatVoiceService.removeRefusedRemoteParticipants).toHaveBeenCalledTimes(1);
		expect(checked).toBe(true);
	});

	test('admin/federation/update-instance logs a failure to remove call participants without failing', async () => {
		const f = await createFixture();
		f.chatVoiceService.removeRefusedRemoteParticipants.mockRejectedValue(new Error('LiveKit is down'));

		await f.endpoint.exec({ host: 'remote.test', isSuspended: true }, admin, null, null);

		await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalled());
	});

	test.each([
		['unsuspending a server', 'manuallySuspended', { isSuspended: false }],
		['suspending a server that is already suspended', 'manuallySuspended', { isSuspended: true }],
		['editing only the moderation note', 'none', { moderationNote: 'note' }],
	])('admin/federation/update-instance leaves calls alone when %s', async (_label, suspensionState, params) => {
		const f = await createFixture(suspensionState);

		await f.endpoint.exec({ host: 'remote.test', ...params }, admin, null, null);

		expect(f.federatedInstanceService.update).toHaveBeenCalled();
		expect(f.chatVoiceService.removeRefusedRemoteParticipants).not.toHaveBeenCalled();
	});
});
