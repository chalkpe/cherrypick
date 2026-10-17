/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { QueueService } from '@/core/QueueService.js';
import { RoleService } from '@/core/RoleService.js';
import { DriveService } from '@/core/DriveService.js';
import { validateExportedClips } from '@/misc/exported-clips.js';
import type { ClipsRepository, DriveFilesRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '../../error.js';

export const meta = {
	secure: true,
	requireCredential: true,
	requiredRolePolicy: 'canImportClips',
	prohibitMoved: true,

	limit: {
		duration: ms('1hour'),
		max: 1,
	},

	errors: {
		noSuchFile: {
			message: 'No such file.',
			code: 'NO_SUCH_FILE',
			id: 'e30e0808-e37b-4068-bfd5-888b794f3397',
		},
		emptyFile: {
			message: 'That file is empty.',
			code: 'EMPTY_FILE',
			id: '2e26003c-0f44-43f3-bed0-b7745fa21a31',
		},
		invalidFileFormat: {
			message: 'That file is not an exported clips file.',
			code: 'INVALID_FILE_FORMAT',
			id: 'ba474685-c641-40a4-bedb-b8aabc5b0333',
		},
		tooManyClips: {
			message: 'You cannot create clip any more.',
			code: 'TOO_MANY_CLIPS',
			id: 'b70fc078-3a36-43c8-9022-04e9e929420d',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		fileId: { type: 'string', format: 'misskey:id' },
	},
	required: ['fileId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.clipsRepository)
		private clipsRepository: ClipsRepository,

		private roleService: RoleService,
		private queueService: QueueService,
		private driveService: DriveService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const file = await this.driveFilesRepository.findOneBy({ id: ps.fileId, userId: me.id });
			if (file == null) throw new ApiError(meta.errors.noSuchFile);
			if (file.size === 0) throw new ApiError(meta.errors.emptyFile);

			const text = await this.driveService.readFileAsText(file);
			let clips: unknown;
			try {
				clips = JSON.parse(text);
			} catch {
				throw new ApiError(meta.errors.invalidFileFormat);
			}
			if (!validateExportedClips(clips)) throw new ApiError(meta.errors.invalidFileFormat);

			const currentClipsCount = await this.clipsRepository.countBy({ userId: me.id });
			if (currentClipsCount + clips.length > (await this.roleService.getUserPolicies(me.id)).clipLimit) {
				throw new ApiError(meta.errors.tooManyClips);
			}

			this.queueService.createImportClipsJob(me, file.id);
		});
	}
}
