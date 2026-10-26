/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { MiMeta } from '@/models/Meta.js';
import type { InstancesRepository } from '@/models/_.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { bindThis } from '@/decorators.js';
import { StatusError } from '@/misc/status-error.js';
import { MAX_ROOM_MEMBERS } from '@/core/ChatService.js';
import { ChatVoiceService, isRemoteVoiceCallEnabled } from '@/core/ChatVoiceService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { hostLookupCandidates, isHostInList } from '@/core/ActivityPubAccessControlService.js';
import { ApRequestService } from '@/core/activitypub/ApRequestService.js';

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_RESPONSE_SIZE_LIMIT = 64 * 1024;

// 通話に対応していないサーバーには、しばらく問い合わせない
const UNSUPPORTED_HOST_TTL_SECONDS = 3600;

/**
 * 他のサーバーの通話に入れなかった理由。
 * - unsupported: そのサーバーでは通話が使えない (404)
 * - forbidden: そのサーバーかこのサーバーが参加を断った
 * - unreachable: そのサーバーに届かない、または応答がおかしい
 */
export class RemoteVoiceCallError extends Error {
	constructor(public reason: 'unsupported' | 'forbidden' | 'unreachable') {
		super(`Cannot join the voice call on the remote host: ${reason}`);
		this.name = 'RemoteVoiceCallError';
	}
}

type TokenResponse = {
	url: string;
	token: string;
	participants: { identity: string; screenSharing: boolean }[];
	updatedAt: number;
};

/**
 * 他のサーバーが持つルーム (ミラー) の通話に、このサーバーのユーザーが入るための窓口。
 * 通話はルームの持ち主のサーバーで開かれるので、そのサーバーにユーザーの鍵で署名してトークンを求める
 */
@Injectable()
export class RemoteVoiceCallService {
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private apRequestService: ApRequestService,
		private chatVoiceService: ChatVoiceService,
		private utilityService: UtilityService,
	) {
	}

	/** このサーバーのユーザーが他のサーバーの通話に入れるか (features.remoteVoiceCall と同じ) */
	public get isEnabled(): boolean {
		return isRemoteVoiceCallEnabled(this.meta);
	}

	/**
	 * ルームの持ち主のサーバーに通話のトークンを求める。
	 * 応答に含まれる参加者の現況はこのサーバーにも保存する
	 */
	@bindThis
	public async requestJoin(me: MiLocalUser, room: MiChatRoom, owner: MiRemoteUser, canScreenShare: boolean): Promise<{ url: string; token: string }> {
		// 要求はユーザーの鍵で署名し、マイクの音声もそこへ送るので、送る前に持ち主とそのサーバーを確かめる
		const ownerUrl = await this.trustedOwnerUrlOf(owner);
		if (ownerUrl == null) throw new RemoteVoiceCallError('forbidden');

		const unsupportedKey = `chatVoice:unsupportedHost:${owner.host}`;
		if (await this.redisClient.exists(unsupportedKey)) throw new RemoteVoiceCallError('unsupported');

		const origin = ownerUrl.origin;

		let body: unknown;
		try {
			// リダイレクトを辿ると、署名した要求が別の場所に送られうるので辿らない
			body = await this.apRequestService.signedPostJson(
				me,
				`${origin}/livekit/federation/token`,
				{ room: `${origin}/chat/rooms/${room.id}`, canScreenShare },
				TOKEN_REQUEST_TIMEOUT_MS,
				{ redirect: 'manual', size: TOKEN_RESPONSE_SIZE_LIMIT },
			);
		} catch (err) {
			if (err instanceof StatusError) {
				// 404 は「通話が使えない」の意味にだけ使われる
				if (err.statusCode === 404) {
					await this.redisClient.set(unsupportedKey, '1', 'EX', UNSUPPORTED_HOST_TTL_SECONDS);
					throw new RemoteVoiceCallError('unsupported');
				}
				if (err.statusCode === 401 || err.statusCode === 403) throw new RemoteVoiceCallError('forbidden');
			}
			throw new RemoteVoiceCallError('unreachable');
		}

		const response = parseTokenResponse(body, `${origin}/livekit`);
		if (response == null) throw new RemoteVoiceCallError('unreachable');

		// 現況は一覧の表示に使うだけなので、保存を待たずに参加させ、失敗しても参加は止めない
		this.chatVoiceService.storeRemoteSnapshot(room, response.participants, response.updatedAt).catch(() => {
			// 次の参加時に届く現況で埋まるので握りつぶす
		});

		return { url: response.url, token: response.token };
	}

	/**
	 * 通話を頼んでよい持ち主なら、その URI を返す。
	 * 停止・削除された持ち主、URI のホストが host と違う持ち主、連合していないか停止されたサーバーの持ち主には null
	 */
	private async trustedOwnerUrlOf(owner: MiRemoteUser): Promise<URL | null> {
		if (owner.isSuspended || owner.isDeleted) return null;

		let ownerUrl: URL;
		try {
			ownerUrl = new URL(owner.uri);
		} catch {
			return null;
		}
		// 確かめるホストと要求を送るホストを同じにする
		if (ownerUrl.host !== owner.host) return null;

		// ブロックはドメインで指定されるので、ポートを除いた名前でも確かめる
		if (!this.utilityService.isFederationAllowedHost(ownerUrl.hostname)) return null;
		if (!this.utilityService.isFederationAllowedHost(owner.host)) return null;
		// inbox (InboxProcessorService) と同じく、ポート・末尾のドット・大文字小文字・Unicode の違いを無視して、ブロックの指定とも比べる
		if (isHostInList(this.meta.blockedHosts, owner.host)) return null;

		// 停止はそのサーバーの記録のどれかにあれば従う。キャッシュを通さず、いまの記録を見る
		for (const host of this.instanceHostsOf(owner.host)) {
			const instance = await this.instancesRepository.findOneBy({ host });
			if (instance != null && instance.suspensionState !== 'none') return null;
		}

		return ownerUrl;
	}

	/**
	 * そのサーバーの停止が記録されうる instance.host。
	 * - toPuny した host: FederatedInstanceService.fetchOrRegister、管理画面での停止、配送の停止の判定 (DeliverProcessorService) が使う記録。
	 *   domainToASCII はポート付きのホストに '' を返すので、ポート付きのサーバーはすべて '' の記録にまとめられている
	 * - hostLookupCandidates: 同じドメインの記録、末尾にドットの付いた記録、domainToASCII を使う前にポートごと保存された記録。
	 *   ActivityPub のアクセス制御と inbox が隔離を確かめるのと同じ候補 (ポートは区別しない)
	 */
	private instanceHostsOf(host: string): string[] {
		return [...new Set([this.utilityService.toPuny(host), ...hostLookupCandidates(host)])];
	}
}

/**
 * ホストの応答を確かめる。LiveKit の URL はそのホストの /livekit でなければならない
 * (ほかの場所を指されると、このサーバーのユーザーのブラウザがそこへ接続してしまう)
 */
function parseTokenResponse(body: unknown, expectedUrl: string): TokenResponse | null {
	if (typeof body !== 'object' || body == null) return null;
	const { url, token, participants, updatedAt } = body as Record<string, unknown>;

	if (url !== expectedUrl) return null;
	if (typeof token !== 'string' || token === '') return null;
	if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
	if (!Array.isArray(participants) || participants.length > MAX_ROOM_MEMBERS + 1) return null;

	const parsed: TokenResponse['participants'] = [];
	for (const participant of participants as unknown[]) {
		if (typeof participant !== 'object' || participant == null) return null;
		const { identity, screenSharing } = participant as Record<string, unknown>;
		if (typeof identity !== 'string' || typeof screenSharing !== 'boolean') return null;
		parsed.push({ identity, screenSharing });
	}

	return { url: expectedUrl, token, participants: parsed, updatedAt };
}
