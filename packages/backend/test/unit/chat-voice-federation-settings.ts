/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import UpdateMetaEndpoint from '@/server/api/endpoints/admin/update-meta.js';
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
