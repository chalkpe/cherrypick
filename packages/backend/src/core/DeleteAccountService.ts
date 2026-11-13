/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Not, IsNull } from 'typeorm';
import type { FollowingsRepository, MiMeta, MiUser, UsersRepository } from '@/models/_.js';
import { QueueService } from '@/core/QueueService.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { SystemAccountService } from '@/core/SystemAccountService.js';

@Injectable()
export class DeleteAccountService {
	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private userEntityService: UserEntityService,
		private apRendererService: ApRendererService,
		private queueService: QueueService,
		private globalEventService: GlobalEventService,
		private moderationLogService: ModerationLogService,
		private systemAccountService: SystemAccountService,
	) {
	}

	@bindThis
	public async deleteAccount(user: {
		id: string;
		host: string | null;
	}, moderator?: MiUser): Promise<void> {
		if (this.meta.rootUserId === user.id) throw new Error('cannot delete a root account');

		const _user = await this.usersRepository.findOneByOrFail({ id: user.id });

		if (user.host === null && _user.username.includes('.')) {
			throw new Error('cannot delete a system account');
		}

		if (moderator != null) {
			this.moderationLogService.log(moderator, 'deleteAccount', {
				userId: user.id,
				userUsername: _user.username,
				userHost: user.host,
			});
		}

		// 작업 등록에 실패하면 삭제 상태를 바꾸지 않고 요청자가 다시 시도할 수 있다.
		await this.queueService.createDeleteAccountJob(user, { soft: !this.userEntityService.isLocalUser(user) });

		await this.usersRepository.update(user.id, {
			isDeleted: true,
		});

		this.globalEventService.publishInternalEvent('userChangeDeletedState', { id: user.id, isDeleted: true });
	}

	/** Registers the account's own Delete before destructive account cleanup starts. */
	@bindThis
	public async queueAccountDelete(user: { id: string; host: null }): Promise<string[]> {
		const content = this.apRendererService.addContext(this.apRendererService.renderDelete(this.userEntityService.genLocalUserUri(user.id), user));
		const followings = await this.followingsRepository.find({
			where: [
				{ followerSharedInbox: Not(IsNull()) },
				{ followeeSharedInbox: Not(IsNull()) },
			],
			select: { followerSharedInbox: true, followeeSharedInbox: true },
		});
		const inboxes = [...new Set(followings.flatMap(following => {
			const inbox = following.followerSharedInbox ?? following.followeeSharedInbox;
			return inbox == null ? [] : [inbox];
		}))];
		const queued = await Promise.allSettled(inboxes.map(inbox => this.queueService.deliver(user, content, inbox, true)));
		const failures = queued.filter(result => result.status === 'rejected');
		if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Failed to queue account Delete');
		return queued.flatMap(result => result.status === 'fulfilled' && result.value?.id != null ? [result.value.id] : []);
	}
}
