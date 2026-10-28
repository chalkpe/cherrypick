/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * サーバー設定の変更履歴 (モデレーションログの updateServerSettings) に値を残さない meta の項目。
 * ログは read:admin:show-moderation-log を持つトークンから読め、設定を消した後も残るため、
 * 外部サービスの認証情報など、知られると悪用されるものはここに足す
 */
export const REDACTED_META_KEYS = [
	'ctav3SaKey',
	'deeplAuthKey',
	'hcaptchaSecretKey',
	'libreTranslateApiKey',
	'mcaptchaSecretKey',
	'objectStorageAccessKey',
	'objectStorageSecretKey',
	'recaptchaSecretKey',
	'remoteObjectStorageAccessKey',
	'remoteObjectStorageSecretKey',
	'sensitiveMediaDetectionApiKey',
	'smtpPass',
	'swPrivateKey',
	'truemailAuthKey',
	'turnstileSecretKey',
	'verifymailAuthKey',
	'voiceCallCloudflareTurnKeyId',
	'voiceCallCloudflareTurnApiToken',
] as const;

/** 値が設定されていることを示す */
export const REDACTED_SET = '(set)';
/** 変更前も設定されていて、別の値に変わったことを示す */
export const REDACTED_CHANGED = '(changed)';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value != null && !Array.isArray(value);
}

function isSet(value: unknown): boolean {
	return value !== null && value !== undefined;
}

/**
 * updateServerSettings の before / after から REDACTED_META_KEYS の値を除き、設定されているか (と変わったか) だけを残す。
 * 設定されていなければ null のまま、設定されていれば '(set)'、設定されていた値が別の値に変わったら after を '(changed)' にする。
 * 渡されたもの (メモリ上の meta を含む) は書き換えず、複製を返す。すでに伏せてあるものに使っても結果は変わらない
 */
export function redactServerSettingsLog<T extends { before?: unknown; after?: unknown }>(info: T): T {
	const { before, after } = info;
	const hasKey = (side: unknown, key: string) => isPlainObject(side) && Object.hasOwn(side, key);
	if (!REDACTED_META_KEYS.some(key => hasKey(before, key) || hasKey(after, key))) return info;

	const redactedBefore = isPlainObject(before) ? { ...before } : before;
	const redactedAfter = isPlainObject(after) ? { ...after } : after;

	for (const key of REDACTED_META_KEYS) {
		const beforeValue = isPlainObject(before) ? before[key] : undefined;
		const afterValue = isPlainObject(after) ? after[key] : undefined;

		if (isPlainObject(redactedBefore) && Object.hasOwn(redactedBefore, key)) {
			redactedBefore[key] = isSet(beforeValue) ? REDACTED_SET : beforeValue;
		}
		if (isPlainObject(redactedAfter) && Object.hasOwn(redactedAfter, key)) {
			redactedAfter[key] = !isSet(afterValue)
				? afterValue
				: isSet(beforeValue) && beforeValue !== afterValue ? REDACTED_CHANGED : REDACTED_SET;
		}
	}

	return { ...info, before: redactedBefore, after: redactedAfter };
}
