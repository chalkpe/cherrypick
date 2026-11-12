/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { FindOperator } from 'typeorm';

/** Whether a stored row meets a repository condition made of plain values, In and IsNull. */
export function meets(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, expected]) => {
		const actual = row[key] ?? null;
		if (!(expected instanceof FindOperator)) {
			if (expected != null && typeof expected === 'object') return actual != null && meets(actual as Record<string, unknown>, expected as Record<string, unknown>);
			return actual === expected;
		}
		if (expected.type === 'in') return (expected.value as unknown as unknown[]).includes(actual);
		if (expected.type === 'isNull') return actual == null;
		if (expected.type === 'not') return actual !== expected.value;
		if (expected.type === 'between') return typeof actual === 'string' && actual >= expected.value[0] && actual <= expected.value[1];
		if (expected.type === 'moreThanOrEqual') return typeof actual === 'string' && actual >= expected.value;
		throw new Error(`condition not supported in this test: ${expected.type}`);
	});
}

