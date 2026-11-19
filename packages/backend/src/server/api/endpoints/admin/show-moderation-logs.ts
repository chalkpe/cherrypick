/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { ModerationLogsRepository } from '@/models/_.js';
import { QueryService } from '@/core/QueryService.js';
import { DI } from '@/di-symbols.js';
import { ModerationLogEntityService } from '@/core/entities/ModerationLogEntityService.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import { REDACTED_META_KEYS } from '@/misc/redact-server-settings-log.js';
import { SYSTEM_WEBHOOK_SECRET_KEY } from '@/misc/redact-system-webhook-log.js';
import { ApiError } from '@/server/api/error.js';

/**
 * #-는 배열이나 문자열 안의 객체 키를 제거할 때 오류가 날 수 있어 대상 필드가 객체일 때만 적용한다.
 */
function withoutRedactedKeys(expression: string, side: 'before' | 'after' | 'webhook', keys: readonly string[] = REDACTED_META_KEYS): string {
	const removed = keys.reduce((result, key) => `(${result} #- '{${side},${key}}'::text[])`, expression);
	return `CASE WHEN jsonb_typeof(log.info -> '${side}') = 'object' THEN ${removed} ELSE ${expression} END`;
}

// 예전에 기록된 서버 설정과 시스템 웹훅의 인증 정보도 검색 범위에서 제외한다.
const WEBHOOK_REDACTED_KEYS = [SYSTEM_WEBHOOK_SECRET_KEY];
const SEARCHABLE_INFO = `CASE
	WHEN log.type = 'updateServerSettings' THEN ${withoutRedactedKeys(withoutRedactedKeys('log.info', 'before'), 'after')}
	WHEN log.type = 'updateSystemWebhook' THEN ${withoutRedactedKeys(withoutRedactedKeys('log.info', 'before', WEBHOOK_REDACTED_KEYS), 'after', WEBHOOK_REDACTED_KEYS)}
	WHEN log.type IN ('createSystemWebhook', 'deleteSystemWebhook') THEN ${withoutRedactedKeys('log.info', 'webhook', WEBHOOK_REDACTED_KEYS)}
	ELSE log.info
END`;

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireAdmin: true,
	kind: 'read:admin:show-moderation-log',

	errors: {
		invalidSearch: {
			message: 'The search text must not contain NUL characters.',
			code: 'INVALID_PARAM',
			id: '90b4d94d-168d-48ab-b8fe-ae8bcea3ba05',
		},
	},

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			properties: {
				id: {
					type: 'string',
					optional: false, nullable: false,
					format: 'id',
				},
				createdAt: {
					type: 'string',
					optional: false, nullable: false,
					format: 'date-time',
				},
				type: {
					type: 'string',
					optional: false, nullable: false,
				},
				info: {
					type: 'object',
					optional: false, nullable: false,
				},
				userId: {
					type: 'string',
					optional: false, nullable: false,
					format: 'id',
				},
				user: {
					type: 'object',
					optional: false, nullable: false,
					ref: 'UserDetailedNotMe',
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
		type: { type: 'string', nullable: true },
		userId: { type: 'string', format: 'misskey:id', nullable: true },
		search: { type: 'string', nullable: true },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.moderationLogsRepository)
		private moderationLogsRepository: ModerationLogsRepository,

		private moderationLogEntityService: ModerationLogEntityService,
		private queryService: QueryService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const query = this.queryService.makePaginationQuery(this.moderationLogsRepository.createQueryBuilder('log'), ps.sinceId, ps.untilId, ps.sinceDate, ps.untilDate);

			if (ps.type != null) {
				query.andWhere('log.type = :type', { type: ps.type });
			}

			if (ps.userId != null) {
				query.andWhere('log.userId = :userId', { userId: ps.userId });
			}

			if (ps.search != null) {
				// PostgreSQL の text は NUL を持てず、引数に入るとエラーになるので、問い合わせる前に断る
				if (ps.search.includes('\u0000')) throw new ApiError(meta.errors.invalidSearch);
				const escapedSearch = sqlLikeEscape(ps.search);
				query.andWhere(`(${SEARCHABLE_INFO})::text ILIKE :search`, { search: `%${escapedSearch}%` });
			}

			const logs = await query.limit(ps.limit).getMany();

			return await this.moderationLogEntityService.packMany(logs);
		});
	}
}
