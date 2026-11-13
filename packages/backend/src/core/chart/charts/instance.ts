/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import * as Redis from 'ioredis';
import type { DriveFilesRepository, FollowingsRepository, UsersRepository, NotesRepository } from '@/models/_.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import { MiNote } from '@/models/Note.js';
import { DI } from '@/di-symbols.js';
import { UtilityService } from '@/core/UtilityService.js';
import { bindThis } from '@/decorators.js';
import { acquireChartInsertLock } from '@/misc/distributed-lock.js';
import Chart from '../core.js';
import { deletionDiff } from '../note-deletion.js';
import type { DeletedChartNote } from '../note-deletion.js';
import { ChartLoggerService } from '../ChartLoggerService.js';
import { name, schema } from './entities/instance.js';
import type { KVs } from '../core.js';

/**
 * インスタンスごとのチャート
 */
@Injectable()
export default class InstanceChart extends Chart<typeof schema> { // eslint-disable-line import/no-default-export
	protected override authoritativeTotalKeys = ['notes.total'];

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private utilityService: UtilityService,
		private chartLoggerService: ChartLoggerService,
	) {
		super(db, (k) => acquireChartInsertLock(redisClient, k), chartLoggerService.logger, name, schema, true);
	}

	protected async authoritativeTotals(manager: EntityManager, group: string): Promise<Partial<KVs<typeof schema>>> {
		return { 'notes.total': await manager.getRepository(MiNote).countBy({ userHost: group }) };
	}

	protected async tickMajor(group: string, manager?: EntityManager): Promise<Partial<KVs<typeof schema>>> {
		const users = manager ? manager.getRepository(this.usersRepository.target) : this.usersRepository;
		const followings = manager ? manager.getRepository(this.followingsRepository.target) : this.followingsRepository;
		const driveFiles = manager ? manager.getRepository(this.driveFilesRepository.target) : this.driveFilesRepository;
		return {
			'users.total': await users.countBy({ host: group }),
			'following.total': await followings.countBy({ followerHost: group }),
			'followers.total': await followings.countBy({ followeeHost: group }),
			'drive.totalFiles': await driveFiles.countBy({ userHost: group }),
		};
	}

	public async applyDeletionInTransaction(manager: EntityManager, notes: readonly DeletedChartNote[], group: string, bucketAt: Date): Promise<void> {
		await this.applyDeletionDiffInTransaction(manager, deletionDiff(notes, 'notes.'), group, bucketAt);
	}

	protected async tickMinor(): Promise<Partial<KVs<typeof schema>>> {
		return {};
	}

	@bindThis
	public async requestReceived(host: string): Promise<void> {
		await this.commit({
			'requests.received': 1,
		}, this.utilityService.toPuny(host));
	}

	@bindThis
	public async requestSent(host: string, isSucceeded: boolean): Promise<void> {
		await this.commit({
			'requests.succeeded': isSucceeded ? 1 : 0,
			'requests.failed': isSucceeded ? 0 : 1,
		}, this.utilityService.toPuny(host));
	}

	@bindThis
	public async newUser(host: string): Promise<void> {
		await this.commit({
			'users.total': 1,
			'users.inc': 1,
		}, this.utilityService.toPuny(host));
	}

	@bindThis
	public async updateNote(host: string, note: MiNote, isAdditional: boolean): Promise<void> {
		await this.commit({
			'notes.inc': isAdditional ? 1 : 0,
			'notes.dec': isAdditional ? 0 : 1,
			'notes.diffs.normal': note.replyId == null && note.renoteId == null ? (isAdditional ? 1 : -1) : 0,
			'notes.diffs.renote': note.renoteId != null ? (isAdditional ? 1 : -1) : 0,
			'notes.diffs.reply': note.replyId != null ? (isAdditional ? 1 : -1) : 0,
			'notes.diffs.withFile': note.fileIds.length > 0 ? (isAdditional ? 1 : -1) : 0,
		}, this.utilityService.toPuny(host));
	}

	@bindThis
	public async updateFollowing(host: string, isAdditional: boolean): Promise<void> {
		await this.commit({
			'following.total': isAdditional ? 1 : -1,
			'following.inc': isAdditional ? 1 : 0,
			'following.dec': isAdditional ? 0 : 1,
		}, this.utilityService.toPuny(host));
	}

	@bindThis
	public async updateFollowers(host: string, isAdditional: boolean): Promise<void> {
		await this.commit({
			'followers.total': isAdditional ? 1 : -1,
			'followers.inc': isAdditional ? 1 : 0,
			'followers.dec': isAdditional ? 0 : 1,
		}, this.utilityService.toPuny(host));
	}

	@bindThis
	public async updateDrive(file: MiDriveFile, isAdditional: boolean): Promise<void> {
		const fileSizeKb = file.size / 1000;
		await this.commit({
			'drive.totalFiles': isAdditional ? 1 : -1,
			'drive.incFiles': isAdditional ? 1 : 0,
			'drive.incUsage': isAdditional ? fileSizeKb : 0,
			'drive.decFiles': isAdditional ? 1 : 0,
			'drive.decUsage': isAdditional ? fileSizeKb : 0,
		}, file.userHost);
	}
}
