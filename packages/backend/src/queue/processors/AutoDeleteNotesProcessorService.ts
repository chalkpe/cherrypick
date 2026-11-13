/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Injectable } from '@nestjs/common';
import { CleanupInputError, NOTE_CLEANUP_LIMITS, NoteCleanupService } from '@/core/NoteCleanupService.js';
import { QueueService } from '@/core/QueueService.js';
import Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { DelayedError } from 'bullmq';
import type * as Bull from 'bullmq';

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
		const { userId, ruleIds, afterId, requestId } = job.data;
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

	// 수동 정리 요청: 완료·적체·예산 소진·시간 초과까지 한 작업 안에서 페이지를 이어 처리한다.
	// 지연할 때는 진행한 커서만 작업 데이터에 남기고, 요청(규칙 조합·requestId)은 그대로 보존한다.
	private async processRequest(job: Bull.Job<Record<string, unknown>>, userId: string, ruleIds: string[], afterId: string | undefined, requestId: unknown) {
		const started = Date.now();
		let cursor = afterId;
		const delay = async (until: number) => {
			if (cursor !== afterId) await job.updateData({ userId, ruleIds, afterId: cursor, requestId });
			await job.moveToDelayed(until, job.token);
			throw new DelayedError();
		};
		let deleted = 0;
		let failed = 0;
		for (;;) {
			if (await this.backlogged()) return delay(Date.now() + BACKLOG_DELAY);
			let result;
			try { result = await this.noteCleanupService.processUser(userId, ruleIds, cursor); } catch (error) {
				// 정상 잠금 충돌은 실패가 아니므로 요청을 보존한 채 다시 시도한다.
				if (!(error instanceof CleanupInputError) || error.code !== 'CLEANUP_BUSY') throw error;
				return delay(Date.now() + RETRY_DELAY);
			}
			deleted += result.deleted;
			failed += result.failed;
			if (result.complete) return { ...result, deleted, failed };
			// 빈 커서('')는 아직 지난 노트가 없다는 뜻이므로 기존 위치를 유지한다.
			cursor = result.cursor || cursor;
			// 예산이 다 찼으면 다음 예약 창이 시작될 때까지 미룬다.
			if (result.throttled) return delay((Math.floor(Date.now() / NOTE_CLEANUP_LIMITS.windowMs) + 1) * NOTE_CLEANUP_LIMITS.windowMs);
			if (Date.now() - started >= NOTE_CLEANUP_LIMITS.roundMs) return delay(Date.now() + RETRY_DELAY);
		}
	}
}
