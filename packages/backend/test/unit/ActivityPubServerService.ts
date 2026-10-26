/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { genRsaKeyPair } from '@/misc/gen-key-pair.js';

type ReplyMock = {
	code: ReturnType<typeof vi.fn>;
	header: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
};

function createReply(): ReplyMock {
	const reply: ReplyMock = {
		code: vi.fn(() => reply),
		header: vi.fn(() => reply),
		send: vi.fn(() => reply),
	};
	return reply;
}

describe('ActivityPubServerService inbox access control', () => {
	let service: ActivityPubServerService;
	let queueService: { inbox: ReturnType<typeof vi.fn> };
	let accessControlService: {
		extractHostFromKeyId: (keyId: string) => string | null;
		checkHostAccess: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		queueService = { inbox: vi.fn() };
		accessControlService = {
			extractHostFromKeyId: (keyId: string) => {
				try {
					const url = new URL(keyId);
					if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
					if (url.hostname.length === 0) return null;
					return url.hostname.toLowerCase() + (url.port.length > 0 ? `:${url.port}` : '');
				} catch {
					return null;
				}
			},
			checkHostAccess: vi.fn(),
		};

		service = Object.assign(Object.create(ActivityPubServerService.prototype), {
			config: { host: 'test.example.com' },
			meta: { federation: 'all' },
			queueService,
			activityPubAccessControlService: accessControlService,
		});
	});

	async function createInboxRequest(keyId: string, userAgent?: string) {
		const keypair = await genRsaKeyPair();
		const body = JSON.stringify({
			id: 'https://sender.example/activities/1',
			type: 'Create',
			actor: 'https://sender.example/users/alice',
		});

		const signed = await ApRequestCreator.createSignedPost({
			key: { keyId, privateKeyPem: keypair.privateKey },
			url: 'https://test.example.com/inbox',
			body,
			additionalHeaders: userAgent ? { 'User-Agent': userAgent } : {},
		});

		const headers: Record<string, string> = {
			...signed.request.headers,
			host: 'test.example.com',
		};

		const request = {
			headers,
			raw: {
				method: 'POST',
				url: '/inbox',
				headers,
				httpVersion: '1.1',
			},
			rawBody: Buffer.from(body),
			body: JSON.parse(body),
		};

		return { request, keypair, body };
	}

	test('rejects an activity signed by a blocked host before queueing', async () => {
		const { request } = await createInboxRequest('https://blocked.example/users/alice#main-key');

		accessControlService.checkHostAccess.mockResolvedValue({
			blocked: true,
			reason: 'blocked',
			host: 'blocked.example',
		});

		const reply = createReply();
		await (service as any).inbox(request, reply);

		expect(accessControlService.checkHostAccess).toHaveBeenCalledWith('blocked.example', true);
		expect(reply.code).toHaveBeenCalledWith(403);
		expect(queueService.inbox).not.toHaveBeenCalled();
	});

	test('rejects an activity signed by a quarantined host before queueing', async () => {
		const { request } = await createInboxRequest('https://quarantined.example/users/alice#main-key');

		accessControlService.checkHostAccess.mockResolvedValue({
			blocked: true,
			reason: 'quarantined',
			host: 'quarantined.example',
		});

		const reply = createReply();
		await (service as any).inbox(request, reply);

		expect(reply.code).toHaveBeenCalledWith(403);
		expect(queueService.inbox).not.toHaveBeenCalled();
	});

	test('ignores a spoofed User-Agent when the signing host is blocked', async () => {
		const { request } = await createInboxRequest(
			'https://blocked.example/users/alice#main-key',
			'Mastodon/4.2.0 (+https://allowed.example)',
		);

		accessControlService.checkHostAccess.mockResolvedValue({
			blocked: true,
			reason: 'blocked',
			host: 'blocked.example',
		});

		const reply = createReply();
		await (service as any).inbox(request, reply);

		expect(accessControlService.checkHostAccess).toHaveBeenCalledWith('blocked.example', true);
		expect(reply.code).toHaveBeenCalledWith(403);
		expect(queueService.inbox).not.toHaveBeenCalled();
	});

	test('queues an activity from an allowed host', async () => {
		const { request } = await createInboxRequest('https://allowed.example/users/alice#main-key');

		accessControlService.checkHostAccess.mockResolvedValue(null);

		const reply = createReply();
		await (service as any).inbox(request, reply);

		expect(accessControlService.checkHostAccess).toHaveBeenCalledWith('allowed.example', true);
		expect(queueService.inbox).toHaveBeenCalledTimes(1);
		expect(reply.code).toHaveBeenCalledWith(202);
	});

	test('allows silenced hosts on the inbox (only blocked and quarantined are rejected)', async () => {
		const { request } = await createInboxRequest('https://silenced.example/users/alice#main-key');

		// checkHostAccess is called with allowLimitedHosts=true, so a silenced host returns null.
		accessControlService.checkHostAccess.mockResolvedValue(null);

		const reply = createReply();
		await (service as any).inbox(request, reply);

		expect(accessControlService.checkHostAccess).toHaveBeenCalledWith('silenced.example', true);
		expect(queueService.inbox).toHaveBeenCalledTimes(1);
		expect(reply.code).toHaveBeenCalledWith(202);
	});

	test('rejects a signature with an invalid keyId', async () => {
		const { request } = await createInboxRequest('not-a-url');

		const reply = createReply();
		await (service as any).inbox(request, reply);

		expect(accessControlService.checkHostAccess).not.toHaveBeenCalled();
		expect(reply.code).toHaveBeenCalledWith(401);
		expect(queueService.inbox).not.toHaveBeenCalled();
	});
});
