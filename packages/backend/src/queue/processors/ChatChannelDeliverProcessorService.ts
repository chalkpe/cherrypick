/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import { QueueService } from '@/core/QueueService.js';
import type * as Bull from 'bullmq';
import type { ChatChannelDeliverJobData } from '../types.js';

@Injectable()
export class ChatChannelDeliverProcessorService {
	constructor(
		private fetchInstanceMetadataService: FetchInstanceMetadataService,
		private queueService: QueueService,
	) {}

	public async process(job: Bull.Job<ChatChannelDeliverJobData>): Promise<string> {
		const { user, content, to, isSharedInbox, host } = job.data;
		const capability = await this.fetchInstanceMetadataService.chatRoomChannelsCapability(host);
		if (capability == null) throw new Error('chat room channel capability temporarily unavailable');
		if (!capability) return 'skip: chat room channels unsupported';
		await this.queueService.deliver(user, content, to, isSharedInbox);
		return 'ok';
	}
}
