/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { URL, domainToASCII } from 'node:url';

/**
 * ActivityPub のホスト（`host` または `host:port`）を比較可能な形に正規化する。
 *
 * - ポートは無視し、ホスト名だけを返す（配信対象・ブロックリストはホスト単位）。
 * - ホスト名は小文字化して punycode に変換する。
 * - 空白・パス・資格情報などを含む不正な値は `null`（呼び出し側で fail closed）。
 *
 * `UtilityService.toPuny` は `host:port` に対して空文字を返して衝突するため、
 * ここでは URL パーサーでホスト名を切り出してから変換する。
 */
export function normalizeHost(host: string | null | undefined): string | null {
	if (host == null) return null;

	const trimmed = host.trim();
	if (trimmed.length === 0 || /\s/.test(trimmed)) return null;

	try {
		const url = new URL(`https://${trimmed}`);
		if (url.username !== '' || url.password !== '') return null;
		if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
		if (url.hostname.length === 0) return null;

		const hostname = domainToASCII(url.hostname.toLowerCase()).replace(/\.$/, '');
		return hostname.length > 0 ? hostname : null;
	} catch {
		return null;
	}
}

/**
 * Whether a remote host may receive a note with the given delivery targets.
 * Local recipients (host == null) are always allowed. Invalid target entries
 * fail closed.
 */
export function isHostAllowedByDeliveryTargets(
	deliveryTargets: { mode: 'include' | 'exclude'; hosts: string[] } | null | undefined,
	host: string | null | undefined,
): boolean {
	if (deliveryTargets == null) return true;
	if (host == null) return true;

	const normalizedHost = normalizeHost(host);
	if (normalizedHost == null) return false;

	const targets = deliveryTargets.hosts.map(target => normalizeHost(target));
	if (targets.some(target => target == null)) return false;

	return deliveryTargets.mode === 'include'
		? targets.includes(normalizedHost)
		: !targets.includes(normalizedHost);
}

/**
 * Like normalizeHost, but keeps a non-default port. Delivery targets are compared
 * against `followings.followerHost`, which may be stored with a port.
 */
export function normalizeHostForDelivery(host: string | null | undefined): string | null {
	if (host == null) return null;

	const trimmed = host.trim();
	if (trimmed.length === 0 || /\s/.test(trimmed)) return null;

	try {
		const url = new URL(`https://${trimmed}`);
		if (url.username !== '' || url.password !== '') return null;
		if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
		if (url.hostname.length === 0) return null;

		const hostname = domainToASCII(url.hostname.toLowerCase()).replace(/\.$/, '');
		if (hostname.length === 0) return null;
		return url.port.length > 0 ? `${hostname}:${url.port}` : hostname;
	} catch {
		return null;
	}
}
