/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import { DeliverProcessorService } from '@/queue/processors/DeliverProcessorService.js';
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

test('일시 실패를 미지원으로 저장하지 않고 복구 후 다시 조회한다', async () => {
	const values = new Map<string, string>();
	const get = vi.fn(async (key: string) => values.get(key) ?? null);
	const set = vi.fn(async (key: string, value: string) => { values.set(key, value); });
	const fetchNodeinfo = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({ metadata: { features: ['chat_room_channels'] } });
	const service = Object.create(FetchInstanceMetadataService.prototype) as FetchInstanceMetadataService;
	Object.defineProperties(service, { redisClient: { value: { get, set } }, fetchNodeinfo: { value: fetchNodeinfo } });

	expect(await service.chatRoomChannelsCapability('peer.test')).toBeNull();
	expect(set).toHaveBeenLastCalledWith('chat_room_channels_capability:peer.test', 'unknown', 'EX', 5);
	values.clear();
	expect(await service.chatRoomChannelsCapability('peer.test')).toBe(true);
	expect(fetchNodeinfo).toHaveBeenCalledTimes(2);
});

test('NodeInfo가 채널을 광고하지 않으면 미지원으로 판단한다', async () => {
	const service = Object.create(FetchInstanceMetadataService.prototype) as FetchInstanceMetadataService;
	Object.defineProperties(service, {
		redisClient: { value: { get: async () => null, set: async () => {} } },
		fetchNodeinfo: { value: async () => ({ metadata: { features: [] } }) },
	});
	expect(await service.chatRoomChannelsCapability('old.test')).toBe(false);
});

test('채널 미지원 서버에는 배달하지 않고 지원 여부를 모르면 재시도한다', async () => {
	const signedPost = vi.fn();
	const capability = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(false);
	const service = Object.assign(Object.create(DeliverProcessorService.prototype), {
		utilityService: { isFederationAllowedUri: () => true, toPuny: (host: string) => host },
		suspendedHostsCache: { get: () => [] },
		fetchInstanceMetadataService: { chatRoomChannelsCapability: capability },
		apRequestService: { signedPost },
	}) as DeliverProcessorService;
	const job = { data: { to: 'https://peer.test/inbox', channelCapabilityHost: 'peer.test' } } as Parameters<DeliverProcessorService['process']>[0];

	await expect(service.process(job)).rejects.toThrow('temporarily unavailable');
	expect(await service.process(job)).toBe('skip (chat room channels unsupported)');
	expect(signedPost).not.toHaveBeenCalled();
});
