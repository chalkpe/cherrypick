/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import { Not } from 'typeorm';
import { NoteDeleteDeliveryService } from '@/core/NoteDeleteDeliveryService.js';
import type { NoteDeleteDeliveryResult } from '@/core/NoteDeleteDeliveryService.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type { InstancesRepository, MiMeta } from '@/models/_.js';
import type Logger from '@/logger.js';
import { ApRequestService } from '@/core/activitypub/ApRequestService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import { MemorySingleCache } from '@/misc/cache.js';
import type { MiInstance } from '@/models/Instance.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import ApRequestChart from '@/core/chart/charts/ap-request.js';
import FederationChart from '@/core/chart/charts/federation.js';
import { StatusError } from '@/misc/status-error.js';
import { UtilityService } from '@/core/UtilityService.js';
import { bindThis } from '@/decorators.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type { DeliverJobData, DeliveryQueueJobData, NoteDeleteDeliverJobData } from '../types.js';

@Injectable()
export class DeliverProcessorService {
	private logger: Logger;
	private suspendedHostsCache: MemorySingleCache<MiInstance[]>;
	private latest: string | null;

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private utilityService: UtilityService,
		private federatedInstanceService: FederatedInstanceService,
		private fetchInstanceMetadataService: FetchInstanceMetadataService,
		private apRequestService: ApRequestService,
		private instanceChart: InstanceChart,
		private apRequestChart: ApRequestChart,
		private federationChart: FederationChart,
		private queueLoggerService: QueueLoggerService,
		private noteDeleteDeliveryService: NoteDeleteDeliveryService,
		@Inject(DI.config) private config: Config,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('deliver');
		this.suspendedHostsCache = new MemorySingleCache<MiInstance[]>(1000 * 60 * 60); // 1h
	}

	@bindThis
	public async process(job: Bull.Job<DeliveryQueueJobData>): Promise<string> {
		if ('noteDeleteDelivery' in job.data) {
			try {
				return await this.processNoteDelete(job.data, String(job.id));
			} catch {
				throw new Error('delete delivery processing failed');
			}
		}
		return this.deliver(job.data);
	}

	private async deliver(data: DeliverJobData, beforeSend?: () => Promise<void>, started?: () => boolean): Promise<string> {
		const { host } = new URL(data.to);

		if (!this.utilityService.isFederationAllowedUri(data.to)) {
			return 'skip (blocked)';
		}

		// isSuspendedなら中断
		let suspendedHosts = this.suspendedHostsCache.get();
		if (suspendedHosts == null) {
			suspendedHosts = await this.instancesRepository.find({
				where: {
					suspensionState: Not('none'),
				},
			});
			this.suspendedHostsCache.set(suspendedHosts);
		}
		if (suspendedHosts.map(x => x.host).includes(this.utilityService.toPuny(host))) {
			return 'skip (suspended)';
		}

		const i = await (this.meta.enableStatsForFederatedInstances
			? this.federatedInstanceService.fetchOrRegister(host)
			: this.federatedInstanceService.fetch(host));

		// suspend server by software
		if (i != null && this.utilityService.isDeliverSuspendedSoftware(i)) {
			return 'skip (software suspended)';
		}

		try {
			await this.apRequestService.signedPost(data.user, data.to, data.content, data.digest, beforeSend);

			this.apRequestChart.deliverSucc();
			this.federationChart.deliverd(host, true);

			// Update instance stats
			process.nextTick(async () => {
				if (i == null) return;

				if (i.isNotResponding) {
					this.federatedInstanceService.update(i.id, {
						isNotResponding: false,
						notRespondingSince: null,
					});
				}

				if (this.meta.enableStatsForFederatedInstances) {
					this.fetchInstanceMetadataService.fetchInstanceMetadata(i);
				}

				if (this.meta.enableChartsForFederatedInstances) {
					this.instanceChart.requestSent(i.host, true);
				}
			});

			return 'Success';
		} catch (res) {
			// 영속 전달의 준비 실패와 정상 stale 제어는 원격 실패 통계로 세지 않는다.
			if (started && !started()) throw res;
			this.apRequestChart.deliverFail();
			this.federationChart.deliverd(host, false);

			// Update instance stats
			this.federatedInstanceService.fetchOrRegister(host).then(i => {
				if (!i.isNotResponding) {
					this.federatedInstanceService.update(i.id, {
						isNotResponding: true,
						notRespondingSince: new Date(),
					});
				} else if (i.notRespondingSince) {
					// 1週間以上不通ならサスペンド
					if (i.suspensionState === 'none' && i.notRespondingSince.getTime() <= Date.now() - 1000 * 60 * 60 * 24 * 7) {
						this.federatedInstanceService.update(i.id, {
							suspensionState: 'autoSuspendedForNotResponding',
						});
					}
				} else {
					// isNotRespondingがtrueでnotRespondingSinceがnullの場合はnotRespondingSinceをセット
					// notRespondingSinceは新たな機能なので、それ以前のデータにはnotRespondingSinceがない場合がある
					this.federatedInstanceService.update(i.id, {
						notRespondingSince: new Date(),
					});
				}

				if (this.meta.enableChartsForFederatedInstances) {
					this.instanceChart.requestSent(i.host, false);
				}
			});

			if (res instanceof StatusError) {
				// 4xx
				if (!res.isRetryable) {
					// 相手が閉鎖していることを明示しているため、配送停止する
					if (data.isSharedInbox && res.statusCode === 410) {
						this.federatedInstanceService.fetchOrRegister(host).then(i => {
							this.federatedInstanceService.update(i.id, {
								suspensionState: 'goneSuspended',
							});
						});
						throw new Bull.UnrecoverableError(`${host} is gone`);
					}
					throw new Bull.UnrecoverableError(`${res.statusCode} ${res.statusMessage}`);
				}

				// 5xx etc.
				throw new Error(`${res.statusCode} ${res.statusMessage}`);
			} else {
				// DNS error, socket error, timeout ...
				throw res;
			}
		}
	}

	private async processNoteDelete(job: NoteDeleteDeliverJobData, jobId: string): Promise<string> {
		const bridge = this.noteDeleteDeliveryService;
		const claimed = await bridge.claim(job.noteDeleteDelivery, jobId);
		if (!claimed) return 'delete delivery stale or busy';
		const { claim, data } = claimed;
		const stale = new Error('delete delivery stale');
		const exhausted = new Error('delete delivery budget exhausted');
		let remoteStarted = false;
		let remoteAttempts = 0;
		let lost = false;
		let databaseError: unknown;
		let renewal: Promise<void> = Promise.resolve();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		const schedule = () => {
			timer = setTimeout(() => {
				renewal = (async () => {
					try { lost = !await bridge.renew(claim); } catch (error) { databaseError = error; lost = true; }
					if (!stopped && !lost) schedule();
				})();
			}, 20_000);
		};
		schedule();
		let result: NoteDeleteDeliveryResult;
		try {
			try {
				// Redis에는 식별자만 맡기며 실제 대상과 전송 문자열은 DB에서 가져온다.
				const response = await this.deliver(data, async () => {
					if (databaseError) throw databaseError;
					if (lost) throw stale;
					try {
						const current = await bridge.validateBeforeSend(claim);
						if (!current) throw stale;
						if (current.to !== data.to || current.content !== data.content || current.digest !== data.digest || current.user.id !== data.user.id || current.isSharedInbox !== data.isSharedInbox) throw stale;
						const attempt = await bridge.recordRemoteAttempt(claim, this.config.deliverJobMaxAttempts ?? 12);
						if (!attempt) throw stale;
						if (attempt.outcome === 'exhausted') throw exhausted;
						remoteAttempts = attempt.attempts;
					} catch (error) {
						if (error !== stale && error !== exhausted) databaseError = error;
						throw error;
					}
					remoteStarted = true;
				}, () => remoteStarted);
				result = response === 'Success' ? { outcome: 'delivered' } : {
					outcome: 'skipped', code: response === 'skip (blocked)' ? 'blocked' : response === 'skip (suspended)' ? 'suspended' : 'software_suspended',
				};
			} catch (error) {
				if (databaseError) throw databaseError;
				if (error === stale) return 'delete delivery stale';
				if (!remoteStarted && error !== exhausted && !lost && await bridge.settleRemovedOwner(claim, claim)) return 'delete delivery owner_removed';
				if (error === exhausted) result = { outcome: 'permanentFailed', code: 'remote_budget_exhausted' };
				else if (remoteStarted && error instanceof Bull.UnrecoverableError) result = { outcome: 'permanentFailed', code: 'remote_permanent' };
				else if (remoteStarted && remoteAttempts >= (this.config.deliverJobMaxAttempts ?? 12)) result = { outcome: 'permanentFailed', code: 'remote_budget_exhausted' };
				else {
					// 영속 작업은 Bull 재시도와 경쟁하지 않고 DB scanner가 다음 접수를 담당한다.
					const delay = Math.min(3_600_000, 5_000 * 2 ** Math.min(remoteAttempts, 10));
					result = { outcome: 'temporaryFailed', code: remoteStarted ? 'remote_retryable' : 'preparation_failed', nextAttemptAt: new Date(Date.now() + delay) };
				}
			}
		} finally {
			stopped = true;
			clearTimeout(timer);
			await renewal;
		}
		if (databaseError) throw databaseError;
		if (lost) return 'delete delivery lease lost';
		// 외부 성공 뒤 ack 유실은 재전송될 수 있다. DB 오류는 성공으로 덮지 않는다.
		if (!await bridge.acknowledge(claim, result)) return 'delete delivery stale acknowledgement';
		return `delete delivery ${result.outcome}`;
	}
}
