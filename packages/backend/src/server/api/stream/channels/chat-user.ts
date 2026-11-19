/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import promiseLimit from 'promise-limit';
import { bindThis } from '@/decorators.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import type { JsonObject } from '@/misc/json-value.js';
import { ChatService } from '@/core/ChatService.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';

@Injectable({ scope: Scope.TRANSIENT })
export class ChatUserChannel extends Channel {
	public readonly chName = 'chatUser';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:chat';
	private otherId: string;
	private disposed = false;
	private eventQueue = promiseLimit<void>(1);

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		private chatService: ChatService,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject): Promise<boolean> {
		if (typeof params.otherId !== 'string') return false;
		if (!this.user) return false;
		if (params.otherId === this.user.id) return false;
		const availability = await this.chatService.getChatAvailability(this.user.id).catch(() => null);
		if (this.disposed || !availability?.read) return false;

		this.otherId = params.otherId;

		this.subscriber.on(`chatUserStream:${this.user.id}-${this.otherId}`, this.onEvent);

		return true;
	}

	@bindThis
	private onEvent(data: GlobalEvents['chatUser']['payload']) {
		// 역할 조회가 기다리는 동안에도 생성·수정·삭제는 발행 순서대로 보낸다.
		return this.eventQueue(async () => {
			if (this.disposed) return;
			const availability = await this.chatService.getChatAvailability(this.user!.id).catch(() => null);
			if (this.disposed || !availability?.read) return;
			this.send(data.type, data.body);
		});
	}

	@bindThis
	public onMessage(type: string, body: any) {
		switch (type) {
			case 'read':
				if (this.otherId) {
					this.chatService.readUserChatMessage(this.user!.id, this.otherId);
				}
				break;
		}
	}

	@bindThis
	public dispose() {
		this.disposed = true;
		if (this.otherId != null) this.subscriber.off(`chatUserStream:${this.user!.id}-${this.otherId}`, this.onEvent);
	}
}
