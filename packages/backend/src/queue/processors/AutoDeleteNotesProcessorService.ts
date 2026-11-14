/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import { CleanupInputError, NOTE_CLEANUP_LIMITS, NoteCleanupService } from '@/core/NoteCleanupService.js';
import { QueueService } from '@/core/QueueService.js';
import Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { isRetryableCleanupFailure } from '@/core/NoteCleanupRunner.js';

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
		const { userId, manual } = job.data;
		if (manual === true && typeof userId === 'string') return this.runManual(userId, Date.now());
		return this.automaticRound();
	}

	// 자동 회차: 수동 대기 계정을 먼저 처리하고 남은 계정 몫만 자동 검사에 쓴다. 회차 사용자·시간 상한은 함께 나눈다.
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
		let globalExhausted = false;
		const manual = await this.noteCleanupService.manualUsers();
		for (const id of manual) {
			// system 큐를 오래 점유하지 않도록 회차 시간을 넘기면 남은 계정은 다음 회차로 넘긴다.
			if (Date.now() - started >= NOTE_CLEANUP_LIMITS.roundMs) break;
			try {
				const result = await this.runManual(id, started);
				deletedCount += result.deleted;
				// 전역 예산이 다 찼으면 뒤 계정도 처리할 수 없으므로 검사 예산을 더 쓰지 않는다.
				if (result.throttled === 'global') { globalExhausted = true; break; }
			} catch (error) {
				// 한 계정의 종료 실패가 같은 회차의 다른 계정을 멈추지 않게 하고, 순번을 뒤로 보낸다.
				this.logger.error('Manual note cleanup failed in round', { userId: id, error });
				try { await this.noteCleanupService.deferUser(id); } catch (deferError) { this.logger.error('Cleanup turn deferral failed', { userId: id, error: deferError }); }
			}
		}
		const remaining = NOTE_CLEANUP_LIMITS.roundUsers - manual.length;
		const automatic = !globalExhausted && remaining > 0 ? await this.noteCleanupService.automaticUsers(remaining) : [];
		for (const id of automatic) {
			if (Date.now() - started >= NOTE_CLEANUP_LIMITS.roundMs) break;
			try {
				const result = await this.noteCleanupService.processUser(id);
				deletedCount += result.deleted;
				if (result.throttled === 'global') break;
			} catch (error) {
				// 한 계정의 잠금 충돌이나 자료 실패가 같은 회차의 다른 계정을 멈추지 않게 하고, 순번을 뒤로 보낸다.
				if (!(error instanceof CleanupInputError && error.code === 'CLEANUP_BUSY')) this.logger.error('Automatic note cleanup failed', { userId: id, error });
				try { await this.noteCleanupService.deferUser(id); } catch (deferError) { this.logger.error('Cleanup turn deferral failed', { userId: id, error: deferError }); }
			}
		}
		return { deletedCount, skipped: false };
	}

	// 수동 요청의 깨우기 작업: 마커를 따라 완료까지 페이지를 잇는다. 대기는 자식 작업 없이 정상 종료해 마커를 다음 회차에 넘긴다.
	// 잠금 충돌·일시 실패·예산 대기는 모두 마커가 보존하는 대기이며, 비재시도 오류만 종료 실패로 처리한다.
	private async runManual(userId: string, started: number): Promise<{ deleted: number; failed: number; delayed?: boolean; throttled?: 'global' | 'account' }> {
		let deleted = 0;
		let failed = 0;
		for (;;) {
			if (await this.backlogged()) return { delayed: true, deleted, failed };
			let result;
			try {
				result = await this.noteCleanupService.continueManual(userId);
			} catch (error) {
				if (error instanceof CleanupInputError && error.code === 'CLEANUP_BUSY') return { delayed: true, deleted, failed };
				if (isRetryableCleanupFailure(error)) {
					this.logger.error('Manual note cleanup temporarily failed', { userId, error });
					return { delayed: true, deleted, failed };
				}
				this.logger.error('Manual note cleanup failed permanently', { userId, error });
				throw new Bull.UnrecoverableError(error instanceof Error ? error.message : String(error));
			}
			deleted += result.deleted;
			failed += result.failed;
			if (result.complete) return { deleted, failed };
			if (result.throttled || Date.now() - started >= NOTE_CLEANUP_LIMITS.roundMs) return { delayed: true, deleted, failed, throttled: result.throttled };
		}
	}
}
