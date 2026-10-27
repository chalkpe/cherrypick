/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { ChatRoomsRepository, ChatRoomMembershipsRepository } from '@/models/_.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { isInstanceMuted, isUserFromMutedInstance } from '@/misc/is-instance-muted.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { bindThis } from '@/decorators.js';
import type { JsonObject } from '@/misc/json-value.js';
import type { MainEventTypes, EventTypesToEventPayload } from '@/core/GlobalEventService.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';

@Injectable({ scope: Scope.TRANSIENT })
export class MainChannel extends Channel {
	public readonly chName = 'main';
	public static shouldShare = true;
	public static requireCredential = true as const;
	public static kind = 'read:account';
	private disposed = false;
	private voiceRooms = new Map<string, { version: number; listener: (event: GlobalEvents['chatRoom']['payload']) => void }>();

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		private noteEntityService: NoteEntityService,
		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,
		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,
		private chatVoiceService: ChatVoiceService,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject): Promise<boolean> {
		if (!this.user) return false;

		this.subscriber.on(`mainStream:${this.user.id}`, this.onData);
		return true;
	}

	@bindThis
	private async onData(data: EventTypesToEventPayload<MainEventTypes>) {
		if (this.disposed) return;
		switch (data.type) {
			case 'chatRoomVoiceState': {
				const roomId = data.body.roomId;
				let guard = this.voiceRooms.get(roomId);
				if (guard == null) {
					guard = { version: 0, listener: event => {
						if (event.type === 'roomDeleted' || (event.type === 'membershipEnded' && event.body.userId === this.user!.id)) guard!.version++;
					} };
					this.voiceRooms.set(roomId, guard);
					this.subscriber.on(`chatRoomStream:${roomId}`, guard.listener);
				}
				const version = guard.version;
				try {
					// モデレーターのタイムライン閲覧権限とは別に、毎回いまの所有・参加を確かめる。
					const [room, member] = await Promise.all([
						this.chatRoomsRepository.findOne({ where: { id: roomId }, relations: { owner: true } }),
						this.chatRoomMembershipsRepository.exists({ where: { roomId, userId: this.user!.id } }),
					]);
					if (room == null || (room.ownerId !== this.user!.id && !member)) return;
					const visible = await this.chatVoiceService.isRoomVoiceVisible(room, data.body.participants.length > 0 ? data.body.updatedAt : undefined);
					if (this.disposed || version !== guard.version) return;
					if (!visible) data = { ...data, body: { ...data.body, participants: [] } };
				} catch {
					return;
				}
				break;
			}
			case 'notification': {
				// Ignore notifications from instances the user has muted
				if (isUserFromMutedInstance(data.body, this.userMutedInstances)) return;
				if (data.body.userId && this.userIdsWhoMeMuting.has(data.body.userId)) return;

				if (data.body.note && data.body.note.isHidden) {
					const note = await this.noteEntityService.pack(data.body.note.id, this.user, {
						detail: true,
					});
					data.body.note = note;
				}
				break;
			}
			case 'mention': {
				if (isInstanceMuted(data.body, this.userMutedInstances)) return;
				if (!this.isNoteVisibleForMe(data.body)) return;
				if (this.isNoteMutedOrBlocked(data.body)) return;
				if (data.body.isHidden) {
					const note = await this.noteEntityService.pack(data.body.id, this.user, {
						detail: true,
					});
					data.body = note;
				}
				break;
			}
		}

		this.send(data.type, data.body);
	}

	@bindThis
	public dispose() {
		this.disposed = true;
		for (const [roomId, guard] of this.voiceRooms) this.subscriber.off(`chatRoomStream:${roomId}`, guard.listener);
		this.voiceRooms.clear();
		this.subscriber.off(`mainStream:${this.user?.id}`, this.onData);
	}
}
