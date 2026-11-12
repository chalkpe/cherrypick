/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { DriveDeletionService } from '@/core/DriveDeletionService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { deletionErrors, deletionResult } from './common.js';

export const meta = {
	tags: ['drive'],
	requireCredential: true,
	kind: 'write:drive',
	limit: { duration: 60000, max: 10 },
	description: 'Prepare a deletion of your selected files (including in-use files) or an entire folder tree. Freezes file IDs for confirmation for one hour, replacing your previous confirmation. At most 10000 files and 1000 folders. Does not delete anything.',
	errors: deletionErrors,
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			operationId: { type: 'string', optional: false, nullable: false },
			totalCount: { type: 'integer', optional: false, nullable: false },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		fileIds: { type: 'array', minItems: 1, maxItems: 10000, items: { type: 'string', format: 'misskey:id' } },
		folderId: { type: 'string', format: 'misskey:id' },
	},
	oneOf: [{ required: ['fileIds'] }, { required: ['folderId'] }],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private driveDeletionService: DriveDeletionService) {
		super(meta, paramDef, async (ps, me) => deletionResult(() => this.driveDeletionService.prepare(me, ps)));
	}
}
