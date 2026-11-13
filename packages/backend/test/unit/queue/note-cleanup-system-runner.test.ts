/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { DelayedError } from 'bullmq';
import { QueueProcessorService } from '@/queue/QueueProcessorService.js';
import { AutoDeleteNotesProcessorService } from '@/queue/processors/AutoDeleteNotesProcessorService.js';

vi.mock('@/core/UtilityService.js', () => ({ UtilityService: class {} }));
vi.mock('@/core/NoteDeleteDeliveryService.js', () => ({ NoteDeleteDeliveryService: class {} }));
vi.mock('@/core/NoteDeleteLocalRunnerService.js', () => ({ NoteDeleteLocalRunnerService: class {} }));
vi.mock('@/core/telemetry/TelemetryService.js', () => ({ TelemetryService: class {} }));
vi.mock('@/queue/processors/CheckModeratorsActivityProcessorService.js', () => ({ CheckModeratorsActivityProcessorService: class {} }));
vi.mock('@/queue/processors/UserWebhookDeliverProcessorService.js', () => ({ UserWebhookDeliverProcessorService: class {} }));
vi.mock('@/queue/processors/SystemWebhookDeliverProcessorService.js', () => ({ SystemWebhookDeliverProcessorService: class {} }));
vi.mock('@/queue/processors/EndedPollNotificationProcessorService.js', () => ({ EndedPollNotificationProcessorService: class {} }));
vi.mock('@/queue/processors/PostScheduledNoteProcessorService.js', () => ({ PostScheduledNoteProcessorService: class {} }));
vi.mock('@/queue/processors/DeliverProcessorService.js', () => ({ DeliverProcessorService: class {} }));
vi.mock('@/queue/processors/InboxProcessorService.js', () => ({ InboxProcessorService: class {} }));
vi.mock('@/queue/processors/DeleteDriveFilesProcessorService.js', () => ({ DeleteDriveFilesProcessorService: class {} }));
vi.mock('@/queue/processors/ExportCustomEmojisProcessorService.js', () => ({ ExportCustomEmojisProcessorService: class {} }));
vi.mock('@/queue/processors/ExportNotesProcessorService.js', () => ({ ExportNotesProcessorService: class {} }));
vi.mock('@/queue/processors/ExportClipsProcessorService.js', () => ({ ExportClipsProcessorService: class {} }));
vi.mock('@/queue/processors/ExportFollowingProcessorService.js', () => ({ ExportFollowingProcessorService: class {} }));
vi.mock('@/queue/processors/ExportMutingProcessorService.js', () => ({ ExportMutingProcessorService: class {} }));
vi.mock('@/queue/processors/ExportBlockingProcessorService.js', () => ({ ExportBlockingProcessorService: class {} }));
vi.mock('@/queue/processors/ExportUserListsProcessorService.js', () => ({ ExportUserListsProcessorService: class {} }));
vi.mock('@/queue/processors/ExportAntennasProcessorService.js', () => ({ ExportAntennasProcessorService: class {} }));
vi.mock('@/queue/processors/ImportFollowingProcessorService.js', () => ({ ImportFollowingProcessorService: class {} }));
vi.mock('@/queue/processors/ImportMutingProcessorService.js', () => ({ ImportMutingProcessorService: class {} }));
vi.mock('@/queue/processors/ImportBlockingProcessorService.js', () => ({ ImportBlockingProcessorService: class {} }));
vi.mock('@/queue/processors/ImportUserListsProcessorService.js', () => ({ ImportUserListsProcessorService: class {} }));
vi.mock('@/queue/processors/ImportCustomEmojisProcessorService.js', () => ({ ImportCustomEmojisProcessorService: class {} }));
vi.mock('@/queue/processors/ImportAntennasProcessorService.js', () => ({ ImportAntennasProcessorService: class {} }));
vi.mock('@/queue/processors/ImportClipsProcessorService.js', () => ({ ImportClipsProcessorService: class {} }));
vi.mock('@/queue/processors/ChatRoomRosterSyncProcessorService.js', () => ({ ChatRoomRosterSyncProcessorService: class {} }));
vi.mock('@/queue/processors/DeleteAccountProcessorService.js', () => ({ DeleteAccountProcessorService: class {} }));
vi.mock('@/queue/processors/TruncateAccountProcessorService.js', () => ({ TruncateAccountProcessorService: class {} }));
vi.mock('@/queue/processors/ExportFavoritesProcessorService.js', () => ({ ExportFavoritesProcessorService: class {} }));
vi.mock('@/queue/processors/CleanRemoteFilesProcessorService.js', () => ({ CleanRemoteFilesProcessorService: class {} }));
vi.mock('@/queue/processors/DeleteFileProcessorService.js', () => ({ DeleteFileProcessorService: class {} }));
vi.mock('@/queue/processors/RelationshipProcessorService.js', () => ({ RelationshipProcessorService: class {} }));
vi.mock('@/queue/processors/ReportAbuseProcessorService.js', () => ({ ReportAbuseProcessorService: class {} }));
vi.mock('@/queue/processors/TickChartsProcessorService.js', () => ({ TickChartsProcessorService: class {} }));
vi.mock('@/queue/processors/ResyncChartsProcessorService.js', () => ({ ResyncChartsProcessorService: class {} }));
vi.mock('@/queue/processors/CleanChartsProcessorService.js', () => ({ CleanChartsProcessorService: class {} }));
vi.mock('@/queue/processors/CheckExpiredMutingsProcessorService.js', () => ({ CheckExpiredMutingsProcessorService: class {} }));
vi.mock('@/queue/processors/ArchiveAnnouncementProcessorService.js', () => ({ ArchiveAnnouncementProcessorService: class {} }));
vi.mock('@/queue/processors/BakeBufferedReactionsProcessorService.js', () => ({ BakeBufferedReactionsProcessorService: class {} }));
vi.mock('@/queue/processors/CleanProcessorService.js', () => ({ CleanProcessorService: class {} }));
vi.mock('@/queue/processors/AggregateRetentionProcessorService.js', () => ({ AggregateRetentionProcessorService: class {} }));
vi.mock('@/queue/processors/CleanRemoteNotesProcessorService.js', () => ({ CleanRemoteNotesProcessorService: class {} }));
vi.mock('@/queue/processors/ScheduledNoteDeleteProcessorService.js', () => ({ ScheduledNoteDeleteProcessorService: class {} }));
vi.mock('@/queue/QueueLoggerService.js', () => ({ QueueLoggerService: class {} }));

const workers = vi.hoisted(() => new Map<string, (job: any) => Promise<unknown>>());
vi.mock('bullmq', async importOriginal => {
	const original = await importOriginal<typeof import('bullmq')>();
	return { ...original, Worker: class {
		constructor(name: string, process: (job: any) => Promise<unknown>) { workers.set(name, process); }
		on() { return this; }
	} };
});
vi.mock('@/core/NoteCleanupService.js', () => ({ NoteCleanupService: class {}, NOTE_CLEANUP_LIMITS: { roundMs: 10000 } }));

// Worker만 대체하여 실제 system callback → runQueueJob → cleanup processor를 실행한다.
// telemetry 모형은 span callback의 rejection을 기록한다. 실제 collector는 사용하지 않는다.
function fixture() {
	const errors: unknown[] = [];
	const captures: unknown[] = [];
	const spans: unknown[] = [];
	let active = false;
	const logger = { error: vi.fn((...args: unknown[]) => { errors.push(args); expect(active).toBe(true); }), debug: vi.fn(), warn: vi.fn(), createSubLogger: () => logger };
	const telemetry = {
		startSpan: async (_name: string, fn: () => Promise<unknown>) => {
			active = true;
			try { return await fn(); } catch (error) { spans.push(error); throw error; } finally { active = false; }
		},
		captureMessage: vi.fn((...args: unknown[]) => { expect(active).toBe(true); captures.push(args); }),
	};
	const cleanup = new AutoDeleteNotesProcessorService({} as any, { deliverQueue: { getWaiting: async () => [{ timestamp: 0 }] }, inboxQueue: { getWaiting: async () => [] } } as any);
	const other = { process: vi.fn() };
	const localRecovery = { scan: vi.fn(async () => 1) };
	const deliveryRecovery = { scanPage: vi.fn(async () => ({ accepted: 1, full: false })), requestRecovery: vi.fn(async () => {}) };
	const args = [{ redisForJobQueue: {}, outbox: {}, inbox: {} }, {}, { logger }, telemetry, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, cleanup, other, other, localRecovery, deliveryRecovery];
	new (QueueProcessorService as any)(...args);
	return { localRecovery, deliveryRecovery, errors, captures, spans, other, cleanup, active: () => active, process: workers.get('system')! };
}

test('system wrapper의 실제 수동 cleanup 정상 지연은 실패 로그·telemetry·span 오류 없이 원래 제어 오류를 전달한다', async () => {
	const f = fixture();
	let delayed: unknown;
	const process = f.cleanup.process.bind(f.cleanup);
	vi.spyOn(f.cleanup, 'process').mockImplementation(async job => {
		try { return await process(job); } catch (error) { delayed = error; throw error; }
	});
	const job = { id: 'job', opts: {}, timestamp: Date.now(), attemptsMade: 0, name: 'autoDeleteNotes', data: { userId: 'alice', ruleIds: ['rule'] }, token: 'token', moveToDelayed: vi.fn(async () => {}) };
	const thrown = await f.process(job).catch(error => error);
	expect(thrown).toBeInstanceOf(DelayedError);
	expect(thrown).toBe(delayed);
	expect(job.moveToDelayed).toHaveBeenCalledOnce();
	expect(f.errors).toHaveLength(0);
	expect(f.captures).toHaveLength(0);
	expect(f.spans).toHaveLength(0);
	expect(f.active()).toBe(false);
});

test('다른 system 작업의 DelayedError와 cleanup 실제 오류는 기존 실패 관측과 원래 오류를 유지한다', async () => {
	for (const name of ['clean', 'autoDeleteNotes']) {
		const f = fixture();
		const original = name === 'clean' ? new DelayedError() : new Error('infrastructure failed');
		if (name === 'clean') f.other.process.mockRejectedValue(original);
		else vi.spyOn(f.cleanup, 'process').mockRejectedValue(original);
		await expect(f.process({ id: 'job', opts: {}, timestamp: Date.now(), attemptsMade: 0, name, data: {} })).rejects.toBe(original);
		expect(f.errors).toHaveLength(1);
		expect(f.captures).toHaveLength(1);
		expect(f.spans).toEqual([original]);
		expect(f.active()).toBe(false);
	}
});

test('기존 system 복구 주기는 원본 없이 전달 scanner와 로컬 정산을 실행한다', async () => {
	const f = fixture();
	await f.process({ id: 'job', opts: {}, timestamp: Date.now(), attemptsMade: 0, name: 'recoverNoteDeletes', data: {} });

	expect(f.deliveryRecovery.scanPage).toHaveBeenCalledTimes(1);
	expect(f.localRecovery.scan).toHaveBeenCalledTimes(1);
});

test('전달 scanner DB 오류도 로컬 복구를 막거나 정상 완료가 되지 않는다', async () => {
	const f = fixture();
	f.deliveryRecovery.scanPage.mockRejectedValue(new Error('database'));
	await expect(f.process({ id: 'job', opts: {}, timestamp: Date.now(), attemptsMade: 0, name: 'recoverNoteDeletes', data: {} })).rejects.toThrow('database');

	expect(f.localRecovery.scan).toHaveBeenCalledTimes(1);
});

test('가득 찬 전달 또는 로컬 묶음은 즉시 다음 작업을 접수한다', async () => {
	for (const kind of ['delivery', 'local'] as const) {
		const f = fixture();
		if (kind === 'delivery') f.deliveryRecovery.scanPage.mockResolvedValue({ accepted: 0, full: true });
		else f.localRecovery.scan.mockResolvedValue(10);

		await f.process({ id: 'job', opts: {}, timestamp: Date.now(), attemptsMade: 0, name: 'recoverNoteDeletes', data: {} });

		expect(f.deliveryRecovery.requestRecovery).toHaveBeenCalledOnce();
	}
});
