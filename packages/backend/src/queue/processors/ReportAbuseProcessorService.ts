/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable, Inject } from '@nestjs/common';
import { MoreThan, IsNull } from 'typeorm';
import RE2 from 're2';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';
import type { AbuseReportResolversRepository, AbuseUserReportsRepository, UsersRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { SystemAccountService } from '@/core/SystemAccountService.js';
import { AbuseReportNotificationService } from '@/core/AbuseReportNotificationService.js';
import { QueueService } from '@/core/QueueService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type { DbAbuseReportJobData } from '../types.js';
import type * as Bull from 'bullmq';

@Injectable()
export class ReportAbuseProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.abuseReportResolversRepository)
		private abuseReportResolversRepository: AbuseReportResolversRepository,

		@Inject(DI.abuseUserReportsRepository)
		private abuseUserReportsRepository: AbuseUserReportsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private queueLoggerService: QueueLoggerService,
		private systemAccountService: SystemAccountService,
		private apRendererService: ApRendererService,
		private queueService: QueueService,
		private abuseReportNotificationService: AbuseReportNotificationService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('report-abuse');
	}

	@bindThis
	public async process(job: Bull.Job<DbAbuseReportJobData>): Promise<void> {
		this.logger.info('Running...');

		const report = await this.abuseUserReportsRepository.findOneBy({ id: job.data.id });
		if (report == null || report.resolved) return;

		const resolvers = await this.abuseReportResolversRepository.find({
			where: [
				{ expirationDate: MoreThan(new Date()) },
				{ expirationDate: IsNull() },
			],
		});

		const targetUser = await this.usersRepository.findOneByOrFail({
			id: job.data.targetUserId,
		});

		const reporter = await this.usersRepository.findOneByOrFail({
			id: job.data.reporterId,
		});

		const actor = await this.systemAccountService.fetch('actor');

		const targetUserAcct = targetUser.host ? `${targetUser.username.toLowerCase()}@${targetUser.host}` : targetUser.username.toLowerCase();
		const reporterAcct = reporter.host ? `${reporter.username.toLowerCase()}@${reporter.host}` : reporter.username.toLowerCase();

		for (const resolver of resolvers) {
			if (!(resolver.targetUserPattern || resolver.reporterPattern || resolver.reportContentPattern)) {
				continue;
			}
			let matched: boolean;
			try {
				matched = (!resolver.targetUserPattern || new RE2(resolver.targetUserPattern).test(targetUserAcct))
					&& (!resolver.reporterPattern || new RE2(resolver.reporterPattern).test(reporterAcct))
					&& (!resolver.reportContentPattern || new RE2(resolver.reportContentPattern).test(job.data.comment));
			} catch (error) {
				// Older resolver validation accepted RegExp syntax unsupported by RE2.
				// A broken rule must not prevent delivery of moderation notifications.
				this.logger.warn({ message: 'Skipping invalid abuse report resolver', attributes: { resolverId: resolver.id }, error });
				continue;
			}

			if (matched) {
				if (resolver.forward && job.data.targetUserHost !== null && job.data.reporterHost === null) {
					await this.queueService.deliver(actor, this.apRendererService.addContext(this.apRendererService.renderFlag(actor, targetUser.uri!, job.data.comment)), targetUser.inbox, false);
				}

				await this.abuseUserReportsRepository.update(job.data.id, {
					resolved: true,
					assigneeId: actor.id,
					forwarded: resolver.forward && job.data.targetUserHost !== null && job.data.reporterHost === null,
				});

				const resolvedReport = await this.abuseUserReportsRepository.findOneByOrFail({ id: report.id });
				await this.abuseReportNotificationService.notifySystemWebhook([resolvedReport], 'abuseReportResolved');
				return;
			}
		}

		await Promise.all([
			this.abuseReportNotificationService.notifyAdminStream([report]),
			this.abuseReportNotificationService.notifySystemWebhook([report], 'abuseReport'),
			this.abuseReportNotificationService.notifyMail([report]),
		]);
	}
}
