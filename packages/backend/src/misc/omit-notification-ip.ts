/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * ログイン通知に載っている接続元のIPアドレスを取り除いた通知を返す。
 * それ以外の通知はそのまま返す。
 */
export function omitLoginIp<T>(notification: T): T {
	const n = notification as { type?: unknown; ip?: unknown } | null;
	if (n == null || n.type !== 'login' || !('ip' in n)) return notification;
	const copy = { ...n };
	delete copy.ip;
	return copy as T;
}
