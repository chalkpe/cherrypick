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

const ROOM_NAME_PREFIX = 'chatRoom:';

export type LiveKitParticipant = {
	identity: string;
	userId: MiUser['id'];
	screenSharing: boolean;
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
		for (const participant of participants) {
			const userId = parseUserId(participant.metadata);
			if (userId == null) continue;
			result.push({
				identity: participant.identity,
				userId,
				screenSharing: participant.tracks.some(track => track.source === TrackSource.SCREEN_SHARE),
				micTrackSid: participant.tracks.find(track => track.source === TrackSource.MICROPHONE)?.sid ?? null,
			});
		}
		return result;
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
		await this.requireRoomService().mutePublishedTrack(this.roomNameOf(roomId), identity, participant.micTrackSid, true);
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

function parseUserId(metadata: string | undefined): string | null {
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
