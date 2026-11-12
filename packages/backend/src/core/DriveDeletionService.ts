/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import promiseLimit from 'promise-limit';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import type * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { MiDriveFile } from '@/models/DriveFile.js';
import type { MiUser } from '@/models/User.js';
import { DriveService } from '@/core/DriveService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import Logger from '@/logger.js';

const MAX_FILES = 10000;
const MAX_FOLDERS = 1000;
const BATCH_SIZE = 100;
const EXPIRY = 3600;
const LOCK_NAMESPACE = 137379;

type Folder = { id: string; parentId: string | null };
type Plan = { operationId: string; totalCount: number; rootId: string | null; folders: Folder[] };
type Status = 'pending' | 'deleted' | 'missing' | 'failed';

export class DriveDeletionError extends Error {
	constructor(public readonly code: 'DELETE_BUSY' | 'PLAN_EXPIRED' | 'NO_SUCH_FOLDER' | 'TOO_MANY_ITEMS' | 'INVALID_SELECTION') {
		super(code);
	}
}

// UNION은 손상된 순환 구조에서도 탐색을 끝내며 소유권 경계를 매 단계 적용한다.
const TREE = `WITH RECURSIVE tree AS (
	SELECT id, "parentId" FROM drive_folder WHERE id = $1 AND "userId" = $2
	UNION
	SELECT folder.id, folder."parentId" FROM drive_folder folder JOIN tree ON folder."parentId" = tree.id WHERE folder."userId" = $2
)`;

@Injectable()
export class DriveDeletionService {
	private logger = new Logger('drive:delete');

	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.redis) private redis: Redis.Redis,
		private driveService: DriveService,
		private globalEventService: GlobalEventService,
	) {}

	// 시간 제한 Redis 잠금 대신 연결 소유 잠금을 사용한다. 느린 저장소에서도 잠금이 만료되지 않는다.
	private async locked<T>(userId: string, action: (runner: QueryRunner) => Promise<T>): Promise<T> {
		const runner = this.db.createQueryRunner();
		let acquired = false;
		try {
			await runner.connect();
			const [result] = await runner.query('SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked', [LOCK_NAMESPACE, userId]);
			acquired = result.locked;
			if (!acquired) throw new DriveDeletionError('DELETE_BUSY');
			return await action(runner);
		} finally {
			await this.releaseLock(runner, userId, acquired);
		}
	}

	private async releaseLock(runner: QueryRunner, userId: string, acquired: boolean): Promise<void> {
		try {
			if (acquired) await runner.query('SELECT pg_advisory_unlock($1, hashtext($2))', [LOCK_NAMESPACE, userId]);
		} catch (error) {
			// 잠금이 남은 세션을 풀에서 재사용하지 않도록 오류와 함께 연결을 폐기한다.
			await (runner as unknown as { releasePostgresConnection(error: Error): Promise<void> }).releasePostgresConnection(new Error('Drive deletion database unlock failed'));
			throw error;
		} finally {
			await runner.release();
		}
	}

	public async prepare(user: MiUser, input: { fileIds?: string[]; folderId?: string }) {
		if ((input.fileIds == null) === (input.folderId == null) || input.fileIds?.length === 0) throw new DriveDeletionError('INVALID_SELECTION');
		if ((input.fileIds?.length ?? 0) > MAX_FILES) throw new DriveDeletionError('TOO_MANY_ITEMS');
		return this.locked(user.id, async runner => {
			let folders: Folder[] = [];
			let ids = [...new Set(input.fileIds ?? [])];
			if (input.folderId != null) {
				await this.transaction(runner, 'REPEATABLE READ', async () => {
					folders = await runner.query(`${TREE} SELECT * FROM tree LIMIT ${MAX_FOLDERS + 1}`, [input.folderId, user.id]);
					if (folders.length === 0) throw new DriveDeletionError('NO_SUCH_FOLDER');
					if (folders.length > MAX_FOLDERS) throw new DriveDeletionError('TOO_MANY_ITEMS');
					const rows: { id: string }[] = await runner.query(`SELECT id FROM drive_file WHERE "userId" = $1 AND "folderId" = ANY($2::varchar[]) LIMIT ${MAX_FILES + 1}`, [user.id, folders.map(f => f.id)]);
					if (rows.length > MAX_FILES) throw new DriveDeletionError('TOO_MANY_ITEMS');
					ids = rows.map(f => f.id);
				});
				// 재귀 호출 없이 자식부터 삭제한다. 최대 1,000개의 폴더만 메모리에 둔다.
				const ordered: Folder[] = [];
				const queue = folders.filter(f => f.id === input.folderId);
				const seen = new Set<string>();
				for (let i = 0; i < queue.length; i++) {
					const folder = queue[i];
					if (seen.has(folder.id)) continue;
					seen.add(folder.id);
					ordered.push(folder);
					queue.push(...folders.filter(f => f.parentId === folder.id && !seen.has(f.id)));
				}
				folders = ordered.reverse();
			}
			const plan: Plan = { operationId: randomUUID(), totalCount: ids.length, rootId: input.folderId ?? null, folders };
			const key = this.key(user.id);
			const fields: Record<string, string> = { plan: JSON.stringify(plan) };
			for (const id of ids) fields[`file:${id}`] = 'pending';
			for (const folder of folders) fields[`folder:${folder.id}`] = 'pending';
			// 한 명의 준비가 이전 확인창을 무효화한다. 삭제 대상을 클라이언트에서 추가할 수 없다.
			await this.writeState(key, fields, true);
			return { operationId: plan.operationId, totalCount: plan.totalCount };
		});
	}

	public async execute(user: MiUser, operationId: string) {
		return this.locked(user.id, async runner => {
			const key = this.key(user.id);
			const fields = await this.redis.hgetall(key);
			const plan: Plan | null = fields.plan ? JSON.parse(fields.plan) : null;
			if (plan == null || plan.operationId !== operationId) throw new DriveDeletionError('PLAN_EXPIRED');
			await this.redis.expire(key, EXPIRY);
			const files = runner.manager.getRepository(MiDriveFile);
			const pending = Object.keys(fields).filter(k => k.startsWith('file:') && fields[k] === 'pending').slice(0, BATCH_SIZE);
			const save = async (field: string, status: Status) => {
				fields[field] = status;
				await this.writeState(key, { [field]: status });
			};
			// 같은 pg client의 SQL은 순차 실행하고, Redis 결과 저장은 최대 네 파일까지 처리한다.
			const queryLimit = promiseLimit<Status>(1);
			let cursor = 0;
			const workers = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, async () => {
				while (cursor < pending.length) {
					const field = pending[cursor++];
					const id = field.slice(5);
					let status: Status;
					try {
						status = await queryLimit(async () => {
							const file = await files.findOneBy({ id, userId: user.id });
							return file == null ? 'missing' : await this.driveService.deleteFile(file, false, undefined, files, { awaitStorageQueue: true }) ? 'deleted' : 'missing';
						});
					} catch (error) {
						this.logger.error(`Failed to delete drive file ${id}`, { error });
						status = 'failed';
					}
					// Redis 기록 실패는 파일 실패로 덮어쓰지 않고 요청을 실패시킨다.
					await save(field, status);
				}
			}));

			const rejected = workers.find(worker => worker.status === 'rejected');
			if (rejected?.status === 'rejected') throw rejected.reason;

			if (!Object.keys(fields).some(k => k.startsWith('file:') && fields[k] === 'pending')) {
				let processed = 0;
				for (const folder of plan.folders) {
					const field = `folder:${folder.id}`;
					if (fields[field] !== 'pending') continue;
					if (processed++ >= BATCH_SIZE) break;
					let status: Status;
					try {
						status = await this.deleteEmptyFolder(runner, user.id, folder);
					} catch (error) {
						this.logger.error(`Failed to delete drive folder ${folder.id}`, { error });
						status = 'failed';
					}
					await save(field, status);
				}
			}
			return this.result(runner, user.id, plan, fields);
		});
	}

	public async status(user: MiUser, operationId: string) {
		return this.locked(user.id, async runner => {
			const fields = await this.redis.hgetall(this.key(user.id));
			const plan: Plan | null = fields.plan ? JSON.parse(fields.plan) : null;
			if (plan == null || plan.operationId !== operationId) throw new DriveDeletionError('PLAN_EXPIRED');
			return this.result(runner, user.id, plan, fields);
		});
	}

	private async deleteEmptyFolder(runner: QueryRunner, userId: string, folder: Folder): Promise<Status> {
		const status = await this.transaction(runner, 'READ COMMITTED', async () => {
			// FOR UPDATE와 FK의 KEY SHARE가 충돌하므로 빈 상태 확인 뒤 자식이 추가될 수 없다.
			const rows: Folder[] = await runner.query('SELECT id, "parentId" FROM drive_folder WHERE id = $1 AND "userId" = $2 FOR UPDATE', [folder.id, userId]);
			if (rows.length === 0) return 'missing';
			if (rows[0].parentId !== folder.parentId) return 'failed';
			const [children] = await runner.query(`SELECT
				EXISTS(SELECT 1 FROM drive_file WHERE "folderId" = $1) OR
				EXISTS(SELECT 1 FROM drive_folder WHERE "parentId" = $1) AS present`, [folder.id]);
			if (children.present) return 'failed';
			await runner.query('DELETE FROM drive_folder WHERE id = $1 AND "userId" = $2', [folder.id, userId]);
			return 'deleted';
		});
		if (status === 'deleted') this.globalEventService.publishDriveStream(userId, 'folderDeleted', folder.id);
		return status;
	}

	private async result(runner: QueryRunner, userId: string, plan: Plan, fields: Record<string, string>) {
		// Redis 필드 순서와 처리 순서에 관계없이 execute/status의 ID 배열을 같은 사전순으로 반환한다.
		const ids = (prefix: string, status: Status) => Object.keys(fields).filter(k => k.startsWith(prefix) && fields[k] === status).map(k => k.slice(prefix.length)).sort();
		const deletedIds = ids('file:', 'deleted');
		const missingIds = ids('file:', 'missing');
		const failedIds = ids('file:', 'failed');
		const done = !Object.values(fields).includes('pending');
		let remainingCount = plan.totalCount - deletedIds.length - missingIds.length;
		let remainingFoldersCount = plan.folders.length - ids('folder:', 'deleted').length - ids('folder:', 'missing').length;
		if (done) {
			// 확인 후 추가된 자식과 폴더 밖으로 이동한 실패 대상도 실제 잔여 수에 포함한다.
			const [counts] = await runner.query(`${TREE} SELECT
				(SELECT count(*) FROM drive_file WHERE "userId" = $2 AND ("folderId" IN (SELECT id FROM tree) OR id = ANY($3::varchar[]))) AS files,
				(SELECT count(*) FROM drive_folder WHERE "userId" = $2 AND (id IN (SELECT id FROM tree) OR id = ANY($4::varchar[]))) AS folders`,
			[plan.rootId, userId, failedIds, ids('folder:', 'failed')]);
			remainingCount = Number(counts.files);
			remainingFoldersCount = Number(counts.folders);
		}
		return {
			operationId: plan.operationId, totalCount: plan.totalCount,
			deletedCount: deletedIds.length, missingCount: missingIds.length, failedCount: failedIds.length,
			remainingCount, remainingFoldersCount, done, deletedIds, missingIds,
			deletedFolderIds: ids('folder:', 'deleted'),
			missingFolderIds: ids('folder:', 'missing'),
			folderDeleted: plan.rootId != null && ['deleted', 'missing'].includes(fields[`folder:${plan.rootId}`]),
		};
	}

	private async transaction<T>(runner: QueryRunner, isolation: 'REPEATABLE READ' | 'READ COMMITTED', action: () => Promise<T>) {
		// 잠금에 쓴 연결을 재사용한다. 연결 풀이 작아도 추가 연결을 기다리며 서로 막지 않는다.
		await runner.startTransaction(isolation);
		try {
			const result = await action();
			await runner.commitTransaction();
			return result;
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		}
	}

	private async writeState(key: string, fields: Record<string, string>, replace = false) {
		const transaction = this.redis.multi();
		if (replace) transaction.del(key);
		const replies = await transaction.hset(key, fields).expire(key, EXPIRY).exec();
		if (replies == null) throw new Error('Drive deletion state was not saved.');
		const failed = replies.find(([error]) => error != null);
		if (failed) throw failed[0];
	}

	private key(userId: string) { return `drive-deletion:${userId}`; }
}
