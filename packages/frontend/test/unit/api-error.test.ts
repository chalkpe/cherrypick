/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { isApiError } from '@/utility/api-error.js';

describe('API error code guard', () => {
	test.each([null, undefined, 'REMOTE_HOST_UNSUPPORTED', 4, {}, { code: 4 }])('rejects %j', value => {
		expect(isApiError(value)).toBe(false);
	});
	test('accepts the API error code returned by misskeyApi', () => {
		expect(isApiError({ code: 'REMOTE_HOST_UNSUPPORTED' })).toBe(true);
	});
});
