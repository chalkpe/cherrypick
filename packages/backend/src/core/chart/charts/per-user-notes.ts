/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import * as Redis from 'ioredis';
import type { MiUser } from '@/models/User.js';
import { MiNote } from '@/models/Note.js';
import { DI } from '@/di-symbols.js';
import type { NotesRepository } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { acquireChartInsertLock } from '@/misc/distributed-lock.js';
import Chart from '../core.js';
import { deletionDiff } from '../note-deletion.js';
import type { DeletedChartNote } from '../note-deletion.js';
import { ChartLoggerService } from '../ChartLoggerService.js';
import { name, schema } from './entities/per-user-notes.js';
import type { KVs } from '../core.js';

/**
 * ユーザーごとのノートに関するチャート
 */
@Injectable()
export default class PerUserNotesChart extends Chart<typeof schema> { // eslint-disable-line import/no-default-export
	protected override authoritativeTotalKeys = ['total'];

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private chartLoggerService: ChartLoggerService,
	) {
		super(db, (k) => acquireChartInsertLock(redisClient, k), chartLoggerService.logger, name, schema, true);
	}

	protected async authoritativeTotals(manager: EntityManager, group: string): Promise<Partial<KVs<typeof schema>>> {
		return { total: await manager.getRepository(MiNote).countBy({ userId: group }) };
	}

	protected async tickMajor(): Promise<Partial<KVs<typeof schema>>> {
		return {};
	}

	public async applyDeletionInTransaction(manager: EntityManager, notes: readonly DeletedChartNote[], group: string, bucketAt: Date): Promise<void> {
		await this.applyDeletionDiffInTransaction(manager, deletionDiff(notes, ''), group, bucketAt);
	}

	protected async tickMinor(): Promise<Partial<KVs<typeof schema>>> {
		return {};
	}

	@bindThis
	public update(user: { id: MiUser['id'] }, note: MiNote, isAdditional: boolean): void {
		this.commit({
			'inc': isAdditional ? 1 : 0,
			'dec': isAdditional ? 0 : 1,
			'diffs.normal': note.replyId == null && note.renoteId == null ? (isAdditional ? 1 : -1) : 0,
			'diffs.renote': note.renoteId != null ? (isAdditional ? 1 : -1) : 0,
			'diffs.reply': note.replyId != null ? (isAdditional ? 1 : -1) : 0,
			'diffs.withFile': note.fileIds.length > 0 ? (isAdditional ? 1 : -1) : 0,
		}, user.id);
	}
}
