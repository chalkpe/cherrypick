/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { DriveService } from '@/core/DriveService.js';
import { DriveFileUsageService } from '@/core/DriveFileUsageService.js';
import { DI } from '@/di-symbols.js';

export const meta = {
	tags: ['drive'],

	requireCredential: true,

	kind: 'write:drive',

	description: 'Delete multiple drive files owned by the requesting user that are not referenced anywhere (the same check as drive/files/unused). Files that are in use, belong to someone else or do not exist are skipped. Returns the IDs that were actually deleted.',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'string',
			optional: false, nullable: false,
			format: 'id',
		},
	},

	errors: {
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		fileIds: { type: 'array', uniqueItems: true, minItems: 1, maxItems: 100, items: { type: 'string', format: 'misskey:id' } },
	},
	required: ['fileIds'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private driveService: DriveService,
		private driveFileUsageService: DriveFileUsageService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// 一覧を取得してから削除するまでの間に添付された場合に備え、削除直前にもう一度未使用かどうかを確かめる。
			// 他人のファイルや存在しない ID もここで落ちる
			const query = this.driveFilesRepository.createQueryBuilder('file')
				.andWhere('file.id IN (:...fileIds)', { fileIds: ps.fileIds });
			this.driveFileUsageService.applyUnusedFilter(query, me.id);
			const files = await query.getMany();

			for (const file of files) {
				await this.driveService.deleteFile(file, false, me);
			}

			return files.map(file => file.id);
		});
	}
}
