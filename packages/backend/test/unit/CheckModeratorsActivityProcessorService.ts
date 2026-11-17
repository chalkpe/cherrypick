/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { CheckModeratorsActivityProcessorService } from '@/queue/processors/CheckModeratorsActivityProcessorService.js';

describe('CheckModeratorsActivityProcessorService', () => {
	test('keeps the other base policies when disabling public notes', async () => {
		const update = vi.fn().mockResolvedValue({});
		const metaService = {
			fetch: vi.fn().mockResolvedValue({ policies: { chatAvailability: 'readonly', driveCapacityMb: 10, canPublicNote: true } }),
			update,
		};
		const service = new CheckModeratorsActivityProcessorService(
			{} as any,
			metaService as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{ logger: { createSubLogger: () => ({}) } } as any,
		);

		await (service as any).changeToDisablePublicNote();

		expect(update).toHaveBeenCalledWith({ policies: { chatAvailability: 'readonly', driveCapacityMb: 10, canPublicNote: false } });
	});
});
