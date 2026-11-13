/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import { ChatChannelDeliverProcessorService } from '@/queue/processors/ChatChannelDeliverProcessorService.js';
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

test('일시 실패는 재시도하고 미지원 서버는 건너뛰며 지원 서버는 일반 배달을 예약한다', async () => {
	const deliver = vi.fn();
	const capability = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
	const service = Object.assign(Object.create(ChatChannelDeliverProcessorService.prototype), {
		fetchInstanceMetadataService: { chatRoomChannelsCapability: capability },
		queueService: { deliver },
	}) as ChatChannelDeliverProcessorService;
	const job = { data: { host: 'peer.test', to: 'https://peer.test/inbox', user: { id: 'actor' }, content: { type: 'Update' }, isSharedInbox: false } } as Parameters<ChatChannelDeliverProcessorService['process']>[0];
	await expect(service.process(job)).rejects.toThrow('temporarily unavailable');
	expect(await service.process(job)).toBe('skip: chat room channels unsupported');
	expect(deliver).not.toHaveBeenCalled();
	expect(await service.process(job)).toBe('ok');
	expect(deliver).toHaveBeenCalledWith(job.data.user, job.data.content, job.data.to, false);
});
