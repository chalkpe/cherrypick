/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { isAllowedRemoteIceUrl } from '@/misc/ice-server-url.js';

describe('isAllowedRemoteIceUrl (ICE server urls sent by another server)', () => {
	// ICE サーバーはユーザーのブラウザが接続しに行く。他のサーバーが、ユーザーの手元や同じネットワークの機器に接続させないよう、
	// ループバック・プライベート・リンクローカル・未指定のアドレスと localhost を断る。読み方が分かれる書き方も断る
	test.each([
		['localhost', 'stun:localhost:3478'],
		['upper-case LOCALHOST', 'stun:LOCALHOST'],
		['localhost with a trailing dot', 'stun:localhost.:3478'],
		['a name under localhost', 'turn:turn.localhost:3478'],
		['an IPv4 loopback address', 'turn:127.0.0.1:3478'],
		['another IPv4 loopback address', 'stun:127.8.9.10'],
		['an IPv4 private address (10/8)', 'turns:10.1.2.3:443?transport=tcp'],
		['an IPv4 private address (172.16/12)', 'stun:172.31.255.255'],
		['an IPv4 private address (192.168/16)', 'stun:192.168.0.1:3478'],
		['a shared address (100.64/10)', 'stun:100.64.0.1'],
		['an IPv4 link-local address', 'stun:169.254.169.254'],
		['the IPv4 unspecified address', 'stun:0.0.0.0:3478'],
		['an address in 0/8', 'stun:0.1.2.3'],
		['the IPv4 broadcast address', 'stun:255.255.255.255'],
		['an IPv4 multicast address', 'stun:224.0.0.1'],
		['a decimal IPv4 address', 'stun:2130706433:3478'],
		['a hexadecimal IPv4 address', 'stun:0x7f000001'],
		['a hexadecimal IPv4 part', 'stun:0x7f.0.0.1'],
		['an octal IPv4 part', 'stun:0177.0.0.1'],
		['a leading zero in an IPv4 part', 'stun:010.0.0.1'],
		['a shortened IPv4 address', 'stun:127.1'],
		['an IPv4 address with a trailing dot', 'stun:127.0.0.1.'],
		['a public IPv4 address with a trailing dot', 'stun:8.8.8.8.'],
		['a name ending in a number', 'stun:stun.example.123'],
		['the IPv6 loopback address', 'turn:[::1]:3478'],
		['the IPv6 loopback address written out', 'stun:[0:0:0:0:0:0:0:1]'],
		['the IPv6 unspecified address', 'stun:[::]'],
		['an IPv6 link-local address', 'stun:[fe80::1]:3478'],
		['an IPv6 link-local address with a zone', 'stun:[fe80::1%25eth0]'],
		['an IPv6 unique local address', 'stun:[fd12:3456::1]'],
		['an IPv6 site-local address', 'stun:[fec0::1]'],
		['an IPv6 multicast address', 'stun:[ff02::1]'],
		['an IPv4-mapped loopback address', 'stun:[::ffff:127.0.0.1]'],
		['an IPv4-mapped private address in hex', 'turn:[::ffff:a00:1]:3478'],
		['an IPv4-mapped address in upper case', 'stun:[::FFFF:7F00:1]'],
		['an IPv4-compatible address', 'stun:[::127.0.0.1]'],
		['an IPv4-compatible public address', 'stun:[::8.8.8.8]'],
		['an IPv4-translated address', 'stun:[::ffff:0:808:808]'],
		['a NAT64 address of a loopback address', 'stun:[64:ff9b::127.0.0.1]'],
		['an IPv6 address without brackets', 'stun:::1'],
		['an unclosed bracket', 'stun:[2001:db8::1'],
		['something after the bracket', 'stun:[2001:db8::1]x:3478'],
		['a malformed IPv6 address', 'stun:[2001:db8::g]'],
		['an IPv4 address in brackets', 'stun:[8.8.8.8]'],
		['no host', 'stun::3478'],
		['user information', 'turn:user@turn.example:3478'],
		['percent-encoding', 'stun:%6Cocalhost'],
		['an underscore', 'stun:stun_1.example'],
		['an empty label', 'stun:stun..example'],
		['a port that is not a number', 'stun:stun.example:x'],
		['a port that is out of range', 'stun:stun.example:65536'],
		['port 0', 'stun:stun.example:0'],
		['an empty port', 'stun:stun.example:'],
	])('refuses a url with %s', (_label, url) => {
		expect(isAllowedRemoteIceUrl(url)).toBe(false);
	});

	test.each([
		['a name', 'turn:turn.cloudflare.com:3478?transport=udp'],
		['a name in upper case', 'stun:STUN.Example:3478'],
		['a name with a trailing dot', 'stun:stun.example.:3478'],
		['a name that contains localhost', 'stun:localhost.example'],
		['a name with a numeric first label', 'stun:53.example:3478'],
		['a public IPv4 address', 'stun:8.8.8.8:3478'],
		['a public IPv6 address', 'turns:[2606:4700::6810:84e5]:443?transport=tcp'],
		['an IPv4-mapped public address', 'stun:[::ffff:8.8.8.8]'],
		['the highest port', 'stun:stun.example:65535'],
	])('accepts a url with %s', (_label, url) => {
		expect(isAllowedRemoteIceUrl(url)).toBe(true);
	});

	// ベンチマーク用のアドレス (198.18.0.0/15) は、組織の中で使われていることがある
	test.each([
		['the first IPv6 benchmarking address', 'stun:[2001:2::]'],
		['the last IPv6 benchmarking address', 'turn:[2001:2:0:ffff:ffff:ffff:ffff:ffff]:3478'],
		['the first benchmarking address', 'stun:198.18.0.0'],
		['a benchmarking address', 'turn:198.18.0.1:3478?transport=tcp'],
		['the last benchmarking address', 'stun:198.19.255.255'],
		['an IPv4-mapped benchmarking address', 'stun:[::ffff:198.19.0.1]'],
	])('refuses a url with %s', (_label, url) => {
		expect(isAllowedRemoteIceUrl(url)).toBe(false);
	});

	test.each([
		['the address just before the IPv6 benchmarking block', 'stun:[2001:1:ffff:ffff:ffff:ffff:ffff:ffff]'],
		['the address just after the IPv6 benchmarking block', 'stun:[2001:2:1::]'],
		['a documentation address', 'stun:[2001:db8::1]'],
		['the address just before the benchmarking block', 'stun:198.17.255.255'],
		['the address just after the benchmarking block', 'stun:198.20.0.0'],
	])('accepts a url with %s', (_label, url) => {
		expect(isAllowedRemoteIceUrl(url)).toBe(true);
	});

	// IPv4 アドレスを埋め込む IPv6 アドレスは、埋め込まれた IPv4 アドレスで決める。
	// ネットワークの中で使う NAT64 (64:ff9b:1::/48) は、ネットワークが選ぶ長さ (RFC 6052 の /48、/56、/64、/96) のどれで読んでも
	// 手元のアドレスにならないものだけを受け付ける
	test.each([
		['a local-use NAT64 address of a private address (/96)', 'stun:[64:ff9b:1::a00:1]'],
		['a local-use NAT64 address of a private address (/48)', 'stun:[64:ff9b:1:a00:1:100::]'],
		['a local-use NAT64 address of a loopback address (/64)', 'stun:[64:ff9b:1:0:7f:0:100::]'],
		['a local-use NAT64 address of a private address (/56)', 'stun:[64:ff9b:1:a:a8:c000::]'],
		['a 6to4 address of a private address', 'turn:[2002:a00:1::1]:3478'],
		['a 6to4 address of a loopback address', 'stun:[2002:7f00:1::]'],
		['a 6to4 address of a benchmarking address', 'stun:[2002:c612:1::]'],
	])('refuses a url with %s', (_label, url) => {
		expect(isAllowedRemoteIceUrl(url)).toBe(false);
	});

	test.each([
		['a local-use NAT64 address of a public address', 'stun:[64:ff9b:1::808:808]'],
		['a 6to4 address of a public address', 'stun:[2002:808:808::1]'],
	])('accepts a url with %s', (_label, url) => {
		expect(isAllowedRemoteIceUrl(url)).toBe(true);
	});

	// 同じネットワークの機器の名前になりうるもの
	test.each([
		['a name of one label', 'stun:router:3478'],
		['a name of one label with a trailing dot', 'stun:nas.'],
		['a name under .local (mDNS)', 'stun:printer.local:3478'],
		['a name under .local with a trailing dot', 'turn:printer.LOCAL.:3478'],
		['localhost.localdomain', 'stun:localhost.localdomain'],
		['ip6-localhost', 'stun:ip6-localhost'],
		['ip6-loopback', 'stun:ip6-loopback:3478'],
		['a name under home.arpa', 'stun:nas.home.arpa'],
		['a name under .internal', 'stun:turn.corp.internal'],
	])('refuses a url with %s', (_label, url) => {
		expect(isAllowedRemoteIceUrl(url)).toBe(false);
	});

	test.each([
		['a name that only ends like local', 'stun:stun.notlocal'],
		['a name with local as its first label', 'stun:local.example'],
		['a name with localdomain elsewhere', 'stun:localdomain.example'],
	])('accepts a url with %s', (_label, url) => {
		expect(isAllowedRemoteIceUrl(url)).toBe(true);
	});

	test.each([
		['a value that is not a string', 1],
		['a url that is not STUN or TURN', 'https://turn.example'],
		['STUNS, which browsers do not support', 'stuns:stun.example:3478'],
		['port 53', 'stun:stun.example:53'],
		['port 53 written with a leading zero', 'turns:[2001:db8::1]:053'],
		['a control character', 'stun:stun.example\u0000:3478'],
		['non-ASCII characters', 'stun:例え.example:3478'],
	])('refuses %s', (_label, url) => {
		expect(isAllowedRemoteIceUrl(url)).toBe(false);
	});
});
