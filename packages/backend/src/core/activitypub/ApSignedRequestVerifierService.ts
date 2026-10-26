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
import type { MiRemoteUser } from '@/models/User.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { bindThis } from '@/decorators.js';

const REQUIRED_SIGNED_HEADERS = ['(request-target)', 'host', 'date', 'digest'];
const CLOCK_SKEW_MS = 300 * 1000;

/**
 * 他サーバーからの HTTP 署名付きリクエストをその場で検証する。
 * inbox はキューで非同期に検証するが、こちらは応答を返す前に送信者を確定させたい経路で使う。
 */
@Injectable()
export class ApSignedRequestVerifierService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		private apDbResolverService: ApDbResolverService,
	) {
	}

	/**
	 * 署名・host・date・digest がすべて正しく、署名鍵を DB で知っていればその鍵の持ち主を返す。
	 * 鍵をリモートから取りには行かない。どの検査に失敗しても null を返す。
	 */
	@bindThis
	public async verify(request: { method: string; url: string; headers: IncomingHttpHeaders }, rawBody: string): Promise<MiRemoteUser | null> {
		let signature: httpSignature.IParsedSignature;
		try {
			// parseRequest は method / url / headers があれば足りる (request-line を署名に含めた要求は検証で落ちる)
			signature = httpSignature.parseRequest(request as IncomingMessage, { headers: REQUIRED_SIGNED_HEADERS, authorizationHeaderName: 'signature' });
		} catch {
			return null;
		}

		if (request.headers.host !== this.config.host) return null;

		// parseRequest は x-date があればそちらで時刻のずれを測り、解釈できない date は素通しする。
		// 署名に含まれる date で測り直す。
		const date = Date.parse(request.headers.date ?? '');
		if (Number.isNaN(date) || Math.abs(Date.now() - date) > CLOCK_SKEW_MS) return null;

		if (!this.digestMatches(request.headers.digest, rawBody)) return null;

		const authUser = await this.apDbResolverService.getAuthUserFromKeyId(signature.keyId);
		if (authUser == null) return null;

		try {
			if (!httpSignature.verifySignature(signature, authUser.key.keyPem)) return null;
		} catch {
			return null;
		}

		return authUser.user;
	}

	@bindThis
	private digestMatches(digest: string | string[] | undefined, rawBody: string): boolean {
		if (typeof digest !== 'string') return false;

		const match = digest.match(/^([a-zA-Z0-9\-]+)=(.+)$/);
		if (match == null) return false;
		if (match[1].toUpperCase() !== 'SHA-256') return false;

		return crypto.createHash('sha256').update(rawBody).digest('base64') === match[2];
	}
}
