/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ReportAbuseProcessorService } from '@/queue/processors/ReportAbuseProcessorService.js';
import { AbuseReportService } from '@/core/AbuseReportService.js';
import { AbuseReportNotificationService } from '@/core/AbuseReportNotificationService.js';

function fixture(resolvers: object[] = []) {
	const report = { id: 'report', targetUserId: 'target', reporterId: 'reporter', targetUserHost: null, reporterHost: null, comment: 'spam', resolved: false };
	const reports = { findOneBy: vi.fn().mockResolvedValue(report), findOneByOrFail: vi.fn().mockResolvedValue({ ...report, resolved: true }), update: vi.fn() };
	const notifications = { notifyAdminStream: vi.fn(), notifySystemWebhook: vi.fn(), notifyMail: vi.fn() };
	const queue = { deliver: vi.fn() };
	const processor = new ReportAbuseProcessorService(
		{ find: async () => resolvers } as never,
		reports as never,
		{ findOneByOrFail: async ({ id }: { id: string }) => ({ id, username: id, host: null }) } as never,
		{ logger: { createSubLogger: () => ({ info: vi.fn(), warn: vi.fn() }) } } as never,
		{ fetch: async () => ({ id: 'actor' }) } as never,
		{} as never,
		queue as never,
		notifications as never,
	);
	return { processor, report, reports, notifications, queue };
}

describe('Abuse report resolver pipeline', () => {
	test('enqueues persisted reports once without notifying before resolution', async () => {
		const { report, notifications } = fixture();
		const createReportAbuseJob = vi.fn();
		const service = new AbuseReportService(
			{ insertOne: async () => report } as never, {} as never,
			{ gen: () => 'report' } as never, notifications as never,
			{ createReportAbuseJob } as never, {} as never, {} as never, {} as never,
		);
		await service.report([report]);
		expect(createReportAbuseJob).toHaveBeenCalledExactlyOnceWith(report);
		expect(notifications.notifyAdminStream).not.toHaveBeenCalled();
		expect(notifications.notifyMail).not.toHaveBeenCalled();
	});

	test('matching resolver resolves the report and suppresses new-report notifications', async () => {
		const { processor, report, reports, notifications } = fixture([{ reportContentPattern: '^spam$', forward: false }]);
		await processor.process({ data: report } as never);
		expect(reports.update).toHaveBeenCalledExactlyOnceWith('report', { resolved: true, assigneeId: 'actor', forwarded: false });
		expect(notifications.notifyAdminStream).not.toHaveBeenCalled();
		expect(notifications.notifyMail).not.toHaveBeenCalled();
		expect(notifications.notifySystemWebhook).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ resolved: true })], 'abuseReportResolved');
	});

	test('nonmatching resolver retains upstream notification channels exactly once', async () => {
		const { processor, report, reports, notifications } = fixture([{ reportContentPattern: '^other$' }]);
		await processor.process({ data: report } as never);
		expect(reports.update).not.toHaveBeenCalled();
		expect(notifications.notifyAdminStream).toHaveBeenCalledExactlyOnceWith([report]);
		expect(notifications.notifyMail).toHaveBeenCalledExactlyOnceWith([report]);
		expect(notifications.notifySystemWebhook).toHaveBeenCalledExactlyOnceWith([report], 'abuseReport');
	});

	test('invalid stored RE2 pattern does not block moderation notifications', async () => {
		const { processor, report, reports, notifications } = fixture([{ reportContentPattern: '(?=spam)' }]);
		await processor.process({ data: report } as never);
		expect(reports.update).not.toHaveBeenCalled();
		expect(notifications.notifyAdminStream).toHaveBeenCalledExactlyOnceWith([report]);
		expect(notifications.notifyMail).toHaveBeenCalledExactlyOnceWith([report]);
		expect(notifications.notifySystemWebhook).toHaveBeenCalledExactlyOnceWith([report], 'abuseReport');
	});

	test.each([null, { resolved: true }])('ignores absent or already resolved reports: %s', async saved => {
		const { processor, report, reports, notifications } = fixture();
		reports.findOneBy.mockResolvedValue(saved);
		await processor.process({ data: report } as never);
		expect(reports.update).not.toHaveBeenCalled();
		for (const notify of Object.values(notifications)) expect(notify).not.toHaveBeenCalled();
	});

	test('email suppression prevents recipient lookup and delivery', async () => {
		const sendEmail = vi.fn();
		const service = new AbuseReportNotificationService(
			{ doNotSendNotificationEmailsForAbuseReport: true } as never, {} as never,
			{ on: vi.fn(), off: vi.fn() } as never, {} as never, {} as never, {} as never,
			{ sendEmail } as never, {} as never, {} as never, {} as never,
		);
		await service.notifyMail([fixture().report as never]);
		expect(sendEmail).not.toHaveBeenCalled();
		service.dispose();
	});
});
