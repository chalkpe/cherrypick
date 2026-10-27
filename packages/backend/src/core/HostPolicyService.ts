/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { InstancesRepository } from '@/models/_.js';
import type { MiMeta } from '@/models/Meta.js';
import { bindThis } from '@/decorators.js';
import { UtilityService } from '@/core/UtilityService.js';
import { hostLookupCandidates, isHostInList, normalizeHost } from '@/core/ActivityPubAccessControlService.js';

/**
 * 他のサーバーのホストを、このサーバーが断っているかを決める。
 * inbox (InboxProcessorService) が他のサーバーからのアクティビティを捨てる条件と揃える。
 * - 連合が許されていないホスト。inbox と同じく、正規化した名前 (ポートと末尾のドットを除いた小文字の punycode) だけで決める
 * - inbox と同じく、ポート・末尾のドット・大文字小文字・Unicode の違いを無視して、ブロックの指定に当たるホスト
 * - 停止 (手動・自動を問わない) されたサーバー。toPuny した記録 (FederatedInstanceService.fetch が引く記録。
 *   domainToASCII はポート付きのホストに '' を返すので、ポート付きのサーバーはすべて '' の記録にまとめられている) と、
 *   そのサーバーの記録 (hostLookupCandidates) のどれかにあれば従う
 * - 隔離 (quarantineLimited) されたサーバー。inbox と同じく、そのサーバーの記録 (hostLookupCandidates) だけで決める
 * 記録はキャッシュを通さず、いまのものを見る。ホストとして読めないものも断る
 */
@Injectable()
export class HostPolicyService {
	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private utilityService: UtilityService,
	) {
	}

	@bindThis
	public async isRefusedRemoteHost(host: string): Promise<boolean> {
		return (await this.refusedRemoteHostsOf([host])).get(host) ?? true;
	}

	/**
	 * hosts のそれぞれを断っているか (isRefusedRemoteHost)。サーバーの記録は一度にまとめて引き、設定だけで断るホストの記録は引かない
	 */
	@bindThis
	public async refusedRemoteHostsOf(hosts: string[]): Promise<Map<string, boolean>> {
		const result = new Map<string, boolean>();
		const pending: { host: string; suspensionHosts: Set<string>; quarantineHosts: Set<string> }[] = [];
		for (const host of new Set(hosts)) {
			const normalized = normalizeHost(host);
			if (normalized == null || !this.utilityService.isFederationAllowedHost(normalized) || isHostInList(this.meta.blockedHosts, host)) {
				result.set(host, true);
				continue;
			}
			const quarantineHosts = new Set(hostLookupCandidates(host));
			pending.push({ host, suspensionHosts: new Set([this.utilityService.toPuny(host), ...quarantineHosts]), quarantineHosts });
		}
		if (pending.length === 0) return result;

		const instances = await this.instancesRepository.findBy({ host: In([...new Set(pending.flatMap(p => [...p.suspensionHosts]))]) });
		for (const { host, suspensionHosts, quarantineHosts } of pending) {
			result.set(host, instances.some(instance =>
				(suspensionHosts.has(instance.host) && instance.suspensionState !== 'none')
				|| (quarantineHosts.has(instance.host) && instance.quarantineLimited)));
		}
		return result;
	}
}
