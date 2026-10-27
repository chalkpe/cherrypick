/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { MiMeta } from '@/models/Meta.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';
import { StatusError } from '@/misc/status-error.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { BLOCKED_ICE_PORT, ICE_SERVER_URL, isAllowedRemoteIceUrl } from '@/misc/ice-server-url.js';

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
const TURN_URL = /^turns?:/;

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
 * 資格情報の無い TURN と同じ項目にある STUN は、資格情報を付けずに一つの項目にまとめ (MAX_ICE_SERVER_URLS まで)、
 * そのまま使える項目 (資格情報のある TURN や STUN だけの項目) を先に並べたうえで、上限に空きがあれば最後に置く
 */
function iceServersFromCloudflare(body: unknown): IceServer[] | null {
	if (typeof body !== 'object' || body == null) return null;
	const { iceServers } = body as Record<string, unknown>;
	const entries: unknown[] = Array.isArray(iceServers) ? iceServers : iceServers != null ? [iceServers] : [];

	const result: IceServer[] = [];
	const splitStun = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== 'object' || entry == null) continue;
		const { urls, username, credential } = entry as Record<string, unknown>;
		if (!isValidCredential(username) || !isValidCredential(credential)) continue;

		const list: unknown[] = Array.isArray(urls) ? urls : [urls];
		const usable = list
			.filter((url): url is string => typeof url === 'string' && ICE_SERVER_URL.test(url) && portOf(url) !== BLOCKED_ICE_PORT)
			.slice(0, MAX_ICE_SERVER_URLS);
		if (usable.length === 0) continue;
		if (hasCredentialsFor(usable, username, credential)) {
			if (result.length < MAX_ICE_SERVERS) result.push(iceServerOf(usable, username, credential));
		} else {
			// ブラウザは資格情報の無い TURN を受け付けず、接続ごと失敗する。STUN は資格情報を使わないので残す
			for (const url of usable) {
				if (!TURN_URL.test(url)) splitStun.add(url);
			}
		}
	}

	if (splitStun.size > 0 && result.length < MAX_ICE_SERVERS) {
		result.push({ urls: [...splitStun].slice(0, MAX_ICE_SERVER_URLS) });
	}

	return result.length > 0 ? result : null;
}

/**
 * 他のサーバーから届いた ICE サーバーを確かめる。どこかがおかしければ全体を null にする (通話への参加は止めない)。
 * ブラウザが受け付けないもの (資格情報の無い TURN、53 番ポート、表示できる ASCII 以外の文字) もおかしいものとして扱う。
 * ユーザーのブラウザが接続しに行くので、ユーザーの手元や同じネットワークの機器を指す URL (isAllowedRemoteIceUrl) も断る。
 * 空の配列も null にする (追加の ICE サーバーが無いことを表し、frontend は LiveKit が渡すものを使う)
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
