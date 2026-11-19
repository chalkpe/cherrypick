/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ipaddr from 'ipaddr.js';
import type * as http from 'node:http';
import type { FastifyServerOptions } from 'fastify';

type TrustProxy = FastifyServerOptions['trustProxy'];

const NAMED_RANGES: Record<string, string[]> = {
	linklocal: ['169.254.0.0/16', 'fe80::/10'],
	loopback: ['127.0.0.1/8', '::1/128'],
	uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

function parseAddress(value: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
	if (!ipaddr.isValid(value)) return null;
	const parsed = ipaddr.parse(value);
	return parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress() ? (parsed as ipaddr.IPv6).toIPv4Address() : parsed;
}

function compileTrust(trustProxy: TrustProxy): (address: string, hop: number) => boolean {
	if (trustProxy == null || trustProxy === false) return () => false;
	if (trustProxy === true) return () => true;
	// fastify と同じく、ホップ数だけの設定では転送ヘッダーを信頼しない
	if (typeof trustProxy === 'number') return () => false;
	if (typeof trustProxy === 'function') return trustProxy;

	const entries = (Array.isArray(trustProxy) ? trustProxy : trustProxy.split(','))
		.map(entry => entry.trim())
		.flatMap(entry => NAMED_RANGES[entry] ?? [entry]);
	const ranges: [ipaddr.IPv4 | ipaddr.IPv6, number][] = [];
	for (const entry of entries) {
		try {
			if (entry.includes('/')) {
				ranges.push(ipaddr.parseCIDR(entry) as [ipaddr.IPv4 | ipaddr.IPv6, number]);
			} else {
				const address = parseAddress(entry);
				if (address) ranges.push([address, address.kind() === 'ipv4' ? 32 : 128]);
			}
		} catch { /* ignore an entry that is not an address */ }
	}
	return address => {
		const parsed = parseAddress(address);
		if (!parsed) return false;
		return ranges.some(([range, bits]) => range.kind() === parsed.kind() && (parsed as ipaddr.IPv4).match(range as ipaddr.IPv4, bits));
	};
}

/**
 * fastify を通らない要求 (WebSocket の upgrade など) のクライアントのアドレス。
 * fastify が request.ip を決めるのと同じく、trustProxy に合う接続元から届いた X-Forwarded-For だけを辿る。
 * 信頼する接続元が無いときは、接続元のアドレスをそのまま返す
 */
export function clientAddressOf(request: Pick<http.IncomingMessage, 'headers' | 'socket'>, trustProxy: TrustProxy): string | undefined {
	const socketAddress = request.socket?.remoteAddress;
	if (socketAddress == null) return undefined;
	const forwardedFor = request.headers['x-forwarded-for'];
	if (forwardedFor == null) return socketAddress;

	const trust = compileTrust(trustProxy);
	const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor).split(',').map(hop => hop.trim()).filter(hop => hop !== '');
	const addresses = [socketAddress, ...hops.reverse()];
	let chosen = addresses.length - 1;
	for (let i = 0; i < addresses.length - 1; i++) {
		if (!trust(addresses[i], i)) {
			chosen = i;
			break;
		}
	}
	// 辿った先がアドレスの形でなければ、そこから先は信用しない
	return parseAddress(addresses[chosen]) ? addresses[chosen] : socketAddress;
}
