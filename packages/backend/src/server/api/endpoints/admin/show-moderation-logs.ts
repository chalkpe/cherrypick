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

/**
 * expression (log.info から作った jsonb) から、log.info の side (before か after) がオブジェクトのときだけ、伏せる項目を除く。
 * #- はオブジェクトでない値 (配列・文字列・null など) の中を指すとエラーになり、そういう記録が一つでもあるとどの検索も失敗するので、
 * jsonb_typeof で確かめる。log.info がオブジェクトでなければ log.info -> side は NULL になり、何も除かない
 */
function withoutRedactedKeys(expression: string, side: 'before' | 'after'): string {
	const removed = REDACTED_META_KEYS.reduce((result, key) => `(${result} #- '{${side},${key}}'::text[])`, expression);
	return `CASE WHEN jsonb_typeof(log.info -> '${side}') = 'object' THEN ${removed} ELSE ${expression} END`;
}

// 伏せるようにする前に残されたサーバー設定の変更履歴から、認証情報を検索で一文字ずつ当てられないよう、検索する範囲から除く。
// 他の種類のログの before / after は配列や文字列のこともあるので、サーバー設定の変更履歴 (meta か policies) に限る
const SEARCHABLE_INFO = `CASE WHEN log.type = 'updateServerSettings' THEN ${withoutRedactedKeys(withoutRedactedKeys('log.info', 'before'), 'after')} ELSE log.info END`;

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireAdmin: true,
	kind: 'read:admin:show-moderation-log',

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
				const escapedSearch = sqlLikeEscape(ps.search);
				query.andWhere(`(${SEARCHABLE_INFO})::text ILIKE :search`, { search: `%${escapedSearch}%` });
			}

			const logs = await query.limit(ps.limit).getMany();

			return await this.moderationLogEntityService.packMany(logs);
		});
	}
}
