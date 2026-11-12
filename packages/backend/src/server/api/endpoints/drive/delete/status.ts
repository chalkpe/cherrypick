/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { DriveDeletionService } from '@/core/DriveDeletionService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { deletionResult } from './common.js';
import { meta as executeMeta, paramDef } from './execute.js';

export { paramDef };
export const meta = {
	...executeMeta,
	description: 'Read your deletion operation outcomes without deleting another batch. Use after a lost execute response. The operation is owner-bound and expires after one hour of inactivity.',
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private driveDeletionService: DriveDeletionService) {
		super(meta, paramDef, async (ps, me) => deletionResult(() => this.driveDeletionService.status(me, ps.operationId)));
	}
}
