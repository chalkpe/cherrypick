/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { runDriveFileBatches } from '@/utility/drive-bulk.js';

test('moves more than 100 selected files in serial bounded requests and preserves failed selection', async () => {
	const selected = Array.from({ length: 205 }, (_, i) => `file${i}`);
	const calls: string[][] = [];
	let active = 0;
	const promise = runDriveFileBatches(selected, async ids => {
		expect(active++).toBe(0);
		calls.push(ids);
		await Promise.resolve();
		active--;
		if (ids[0] === 'file100') throw new Error('request failed');
	});
	selected.push('unconfirmed');

	const result = await promise;

	expect(calls.map(ids => ids.length)).toEqual([100, 100, 5]);
	expect(result.succeededIds).toHaveLength(105);
	expect(result.failedIds).toHaveLength(100);
	expect(calls.flat()).not.toContain('unconfirmed');
});
