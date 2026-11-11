/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import push from 'web-push';
import { PushNotificationService } from '@/core/PushNotificationService.js';
import { runChatDiceWorker } from '@/core/ChatDiceService.js';

vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => undefined) } }));

function service() {
	return Object.assign(Object.create(PushNotificationService.prototype), {
		config: { url: 'https://local.test' },
		meta: { enableServiceWorker: true, swPublicKey: 'test-public-key', swPrivateKey: 'test-private-key' },
		subscriptionsCache: { fetch: vi.fn(async () => [{ endpoint: 'https://push.example/subscription', auth: 'test-auth', publickey: 'test-key' }]) },
		httpRequestService: { getAgentForHttps: vi.fn() },
	}) as PushNotificationService;
}

describe('dice chat Web Push payload', () => {
	test('keeps large saved roll details out of the push transport without changing the message', async () => {
		const dice = await runChatDiceWorker('999d1048576min1000000');
		const body = { id: 'message', text: `/dice ${dice.notation}`, fromUserId: 'alice', fromUser: { id: 'alice', username: 'alice' }, toUserId: 'bob', dice };
		const original = structuredClone(body);

		await service().pushNotification('bob', 'newChatMessage', body as never);

		const encoded = vi.mocked(push.sendNotification).mock.lastCall![1] as string;
		const sent = JSON.parse(encoded);
		expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(4096);
		expect(sent.body).not.toHaveProperty('dice');
		expect(sent.body).toMatchObject({ id: 'message', text: `/dice ${dice.notation}` });
		expect(Buffer.byteLength(encoded)).toBeLessThan(4096);
		expect(body).toEqual(original);
	});
	test('preserves ordinary chat push fields', async () => {
		const body = { id: 'ordinary', text: 'hello', fromUserId: 'alice', toUserId: 'bob' };

		await service().pushNotification('bob', 'newChatMessage', body as never);

		const sent = JSON.parse(vi.mocked(push.sendNotification).mock.lastCall![1] as string);
		expect(sent.body).toEqual(body);
	});
});
