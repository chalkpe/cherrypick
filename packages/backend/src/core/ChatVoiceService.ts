/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { WebhookEvent } from 'livekit-server-sdk';
import { DI } from '@/di-symbols.js';
import type { ChatRoomMembershipsRepository, ChatRoomsRepository } from '@/models/_.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { MiLocalUser, MiUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { bindThis } from '@/decorators.js';
import { MAX_ROOM_MEMBERS } from '@/core/ChatService.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';

const REFRESH_DELAY_MS = 500;

// 参加者の出入りや画面共有の開始・終了に関わるイベントだけを扱う
const REFRESH_EVENTS = new Set([
	'room_started',
	'room_finished',
	'participant_joined',
	'participant_left',
	'participant_connection_aborted',
	'track_published',
	'track_unpublished',
]);

type VoiceSnapshot = {
	participants: { identity: string; userId: MiUser['id']; screenSharing: boolean }[];
	updatedAt: number;
};

/**
 * チャットルームの通話参加者のスナップショットを Redis に保持し、ストリームへ配信する。
 */
@Injectable()
export class ChatVoiceService implements OnApplicationShutdown {
	private pendingRefreshes = new Map<MiChatRoom['id'], NodeJS.Timeout>();

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		private liveKitService: LiveKitService,
		private userEntityService: UserEntityService,
		private globalEventService: GlobalEventService,
	) {
	}

	@bindThis
	public async issueJoinToken(me: MiLocalUser, room: MiChatRoom, canScreenShare: boolean): Promise<{ url: string; token: string }> {
		await this.liveKitService.ensureRoom(room.id, MAX_ROOM_MEMBERS + 1);
		const token = await this.liveKitService.createJoinToken({
			roomId: room.id,
			identity: this.liveKitService.identityOf(me),
			userId: me.id,
			canScreenShare,
		});
		return { url: this.liveKitService.getPublicUrl(), token };
	}

	@bindThis
	public async getStates(me: { id: MiUser['id'] }, roomIds: MiChatRoom['id'][]): Promise<Packed<'ChatRoomVoiceState'>[]> {
		if (roomIds.length === 0) return [];
		const raws = await this.redisClient.mget(...roomIds.map(roomId => this.keyOf(roomId)));
		const states: Packed<'ChatRoomVoiceState'>[] = [];
		for (let i = 0; i < roomIds.length; i++) {
			const raw = raws[i];
			if (raw == null) continue;
			const snapshot = JSON.parse(raw) as VoiceSnapshot;
			if (snapshot.participants.length === 0) continue;
			states.push(await this.pack(roomIds[i], snapshot, me));
		}
		return states;
	}

	@bindThis
	public handleWebhook(event: WebhookEvent): void {
		if (!REFRESH_EVENTS.has(event.event)) return;
		const roomName = event.room?.name;
		if (roomName == null) return;
		const roomId = this.liveKitService.roomIdOf(roomName);
		if (roomId == null) return;
		this.scheduleRefresh(roomId);
	}

	@bindThis
	public scheduleRefresh(roomId: MiChatRoom['id']): void {
		if (this.pendingRefreshes.has(roomId)) return;
		this.pendingRefreshes.set(roomId, setTimeout(() => {
			this.pendingRefreshes.delete(roomId);
			this.refresh(roomId).catch(() => {
				// 次の webhook か通話参加時に再取得されるので握りつぶす
			});
		}, REFRESH_DELAY_MS));
	}

	@bindThis
	public async refresh(roomId: MiChatRoom['id']): Promise<void> {
		const participants = await this.liveKitService.listParticipants(roomId);
		const snapshot: VoiceSnapshot = {
			participants: participants.map(p => ({ identity: p.identity, userId: p.userId, screenSharing: p.screenSharing })),
			updatedAt: Date.now(),
		};

		if (snapshot.participants.length === 0) {
			await this.redisClient.del(this.keyOf(roomId));
		} else {
			await this.redisClient.set(this.keyOf(roomId), JSON.stringify(snapshot));
		}

		const packed = await this.pack(roomId, snapshot, null);
		this.globalEventService.publishChatRoomStream(roomId, 'voiceState', packed);

		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room == null) return;
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId });
		const memberIds = new Set([room.ownerId, ...memberships.map(m => m.userId)]);
		for (const userId of memberIds) {
			this.globalEventService.publishMainStream(userId, 'chatRoomVoiceState', packed);
		}
	}

	@bindThis
	public onApplicationShutdown(): void {
		for (const timer of this.pendingRefreshes.values()) clearTimeout(timer);
		this.pendingRefreshes.clear();
	}

	private keyOf(roomId: MiChatRoom['id']): string {
		return `chatVoice:${roomId}`;
	}

	private async pack(roomId: MiChatRoom['id'], snapshot: VoiceSnapshot, me: { id: MiUser['id'] } | null): Promise<Packed<'ChatRoomVoiceState'>> {
		const users = await this.userEntityService.packMany(snapshot.participants.map(p => p.userId), me);
		const usersById = new Map(users.map(user => [user.id, user]));
		const participants: Packed<'ChatRoomVoiceState'>['participants'] = [];
		for (const p of snapshot.participants) {
			const user = usersById.get(p.userId);
			if (user == null) continue;
			participants.push({ identity: p.identity, user, screenSharing: p.screenSharing });
		}
		return { roomId, participants };
	}
}
