/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { DriveFileUsageService } from '@/core/DriveFileUsageService.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '../../../error.js';

// 並び替えキーと向き。同じサイズ・名前が並んでもページ間で順序が揺れないよう、id を同じ向きの第二キーにする
const SORTS = {
	'+createdAt': ['id', 'DESC'],
	'-createdAt': ['id', 'ASC'],
	'+name': ['name', 'DESC'],
	'-name': ['name', 'ASC'],
	'+size': ['size', 'DESC'],
	'-size': ['size', 'ASC'],
} as const;

export const meta = {
	tags: ['drive'],

	requireCredential: true,

	kind: 'read:drive',

	description: 'List drive files that are not referenced by any note, draft, chat message, gallery post, page, channel, avatar or banner. Folders are ignored. To paginate, pass the last file of the previous page as untilId, plus its size as untilSize (size sorts) or its name as untilName (name sorts).',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'DriveFile',
		},
	},

	errors: {
		cursorKeyRequired: {
			message: 'untilSize or untilName is required with untilId for this sort.',
			code: 'CURSOR_KEY_REQUIRED',
			id: '3fa16e18-a928-4f04-8471-3da956576bd0',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		untilId: { type: 'string', format: 'misskey:id' },
		untilSize: { type: 'integer', minimum: 0 },
		untilName: { type: 'string' },
		sort: { type: 'string', nullable: true, enum: ['+createdAt', '-createdAt', '+name', '-name', '+size', '-size', null] },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private driveFileEntityService: DriveFileEntityService,
		private driveFileUsageService: DriveFileUsageService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const query = this.driveFilesRepository.createQueryBuilder('file');

			this.driveFileUsageService.applyUnusedFilter(query, me.id);

			const [key, dir] = SORTS[ps.sort ?? '+createdAt'];
			const op = dir === 'DESC' ? '<' : '>';

			// OFFSET だと読み飛ばす行にも参照チェックが走るので、前ページ末尾のファイルを基準にしたキーセットで読み進める。
			// 末尾のファイルが別の場所で削除されても続きを読めるよう、並び替えキーの値はクライアントから受け取る
			if (ps.untilId) {
				if (key === 'id') {
					query.andWhere(`file.id ${op} :untilId`, { untilId: ps.untilId });
				} else {
					const cursorKey = key === 'size' ? ps.untilSize : ps.untilName;
					if (cursorKey == null) throw new ApiError(meta.errors.cursorKeyRequired);
					query.andWhere(`(file.${key}, file.id) ${op} (:cursorKey, :untilId)`, { cursorKey, untilId: ps.untilId });
				}
			}

			query.orderBy(`file.${key}`, dir);
			if (key !== 'id') query.addOrderBy('file.id', dir);

			const files = await query.limit(ps.limit).getMany();

			return await this.driveFileEntityService.packMany(files, { detail: false, self: true });
		});
	}
}
