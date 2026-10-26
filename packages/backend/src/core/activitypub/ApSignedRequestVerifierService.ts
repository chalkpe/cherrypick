/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as crypto from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import httpSignature from '@peertube/http-signature';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { UserPublickeysRepository, UsersRepository } from '@/models/_.js';
import type { MiRemoteUser } from '@/models/User.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';

const REQUIRED_SIGNED_HEADERS = ['(request-target)', 'host', 'date', 'digest'];
const CLOCK_SKEW_MS = 300 * 1000;
// user_publickey.keyId は varchar(256)。これより長い keyId は DB に無いので引かない。
// ヘッダーの値は 1 バイトを 1 文字として読むので、length が 256 を超えれば DB のどの keyId とも一致しない
const MAX_KEY_ID_LENGTH = 256;

/** 拒否したときに記録する、通らなかった検査の名前 */
type FailedCheck = 'signature header' | 'host' | 'date' | 'digest' | 'keyId length' | 'key lookup' | 'key owner' | 'signature';

/**
 * 他サーバーからの HTTP 署名付きリクエストをその場で検証する。
 * inbox はキューで非同期に検証するが、こちらは応答を返す前に送信者を確定させたい経路で使う。
 */
@Injectable()
export class ApSignedRequestVerifierService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.userPublickeysRepository)
		private userPublickeysRepository: UserPublickeysRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('ap-signed-request');
	}

	/**
	 * 署名・host・date・digest がすべて正しく、署名鍵を DB で知っていればその鍵の持ち主を返す。
	 * 鍵をリモートから取りには行かない。どの検査に失敗しても null を返す (DB の障害はそのまま投げる)。
	 * 失敗したときは、どの検査で落ちたかを debug で記録する
	 */
	@bindThis
	public async verify(request: { method: string; url: string; headers: IncomingHttpHeaders }, rawBody: string): Promise<MiRemoteUser | null> {
		let signature: httpSignature.IParsedSignature;
		try {
			// parseRequest が読むのは method / url / headers だけで、request-line (古い草案) に要る HTTP のバージョンは渡さない。
			// strict にして、request-line を署名に含めた要求はここで断る
			signature = httpSignature.parseRequest(request as IncomingMessage, { headers: REQUIRED_SIGNED_HEADERS, authorizationHeaderName: 'signature', strict: true });
		} catch {
			return this.reject('signature header');
		}
		const keyId = signature.keyId;

		if (request.headers.host !== this.config.host) return this.reject('host', keyId);

		// parseRequest は x-date があればそちらで時刻のずれを測り、解釈できない date は素通しする。
		// 署名に含まれる date で測り直す。
		const date = Date.parse(request.headers.date ?? '');
		if (Number.isNaN(date) || Math.abs(Date.now() - date) > CLOCK_SKEW_MS) return this.reject('date', keyId);

		if (!this.digestMatches(request.headers.digest, rawBody)) return this.reject('digest', keyId);

		if (keyId.length > MAX_KEY_ID_LENGTH) return this.reject('keyId length', keyId);

		// ApDbResolverService の鍵キャッシュ (12 時間、鍵の更新で消えない) は使わない。
		// 鍵が差し替わった直後から古い鍵を拒否し、未知の keyId でメモリを増やさないため。
		const key = await this.userPublickeysRepository.findOneBy({ keyId });
		if (key == null) return this.reject('key lookup', keyId);

		// 他のサーバーのユーザーの鍵だけを受け入れる
		const user = await this.usersRepository.findOneBy({ id: key.userId });
		if (user == null || user.isDeleted || user.host == null) return this.reject('key owner', keyId);

		try {
			if (!httpSignature.verifySignature(signature, key.keyPem)) return this.reject('signature', keyId);
		} catch {
			return this.reject('signature', keyId);
		}

		return user as MiRemoteUser;
	}

	@bindThis
	private digestMatches(digest: string | string[] | undefined, rawBody: string): boolean {
		if (typeof digest !== 'string') return false;

		const match = digest.match(/^([a-zA-Z0-9\-]+)=(.+)$/);
		if (match == null) return false;
		if (match[1].toUpperCase() !== 'SHA-256') return false;

		return crypto.createHash('sha256').update(rawBody).digest('base64') === match[2];
	}

	/**
	 * 通らなかった検査の名前を debug で記録して null を返す。
	 * keyId はホストだけを残す (パスや署名、本文は記録しない)。長すぎる keyId はホストも読まない
	 */
	@bindThis
	private reject(check: FailedCheck, keyId?: string): null {
		const host = keyId != null ? keyHostOf(keyId) : null;
		this.logger.debug(`Rejected a signed request at the "${check}" check${host != null ? ` (key host: ${host})` : ''}`);
		return null;
	}
}

function keyHostOf(keyId: string): string | null {
	if (keyId.length > MAX_KEY_ID_LENGTH) return null;
	try {
		return new URL(keyId).host || null;
	} catch {
		return null;
	}
}
