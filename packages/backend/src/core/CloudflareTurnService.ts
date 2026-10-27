/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isIPv4 } from 'node:net';
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import ipaddr from 'ipaddr.js';
import { DI } from '@/di-symbols.js';
import type { MiMeta } from '@/models/Meta.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';
import { StatusError } from '@/misc/status-error.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { LoggerService } from '@/core/LoggerService.js';

/** ブラウザの RTCIceServer に渡す形 */
export type IceServer = { urls: string[]; username?: string; credential?: string };

// 発行してもらう資格情報の寿命と、使い回す間 (寿命が半分以上残っている間)
const CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;
const REUSE_MS = 12 * 60 * 60 * 1000;

// 失敗したら、通話に参加するたびに Cloudflare を待たせないよう、しばらく問い合わせない
const FAILURE_CACHE_MS = 60_000;

const REQUEST_TIMEOUT_MS = 5000;
const RESPONSE_SIZE_LIMIT = 64 * 1024;

// 通話の参加者 (他のサーバーのユーザーを含む) に渡すものの上限。他のサーバーから届いたものもこれで確かめる
const MAX_ICE_SERVERS = 4;
const MAX_ICE_SERVER_URLS = 8;
const MAX_ICE_CREDENTIAL_LENGTH = 512;
// 制御文字や ASCII 以外の文字を含む URL はブラウザが受け付けず、接続ごと失敗するので、表示できる ASCII に限る
const ICE_SERVER_URL = /^(stun|turns?):[\x21-\x7e]{1,256}$/;
const TURN_URL = /^turns?:/;

// ブラウザは 53 番ポートへの接続を拒むので、Cloudflare が返しても渡さない
const BLOCKED_PORT = 53;

// 他のサーバーから届いた ICE サーバーでは、ユーザーの手元や同じネットワークの機器を指すアドレスを断る (ipaddr.js の range() の名前)。
// ループバック・プライベート (RFC 1918、共有アドレス 100.64/10、IPv6 のユニークローカル)・リンクローカル・未指定に加え、
// 同じネットワークに届くブロードキャストとマルチキャスト、使われなくなったサイトローカル、IPv4 に変換される ::ffff:0:0:0/96 も断る
const LOCAL_IPV4_RANGES = new Set(['unspecified', 'loopback', 'private', 'carrierGradeNat', 'linkLocal', 'broadcast', 'multicast']);
const LOCAL_IPV6_RANGES = new Set(['unspecified', 'loopback', 'uniqueLocal', 'linkLocal', 'deprecatedSiteLocal', 'multicast', 'rfc6145']);

// 名前として受け付ける形。小文字の英数字とハイフンのラベルをドットでつないだもの (末尾のドットは許す)
const HOST_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?$/;
// 最後のラベルがこの形 (10 進、または 0x で始まる 16 進) の名前は、WHATWG URL などが IPv4 アドレスとして読む
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;
// 角括弧の中に書けるもの (IPv6 アドレス)。ゾーン (%) などは読み方が分かれるので含めない
const BRACKETED_IPV6 = /^\[[0-9a-f:.]+\]$/;

type CacheEntry = {
	keyId: string;
	apiToken: string;
	iceServers: IceServer[] | null;
	expiresAt: number;
};

type PendingRequest = {
	keyId: string;
	apiToken: string;
	promise: Promise<IceServer[] | null>;
};

/**
 * 管理者が設定した Cloudflare の TURN キーで、通話の参加者に渡す短命な TURN の資格情報を発行してもらう。
 * LiveKit が NAT やファイアウォールの内側にあっても、参加者は TURN を経由して通話できる。
 * 資格情報はプロセスごとに覚えておき、寿命が半分以上残っている間は使い回す
 */
@Injectable()
export class CloudflareTurnService implements OnModuleInit, OnApplicationShutdown {
	private cache: CacheEntry | null = null;
	private pending: PendingRequest | null = null;
	private logger: Logger;

	constructor(
		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		@Inject(DI.meta)
		private meta: MiMeta,

		private httpRequestService: HttpRequestService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('cloudflare-turn');
	}

	@bindThis
	public onModuleInit(): void {
		this.redisForSub.on('message', this.onMessage);
	}

	@bindThis
	public onApplicationShutdown(): void {
		this.redisForSub.off('message', this.onMessage);
	}

	/**
	 * 通話の参加者に渡す ICE サーバー。設定されていないか、取得できなかったときは null (LiveKit が渡すものだけを使う)。
	 * 失敗しても例外は投げない
	 */
	@bindThis
	public async getIceServers(): Promise<IceServer[] | null> {
		const keyId = this.meta.voiceCallCloudflareTurnKeyId;
		const apiToken = this.meta.voiceCallCloudflareTurnApiToken;
		if (keyId == null || apiToken == null) return null;

		const cache = this.cache;
		if (cache != null && cache.keyId === keyId && cache.apiToken === apiToken && Date.now() < cache.expiresAt) {
			return cache.iceServers;
		}

		// 同時に参加した人の分はまとめて一度だけ問い合わせる
		if (this.pending != null && this.pending.keyId === keyId && this.pending.apiToken === apiToken) {
			return await this.pending.promise;
		}

		// 資格情報の寿命は Cloudflare が受け取ったときから数えられるので、使い回す間 (と失敗を覚える間) も問い合わせ始めたときから数える
		const requestedAt = Date.now();
		const pending: PendingRequest = { keyId, apiToken, promise: this.fetchIceServers(keyId, apiToken) };
		this.pending = pending;
		const iceServers = await pending.promise;

		// 問い合わせている間に設定が変わったら (clear で pending が消えている)、古い設定の結果は覚えない
		if (this.pending === pending) {
			this.pending = null;
			this.cache = {
				keyId,
				apiToken,
				iceServers,
				expiresAt: requestedAt + (iceServers != null ? REUSE_MS : FAILURE_CACHE_MS),
			};
		}

		return iceServers;
	}

	private async fetchIceServers(keyId: string, apiToken: string): Promise<IceServer[] | null> {
		let body: unknown;
		try {
			// リダイレクトを辿ると API トークンが別の場所に送られうるので辿らない
			const res = await this.httpRequestService.send(
				`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
				{
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${apiToken}`,
						'Content-Type': 'application/json',
						'Accept': 'application/json',
					},
					body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
					timeout: REQUEST_TIMEOUT_MS,
					size: RESPONSE_SIZE_LIMIT,
					redirect: 'manual',
				},
			);
			body = await res.json();
		} catch (err) {
			// エラーの内容には URL (キーの ID) やヘッダーが含まれうるので、状態コードか種類だけを残す
			const reason = err instanceof StatusError ? `HTTP ${err.statusCode}` : err instanceof Error ? err.name : 'unknown error';
			this.logger.warn(`Failed to get TURN credentials from Cloudflare: ${reason}`);
			return null;
		}

		const iceServers = iceServersFromCloudflare(body);
		if (iceServers == null) this.logger.warn('Cloudflare returned no usable TURN servers');
		return iceServers;
	}

	private clear(): void {
		this.cache = null;
		this.pending = null;
	}

	@bindThis
	private onMessage(_: string, data: string): void {
		const obj = JSON.parse(data);

		if (obj.channel === 'internal') {
			const { type, body } = obj.message as GlobalEvents['internal']['payload'];
			switch (type) {
				case 'metaUpdated': {
					// キーが変わったら、古いキーで発行してもらったもの (失敗も) を捨てる
					if (
						body.before == null ||
						body.before.voiceCallCloudflareTurnKeyId !== body.after.voiceCallCloudflareTurnKeyId ||
						body.before.voiceCallCloudflareTurnApiToken !== body.after.voiceCallCloudflareTurnApiToken
					) {
						this.clear();
					}
					break;
				}
				default:
					break;
			}
		}
	}
}

/**
 * Cloudflare の応答 ({ iceServers: [...] } または { iceServers: {...} }) から、ブラウザに渡せるものだけを取り出す。
 * STUN / TURN 以外の URL と 53 番ポートの URL を除き、資格情報の無い TURN と上限を超える分は捨てる。
 * 資格情報の無い TURN と同じ項目にある STUN は、資格情報を付けずにそれだけで一つの項目として残す
 */
function iceServersFromCloudflare(body: unknown): IceServer[] | null {
	if (typeof body !== 'object' || body == null) return null;
	const { iceServers } = body as Record<string, unknown>;
	const entries: unknown[] = Array.isArray(iceServers) ? iceServers : iceServers != null ? [iceServers] : [];

	const result: IceServer[] = [];
	for (const entry of entries) {
		if (typeof entry !== 'object' || entry == null) continue;
		const { urls, username, credential } = entry as Record<string, unknown>;
		if (!isValidCredential(username) || !isValidCredential(credential)) continue;

		const list: unknown[] = Array.isArray(urls) ? urls : [urls];
		const usable = list
			.filter((url): url is string => typeof url === 'string' && ICE_SERVER_URL.test(url) && portOf(url) !== BLOCKED_PORT)
			.slice(0, MAX_ICE_SERVER_URLS);
		if (usable.length === 0) continue;
		if (hasCredentialsFor(usable, username, credential)) {
			result.push(iceServerOf(usable, username, credential));
		} else {
			// ブラウザは資格情報の無い TURN を受け付けず、接続ごと失敗する。STUN は資格情報を使わないので残す
			const stun = usable.filter(url => !TURN_URL.test(url));
			if (stun.length === 0) continue;
			result.push({ urls: stun });
		}
		if (result.length === MAX_ICE_SERVERS) break;
	}

	return result.length > 0 ? result : null;
}

/**
 * 他のサーバーから届いた ICE サーバーを確かめる。どこかがおかしければ全体を null にする (通話への参加は止めない)。
 * ブラウザが受け付けないもの (資格情報の無い TURN、53 番ポート、表示できる ASCII 以外の文字) もおかしいものとして扱う。
 * ユーザーのブラウザが接続しに行くので、ユーザーの手元や同じネットワークの機器を指す URL (isAllowedRemoteIceUrl) も断る。
 * 空の配列も null にする (渡すと LiveKit が渡す ICE サーバーまで使われなくなる)
 */
export function parseIceServers(value: unknown): IceServer[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ICE_SERVERS) return null;

	const result: IceServer[] = [];
	for (const entry of value as unknown[]) {
		if (typeof entry !== 'object' || entry == null) return null;
		const { urls, username, credential } = entry as Record<string, unknown>;
		if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_ICE_SERVER_URLS) return null;
		if (!urls.every(isAllowedRemoteIceUrl)) return null;
		if (!isValidCredential(username) || !isValidCredential(credential)) return null;
		if (!hasCredentialsFor(urls as string[], username, credential)) return null;
		result.push(iceServerOf(urls as string[], username, credential));
	}
	return result;
}

/**
 * 他のサーバーから届いた STUN / TURN の URL として受け付けるか。
 * ホストとポートを読めて (iceHostAndPortOf)、ポートが 53 番でなく、ホストがユーザーの手元や同じネットワークの機器を指さない
 * (isLocalIceHost) ものだけを受け付ける
 */
function isAllowedRemoteIceUrl(url: unknown): boolean {
	if (typeof url !== 'string' || !ICE_SERVER_URL.test(url)) return false;
	const parsed = iceHostAndPortOf(url);
	return parsed != null && parsed.port !== BLOCKED_PORT && !isLocalIceHost(parsed.host);
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
 * - 名前は、localhost とその下の名前を断る
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
	const labels = host.replace(/\.$/, '').split('.');
	const last = labels[labels.length - 1];
	if (NUMERIC_LABEL.test(last)) {
		if (!isIPv4(host)) return true;
		return isLocalIPv4(ipaddr.IPv4.parse(host));
	}
	return last === 'localhost';
}

function isLocalIPv4(address: ipaddr.IPv4): boolean {
	return LOCAL_IPV4_RANGES.has(address.range());
}

/**
 * IPv6 アドレスが、ユーザーの手元や同じネットワークの機器を指すか。
 * IPv4 を写したアドレス (::ffff:0:0/96) と NAT64 のアドレス (64:ff9b::/96) は、埋め込まれた IPv4 アドレスで決める。
 * ::/96 (:: と ::1、使われなくなった IPv4 互換アドレス) は断る
 */
function isLocalIPv6(address: ipaddr.IPv6): boolean {
	const parts = address.parts;
	const embedded = () => new ipaddr.IPv4([parts[6] >> 8, parts[6] & 0xff, parts[7] >> 8, parts[7] & 0xff]);
	const zeroUntil = (end: number) => parts.slice(0, end).every(part => part === 0);

	if (zeroUntil(5) && parts[5] === 0xffff) return isLocalIPv4(embedded());
	if (zeroUntil(6)) return true;
	if (parts[0] === 0x64 && parts[1] === 0xff9b && parts.slice(2, 6).every(part => part === 0)) return isLocalIPv4(embedded());
	return LOCAL_IPV6_RANGES.has(address.range());
}

function isValidCredential(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === 'string' && value.length <= MAX_ICE_CREDENTIAL_LENGTH);
}

/** TURN の URL があるなら、ユーザー名と資格情報が両方とも (空でなく) ある */
function hasCredentialsFor(urls: string[], username: string | undefined, credential: string | undefined): boolean {
	if (!urls.some(url => TURN_URL.test(url))) return true;
	return username != null && username !== '' && credential != null && credential !== '';
}

/** 知っている項目だけを持つ新しいオブジェクトを作る */
function iceServerOf(urls: string[], username: string | undefined, credential: string | undefined): IceServer {
	const server: IceServer = { urls: [...urls] };
	if (username !== undefined) server.username = username;
	if (credential !== undefined) server.credential = credential;
	return server;
}

/**
 * `stun:host:port` / `turn:host:port?transport=udp` / `turn:[::1]:port` のポート。書かれていなければ null
 */
function portOf(url: string): number | null {
	const hostPort = url.slice(url.indexOf(':') + 1).split('?')[0];
	const match = /:(\d+)$/.exec(hostPort);
	return match != null ? Number(match[1]) : null;
}
