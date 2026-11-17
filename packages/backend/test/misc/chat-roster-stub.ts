/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { vi } from 'vitest';
import { ChatRosterService } from '@/core/ChatRosterService.js';
import { ChatInviteLinkService } from '@/core/ChatInviteLinkService.js';

/** The service itself over an empty record, for tests about something else: every membership change applies. */
export function chatRosterOver(redisClient: unknown): ChatRosterService {
	return Object.assign(Object.create(ChatRosterService.prototype), {
		redisClient,
		chatRoomRosterStatesRepository: {
			findOneBy: async () => null,
			query: async () => [{}],
			update: async () => ({ affected: 0 }),
		},
		queueService: { createChatRoomRosterSyncJob: vi.fn(async () => {}) },
		logger: { warn: vi.fn() },
	}) as ChatRosterService;
}

/** A Redis client that remembers nothing, for tests that do not look at what is kept there. */
export const forgetfulRedis = () => {
	const pipeline = { setex: () => pipeline, exec: async () => [] };
	return {
		get: async () => null,
		set: async () => 'OK',
		setex: async () => 'OK',
		del: async () => 0,
		pipeline: () => pipeline,
	};
};

/** 초대 링크로 참여를 요청한 사람이 없는 서비스. 초대 링크와 관계없는 시험에서 쓴다 */
export function noChatInviteJoins(): ChatInviteLinkService {
	return Object.assign(Object.create(ChatInviteLinkService.prototype), {
		redisClient: { get: async () => null, del: async () => 0, getdel: async () => null },
	}) as ChatInviteLinkService;
}
