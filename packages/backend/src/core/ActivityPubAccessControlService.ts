/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { URL, domainToASCII } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import httpSignature from '@peertube/http-signature';
import { DI } from '@/di-symbols.js';
import type { InstancesRepository, MiMeta } from '@/models/_.js';
import { UtilityService } from '@/core/UtilityService.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';
import { LoggerService } from '@/core/LoggerService.js';
import type { MiNote } from '@/models/Note.js';
import type { FastifyRequest } from 'fastify';

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
/**
 * インスタンス行の照合に使うホスト表記の候補を返す。
 *
 * `instance.host` は `host` のこともあれば `host:port` のこともあり、
 * 末尾ドット付きで保存されている場合もある。正規化したホスト名だけでなく、
 * ポートを保持した表記と末尾ドットを除いた表記も返し、呼び出し側で
 * いずれかの行が隔離されていれば拒否できるようにする。
 */
export function hostLookupCandidates(host: string | null | undefined): string[] {
	const candidates = new Set<string>();

	const normalized = normalizeHost(host);
	if (normalized != null) {
		candidates.add(normalized);
		// `instance.host` may have been stored with a trailing FQDN dot even
		// when the requester uses the dotless spelling.
		candidates.add(`${normalized}.`);
	}

	const trimmed = host?.trim().toLowerCase();
	if (trimmed != null && trimmed.length > 0) {
		candidates.add(trimmed);
		const stripped = trimmed.replace(/\.+(?=:\d+$|$)/, '');
		candidates.add(stripped);

		// Also cover a dotted row stored with the same port.
		const withPort = stripped.match(/^([^:]+)(:\d+)$/);
		if (withPort != null) {
			candidates.add(`${withPort[1]}.${withPort[2]}`);
		}
	}

	return [...candidates].filter(candidate => candidate.length > 0);
}

export function isHostInList(hosts: string[] | undefined, host: string | null): boolean {
	const normalizedHost = normalizeHost(host);
	if (normalizedHost == null) return false;

	return (hosts ?? []).some(entry => {
		const normalizedEntry = normalizeHost(entry);
		if (normalizedEntry == null) return false;
		return normalizedHost === normalizedEntry || normalizedHost.endsWith(`.${normalizedEntry}`);
	});
}

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

@Injectable()
export class ActivityPubAccessControlService {
	private logger: Logger;

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private utilityService: UtilityService,
		private loggerService: LoggerService,
		private apDbResolverService: ApDbResolverService,
	) {
		this.logger = this.loggerService.getLogger('ap-access-control');
	}

	/**
	 * リクエスト元ホストを HTTP Signature から解決する。
	 *
	 * - `Signature` / `Authorization: Signature` ヘッダーが無い場合は `null`（ホスト不明）
	 * - 署名を検証できない場合（鍵が未知、署名不正、actor と keyId のホスト不一致）も `null`
	 *
	 * 鍵は DB に既知のものだけを使い、リモートへの追加フェッチは行わない。
	 * `User-Agent` は攻撃者が自由に設定できるため、セキュリティ上の識別子としては一切使わない。
	 */
	@bindThis
	public async resolveRemoteHostFromRequest(request: FastifyRequest): Promise<string | null> {
		const signatureHeader = request.headers['signature'] ?? request.headers['authorization'];
		if (typeof signatureHeader !== 'string') {
			return null;
		}

		let signature: httpSignature.IParsedSignature;
		try {
			signature = httpSignature.parseRequest(request.raw, {
				headers: ['(request-target)', 'date', 'host'],
				authorizationHeaderName: 'signature',
			});
		} catch (err) {
			this.logger.debug(`Failed to parse HTTP Signature: ${err instanceof Error ? err.message : err}`);
			return null;
		}

		const keyHost = this.extractHostFromKeyId(signature.keyId);
		if (keyHost == null) {
			this.logger.debug(`Invalid signature keyId: ${signature.keyId}`);
			return null;
		}

		let authUser: Awaited<ReturnType<ApDbResolverService['getAuthUserFromKeyId']>>;
		try {
			authUser = await this.apDbResolverService.getAuthUserFromKeyId(signature.keyId);
		} catch (err) {
			this.logger.debug(`Failed to resolve signature keyId ${signature.keyId}: ${err instanceof Error ? err.message : err}`);
			return null;
		}

		if (authUser == null) {
			this.logger.debug(`Unknown signature keyId: ${signature.keyId}`);
			return null;
		}

		let verified = false;
		try {
			verified = httpSignature.verifySignature(signature, authUser.key.keyPem);
		} catch (err) {
			this.logger.debug(`Failed to verify HTTP Signature for ${signature.keyId}: ${err instanceof Error ? err.message : err}`);
			return null;
		}

		if (!verified) {
			this.logger.debug(`Invalid HTTP Signature for ${signature.keyId}`);
			return null;
		}

		let actorUriHost: string;
		try {
			actorUriHost = this.utilityService.punyHost(authUser.user.uri);
		} catch {
			this.logger.debug(`Signature keyId ${signature.keyId} resolved to an actor without a valid URI`);
			return null;
		}

		// 鍵は actor と同じホストで公開されている必要がある。
		// 別ホストの鍵で actor を名乗れると、include/exclude のホスト判定を迂回できてしまう。
		// ポートは配信対象の比較と同様に無視する。
		const actorHost = normalizeHost(actorUriHost);
		if (actorHost == null || actorHost !== keyHost) {
			this.logger.debug(`Signature keyId host (${keyHost}) does not match actor host (${actorHost})`);
			return null;
		}

		// 呼び出し側が `instance.host` の `host:port` 表記も照合できるよう、
		// 正規化前のホストを返す。配信対象の比較では改めて正規化される。
		return actorUriHost;
	}

	@bindThis
	public extractHostFromKeyId(keyId: string): string | null {
		try {
			const url = new URL(keyId);
			if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
			if (url.username !== '' || url.password !== '') return null;
			if (url.hostname.length === 0) return null;
			return normalizeHost(url.host);
		} catch {
			return null;
		}
	}

	/**
	 * ノートの配信対象制御を評価する。
	 *
	 * `deliveryTargets` が設定されているノートは、リクエスト元ホストが検証できなければ
	 * 常に拒否する（fail closed）。`remoteHost` には署名検証済みのホストのみを渡すこと。
	 */
	@bindThis
	public checkNoteAccess(note: Pick<MiNote, 'id' | 'deliveryTargets'>, remoteHost: string | null): boolean {
		const deliveryTargets = note.deliveryTargets;

		if (deliveryTargets == null || !Array.isArray(deliveryTargets.hosts)) {
			return true;
		}

		const host = remoteHost == null ? null : normalizeHost(remoteHost);

		if (remoteHost != null && host == null) {
			this.logger.info(`Access to note ${note.id} denied: invalid requester host`);
			return false;
		}

		if (host != null && this.utilityService.isSelfHost(host)) {
			return true;
		}

		if (host == null) {
			this.logger.info(`Access to note ${note.id} denied: requester host is unknown`);
			return false;
		}

		const targets: string[] = [];
		for (const target of deliveryTargets.hosts) {
			const normalizedTarget = normalizeHost(target);
			if (normalizedTarget == null) {
				this.logger.info(`Access to note ${note.id} denied: invalid delivery target`);
				return false;
			}
			targets.push(normalizedTarget);
		}

		if (deliveryTargets.mode === 'include') {
			if (!targets.includes(host)) {
				this.logger.info(`Access to note ${note.id} denied for ${host} (not in include list)`);
				return false;
			}
		} else if (deliveryTargets.mode === 'exclude') {
			if (targets.includes(host)) {
				this.logger.info(`Access to note ${note.id} denied for ${host} (in exclude list)`);
				return false;
			}
		} else {
			this.logger.info(`Access to note ${note.id} denied: unknown delivery target mode`);
			return false;
		}

		return true;
	}

	/**
	 * リモートインスタンスのアクセス制限設定をチェック
	 */
	@bindThis
	private async checkInstanceRestrictions(host: string, rawHost?: string): Promise<{
		isBlocked: boolean;
		isSilenced: boolean;
		isQuarantined: boolean;
		reason?: string;
	}> {
		// Policy entries are normalized too, so `blocked.example:8443`,
		// `blocked.example.`, mixed case, and Unicode entries match the
		// normalized requester host.
		const isBlocked = isHostInList(this.meta.blockedHosts, host);
		if (isBlocked) {
			return { isBlocked: true, isSilenced: false, isQuarantined: false, reason: 'blocked' };
		}

		const isSilenced = isHostInList(this.meta.silencedHosts, host);

		// Instance rows may be stored with a port or a trailing dot. Check every
		// candidate separately so a non-quarantined row cannot shadow a
		// quarantined one.
		let isQuarantined = false;
		for (const candidate of hostLookupCandidates(rawHost ?? host)) {
			const instance = await this.instancesRepository.findOneBy({ host: candidate });
			if (instance?.quarantineLimited) {
				isQuarantined = true;
				break;
			}
		}

		return {
			isBlocked: false,
			isSilenced,
			isQuarantined,
			reason: isQuarantined ? 'quarantined' : isSilenced ? 'silenced' : undefined,
		};
	}

	/**
	 * ActivityPubリクエストのアクセス制御を行います
	 * @param request FastifyRequest
	 * @returns アクセス許可の場合はnull、拒否の場合は理由を含むオブジェクト
	 */
	@bindThis
	public async checkAccess(request: FastifyRequest, allowLimitedHosts = false): Promise<{
		blocked: boolean;
		reason: string;
		host?: string;
	} | null> {
		// User-Agent は攻撃者が制御できるため使わない。署名が無い／検証できない場合は
		// 「ホスト不明」として扱い、公開コンテンツの GET は従来どおり許可する。
		const remoteHost = await this.resolveRemoteHostFromRequest(request);
		return await this.checkHostAccess(remoteHost, allowLimitedHosts);
	}

	/**
	 * 指定されたホストに対してインスタンス制限を評価する。
	 *
	 * ポリシー:
	 * - 署名なし / 署名検証失敗（ホスト不明）: 公開コンテンツの GET は許可する。
	 *   署名しないブラウザや ActivityPub クライアントを壊さないため。ただし
	 *   `deliveryTargets` 付きノートは `checkNoteAccess` が fail closed で拒否する。
	 * - 署名検証済み: ブロック・隔離は常に拒否。サイレンスは `allowLimitedHosts`
	 *   が true のルート（inbox など）でのみ許可する。
	 *
	 * 残存リスク: ブロック済みホストが「完全に匿名」で公開コンテンツを取得することは
	 * IP / User-Agent では安全に識別できないため防げない。inbox は必ず署名を要求するので
	 * ブロックできる。
	 */
	@bindThis
	public async checkHostAccess(remoteHost: string | null, allowLimitedHosts = false): Promise<{
		blocked: boolean;
		reason: string;
		host?: string;
	} | null> {
		if (remoteHost == null) {
			// リモートホストが特定できない場合はアクセスを許可
			// (通常のブラウザーやその他のクライアントからのアクセス)
			return null;
		}

		const host = normalizeHost(remoteHost);
		if (host == null) {
			this.logger.info(`ActivityPub access denied: invalid remote host ${remoteHost}`);
			return {
				blocked: true,
				reason: 'invalid-host',
				host: remoteHost,
			};
		}

		if (this.utilityService.isSelfHost(host)) {
			return null;
		}

		// インスタンス制限をチェック
		const restrictions = await this.checkInstanceRestrictions(host, remoteHost);

		// isBlocked と isQuarantined は常に拒否。
		// isSilenced は allowLimitedHosts が true の場合のみ許可。
		const shouldDeny = restrictions.isBlocked || restrictions.isQuarantined || (!allowLimitedHosts && restrictions.isSilenced);
		if (shouldDeny) {
			this.logger.info(`ActivityPub access denied from ${host}: ${restrictions.reason}`, {
				host,
				reason: restrictions.reason,
			});

			return {
				blocked: true,
				reason: restrictions.reason ?? 'restricted',
				host,
			};
		}

		// デバッグ用：許可されたアクセスもログ出力（verbose level）
		this.logger.debug(`ActivityPub access allowed from ${host}`, {
			host,
		});

		// アクセス許可
		return null;
	}
}
