/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { QueryService } from '@/core/QueryService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { DI } from '@/di-symbols.js';

export const meta = {
	tags: ['drive'],

	requireCredential: true,

	kind: 'read:drive',

	description: 'For name or size sorting, pass the last file’s name as untilName or size as untilSize with untilId to continue even if the file is moved or deleted.',

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
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		untilName: { type: 'string' },
		untilSize: { type: 'integer', minimum: 0 },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
		folderId: { type: 'string', format: 'misskey:id', nullable: true, default: null },
		type: { type: 'string', nullable: true, pattern: /^[a-zA-Z\/\-*]+$/.toString().slice(1, -1) },
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
		private queryService: QueryService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const sortKey = ps.sort === '+name' || ps.sort === '-name' ? 'name' : ps.sort === '+size' || ps.sort === '-size' ? 'size' : undefined;
			let cursorKey = sortKey === 'name' ? ps.untilName : sortKey === 'size' ? ps.untilSize : undefined;
			if (sortKey && ps.untilId != null && cursorKey == null) {
				const cursor = await this.driveFilesRepository.findOne({
					select: { name: true, size: true },
					where: { id: ps.untilId, userId: me.id, folderId: ps.folderId ?? IsNull() },
				});
				cursorKey = cursor?.[sortKey];
			}
			const hasSortCursor = ps.untilId != null && cursorKey != null;
			const query = this.queryService.makePaginationQuery(this.driveFilesRepository.createQueryBuilder('file'), ps.sinceId, hasSortCursor ? undefined : ps.untilId, ps.sinceDate, ps.untilDate)
				.andWhere('file.userId = :userId', { userId: me.id });

			if (ps.folderId) {
				query.andWhere('file.folderId = :folderId', { folderId: ps.folderId });
			} else {
				query.andWhere('file.folderId IS NULL');
			}

			if (ps.type) {
				if (ps.type.endsWith('/*')) {
					query.andWhere('file.type like :type', { type: ps.type.replace('/*', '/') + '%' });
				} else {
					query.andWhere('file.type = :type', { type: ps.type });
				}
			}

			if (hasSortCursor) {
				const operator = ps.sort === '+name' || ps.sort === '+size' ? '<' : '>';
				query.andWhere(`(file.${sortKey}, file.id) ${operator} (:cursorKey, :cursorId)`, { cursorKey, cursorId: ps.untilId });
			}

			switch (ps.sort) {
				case '+createdAt': query.orderBy('file.id', 'DESC'); break;
				case '-createdAt': query.orderBy('file.id', 'ASC'); break;
				case '+name': query.orderBy('file.name', 'DESC').addOrderBy('file.id', 'DESC'); break;
				case '-name': query.orderBy('file.name', 'ASC').addOrderBy('file.id', 'ASC'); break;
				case '+size': query.orderBy('file.size', 'DESC').addOrderBy('file.id', 'DESC'); break;
				case '-size': query.orderBy('file.size', 'ASC').addOrderBy('file.id', 'ASC'); break;
			}

			const files = await query.limit(ps.limit).getMany();

			return await this.driveFileEntityService.packMany(files, { detail: false, self: true });
		});
	}
}
