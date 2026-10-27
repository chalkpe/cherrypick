/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 通話の参加者のブラウザに渡す ICE サーバー (STUN / TURN) の URL を確かめる

import { isIPv4 } from 'node:net';
import ipaddr from 'ipaddr.js';

// 制御文字や ASCII 以外の文字を含む URL はブラウザが受け付けず、接続ごと失敗するので、表示できる ASCII に限る
export const ICE_SERVER_URL = /^(stun|turns?):[\x21-\x7e]{1,256}$/;

// ブラウザは 53 番ポートへの接続を拒むので渡さない
export const BLOCKED_ICE_PORT = 53;

// 他のサーバーから届いた ICE サーバーでは、ユーザーの手元や同じネットワークの機器を指すアドレスを断る (ipaddr.js の range() の名前)。
// ループバック・プライベート (RFC 1918、共有アドレス 100.64/10、IPv6 のユニークローカル)・リンクローカル・未指定に加え、
// 同じネットワークに届くブロードキャストとマルチキャスト、使われなくなったサイトローカル、IPv4 に変換される ::ffff:0:0:0/96 も断る
const LOCAL_IPV4_RANGES = new Set(['unspecified', 'loopback', 'private', 'carrierGradeNat', 'linkLocal', 'broadcast', 'multicast']);
const LOCAL_IPV6_RANGES = new Set(['unspecified', 'loopback', 'uniqueLocal', 'linkLocal', 'deprecatedSiteLocal', 'multicast', 'rfc6145']);
// ベンチマーク用のアドレス (RFC 2544)。組織の中で使われていることがあるので断る。ipaddr.js はこれを reserved に含めるが、ほかの reserved (文書用など) は断らない
const BENCHMARKING_IPV4 = ipaddr.IPv4.parseCIDR('198.18.0.0/15');

// ネットワークの中で使う NAT64 のプレフィックス (64:ff9b:1::/48) の中でネットワークが選ぶ長さごとの、RFC 6052 の形。
// IPv4 アドレスのバイトの位置と、0 でなければならないバイト (u と後ろ) の位置
const LOCAL_USE_NAT64_LAYOUTS = [
	{ ipv4: [6, 7, 9, 10], zero: [8, 11, 12, 13, 14, 15] }, // /48
	{ ipv4: [7, 9, 10, 11], zero: [8, 12, 13, 14, 15] }, // /56
	{ ipv4: [9, 10, 11, 12], zero: [8, 13, 14, 15] }, // /64
	{ ipv4: [12, 13, 14, 15], zero: [] }, // /96
];

// 名前として受け付ける形。小文字の英数字とハイフンのラベルをドットでつないだもの (末尾のドットは許す)
const HOST_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?$/;
// 最後のラベルがこの形 (10 進、または 0x で始まる 16 進) の名前は、WHATWG URL などが IPv4 アドレスとして読む
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;
// 角括弧の中に書けるもの (IPv6 アドレス)。ゾーン (%) などは読み方が分かれるので含めない
const BRACKETED_IPV6 = /^\[[0-9a-f:.]+\]$/;
// 同じネットワークの機器を指す名前。最後のラベルがこれらの名前か、その下の名前 (mDNS の .local、RFC 8375 の home.arpa、
// 組織の中で使う .internal を含む) と、LOCAL_HOST_NAMES は断る
const LOCAL_NAME_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa'];
const LOCAL_HOST_NAMES = new Set(['localhost.localdomain']);

/**
 * 他のサーバーから届いた STUN / TURN の URL として受け付けるか。
 * ホストとポートを読めて (iceHostAndPortOf)、ポートが 53 番でなく、ホストがユーザーの手元や同じネットワークの機器を指さない
 * (isLocalIceHost) ものだけを受け付ける
 */
export function isAllowedRemoteIceUrl(url: unknown): boolean {
	if (typeof url !== 'string' || !ICE_SERVER_URL.test(url)) return false;
	const parsed = iceHostAndPortOf(url);
	return parsed != null && parsed.port !== BLOCKED_ICE_PORT && !isLocalIceHost(parsed.host);
}

/**
 * `stun:host[:port]` / `turn:host[:port]?transport=udp` / `turn:[IPv6]:port` のホスト (小文字) とポート (書かれていなければ null)。
 * ポートが 1 から 65535 の 10 進の数でないもの、角括弧の後にポート以外が続くものは読めないものとして null
 */
function iceHostAndPortOf(url: string): { host: string; port: number | null } | null {
	const rest = url.slice(url.indexOf(':') + 1);
	const query = rest.indexOf('?');
	const hostPort = (query === -1 ? rest : rest.slice(0, query)).toLowerCase();

	let host: string;
	let port: string | null;
	if (hostPort.startsWith('[')) {
		const close = hostPort.indexOf(']');
		if (close === -1) return null;
		host = hostPort.slice(0, close + 1);
		const after = hostPort.slice(close + 1);
		if (after !== '' && !after.startsWith(':')) return null;
		port = after === '' ? null : after.slice(1);
	} else {
		const colon = hostPort.indexOf(':');
		host = colon === -1 ? hostPort : hostPort.slice(0, colon);
		port = colon === -1 ? null : hostPort.slice(colon + 1);
	}

	if (port == null) return { host, port: null };
	if (!/^\d{1,5}$/.test(port)) return null;
	const portNumber = Number(port);
	if (portNumber < 1 || portNumber > 65535) return null;
	return { host, port: portNumber };
}

/**
 * ホスト (小文字) が、ユーザーの手元や同じネットワークの機器を指すか。読み方が分かれるものも指すものとして扱う。
 * - 角括弧の中は IPv6 アドレスだけ。WHATWG URL で正規の形 (16 進) にしてから、そのアドレスで決める (isLocalIPv6)
 * - 最後のラベルが数の名前は IPv4 アドレスとして読まれうるので、4 つの 10 進の組 (先頭の 0 も末尾のドットもない) のときだけ、
 *   そのアドレスで決める。2130706433、0x7f000001、127.1、0177.0.0.1 などは断る
 * - 名前は、同じネットワークの機器を指しうるものを断る。ラベルが一つだけの名前 (router、nas、ip6-localhost など。検索ドメインを付けて引かれうる)、
 *   localhost・.local・home.arpa・.internal とその下の名前、localhost.localdomain
 */
function isLocalIceHost(host: string): boolean {
	if (host.startsWith('[')) {
		if (!BRACKETED_IPV6.test(host)) return true;
		let canonical: string;
		try {
			canonical = new URL(`http://${host}/`).hostname;
		} catch {
			return true;
		}
		const literal = canonical.slice(1, -1);
		if (!canonical.startsWith('[') || !ipaddr.IPv6.isValid(literal)) return true;
		return isLocalIPv6(ipaddr.IPv6.parse(literal));
	}

	if (!HOST_NAME.test(host)) return true;
	const name = host.replace(/\.$/, '');
	const labels = name.split('.');
	const last = labels[labels.length - 1];
	if (NUMERIC_LABEL.test(last)) {
		if (!isIPv4(host)) return true;
		return isLocalIPv4(ipaddr.IPv4.parse(host));
	}
	if (labels.length === 1) return true;
	if (LOCAL_HOST_NAMES.has(name)) return true;
	return LOCAL_NAME_SUFFIXES.some(suffix => name === suffix || name.endsWith(`.${suffix}`));
}

function isLocalIPv4(address: ipaddr.IPv4): boolean {
	return LOCAL_IPV4_RANGES.has(address.range()) || address.match(BENCHMARKING_IPV4);
}

/**
 * IPv6 アドレスが、ユーザーの手元や同じネットワークの機器を指すか。
 * IPv4 アドレスを埋め込むアドレスは、埋め込まれた IPv4 アドレスで決める。
 * - IPv4 を写したアドレス (::ffff:0:0/96)、NAT64 のよく知られたプレフィックス (64:ff9b::/96)、6to4 (2002::/16)
 * - ネットワークの中で使う NAT64 (64:ff9b:1::/48)。プレフィックスの長さはネットワークが選ぶので、RFC 6052 の形として読める
 *   どの長さで読んでも手元を指さないものだけを受け付ける
 * ::/96 (:: と ::1、使われなくなった IPv4 互換アドレス) は断る
 */
function isLocalIPv6(address: ipaddr.IPv6): boolean {
	const parts = address.parts;
	const bytes = address.toByteArray();
	const ipv4At = (indexes: number[]) => new ipaddr.IPv4(indexes.map(index => bytes[index]));
	const zeroUntil = (end: number) => parts.slice(0, end).every(part => part === 0);

	if (zeroUntil(5) && parts[5] === 0xffff) return isLocalIPv4(ipv4At([12, 13, 14, 15]));
	if (zeroUntil(6)) return true;
	if (parts[0] === 0x64 && parts[1] === 0xff9b && parts.slice(2, 6).every(part => part === 0)) return isLocalIPv4(ipv4At([12, 13, 14, 15]));
	if (parts[0] === 0x64 && parts[1] === 0xff9b && parts[2] === 0x0001) {
		return LOCAL_USE_NAT64_LAYOUTS
			.filter(layout => layout.zero.every(index => bytes[index] === 0))
			.some(layout => isLocalIPv4(ipv4At(layout.ipv4)));
	}
	if (parts[0] === 0x2002) return isLocalIPv4(ipv4At([2, 3, 4, 5]));
	return LOCAL_IPV6_RANGES.has(address.range());
}
