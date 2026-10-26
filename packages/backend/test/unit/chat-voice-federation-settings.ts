/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import UpdateMetaEndpoint from '@/server/api/endpoints/admin/update-meta.js';
import UpdateInstanceEndpoint from '@/server/api/endpoints/admin/federation/update-instance.js';
import { MetaEntityService } from '@/core/entities/MetaEntityService.js';

describe('remote voice call setting', () => {
	test.each([
		[{ enableRemoteVoiceCall: true, federation: 'all' }, true],
		[{ enableRemoteVoiceCall: false, federation: 'all' }, false],
		[{ enableRemoteVoiceCall: true, federation: 'none' }, false],
	])('reports remote voice call availability for %j', async (meta, expected) => {
		const service = Object.assign(Object.create(MetaEntityService.prototype), {
			meta: { rootUserId: 'root', ...meta },
			systemAccountService: { fetch: async () => ({ username: 'proxy' }) },
			liveKitService: { isEnabled: true },
		});
		Object.defineProperty(service, 'pack', { value: async () => ({}) });
		const packed = await service.packDetailed({ policies: { ltlAvailable: true, gtlAvailable: true }, ...meta } as any);
		expect(packed.features.remoteVoiceCall).toBe(expected);
	});

	test('admin/update-meta stores enableRemoteVoiceCall', async () => {
		const metaService = {
			fetch: vi.fn(async () => ({})),
			update: vi.fn(async () => ({})),
		};
		const endpoint = new (UpdateMetaEndpoint as any)(
			{ resolve: async () => ({ start: vi.fn(), dispose: vi.fn() }) }, {}, metaService, { log: vi.fn() },
		);
		await endpoint.exec({ enableRemoteVoiceCall: false }, { id: 'admin' }, undefined);
		expect(metaService.update).toHaveBeenCalledWith(expect.objectContaining({ enableRemoteVoiceCall: false }));
	});
});

describe('suspending a server from the admin panel', () => {
	function createFixture(suspensionState = 'none') {
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
		const endpoint = new (UpdateInstanceEndpoint as any)(
			{ findOneBy: async ({ host }: { host: string }) => (host === instance.host ? instance : null) },
			{ toPuny: (host: string) => host },
			federatedInstanceService,
			{ log: vi.fn() },
			chatVoiceService,
			{ logger },
		);
		return { endpoint, instance, federatedInstanceService, chatVoiceService, logger };
	}

	test('admin/federation/update-instance removes the server\'s call participants after suspending it, without waiting', async () => {
		const f = createFixture();
		let checked = false;
		f.chatVoiceService.removeRefusedRemoteParticipants.mockImplementation(async () => {
			// 停止が記録された後で判定する
			checked = f.instance.suspensionState === 'manuallySuspended';
			await new Promise(() => {});
		});

		await f.endpoint.exec({ host: 'remote.test', isSuspended: true }, { id: 'admin' }, null, null);

		expect(f.chatVoiceService.removeRefusedRemoteParticipants).toHaveBeenCalledTimes(1);
		expect(checked).toBe(true);
	});

	test('admin/federation/update-instance logs a failure to remove call participants without failing', async () => {
		const f = createFixture();
		f.chatVoiceService.removeRefusedRemoteParticipants.mockRejectedValue(new Error('LiveKit is down'));

		await f.endpoint.exec({ host: 'remote.test', isSuspended: true }, { id: 'admin' }, null, null);

		await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalled());
	});

	test.each([
		['unsuspending a server', 'manuallySuspended', { isSuspended: false }],
		['suspending a server that is already suspended', 'manuallySuspended', { isSuspended: true }],
		['editing only the moderation note', 'none', { moderationNote: 'note' }],
	])('admin/federation/update-instance leaves calls alone when %s', async (_label, suspensionState, params) => {
		const f = createFixture(suspensionState);

		await f.endpoint.exec({ host: 'remote.test', ...params }, { id: 'admin' }, null, null);

		expect(f.federatedInstanceService.update).toHaveBeenCalled();
		expect(f.chatVoiceService.removeRefusedRemoteParticipants).not.toHaveBeenCalled();
	});
});
