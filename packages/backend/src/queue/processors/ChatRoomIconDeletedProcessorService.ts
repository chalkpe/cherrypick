/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { ChatRoomsRepository, DriveFilesRepository } from '@/models/_.js';
import { ChatService } from '@/core/ChatService.js';
import type * as Bull from 'bullmq';

@Injectable()
export class ChatRoomIconDeletedProcessorService {
	constructor(
		@Inject(DI.chatRoomsRepository) private chatRoomsRepository: ChatRoomsRepository,
		@Inject(DI.driveFilesRepository) private driveFilesRepository: DriveFilesRepository,
		private chatService: ChatService,
	) {}

	public async process(job: Bull.Job<{ roomId: string; fileId: string }>): Promise<void> {
		const { roomId, fileId } = job.data;
		// 삭제 트랜잭션보다 작업이 먼저 실행되면 완료 뒤에 다시 시도한다.
		if (await this.driveFilesRepository.existsBy({ id: fileId })) throw new Error('Drive file deletion has not completed');
		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room == null) return;
		await this.chatService.updateRoom(room, { iconId: null, iconUrl: null, iconBlurhash: null }, { deletedIconId: fileId });
	}
}
