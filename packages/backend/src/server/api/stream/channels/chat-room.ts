/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import type { JsonObject } from '@/misc/json-value.js';
import { ChatService } from '@/core/ChatService.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';
import type { ChatRoomsRepository, MiChatRoom } from '@/models/_.js';

@Injectable({ scope: Scope.TRANSIENT })
export class ChatRoomChannel extends Channel {
	public readonly chName = 'chatRoom';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:chat';
	private roomId: string;
	private channelId?: string;
	private room: MiChatRoom | null = null;
	private disposed = false;
	private permissionVersion = 0;
	private lastPermissionCheck = -Infinity;
	private permissionCheck?: { version: number; promise: Promise<boolean> };

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		private chatService: ChatService,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject): Promise<boolean> {
		if (typeof params.roomId !== 'string') return false;
		if (!this.user) return false;

		this.roomId = params.roomId;
		if (params.channelId != null && typeof params.channelId !== 'string') return false;
		this.channelId = params.channelId as string | undefined;

		// 初期チェック中の退出・削除も受け取り、古い判定を無効にする。
		this.subscriber.on(`chatRoomStream:${this.roomId}`, this.onEvent);
		while (!this.disposed) {
			const version = this.permissionVersion;
			const allowed = await this.checkPermission();
			// 制御イベントで古くなった判定は、最新の判定を待ち直す。
			if (version === this.permissionVersion) {
				if (!allowed || this.disposed || this.room == null) return false;
				if (this.room.hasChannels || this.channelId != null) {
					try { await this.chatService.resolveRoomChannel(this.room, this.channelId); } catch { this.dispose(); return false; }
				}
				return true;
			}
		}
		return false;
	}

	private checkPermission(): Promise<boolean> {
		if (this.disposed) return Promise.resolve(false);
		if (this.permissionCheck?.version === this.permissionVersion) return this.permissionCheck.promise;
		if (Date.now() - this.lastPermissionCheck < 60_000) return Promise.resolve(true);

		const version = this.permissionVersion;
		const checkedAt = Date.now();
		const promise = (async () => {
			try {
				const room = await this.chatRoomsRepository.findOneBy({ id: this.roomId });
				const allowed = room != null && await this.chatService.hasPermissionToViewRoomTimeline(this.user!.id, room);
				if (this.disposed || version !== this.permissionVersion) return false;
				if (!allowed) {
					this.dispose();
					return false;
				}
				this.room = room;
				this.lastPermissionCheck = checkedAt;
				return true;
			} catch {
				// EventEmitter は非同期ハンドラーの例外を処理しないため、安全側に閉じる。
				if (version === this.permissionVersion) this.dispose();
				return false;
			} finally {
				if (this.permissionCheck?.version === version) this.permissionCheck = undefined;
			}
		})();
		this.permissionCheck = { version, promise };
		return promise;
	}

	@bindThis
	private async onEvent(data: GlobalEvents['chatRoom']['payload']) {
		if (this.disposed) return;
		if (data.type === 'roomDeleted') {
			// 削除後は権限を再照会できないため、許可済みの購読へ終了通知だけを送る。
			const wasAllowed = this.lastPermissionCheck !== -Infinity;
			this.permissionVersion++;
			this.dispose();
			if (wasAllowed) this.send(data.type, data.body);
			return;
		}
		if (data.type === 'membershipEnded' && data.body.userId === this.user!.id) {
			const wasAllowed = this.lastPermissionCheck !== -Infinity;
			// 判定待ちのイベントも即座に無効化し、モデレーターの閲覧権限は再判定する。
			this.permissionVersion++;
			this.lastPermissionCheck = -Infinity;
			// Membership is already gone: send only the termination notice to an
			// authorized subscriber before rechecking access to any further content.
			if (wasAllowed) this.send(data.type, data.body);
			await this.checkPermission();
			return;
		}

		let messageChannelId: string | null | undefined;
		const permissionVersion = this.permissionVersion;
		if (data.type === 'message') {
			messageChannelId = data.body.toRoomChannelId ?? null;
		} else if (data.type === 'updated' || data.type === 'deleted' || data.type === 'react' || data.type === 'unreact') {
			const id = data.type === 'deleted' ? data.body : data.body.messageId;
			const message = await this.chatService.findMessageById(id).catch(() => null);
			if (message == null || this.disposed || permissionVersion !== this.permissionVersion) return;
			messageChannelId = message.toRoomChannelId ?? null;
		}
		// 모드 전환 통지와 수신이 경합해도 옛 구독에 다른 채널의 본문을 보내지 않는다.
		if (data.type === 'channelsUpdated' || (messageChannelId != null && !this.room?.hasChannels)) {
			this.permissionVersion++;
			this.lastPermissionCheck = -Infinity;
		}
		const version = this.permissionVersion;
		if (!(await this.checkPermission())) return;
		if (this.disposed || version !== this.permissionVersion) return;
		if (this.room?.hasChannels && messageChannelId !== undefined) {
			const selected = this.channelId ?? this.room.legacyChannelId;
			if (selected == null || messageChannelId !== selected) {
				if (data.type === 'message' && messageChannelId != null) this.send('channelMessage', { channelId: messageChannelId, messageId: data.body.id });
				return;
			}
		}
		this.send(data.type, data.body);
	}

	@bindThis
	public onMessage(type: string, body: any) {
		switch (type) {
			case 'read':
				if (this.roomId) {
					void this.chatService.readRoomChatMessage(this.user!.id, this.roomId, this.channelId).catch(() => {});
				}
				break;
		}
	}

	@bindThis
	public dispose() {
		this.disposed = true;
		this.subscriber.off(`chatRoomStream:${this.roomId}`, this.onEvent);
	}
}
