/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { ModerationLogsRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import { IdService } from '@/core/IdService.js';
import { bindThis } from '@/decorators.js';
import type { ModerationLogPayloads } from '@/types.js';
import { moderationLogTypes } from '@/types.js';
import { redactServerSettingsLog } from '@/misc/redact-server-settings-log.js';

@Injectable()
export class ModerationLogService {
	constructor(
		@Inject(DI.moderationLogsRepository)
		private moderationLogsRepository: ModerationLogsRepository,

		private idService: IdService,
	) {
	}

	@bindThis
	public async log<T extends typeof moderationLogTypes[number]>(moderator: { id: MiUser['id'] }, type: T, info?: ModerationLogPayloads[T]) {
		// サーバー設定の変更前後には外部サービスの認証情報が含まれるので、値を伏せてから残す
		const stored = type === 'updateServerSettings' && info != null
			? redactServerSettingsLog(info as ModerationLogPayloads['updateServerSettings'])
			: info;

		await this.moderationLogsRepository.insert({
			id: this.idService.gen(),
			userId: moderator.id,
			type: type,
			info: (stored as any) ?? {},
		});
	}
}
