/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { MoreThan } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository, NotesRepository, PagesRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type Logger from '@/logger.js';
import { DriveService } from '@/core/DriveService.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiNote } from '@/models/Note.js';
import { EmailService } from '@/core/EmailService.js';
import { bindThis } from '@/decorators.js';
import { SearchService } from '@/core/SearchService.js';
import { PageService } from '@/core/PageService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ChatService } from '@/core/ChatService.js';
import { QueueService } from '@/core/QueueService.js';
import { DeleteAccountService } from '@/core/DeleteAccountService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';
import type { DbUserDeleteJobData } from '../types.js';

// 계정 키로 서명한 Delete의 배송과 재시도가 끝났는지 이 간격으로 다시 본다.
const DELIVERY_CHECK_DELAY = 60 * 1000;
const FINISHED_DELIVERY_STATES = new Set(['completed', 'failed', 'unknown']);

@Injectable()
export class DeleteAccountProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.pagesRepository)
		private pagesRepository: PagesRepository,

		private userEntityService: UserEntityService,
		private driveService: DriveService,
		private pageService: PageService,
		private emailService: EmailService,
		private queueLoggerService: QueueLoggerService,
		private searchService: SearchService,
		private globalEventService: GlobalEventService,
		private chatService: ChatService,
		private queueService: QueueService,
		private deleteAccountService: DeleteAccountService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('delete-account');
	}

	@bindThis
	public async process(job: Bull.Job<DbUserDeleteJobData>): Promise<string | void> {
		this.logger.info(`Deleting account of ${job.data.user.id} ...`);

		const user = await this.usersRepository.findOneBy({ id: job.data.user.id });
		const isRemote = user ? this.userEntityService.isRemoteUser(user) : false;
		if (user == null) {
			return;
		}

		// Everything else is gone already. What is left waits for the deliveries that need the account's key.
		if (job.data.deliveries != null) {
			return await this.removeAfterDeliveries(user.id, job.data.deliveries);
		}

		const resumed = job.data.removingRooms === true;
		if (this.userEntityService.isLocalUser(user) && !job.data.soft && job.data.accountDeliveries == null) {
			const accountDeliveries = await this.deleteAccountService.queueAccountDelete(user);
			await job.updateData({ ...job.data, accountDeliveries });
		}

		if (!resumed) {
			{ // Delete notes
				let cursor: MiNote['id'] | null = null;

				while (true) {
					const notes = await this.notesRepository.find({
						where: {
							userId: user.id,
							...(cursor ? { id: MoreThan(cursor) } : {}),
						},
						take: 100,
						order: {
							id: 1,
						},
					}) as MiNote[];

					if (notes.length === 0) {
						break;
					}

					cursor = notes.at(-1)?.id ?? null;

					await this.notesRepository.delete(notes.map(note => note.id));

					for (const note of notes) {
						await this.searchService.unindexNote(note);
					}
				}

				this.logger.succ(`All of notes deleted: ${job.data.user.id}`);
			}

			{ // Delete files
				let cursor: MiDriveFile['id'] | null = null;

				while (true) {
					const files = await this.driveFilesRepository.find({
						where: {
							userId: user.id,
							...(cursor ? { id: MoreThan(cursor) } : {}),
						},
						take: 10,
						order: {
							id: 1,
						},
					}) as MiDriveFile[];

					if (files.length === 0) {
						break;
					}

					cursor = files.at(-1)?.id ?? null;

					for (const file of files) {
						await this.driveService.deleteFileSync(file, undefined, isRemote);
					}
				}

				this.logger.succ(`All of files deleted: ${job.data.user.id}`);
			}

			{
				// delete pages. Necessary for decrementing pageCount of notes.
				while (true) {
					const pages = await this.pagesRepository.find({
						where: {
							userId: user.id,
						},
						take: 100,
						order: {
							id: 1,
						},
					});

					if (pages.length === 0) {
						break;
					}
					for (const page of pages) {
						await this.pageService.delete(user, page.id);
					}
				}
			}

			{ // Send email notification
				const profile = await this.userProfilesRepository.findOneByOrFail({ userId: user.id });
				if (profile.email && profile.emailVerified) {
					this.emailService.sendEmail(profile.email, 'Account deleted',
						'Your account has been deleted.',
						'Your account has been deleted.');
				}
			}
		}

		// soft指定されている場合は物理削除しない
		if (job.data.soft) {
		// nop
		} else {
			// 방을 지운 뒤 처리가 끊기면 BullMQ가 이 작업을 처음 데이터로 다시 처리한다. 그때는 방이 없어 그 배송을 다시 셀 수 없으므로,
			// 방을 지우기 전에 작업에 표식을 남기고, 표식을 가지고 다시 온 작업은 이 계정이 서명하는 남은 배송을 큐에서 찾는다.
			if (!resumed) await job.updateData({ ...job.data, removingRooms: true });
			// CASCADE 전에 기존 그룹 삭제 경로로 참가자에게도 삭제와 읽음 상태를 알린다.
			const deliveries = [...(job.data.accountDeliveries ?? []), ...await this.chatService.deleteRoomsOwnedBy(user.id)];
			if (resumed) deliveries.push(...await this.deliveriesSignedBy(user.id));
			await this.chatService.deleteMessagesFromUser(user.id);
			return await this.removeAfterDeliveries(user.id, [...new Set(deliveries)]);
		}

		return `[${job.data.user.id}] Account deleted`;
	}

	/**
	 * The deliveries still on the queue that the account signs. Only a job picked up again after its rooms went needs this look over the queue.
	 * A paused queue keeps its jobs waiting, so 'wait' covers them.
	 */
	private async deliveriesSignedBy(userId: string): Promise<string[]> {
		const jobs = await this.queueService.deliverQueue.getJobs(['wait', 'prioritized', 'delayed', 'active', 'waiting-children']);
		return jobs.flatMap(delivery => delivery?.data.user.id === userId && delivery.id != null ? [delivery.id] : []);
	}

	/**
	 * Removes the account row, whose key signs the deletions still on the delivery queue: the account's own and its rooms'.
	 * The key goes with the row, so while one of them is waiting or being retried, this checks again later instead.
	 */
	private async removeAfterDeliveries(userId: string, deliveries: string[]): Promise<string> {
		const pending: string[] = [];
		for (const id of deliveries) {
			const delivery = await this.queueService.deliverQueue.getJob(id);
			// 완료된 배송은 보관 수를 넘으면 큐에서 지워진다. 찾을 수 없으면 끝난 것이다.
			if (delivery != null && !FINISHED_DELIVERY_STATES.has(await delivery.getState())) pending.push(id);
		}

		if (pending.length > 0) {
			await this.queueService.createDeleteAccountJob({ id: userId }, { soft: false, deliveries: pending, delay: DELIVERY_CHECK_DELAY });
			this.logger.info(`Waiting for ${pending.length} deliveries before removing ${userId}`);
			return `[${userId}] Waiting for ${pending.length} deliveries`;
		}

		await this.chatService.deleteUnreadForAccount(userId);
		await this.usersRepository.delete(userId);

		// Trigger CacheService
		this.globalEventService.publishInternalEvent('remoteUserUpdated', { id: userId });

		return `[${userId}] Account deleted`;
	}
}
