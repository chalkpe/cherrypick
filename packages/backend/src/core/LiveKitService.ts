/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { AccessToken, RoomServiceClient, TrackSource, TwirpError, WebhookReceiver } from 'livekit-server-sdk';
import type { WebhookEvent } from 'livekit-server-sdk';
import { DI } from '@/di-symbols.js';
import type { Config, VoiceCallConfig } from '@/config.js';
import type { MiUser } from '@/models/User.js';
import { bindThis } from '@/decorators.js';
import { reportedVoiceStatus } from '@/core/voice-participant-status.js';

const ROOM_NAME_PREFIX = 'chatRoom:';

export type LiveKitParticipant = {
	identity: string;
	userId: MiUser['id'];
	screenSharing: boolean;
	micMuted?: boolean;
	deafened?: boolean;
	canScreenShare?: boolean;
	micTrackSid: string | null;
};

/**
 * LiveKit (SFU) との境界。トークン発行、ルーム管理、webhook 検証だけを担う。
 */
@Injectable()
export class LiveKitService {
	public readonly isEnabled: boolean;
	private readonly livekit: VoiceCallConfig['livekit'] | null;
	protected roomService: RoomServiceClient | null;

	constructor(
		@Inject(DI.config)
		private config: Config,
	) {
		this.livekit = config.voiceCall?.livekit ?? null;
		this.isEnabled = this.livekit != null;
		this.roomService = this.livekit
			? new RoomServiceClient(this.livekit.internalUrl, this.livekit.apiKey, this.livekit.apiSecret)
			: null;
	}

	@bindThis
	public getPublicUrl(): string {
		return `${this.config.url}/livekit`;
	}

	@bindThis
	public getInternalUrl(): string {
		return this.requireConfig().internalUrl;
	}

	@bindThis
	public roomNameOf(roomId: string): string {
		return `${ROOM_NAME_PREFIX}${roomId}`;
	}

	@bindThis
	public roomIdOf(roomName: string): string | null {
		if (!roomName.startsWith(ROOM_NAME_PREFIX)) return null;
		const roomId = roomName.slice(ROOM_NAME_PREFIX.length);
		return roomId.length > 0 ? roomId : null;
	}

	@bindThis
	public identityOf(user: { id: string; host: string | null; uri: string | null }): string {
		if (user.host == null) return `${this.config.url}/users/${user.id}`;
		if (user.uri == null) throw new Error('remote user without uri');
		return user.uri;
	}

	@bindThis
	public async createJoinToken(params: { roomId: string; identity: string; userId: string; canScreenShare: boolean }): Promise<string> {
		const { apiKey, apiSecret } = this.requireConfig();
		const token = new AccessToken(apiKey, apiSecret, {
			identity: params.identity,
			ttl: '10m',
			metadata: JSON.stringify({ userId: params.userId }),
		});
		token.addGrant({
			roomJoin: true,
			room: this.roomNameOf(params.roomId),
			canSubscribe: true,
			canPublish: true,
			canPublishSources: params.canScreenShare
				? [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
				: [TrackSource.MICROPHONE],
			canPublishData: false,
			canUpdateOwnMetadata: false,
		});
		return await token.toJwt();
	}

	@bindThis
	public async ensureRoom(roomId: string, maxParticipants: number): Promise<void> {
		await this.requireRoomService().createRoom({
			name: this.roomNameOf(roomId),
			emptyTimeout: 60,
			departureTimeout: 20,
			maxParticipants,
		});
	}

	@bindThis
	public async listParticipants(roomId: string): Promise<LiveKitParticipant[]> {
		let participants;
		try {
			participants = await this.requireRoomService().listParticipants(this.roomNameOf(roomId));
		} catch (err) {
			if (isNotFound(err)) return [];
			throw err;
		}

		const result: LiveKitParticipant[] = [];
		// LiveKit の一覧順は毎回変わりうる。参加した順に固定し、同じ秒なら identity で揃える。
		for (const participant of [...participants].sort((a, b) => a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : a.identity.localeCompare(b.identity))) {
			const userId = userIdOfMetadata(participant.metadata);
			if (userId == null) continue;
			const micTrack = participant.tracks.find(track => track.source === TrackSource.MICROPHONE);
			result.push({
				identity: participant.identity,
				userId,
				...reportedVoiceStatus({
					// 届いているマイクの音は、本人の「切った」という申告より優先する (話しているのに切ったと見せて、誰が話しているか隠させない)
					micMuted: micTrack?.muted === false ? false : parseReportedBoolean(participant.attributes?.['cherrypick.micMuted']),
					deafened: parseReportedBoolean(participant.attributes?.['cherrypick.deafened']),
				}),
				screenSharing: participant.tracks.some(track => track.source === TrackSource.SCREEN_SHARE),
				// 空のソース一覧は LiveKit では全ソース許可を表す。
				canScreenShare: participant.permission?.canPublish === true && (participant.permission.canPublishSources.length === 0 || participant.permission.canPublishSources.some(source => source === TrackSource.SCREEN_SHARE || source === TrackSource.SCREEN_SHARE_AUDIO)),
				micTrackSid: micTrack?.sid ?? null,
			});
		}
		return result;
	}

	/** Reported UI settings, scoped to the connected participant session. */
	@bindThis
	public async setParticipantStatus(roomId: string, identity: string, sessionId: string, status: { micMuted: boolean; deafened: boolean }): Promise<boolean> {
		const service = this.requireRoomService();
		const roomName = this.roomNameOf(roomId);
		try {
			const participant = await service.getParticipant(roomName, identity);
			if (participant.sid !== sessionId) return false;
			// LiveKit はセッションを指定して書けない (identity で書く) ので、書いた後に返るセッションでも確かめる。
			// 確かめてから書くまでに同じユーザーが入り直していれば、古いセッションの設定を新しいセッションに書いてしまっているので、
			// 書いた設定を消して (空の値は LiveKit で属性の削除) 報告の無い状態に戻し、受け付けたことにしない。
			// 消すまでのあいだに新しいセッションが報告した設定も消えうるが、どちらも二つの呼び出しのあいだだけのことで、次の報告で直る
			const updated = await service.updateParticipant(roomName, identity, {
				attributes: { 'cherrypick.micMuted': String(status.micMuted), 'cherrypick.deafened': String(status.deafened) },
			});
			if (updated.sid === sessionId) return true;
			await service.updateParticipant(roomName, identity, { attributes: { 'cherrypick.micMuted': '', 'cherrypick.deafened': '' } });
			return false;
		} catch (err) {
			if (isNotFound(err)) return false;
			throw err;
		}
	}

	@bindThis
	public async removeParticipant(roomId: string, identity: string): Promise<void> {
		if (this.roomService == null) return;
		try {
			await this.roomService.removeParticipant(this.roomNameOf(roomId), identity);
		} catch (err) {
			if (isNotFound(err)) return;
			throw err;
		}
	}

	@bindThis
	public async muteMicrophone(roomId: string, identity: string): Promise<void> {
		const participant = (await this.listParticipants(roomId)).find(p => p.identity === identity);
		if (participant?.micTrackSid == null) return;
		try {
			await this.requireRoomService().mutePublishedTrack(this.roomNameOf(roomId), identity, participant.micTrackSid, true);
			await this.requireRoomService().updateParticipant(this.roomNameOf(roomId), identity, { attributes: { 'cherrypick.micMuted': 'true' } });
		} catch (err) {
			// 一覧を読んだ後に抜けた (トラックや参加者がもう無い) なら、切るものは残っていない
			if (isNotFound(err)) return;
			throw err;
		}
	}

	@bindThis
	public async deleteRoom(roomId: string): Promise<void> {
		if (this.roomService == null) return;
		try {
			await this.roomService.deleteRoom(this.roomNameOf(roomId));
		} catch (err) {
			if (isNotFound(err)) return;
			throw err;
		}
	}

	@bindThis
	public async receiveWebhook(body: string, authHeader: string | undefined): Promise<WebhookEvent> {
		const { apiKey, apiSecret } = this.requireConfig();
		return await new WebhookReceiver(apiKey, apiSecret).receive(body, authHeader);
	}

	private requireConfig(): VoiceCallConfig['livekit'] {
		if (this.livekit == null) throw new Error('voice calls are not configured');
		return this.livekit;
	}

	private requireRoomService(): RoomServiceClient {
		if (this.roomService == null) throw new Error('voice calls are not configured');
		return this.roomService;
	}
}

function isNotFound(err: unknown): boolean {
	return err instanceof TwirpError && (err.status === 404 || err.code === 'not_found');
}

/** トークンに付けたメタデータ (createJoinToken) からユーザーの id を取り出す。このサーバーが付けたものでなければ null */
export function userIdOfMetadata(metadata: string | undefined): string | null {
	if (!metadata) return null;
	try {
		const parsed: unknown = JSON.parse(metadata);
		if (typeof parsed === 'object' && parsed != null && 'userId' in parsed && typeof parsed.userId === 'string') {
			return parsed.userId;
		}
	} catch {
		// 他のクライアントが付けたメタデータは無視する
	}
	return null;
}

function parseReportedBoolean(value: string | undefined): boolean | undefined {
	return value === 'true' ? true : value === 'false' ? false : undefined;
}
