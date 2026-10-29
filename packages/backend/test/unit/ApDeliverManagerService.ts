/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';

type Follower = {
	followerHost: string;
	followerInbox: string;
	followerSharedInbox: string | null;
};

function serviceFixture(followers: Follower[]) {
	const followingsRepository = {
		find: vi.fn().mockResolvedValue(followers),
	};
	const queueService = {
		deliverMany: vi.fn().mockResolvedValue(undefined),
	};
	const logger = {
		createSubLogger: vi.fn(() => ({ warn: vi.fn() })),
	};
	const loggerService = {
		getLogger: vi.fn(() => logger),
	};
	const service = new ApDeliverManagerService(
		followingsRepository as any,
		{} as any,
		queueService as any,
		loggerService as any,
	);
	return { service, followingsRepository, queueService };
}

const actor = { id: 'author', host: null } as any;
const activity = { type: 'Create', object: {} } as any;

function deliveredInboxes(queueService: { deliverMany: ReturnType<typeof vi.fn> }): string[] {
	const inboxes = queueService.deliverMany.mock.calls[0][2] as Map<string, boolean>;
	return [...inboxes.keys()].sort();
}

describe('ApDeliverManagerService delivery targets', () => {
	test('excludes a follower whose stored host has a trailing dot', async () => {
		const { service, queueService } = serviceFixture([
			{ followerHost: 'evil.example.', followerInbox: 'https://evil.example./inbox', followerSharedInbox: null },
			{ followerHost: 'allowed.example', followerInbox: 'https://allowed.example/inbox', followerSharedInbox: null },
		]);

		await service.deliverToFollowers(actor, activity, {
			mode: 'exclude',
			hosts: ['evil.example.'],
		});

		expect(deliveredInboxes(queueService)).toEqual(['https://allowed.example/inbox']);
	});

	test('includes a follower whose stored host has a trailing dot', async () => {
		const { service, queueService } = serviceFixture([
			{ followerHost: 'evil.example.', followerInbox: 'https://evil.example./inbox', followerSharedInbox: null },
			{ followerHost: 'allowed.example', followerInbox: 'https://allowed.example/inbox', followerSharedInbox: null },
		]);

		await service.deliverToFollowers(actor, activity, {
			mode: 'include',
			hosts: ['evil.example.'],
		});

		expect(deliveredInboxes(queueService)).toEqual(['https://evil.example./inbox']);
	});

	test('fails closed when an exclude target cannot be normalized', async () => {
		const { service, queueService } = serviceFixture([
			{ followerHost: 'evil.example', followerInbox: 'https://evil.example/inbox', followerSharedInbox: null },
			{ followerHost: 'allowed.example', followerInbox: 'https://allowed.example/inbox', followerSharedInbox: null },
		]);

		await service.deliverToFollowers(actor, activity, {
			mode: 'exclude',
			hosts: ['not a host'],
		});

		expect(deliveredInboxes(queueService)).toEqual([]);
	});

	test('matches exclude targets across ports', async () => {
		const { service, queueService } = serviceFixture([
			{ followerHost: 'evil.example:8443', followerInbox: 'https://evil.example:8443/inbox', followerSharedInbox: null },
			{ followerHost: 'evil.example', followerInbox: 'https://evil.example/inbox', followerSharedInbox: null },
			{ followerHost: 'allowed.example', followerInbox: 'https://allowed.example/inbox', followerSharedInbox: null },
		]);

		await service.deliverToFollowers(actor, activity, {
			mode: 'exclude',
			hosts: ['evil.example:8443'],
		});

		expect(deliveredInboxes(queueService)).toEqual(['https://allowed.example/inbox']);
	});
});