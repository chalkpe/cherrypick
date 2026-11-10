/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { DriveFoldersRepository } from '@/models/_.js';
import { QueryService } from '@/core/QueryService.js';
import { DriveFolderEntityService } from '@/core/entities/DriveFolderEntityService.js';
import { DI } from '@/di-symbols.js';

export const meta = {
	tags: ['drive'],

	requireCredential: true,

	kind: 'read:drive',

	description: 'For name sorting, pass the last folder’s name as untilName with untilId to continue even if the folder is moved or deleted.',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'DriveFolder',
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
		sort: { type: 'string', nullable: true, enum: ['+createdAt', '-createdAt', '+name', '-name', null] },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
		folderId: { type: 'string', format: 'misskey:id', nullable: true, default: null },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFoldersRepository)
		private driveFoldersRepository: DriveFoldersRepository,

		private driveFolderEntityService: DriveFolderEntityService,
		private queryService: QueryService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const nameSort = ps.sort === '+name' || ps.sort === '-name';
			let cursorName = ps.untilName;
			if (nameSort && ps.untilId != null && cursorName == null) {
				const cursor = await this.driveFoldersRepository.findOne({
					select: { name: true },
					where: { id: ps.untilId, userId: me.id, parentId: ps.folderId ?? IsNull() },
				});
				cursorName = cursor?.name;
			}
			const nameCursor = nameSort && ps.untilId != null && cursorName != null;
			const query = this.queryService.makePaginationQuery(this.driveFoldersRepository.createQueryBuilder('folder'), ps.sinceId, nameCursor ? undefined : ps.untilId, ps.sinceDate, ps.untilDate)
				.andWhere('folder.userId = :userId', { userId: me.id });

			if (ps.folderId) {
				query.andWhere('folder.parentId = :parentId', { parentId: ps.folderId });
			} else {
				query.andWhere('folder.parentId IS NULL');
			}

			if (ps.sort === '+name' || ps.sort === '-name') {
				const direction = ps.sort === '+name' ? 'DESC' : 'ASC';
				if (nameCursor) {
					const operator = direction === 'DESC' ? '<' : '>';
					query.andWhere(`(folder.name, folder.id) ${operator} (:untilName, :cursorId)`, { untilName: cursorName, cursorId: ps.untilId });
				}
				query.orderBy('folder.name', direction).addOrderBy('folder.id', direction);
			} else if (ps.sort === '+createdAt') {
				query.orderBy('folder.id', 'DESC');
			} else if (ps.sort === '-createdAt') {
				query.orderBy('folder.id', 'ASC');
			}

			const folders = await query.limit(ps.limit).getMany();

			return await Promise.all(folders.map(folder => this.driveFolderEntityService.pack(folder)));
		});
	}
}
