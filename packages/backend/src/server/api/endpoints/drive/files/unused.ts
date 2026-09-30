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

export const meta = {
	tags: ['drive'],

	requireCredential: true,

	kind: 'read:drive',

	description: 'List drive files that are not referenced by any note, draft, chat message, gallery post, page, channel, avatar or banner. Folders are ignored. Paginate with offset (an id cursor does not work with the size / name sorts).',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'DriveFile',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		offset: { type: 'integer', minimum: 0, default: 0 },
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

			// 同じサイズ・名前が並んだときにページ間で順序が揺れないよう、常に id を第二キーにする
			switch (ps.sort) {
				case '-createdAt': query.orderBy('file.id', 'ASC'); break;
				case '+name': query.orderBy('file.name', 'DESC').addOrderBy('file.id', 'DESC'); break;
				case '-name': query.orderBy('file.name', 'ASC').addOrderBy('file.id', 'DESC'); break;
				case '+size': query.orderBy('file.size', 'DESC').addOrderBy('file.id', 'DESC'); break;
				case '-size': query.orderBy('file.size', 'ASC').addOrderBy('file.id', 'DESC'); break;
				case '+createdAt':
				default: query.orderBy('file.id', 'DESC'); break;
			}

			const files = await query.offset(ps.offset).limit(ps.limit).getMany();

			return await this.driveFileEntityService.packMany(files, { detail: false, self: true });
		});
	}
}
