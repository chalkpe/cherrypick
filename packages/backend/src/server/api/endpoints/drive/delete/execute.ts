/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { DriveDeletionService } from '@/core/DriveDeletionService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { deletionErrors, deletionResult } from './common.js';

const count = { type: 'integer', optional: false, nullable: false } as const;
const ids = { type: 'array', description: 'IDs sorted in lexicographic order.', optional: false, nullable: false, items: { type: 'string', format: 'id', optional: false, nullable: false } } as const;

export const meta = {
	tags: ['drive'],
	requireCredential: true,
	kind: 'write:drive',
	description: 'Execute one batch of a confirmed drive deletion. Deletes only frozen file IDs, even if moved, and empty unchanged folders from children to parents. New files are never added to the operation. Call until done. Repeated calls preserve cumulative outcomes; prepare and confirm again to retry failures. Counts describe drive database removal; object-storage cleanup uses the usual deletion queue.',
	errors: deletionErrors,
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			operationId: { type: 'string', optional: false, nullable: false },
			totalCount: count, deletedCount: count, missingCount: count, failedCount: count,
			remainingCount: count, remainingFoldersCount: count,
			done: { type: 'boolean', optional: false, nullable: false },
			folderDeleted: { type: 'boolean', optional: false, nullable: false },
			deletedIds: ids, missingIds: ids, deletedFolderIds: ids, missingFolderIds: ids,
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: { operationId: { type: 'string', minLength: 36, maxLength: 36 } },
	required: ['operationId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private driveDeletionService: DriveDeletionService) {
		super(meta, paramDef, async (ps, me) => deletionResult(() => this.driveDeletionService.execute(me, ps.operationId)));
	}
}
