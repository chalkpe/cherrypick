/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { api } from 'cherrypick-js';

/** misskeyApi が返すエラーの code を、安全に参照できるか確認する。 */
export function isApiError(error: unknown): error is Pick<api.APIError, 'code'> {
	return typeof error === 'object' && error != null && 'code' in error && typeof error.code === 'string';
}
