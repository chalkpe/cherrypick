/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { StatusError } from '@/misc/status-error.js';

const TEMPORARY_NETWORK_ERRORS = new Set([
	'ECONNRESET',
	'ECONNREFUSED',
	'ECONNABORTED',
	'EPIPE',
	'ETIMEDOUT',
	'ESOCKETTIMEDOUT',
	'EAI_AGAIN',
	'ENOTFOUND',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ENETDOWN',
	// 途中で切れた応答
	'ERR_HTTP_CONTENT_LENGTH_MISMATCH',
]);

/**
 * 相手の都合で今は取れないだけで、待てば取れるかもしれない失敗か。
 * 429 と 5xx、接続の失敗と切断がこれにあたる。404 や大きすぎるファイルは何度試しても同じなので含めない
 */
export function isTemporaryFetchFailure(err: unknown): boolean {
	if (err instanceof StatusError) return err.isRetryable;

	let current = err as { code?: unknown; name?: unknown; cause?: unknown } | null | undefined;
	for (let depth = 0; current != null && depth < 4; depth++) {
		if (typeof current.code === 'string' && TEMPORARY_NETWORK_ERRORS.has(current.code)) return true;
		if (current.name === 'TimeoutError') return true;
		current = current.cause as typeof current;
	}
	return false;
}
