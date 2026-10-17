/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setImmediate } from 'node:timers/promises';
import { describe, expect, test, vi } from 'vitest';
import { NotificationService } from '@/core/NotificationService.js';
import { allSettled } from '@/misc/promise-tracker.js';

describe('NotificationService shutdown', () => {
	test('waits for an unread notification callback that has already started', async () => {
		const started = Promise.withResolvers<void>();
		const read = Promise.withResolvers<string | null>();
		const publishMainStream = vi.fn();
		const pushNotification = vi.fn();
		const packed = { id: 'notification', type: 'test' };
		const service = new NotificationService(
			{ perUserNotificationsMaxCount: 100 } as never,
			{
				xadd: async () => '1-0',
				get: () => {
					started.resolve();
					return read.promise;
				},
			} as never,
			{} as never,
			{ pack: async () => packed } as never,
			{ gen: () => 'notification', parseFull: () => ({ date: 1, additional: 0n }) } as never,
			{ publishMainStream } as never,
			{ pushNotification } as never,
			{ userProfileCache: { fetch: async () => ({ notificationRecieveConfig: {} }) } } as never,
			{} as never,
		);

		try {
			service.createNotification('user', 'test', {});
			await started.promise;
			service.dispose();
			let settled = false;
			const draining = allSettled().then(() => { settled = true; });
			await setImmediate();
			expect(settled).toBe(false);

			read.resolve(null);
			await draining;
			expect(publishMainStream).toHaveBeenCalledWith('user', 'unreadNotification', packed);
			expect(pushNotification).toHaveBeenCalledWith('user', 'notification', packed);
		} finally {
			service.dispose();
			read.resolve(null);
			await allSettled();
			await setImmediate();
		}
	});
});
