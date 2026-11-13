/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import * as Redis from 'ioredis';
import type { NotesRepository } from '@/models/_.js';
import { MiNote } from '@/models/Note.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { acquireChartInsertLock } from '@/misc/distributed-lock.js';
import Chart from '../core.js';
import { deletionDiff } from '../note-deletion.js';
import type { DeletedChartNote } from '../note-deletion.js';
import { ChartLoggerService } from '../ChartLoggerService.js';
import { name, schema } from './entities/notes.js';
import type { KVs } from '../core.js';

/**
 * ノートに関するチャート
 */
@Injectable()
export default class NotesChart extends Chart<typeof schema> { // eslint-disable-line import/no-default-export
	protected override authoritativeTotalKeys = ['local.total', 'remote.total'];

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private chartLoggerService: ChartLoggerService,
	) {
		super(db, (k) => acquireChartInsertLock(redisClient, k), chartLoggerService.logger, name, schema);
	}

	protected async authoritativeTotals(manager: EntityManager): Promise<Partial<KVs<typeof schema>>> {
		const counts = await manager.getRepository(MiNote).createQueryBuilder('note')
			.select('COUNT(*) FILTER (WHERE "note"."userHost" IS NULL)', 'local')
			.addSelect('COUNT(*) FILTER (WHERE "note"."userHost" IS NOT NULL)', 'remote')
			.getRawOne<{ local: string; remote: string }>();
		if (!counts) throw new Error('Missing note chart count');
		return { 'local.total': Number(counts.local), 'remote.total': Number(counts.remote) };
	}

	protected async tickMajor(): Promise<Partial<KVs<typeof schema>>> {
		return {};
	}

	public async applyDeletionInTransaction(manager: EntityManager, notes: readonly DeletedChartNote[], group: null, bucketAt: Date): Promise<void> {
		await this.applyDeletionDiffInTransaction(manager, deletionDiff(notes, note => note.userHost === null ? 'local.' : 'remote.'), group, bucketAt);
	}

	protected async tickMinor(): Promise<Partial<KVs<typeof schema>>> {
		return {};
	}

	@bindThis
	public async update(note: MiNote, isAdditional: boolean): Promise<void> {
		const prefix = note.userHost === null ? 'local' : 'remote';

		await this.commit({
			[`${prefix}.inc`]: isAdditional ? 1 : 0,
			[`${prefix}.dec`]: isAdditional ? 0 : 1,
			[`${prefix}.diffs.normal`]: note.replyId == null && note.renoteId == null ? (isAdditional ? 1 : -1) : 0,
			[`${prefix}.diffs.renote`]: note.renoteId != null ? (isAdditional ? 1 : -1) : 0,
			[`${prefix}.diffs.reply`]: note.replyId != null ? (isAdditional ? 1 : -1) : 0,
			[`${prefix}.diffs.withFile`]: note.fileIds.length > 0 ? (isAdditional ? 1 : -1) : 0,
		});
	}
}
