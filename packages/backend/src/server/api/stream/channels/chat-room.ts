/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import type { JsonObject, JsonValue } from '@/misc/json-value.js';
import { ChatService } from '@/core/ChatService.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';
import type { ChatRoomsRepository, MiChatRoom } from '@/models/_.js';

const READ_INTERVAL = 1000;
// 対象(ルーム・チャンネル)が違っても、1ユーザーの既読処理の間に空ける最小間隔
const USER_READ_INTERVAL = 100;
// 1ユーザーが溜められる待機中の既読の上限
const MAX_PENDING_READS = 256;

type ReadTarget = { chatService: ChatService; roomId: string; channelId?: string; id: string };
type ReadState = {
	running: boolean;
	// (ルーム, チャンネル) ごとに最後の id だけを持つ
	pending: Map<string, ReadTarget>;
	// (ルーム, チャンネル) ごとの、直前の処理が終わった時刻
	finishedAt: Map<string, number>;
	// ユーザー単位で直前の処理が終わった時刻
	lastFinishedAt: number;
	timer: NodeJS.Timeout | null;
};

// 既読処理はルームの行をロックするので、接続数・チャンネル数に関係なくユーザーごとに1つだけ動かす。
// チャンネルを閉じても受け取り済みの既読は捨てないため、状態はチャンネルのインスタンスの外に持つ。
const readStates = new Map<string, ReadState>();

function readKey(roomId: string, channelId: string | undefined): string {
	return JSON.stringify([roomId, channelId ?? null]);
}

function enqueueRead(userId: string, target: ReadTarget) {
	let state = readStates.get(userId);
	if (state == null) {
		state = { running: false, pending: new Map(), finishedAt: new Map(), lastFinishedAt: -Infinity, timer: null };
		readStates.set(userId, state);
	}
	const key = readKey(target.roomId, target.channelId);
	if (!state.pending.has(key) && state.pending.size >= MAX_PENDING_READS) return;
	state.pending.set(key, target);
	pumpRead(userId, state);
}

function pumpRead(userId: string, state: ReadState) {
	if (state.running) return;
	if (state.timer != null) {
		clearTimeout(state.timer);
		state.timer = null;
	}

	const now = Date.now();
	let wakeAt = Infinity;
	const userReadyAt = state.lastFinishedAt + USER_READ_INTERVAL;
	for (const [key, finished] of state.finishedAt) {
		if (finished + READ_INTERVAL <= now) state.finishedAt.delete(key);
		else wakeAt = Math.min(wakeAt, finished + READ_INTERVAL);
	}

	for (const [key, target] of state.pending) {
		if (state.finishedAt.has(key)) continue;
		if (userReadyAt > now) {
			wakeAt = Math.min(wakeAt, userReadyAt);
			break;
		}
		state.pending.delete(key);
		state.running = true;
		void target.chatService.readRoomChatMessage(userId, target.roomId, target.channelId, target.id).catch(() => {}).then(() => {
			state.running = false;
			state.lastFinishedAt = Date.now();
			state.finishedAt.set(key, state.lastFinishedAt);
			pumpRead(userId, state);
		});
		return;
	}

	if (state.pending.size === 0 && wakeAt === Infinity) {
		// 処理するものも待つものもなければ状態を消す
		readStates.delete(userId);
		return;
	}
	state.timer = setTimeout(() => {
		state.timer = null;
		pumpRead(userId, state);
	}, Math.max(wakeAt - now, 0));
	state.timer.unref?.();
}

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
	private initialized = false;
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
			if (version !== this.permissionVersion) continue;
			if (!allowed || this.disposed || this.room == null) return false;
			if (this.room.hasChannels || this.channelId != null) {
				try {
					await this.chatService.resolveRoomChannel(this.room, this.channelId);
				} catch {
					if (version !== this.permissionVersion) continue;
					this.dispose();
					return false;
				}
				if (this.disposed || version !== this.permissionVersion) continue;
				const availability = await this.chatService.getChatAvailability(this.user.id).catch(() => null);
				if (this.disposed || version !== this.permissionVersion) continue;
				if (!availability?.read) {
					this.dispose();
					return false;
				}
			}
			this.initialized = true;
			return true;
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
				const allowed = room != null
					&& await this.chatService.hasPermissionToViewRoomTimeline(this.user!.id, room)
					&& (await this.chatService.getChatAvailability(this.user!.id)).read;
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
		const selected = this.channelId ?? this.room?.legacyChannelId;
		let outgoing: { type: string; body: JsonValue } = data;
		if (this.room?.hasChannels && messageChannelId !== undefined && (selected == null || messageChannelId !== selected)) {
			if (data.type !== 'message' || messageChannelId == null) return;
			outgoing = { type: 'channelMessage', body: { channelId: messageChannelId, messageId: data.body.id } };
		} else if (data.type === 'message' || data.type === 'updated') {
			const id = data.type === 'message' ? data.body.id : data.body.messageId;
			const newMentions = data.type === 'updated' ? data.body.newMentionUserIds ?? [] : undefined;
			const shouldNotify = (newMentions == null || newMentions.includes(this.user!.id)) && await this.chatService.shouldNotifyRoomMessage(this.user!.id, id).catch(() => false);
			if (data.type === 'updated') {
				const { newMentionUserIds: _newMentionUserIds, ...body } = data.body;
				outgoing = { type: 'updated', body: { ...body, shouldNotify } };
			} else {
				outgoing = { type: 'message', body: { ...data.body, shouldNotify } };
			}
		}
		if (this.disposed || version !== this.permissionVersion) return;
		// 역할은 방 권한의 캐시와 별도로, 본문을 준비한 뒤 검사한다.
		const availability = await this.chatService.getChatAvailability(this.user!.id).catch(() => null);
		if (this.disposed || version !== this.permissionVersion || !availability?.read) return;
		this.send(outgoing);
	}

	@bindThis
	public onMessage(type: string, body: any) {
		switch (type) {
			case 'read':
				if (this.disposed || !this.initialized || typeof body?.id !== 'string') break;
				enqueueRead(this.user!.id, { chatService: this.chatService, roomId: this.roomId, channelId: this.channelId, id: body.id });
				break;
		}
	}

	@bindThis
	public dispose() {
		this.disposed = true;
		this.subscriber.off(`chatRoomStream:${this.roomId}`, this.onEvent);
	}
}
