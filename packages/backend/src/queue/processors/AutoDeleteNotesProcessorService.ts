/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import { CleanupInputError, NOTE_CLEANUP_LIMITS, NoteCleanupService, noteCleanupRequestJobId } from '@/core/NoteCleanupService.js';
import { QueueService } from '@/core/QueueService.js';
import Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { isRetryableCleanupFailure } from '@/core/NoteCleanupRunner.js';

// 잠금 충돌·회차 시간 초과 뒤 다시 시도하기까지의 지연, 연합 큐 적체가 풀리기를 기다리는 지연
const RETRY_DELAY = 1000;
const BACKLOG_DELAY = 60000;

@Injectable()
export class AutoDeleteNotesProcessorService {
	private logger = new Logger('note-cleanup');
	constructor(private noteCleanupService: NoteCleanupService, private queueService: QueueService) {}

	// 전송과 수신이 밀렸으면 연합 삭제 부하를 더하지 않는다. 수동 요청과 자동 회차가 같은 기준을 쓴다.
	private async backlogged() {
		for (const [queue, threshold] of [[this.queueService.deliverQueue, 10000], [this.queueService.inboxQueue, 5000]] as const) {
			const oldest = (await queue.getWaiting(0, 0))[0];
			if (oldest && Date.now() - oldest.timestamp > threshold) return true;
		}
		return false;
	}

	@bindThis
	public async process(job: Bull.Job<Record<string, unknown>>) {
		const { userId, ruleIds, afterId, requestId, sweep } = job.data;
		if (typeof sweep === 'string' && typeof userId === 'string') return this.noteCleanupService.sweepRequestChain(userId, sweep);
		if (typeof userId === 'string' && Array.isArray(ruleIds) && ruleIds.every(id => typeof id === 'string')) {
			return this.processRequest(job, userId, ruleIds, typeof afterId === 'string' ? afterId : undefined, requestId);
		}
		return this.automaticRound();
	}

	// 자동 회차: 계정마다 한 페이지씩, 회차 사용자·시간 상한 안에서 처리한다.
	private async automaticRound() {
		try {
			return await this.noteCleanupService.locked('scheduler', () => this.runRound());
		} catch (error) {
			// 이전 회차가 아직 진행 중이거나 정리 연결이 모두 쓰이는 중이면 정상 혼잡이므로 이번 회차를 건너뛴다.
			if (error instanceof CleanupInputError && error.code === 'CLEANUP_BUSY') return { deletedCount: 0, skipped: true };
			throw error;
		}
	}

	private async runRound() {
		if (await this.backlogged()) return { deletedCount: 0, skipped: true };
		const started = Date.now();
		let deletedCount = 0;
		for (const id of await this.noteCleanupService.automaticUsers()) {
			// system 큐를 오래 점유하지 않도록 회차 시간을 넘기면 남은 계정은 다음 회차로 넘긴다.
			if (Date.now() - started >= NOTE_CLEANUP_LIMITS.roundMs) break;
			try {
				const result = await this.noteCleanupService.processUser(id);
				deletedCount += result.deleted;
				// 전역 예산이 다 찼으면 뒤 계정도 처리할 수 없으므로 검사 예산을 더 쓰지 않는다.
				if (result.throttled === 'global') break;
			} catch (error) {
				// 한 계정의 잠금 충돌이나 자료 실패가 같은 회차의 다른 계정을 멈추지 않게 하고, 순번을 뒤로 보낸다.
				if (!(error instanceof CleanupInputError && error.code === 'CLEANUP_BUSY')) this.logger.error('Automatic note cleanup failed', { userId: id, error });
				try { await this.noteCleanupService.deferUser(id); } catch (deferError) { this.logger.error('Cleanup turn deferral failed', { userId: id, error: deferError }); }
			}
		}
		return { deletedCount, skipped: false };
	}

	// 같은 요청의 이어 받기 작업은 고정 ID로 접수해 재시작 시 중복 등록을 막는다.
	private async processRequest(job: Bull.Job<Record<string, unknown>>, userId: string, ruleIds: string[], afterId: string | undefined, requestId: unknown) {
		const started = Date.now();
		const id = typeof requestId === 'string' ? requestId : randomUUID();
		const step = typeof job.data.step === 'number' ? job.data.step : 0;
		let cursor = afterId;
		let failures = typeof job.data.retryFailures === 'number' ? job.data.retryFailures : 0;
		const handoff = async (until: number) => {
			const next = { userId, ruleIds, afterId: cursor, requestId: id, step: step + 1, retryFailures: failures };
			// 접수 전에 다음 작업을 기록하므로 이 작업이 중단돼도 같은 ID로 다시 접수한다.
			await job.updateData({ ...job.data, requestId: id, step, handoff: { next, until } });
			await this.queueService.systemQueue.add('autoDeleteNotes', next, {
				jobId: `note-cleanup-${id}-${step + 1}`, delay: Math.max(0, until - Date.now()),
				attempts: 10, backoff: { type: 'fixed', delay: 5000 },
				// 완료된 자식은 자동 제거하고 실패 이력만 보존 기한을 둔다. 루트가 체인 정리의 근거를 남긴다.
				removeOnComplete: true, removeOnFail: { age: 7 * 86400 },
			});
			return { delayed: true };
		};
		const saved = job.data.handoff as { next?: { afterId?: string; retryFailures?: number }; until?: number } | undefined;
		if (saved?.next && typeof saved.until === 'number') {
			cursor = saved.next.afterId;
			failures = saved.next.retryFailures ?? 0;
			return handoff(saved.until);
		}
		let deleted = 0;
		let failed = 0;
		for (;;) {
			let result;
			try {
				if (await this.backlogged()) return handoff(Date.now() + BACKLOG_DELAY);
				result = await this.noteCleanupService.processUser(userId, ruleIds, cursor);
			} catch (error) {
				if (error instanceof CleanupInputError && error.code === 'CLEANUP_BUSY') return handoff(Date.now() + RETRY_DELAY);
				if (!isRetryableCleanupFailure(error)) {
					// 비재시도 오류는 종료 실패로 처리한다. 무한 재시도는 큐를 점유하고 새 요청을 영구히 막는다.
					this.logger.error('Manual note cleanup failed permanently', { userId, error });
					throw new Bull.UnrecoverableError(error instanceof Error ? error.message : String(error));
				}
				this.logger.error('Manual note cleanup temporarily failed', { userId, error });
				failures = Math.min(failures + 1, 11);
				return handoff(Date.now() + Math.min(3600000, 5000 * 2 ** (failures - 1)));
			}
			failures = 0;
			deleted += result.deleted;
			failed += result.failed;
			if (result.complete) {
				// 현재 작업이 완료된 뒤 종료된 체인을 정리하도록 지연 접수한다. 진행 중 작업은 직접 제거할 수 없다.
				await this.queueService.systemQueue.add('autoDeleteNotes', { userId, sweep: noteCleanupRequestJobId(userId, ruleIds) }, {
					jobId: `note-cleanup-sweep-${id}-${step}`, delay: 1000,
					attempts: 3, backoff: { type: 'fixed', delay: 5000 },
					removeOnComplete: true, removeOnFail: { age: 7 * 86400 },
				});
				return { ...result, deleted, failed };
			}
			cursor = result.cursor || cursor;
			await job.updateData({ ...job.data, userId, ruleIds, afterId: cursor, requestId: id, step, retryFailures: failures });
			if (result.throttled) return handoff((Math.floor(Date.now() / NOTE_CLEANUP_LIMITS.windowMs) + 1) * NOTE_CLEANUP_LIMITS.windowMs);
			if (Date.now() - started >= NOTE_CLEANUP_LIMITS.roundMs) return handoff(Date.now() + RETRY_DELAY);
		}
	}
}
