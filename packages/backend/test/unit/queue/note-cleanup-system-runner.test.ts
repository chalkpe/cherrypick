/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { QueueProcessorService } from '@/queue/QueueProcessorService.js';
import { AutoDeleteNotesProcessorService } from '@/queue/processors/AutoDeleteNotesProcessorService.js';

vi.mock('@/core/UtilityService.js', () => ({ UtilityService: class {} }));
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
vi.mock('@/core/NoteCleanupService.js', async () => {
	const { createHash } = await import('node:crypto');
	return {
		NoteCleanupService: class {}, NOTE_CLEANUP_LIMITS: { roundMs: 10000 },
		noteCleanupRequestJobId: (userId: string, ruleIds: string[]) => `note-cleanup-${userId}-${createHash('sha256').update([...ruleIds].sort().join(',')).digest('hex')}`,
	};
});

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
	const cleanup = new AutoDeleteNotesProcessorService({} as any, { deliverQueue: { getWaiting: async () => [{ timestamp: 0 }] }, inboxQueue: { getWaiting: async () => [] }, systemQueue: { add: vi.fn(async () => {}), getJob: async () => null } } as any);
	const other = { process: vi.fn() };
	const args = [{ redisForJobQueue: {}, outbox: {}, inbox: {} }, {}, { logger }, telemetry, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, other, cleanup, other, other];
	new (QueueProcessorService as any)(...args);
	return { errors, captures, spans, other, cleanup, active: () => active, process: workers.get('system')! };
}

test('수동 정리의 정상 지연은 공통 실행기에 오류를 전달하지 않는다', async () => {
	const f = fixture();
	const job: any = { id: 'job', opts: {}, timestamp: Date.now(), attemptsMade: 0, name: 'autoDeleteNotes', data: { userId: 'alice', ruleIds: ['rule'], requestId: 'request', step: 0 } };
	job.updateData = async (data: unknown) => { job.data = data; };

	await expect(f.process(job)).resolves.toMatchObject({ delayed: true });

	expect(f.errors).toHaveLength(0);
	expect(f.captures).toHaveLength(0);
	expect(f.spans).toHaveLength(0);
});

test('실제 작업 오류는 기존 실패 관측과 원래 오류를 유지한다', async () => {
	const f = fixture();
	const original = new Error('infrastructure failed');
	vi.spyOn(f.cleanup, 'process').mockRejectedValue(original);
	await expect(f.process({ id: 'job', opts: {}, timestamp: Date.now(), attemptsMade: 0, name: 'autoDeleteNotes', data: {} })).rejects.toBe(original);
	expect(f.errors).toHaveLength(1);
	expect(f.captures).toHaveLength(1);
	expect(f.spans).toEqual([original]);
});
