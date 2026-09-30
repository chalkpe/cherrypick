/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { DriveService } from '@/core/DriveService.js';
import { DI } from '@/di-symbols.js';

export const meta = {
	tags: ['drive'],

	requireCredential: true,

	kind: 'write:drive',

	description: 'Delete multiple drive files owned by the requesting user. IDs of files that do not exist or belong to someone else are skipped.',

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
	) {
		super(meta, paramDef, async (ps, me) => {
			// 自分のファイルだけを対象にする。他人のファイルや存在しない ID は黙って読み飛ばす
			const files = await this.driveFilesRepository.findBy({
				id: In(ps.fileIds),
				userId: me.id,
			});

			for (const file of files) {
				await this.driveService.deleteFile(file, false, me);
			}
		});
	}
}
