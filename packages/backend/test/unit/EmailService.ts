/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '@/config.js';
import type { MiMeta, UserProfilesRepository } from '@/models/_.js';
import type { LoggerService } from '@/core/LoggerService.js';
import type { UtilityService } from '@/core/UtilityService.js';
import type { HttpRequestService } from '@/core/HttpRequestService.js';
import { EmailService } from '@/core/EmailService.js';

const sendMail = vi.fn();

vi.mock('nodemailer', () => ({
	createTransport: () => ({ sendMail }),
}));

describe('EmailService', () => {
	let meta: MiMeta;
	let service: EmailService;

	beforeEach(() => {
		sendMail.mockReset();
		sendMail.mockResolvedValue({ messageId: 'test' });

		meta = {
			enableEmail: true,
			email: 'noreply@example.com',
			name: 'Example',
			themeColor: null,
			logoImageUrl: null,
			iconUrl: null,
		} as unknown as MiMeta;

		const loggerService = {
			getLogger: () => ({ info: () => {}, error: () => {} }),
		} as unknown as LoggerService;

		service = new EmailService(
			{ url: 'https://example.com', host: 'example.com' } as Config,
			meta,
			{} as UserProfilesRepository,
			loggerService,
			{} as UtilityService,
			{} as HttpRequestService,
		);
	});

	async function sentHtml(): Promise<string> {
		await service.sendEmail('to@example.com', 'Subject', '<a href="https://example.com">link</a>', 'text');
		expect(sendMail).toHaveBeenCalledTimes(1);
		return sendMail.mock.calls[0][0].html;
	}

	test('uses the server theme color as the accent color', async () => {
		meta.themeColor = '#86b300';

		const html = await sentHtml();

		expect(html).toContain('#86b300');
		expect(html).not.toContain('#ffbcdc');
	});

	test('falls back to the default accent color without a theme color', async () => {
		const html = await sentHtml();

		expect(html).toContain('#ffbcdc');
	});

	test('ignores a theme color that is not a hex color', async () => {
		meta.themeColor = 'red; background: url(https://evil.example)';

		const html = await sentHtml();

		expect(html).not.toContain('evil.example');
		expect(html).toContain('#ffbcdc');
	});
});
