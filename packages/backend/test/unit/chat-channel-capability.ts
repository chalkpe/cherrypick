/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import type { MiInstance } from '@/models/Instance.js';

test.each([null, { metadata: {} }, { metadata: { features: ['chat_room_channels'] } }])('NodeInfo %j의 채널 지원 상태를 기록한다', async info => {
	const update = vi.fn();
	const overrides = {
		fetchNodeinfo: async () => info,
		fetchDom: async () => null,
		fetchManifest: async () => null,
		fetchFaviconUrl: async () => null,
		fetchIconUrl: async () => null,
		getThemeColor: async () => null,
		getSiteName: async () => null,
		getDescription: async () => null,
		unlock: async () => {},
		logger: { info: () => {}, succ: () => {}, error: () => {} },
		federatedInstanceService: { update },
	};
	const service = Object.create(FetchInstanceMetadataService.prototype) as FetchInstanceMetadataService;
	Object.defineProperties(service, Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value }])));

	await service.fetchInstanceMetadata({ id: 'instance', host: 'peer.test', supportsChatRoomChannels: true } as MiInstance, true);

	expect(update).toHaveBeenCalledWith('instance', expect.objectContaining({ supportsChatRoomChannels: info?.metadata != null && 'features' in info.metadata }));
});
